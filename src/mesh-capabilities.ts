/**
 * Capability collection for the Cloud Mesh.
 *
 * Each peer publishes a `Capabilities` blob in `hello` and again via
 * `capabilities_update` whenever local state shifts (model pulled,
 * ASR backend swapped, accepting policy flipped). This module is the
 * single place that snapshots the local state into the wire shape.
 *
 * Sources we pull from:
 *   - `detect_hardware` (Rust) — GPU class, RAM, VRAM, SoC, arch
 *   - `ollama_list_models` (Rust) — currently-pulled LLM tags
 *   - `asr_models_list` (Rust) — ASR backends present on disk
 *   - active manifest + `pickFamily` — to label each tag with its
 *     family + mode so the router can pick by intent rather than
 *     by raw tag string
 *
 * Everything is best-effort: a failing source returns its empty
 * default and the rest of the snapshot fills in. Better to advertise
 * a partial capability set than to skip the announcement entirely.
 */

import { invoke } from "@tauri-apps/api/core";
import type { HardwareProfile, Mode } from "./types";
import type { Capabilities, AcceptingPolicy } from "./mesh-protocol";
import {
  ADVERTISED_FEATURES,
  APP_VERSION,
  EMPTY_CAPABILITIES,
  FEATURES,
  peerSupportsFeature,
  summarizePeerCompat,
} from "./mesh-protocol";
import { getActiveManifest } from "./providers";
import { loadConfig } from "./config";

interface OllamaTag {
  name: string;
}

interface AsrModelInfo {
  name: string;
  installed: boolean;
}

/** Snapshot the local capabilities into the wire shape. Best-effort:
 *  every field falls back to its empty default on error so the
 *  snapshot never fails wholesale. */
export async function snapshotCapabilities(
  accepting: AcceptingPolicy = "available",
): Promise<Capabilities> {
  const cap: Capabilities = structuredClone(EMPTY_CAPABILITIES);
  cap.accepting = accepting;
  // Build version + feature matrix. Constant per build (no detection
  // needed) but worth stamping fresh on each snapshot so a build
  // upgrade between snapshots is reflected immediately.
  cap.app_version = APP_VERSION;
  cap.features = [...ADVERTISED_FEATURES];

  // Hardware. The router treats `none` GPU + 0 GB RAM as "don't send
  // me real work" — same as an outright failure to detect.
  try {
    const hw = await invoke<HardwareProfile>("detect_hardware");
    cap.hardware = {
      gpu_type: hw.gpu_type as Capabilities["hardware"]["gpu_type"],
      ram_gb: Math.round(hw.ram_gb * 10) / 10,
      vram_gb: hw.vram_gb !== null ? Math.round(hw.vram_gb * 10) / 10 : null,
      soc: hw.soc ?? null,
      arch: hw.arch ?? "",
    };
  } catch {
    // Leave defaults in place.
  }

  // LLMs — every locally-pulled ollama tag. We tag each one with the
  // best-guess (family, mode) from the active manifest so a remote
  // caller asking for "gemma4/text" can match without needing the
  // exact ollama tag string. Tags that don't match any tier fall
  // through as ("", "") and the router falls back to a substring
  // match on the tag itself.
  try {
    const tags = await invoke<OllamaTag[]>("ollama_list_models");
    let manifestModes: Record<string, Record<string, string>> = {};
    try {
      const cfg = await loadConfig();
      const manifest = await getActiveManifest();
      const family = manifest.families[cfg.active_family];
      if (family) {
        const collected: Record<string, Record<string, string>> = {};
        for (const [familyName, fam] of Object.entries(manifest.families)) {
          collected[familyName] = {};
          for (const [modeName, mode] of Object.entries(fam.modes)) {
            for (const tier of mode.tiers) {
              collected[familyName][tier.model] = modeName;
              if (tier.fallback) collected[familyName][tier.fallback] = modeName;
            }
          }
        }
        manifestModes = collected;
      }
    } catch {
      // Manifest unavailable — fall through with empty index.
    }
    for (const t of tags) {
      let family = "";
      let mode = "";
      for (const [familyName, modeMap] of Object.entries(manifestModes)) {
        if (t.name in modeMap) {
          family = familyName;
          mode = modeMap[t.name];
          break;
        }
      }
      cap.llms.push({ tag: t.name, family, mode });
    }
  } catch {
    // No ollama or it's down — leave llms empty.
  }

  // ASR backends — anything in the registry that's actually installed
  // on disk. We bucket into moonshine vs parakeet by name prefix; the
  // suffix becomes the `tier` so a router can prefer "small" over
  // "tiny" when both peers have moonshine.
  try {
    const asrModels = await invoke<AsrModelInfo[]>("asr_models_list");
    for (const m of asrModels) {
      if (!m.installed) continue;
      if (m.name.startsWith("moonshine-")) {
        cap.asr.push({ backend: "moonshine", tier: m.name.slice("moonshine-".length) });
      } else if (m.name.startsWith("parakeet-")) {
        cap.asr.push({ backend: "parakeet", tier: m.name.slice("parakeet-".length) });
      }
    }
  } catch {
    // Skip — no asr advertisement.
  }

  // Diarize — anything in the diarize registry that's installed
  // counts as "yes". The toggle in TranscribeView is independent; we
  // just advertise the capability of supporting it.
  try {
    const diarizeModels = await invoke<AsrModelInfo[]>("diarize_models_list");
    cap.diarize = diarizeModels.some((m) => m.installed);
  } catch {
    cap.diarize = false;
  }

  // Audio in. The detect-mics command returns at least one entry for
  // any host with a working microphone; an empty list means no input
  // device or cpal couldn't enumerate. We don't try to surface camera
  // capability yet — the existing app doesn't capture video.
  try {
    const mics = await invoke<Array<{ name: string }>>("audio_input_devices");
    cap.inputs.mic = mics.length > 0;
  } catch {
    cap.inputs.mic = false;
  }
  cap.inputs.camera = false;
  cap.outputs.speaker = true; // every host has audio output in practice
  cap.outputs.display = true;

  return cap;
}

/** True when `cap` could plausibly serve `family`/`mode`. Used by
 *  the mesh client's remote-inference picker to gate which peers
 *  appear as routing targets.
 *
 *  Matching is permissive on purpose — we don't want a freshly-
 *  pulled tag to be invisible because its manifest mapping hasn't
 *  caught up yet. A peer that has ANY LLM advertised counts as a
 *  potential `text` host; family/mode just bias the ranking when
 *  there are several. */
export function canServeInference(
  cap: Capabilities,
  family: string,
  mode: Mode,
): boolean {
  if (cap.accepting === "busy") return false;
  if (cap.llms.length === 0) return false;
  if (!family && !mode) return true;
  // Exact family+mode wins; otherwise any LLM in the right mode is
  // an acceptable fallback (sender's family preference is treated
  // as a hint, not a hard filter — many families share base models).
  if (cap.llms.some((m) => m.family === family && m.mode === mode)) return true;
  if (cap.llms.some((m) => m.mode === mode)) return true;
  return true;
}

/** Quick summary string for the Connections card. Keeps the row
 *  scannable: "Pi 5 · 4 GB · LLM" rather than spelling out the
 *  whole capability set. */
export function summarizeCapabilities(cap: Capabilities): string {
  const bits: string[] = [];
  if (cap.hardware.soc) {
    bits.push(cap.hardware.soc);
  } else if (cap.hardware.gpu_type !== "none") {
    bits.push(cap.hardware.gpu_type);
  }
  if (cap.hardware.vram_gb !== null && cap.hardware.vram_gb > 0) {
    bits.push(`${cap.hardware.vram_gb} GB VRAM`);
  } else if (cap.hardware.ram_gb > 0) {
    bits.push(`${cap.hardware.ram_gb} GB RAM`);
  }
  return bits.join(" · ");
}

/** Compact badge list — the chips that render under each peer's
 *  row. One per capability surface so the user can scan "this peer
 *  has LLM + ASR + mic" at a glance. */
export function capabilityBadges(cap: Capabilities): string[] {
  const out: string[] = [];
  if (cap.llms.length > 0) out.push("LLM");
  if (cap.asr.length > 0) out.push("ASR");
  if (cap.diarize) out.push("diarize");
  if (cap.inputs.mic) out.push("mic");
  if (cap.accepting === "busy") out.push("busy");
  else if (cap.accepting === "limited") out.push("limited");
  return out;
}

/** "v0.2.14 — 9/9 features" or "v0.3.0 — 7/9 features (missing
 *  file_transfer)" for the Connections card. Lets the user see at a
 *  glance whether a peer is on a different release than them and
 *  what optional capabilities they don't share. Empty string when
 *  the peer hasn't advertised a version (Phase 1 peer or version
 *  field was stripped). */
export function formatPeerCompat(cap: Capabilities, ourVersion: string = APP_VERSION): string {
  if (!cap.app_version) {
    return "";
  }
  const { matched, total, missing } = summarizePeerCompat(cap);
  const ver = cap.app_version === ourVersion ? `v${cap.app_version}` : `v${cap.app_version} ≠ ours`;
  if (matched === total) {
    return `${ver} · all features`;
  }
  // Truncate the missing list to keep the chip readable; the full
  // list shows on hover via title attribute on the call site.
  const trimmed = missing.slice(0, 2).join(", ");
  const ellipsis = missing.length > 2 ? "…" : "";
  return `${ver} · ${matched}/${total} (missing ${trimmed}${ellipsis})`;
}

/** Full missing-feature list as a tooltip-friendly string. Used on
 *  the hover-title alongside the truncated `formatPeerCompat`. */
export function describePeerMissingFeatures(cap: Capabilities): string {
  const { missing } = summarizePeerCompat(cap);
  if (missing.length === 0) return "All advertised features supported.";
  return `Peer doesn't advertise: ${missing.join(", ")}.`;
}

/** Convenience re-exports so callers that already pull from
 *  mesh-capabilities don't need a second import for the feature
 *  matrix helpers. The local import above makes the names
 *  available inside this module; this export line re-surfaces
 *  them to anything that imports from `mesh-capabilities`. */
export { APP_VERSION, FEATURES, peerSupportsFeature };
