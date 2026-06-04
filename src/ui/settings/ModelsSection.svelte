<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import {
    getModelStatusWithMeta,
    keepModel,
    unkeepModel,
    recomputeRecommendedSet,
    lookupModelUsage,
    type ModelUsage,
  } from "../../model-lifecycle";
  import { getAllManifests } from "../../providers";
  import { loadConfig } from "../../config";
  import { canonicalModelTag, resolveModel } from "../../manifest";
  import { scrollAffordance } from "../scroll-affordance";
  import FamilyDetail from "./FamilyDetail.svelte";
  import type { HardwareProfile, Mode } from "../../types";

  type ModelMeta = Awaited<ReturnType<typeof getModelStatusWithMeta>>[number];

  let { onChanged, onClose }: { onChanged?: () => void; onClose: () => void } = $props();

  let models = $state<ModelMeta[]>([]);
  let loading = $state(true);
  /** Tab strip: "installed" lists every pulled model in the library;
   *  "overrides" delegates to FamilyDetail so the user can switch tiers
   *  inside the active family without leaving the Models section. The
   *  tab label is "Model Overrides" — same UI as the Family tab's
   *  detail view, minus the Back button. */
  let tab = $state<"installed" | "overrides">("installed");

  let hardware = $state<HardwareProfile | null>(null);
  let activeMode = $state<Mode>("text");
  /** Active family — used as the seed for the Model Overrides tab so it
   *  always renders the family the user is actually chatting in. */
  let activeFamily = $state<string>("");
  /** Every chat-model tag (text/vision/code, model or fallback) of the
   *  active family. These rows are locked from deletion: switching modes
   *  within the active family stays cheap because the user can't
   *  accidentally delete a tag they'd need on the next mode swap. Switching
   *  families (CLI or Family tab) recomputes this set. */
  let activeFamilyTags = $state<Set<string>>(new Set());
  /** The active family's display label, surfaced in the row badge so users
   *  can read "active · Gemma 4" instead of decoding their config. */
  let activeFamilyLabel = $state<string>("");
  /** Tag → the always-on shared capability whose current pick it is
   *  (Transcribe / Diarize / Embed / Voice activity). These models back
   *  features the user can toggle on at any time and belong to no chat
   *  family, so the per-family lock never catches them — yet deleting the
   *  embedding model out from under Myo's memory, or the VAD model the live
   *  endpointer wants, is exactly the footgun this list prevents. Locked
   *  like the active family; the badge shows the capability name. */
  let capabilityLocks = $state<Record<string, string>>({});
  /** Per-tag list of every place that recommends it, for the soft "in …"
   *  badge on rows that aren't locked. `kind` drives the wording: a chat
   *  family reads "in Qwen 3.6 family", a shared capability reads "in
   *  Speak". Replaces the old per-provider map, which lost the signal of
   *  *which* capability/family wanted the tag. */
  let tagPlaces = $state<Record<string, Array<{ label: string; kind: "family" | "capability" }>>>({});

  let deleteTarget = $state<{
    name: string;
    size: number;
    kept: boolean;
    runtime: string;
    /** Non-null when the row backs an always-on feature or the active family
     *  — used to warn (not block) before deleting an app-required model. */
    requiredBy: string | null;
  } | null>(null);
  let deleteUsage = $state<ModelUsage | null>(null);
  let deleteUsageLoading = $state(false);
  let deleting = $state(false);
  let deleteError = $state("");

  onMount(async () => {
    try {
      hardware = await invoke<HardwareProfile>("detect_hardware");
    } catch {}
    try {
      const config = await loadConfig();
      activeMode = config.active_mode;
      activeFamily = config.active_family;
    } catch {}
    await reload();
  });

  async function reload() {
    loading = true;
    // Refresh the recommended-by set against currently saved manifests before
    // reading. Otherwise a model pulled this session — including the one the
    // resolver just picked — keeps showing as "unrecommended" until the next
    // cleanup pass writes the cache.
    try { await recomputeRecommendedSet(); } catch {}
    models = await getModelStatusWithMeta();
    await computeFamilyMembership();
    loading = false;
  }

  /** Diarize tiers ship composite tags joined with `+`
   *  (e.g. `pyannote-seg-3.0+wespeaker-r34`) — segmenter + embedder.
   *  On disk those land as two separate ONNX files registered under
   *  the component names. Anywhere we walk manifest tags to build a
   *  set keyed by on-disk model name, we need each component, not
   *  the joined string nobody has on disk. Non-composite tags pass
   *  through as a single element. */
  function expandComposite(tag: string | null | undefined): string[] {
    if (!tag) return [];
    return tag.includes("+") ? tag.split("+").filter(Boolean) : [tag];
  }

  /** Walk every saved provider's manifest and bucket each tag into:
   *  (a) the active-family lock set (chat tiers of the family the user is
   *      in — text/vision/code), (b) the capability-lock map (the resolver's
   *      live pick for each always-on shared capability), and (c) the
   *      per-tag "recommended places" map for the soft badge.
   *
   *  Chat families and shared capabilities are kept distinct on purpose:
   *  transcribe / diarize / speak / embed / vad are family-agnostic, so a
   *  downloaded embedding or VAD model is attributed to its capability
   *  ("Embed", "Voice activity") rather than to whichever family happens to
   *  inherit the shared block — and it lands locked, not "unrecommended".
   *  One pass over O(providers × families/modes × tiers). */
  async function computeFamilyMembership() {
    try {
      const [allManifests, config] = await Promise.all([getAllManifests(), loadConfig()]);
      const familyLock = new Set<string>();
      const capLock: Record<string, string> = {};
      const places: Record<string, Array<{ label: string; kind: "family" | "capability" }>> = {};
      let activeLabel = "";

      const addPlace = (tag: string, label: string, kind: "family" | "capability") => {
        const list = places[tag] ?? (places[tag] = []);
        if (!list.some((p) => p.label === label && p.kind === kind)) list.push({ label, kind });
      };

      // (a)/(c) Chat families. Only text/vision/code live on a family —
      // transcribe/diarize/speak/embed/vad are shared capabilities handled
      // below. Attribute every tier tag to the family's label; lock the
      // active family's tags so a mode swap within it can't delete a tag
      // it would immediately re-pull.
      const FAMILY_MODES: Mode[] = ["text", "vision", "code"];
      for (const { provider, manifest } of allManifests) {
        for (const [familyName, family] of Object.entries(manifest.families ?? {})) {
          const isActiveFam =
            provider.name === config.active_provider && familyName === config.active_family;
          if (isActiveFam) activeLabel = family.label;
          for (const mode of FAMILY_MODES) {
            const modeSpec = family.modes?.[mode];
            if (!modeSpec) continue;
            for (const tier of modeSpec.tiers) {
              for (const tag of [tier.model, tier.fallback]) {
                for (const part of expandComposite(tag)) {
                  if (isActiveFam) familyLock.add(part);
                  addPlace(part, family.label, "family");
                }
              }
            }
          }
        }
      }

      // (c) Shared capabilities. Every tier tag (across providers) is a
      // recommended alternate for that capability, so the embedding / VAD /
      // TTS models read "in Embed" / "in Voice activity" instead of
      // "unrecommended". Diarize tiers ship composite tags — expand so each
      // on-disk component gets its own badge.
      for (const { manifest } of allManifests) {
        for (const modeSpec of Object.values(manifest.shared_modes ?? {})) {
          const label = modeSpec.label ?? "Shared";
          for (const tier of modeSpec.tiers) {
            for (const tag of [tier.model, tier.fallback]) {
              for (const part of expandComposite(tag)) addPlace(part, label, "capability");
            }
          }
        }
      }

      // (b) Lock the live pick of each always-on capability. Transcription,
      // speaker diarization, the memory system's embeddings, and the live
      // VAD endpointer are all one toggle away regardless of the chat
      // family/mode, and their models appear in no family ladder — so the
      // per-family lock never catches them. Resolve against the active
      // provider's manifest (every family inherits the same shared ladders).
      const activeEntry =
        allManifests.find((e) => e.provider.name === config.active_provider) ?? allManifests[0];
      if (hardware && activeEntry) {
        const shared = activeEntry.manifest.shared_modes ?? {};
        // Hardware ladders → lock the current rung. (transcribe / diarize /
        // embed / speak are all real Modes the resolver understands; speak's
        // pick — a Kokoro or Piper voice — would otherwise read as a soft
        // "in Speak" suggestion instead of the recommended model in use.)
        for (const mode of ["transcribe", "diarize", "embed", "speak"] as Mode[]) {
          if (!shared[mode]) continue;
          const label = shared[mode].label ?? mode;
          try {
            const tag = resolveModel(
              hardware,
              activeEntry.manifest,
              mode,
              config.mode_overrides,
              config.active_family,
              config.family_overrides,
            );
            // Diarize resolves to a composite ("seg+embedder") — expand so
            // each on-disk component is locked, not the joined string.
            for (const part of expandComposite(tag)) capLock[part] = label;
          } catch {}
        }
        // A mode_override can point the active chat mode at a tag outside
        // the family's own tiers; that live pick belongs to the family.
        if (FAMILY_MODES.includes(activeMode)) {
          try {
            const tag = resolveModel(
              hardware,
              activeEntry.manifest,
              activeMode,
              config.mode_overrides,
              config.active_family,
              config.family_overrides,
            );
            for (const part of expandComposite(tag)) familyLock.add(part);
          } catch {}
        }
        // VAD ships a single always-on model with no hardware ladder to
        // resolve — lock every tag the `vad` block names.
        const vadSpec = shared["vad"];
        if (vadSpec) {
          const label = vadSpec.label ?? "Voice activity";
          for (const tier of vadSpec.tiers) {
            for (const tag of [tier.model, tier.fallback]) {
              if (tag) capLock[tag] = label;
            }
          }
        }
      }

      activeFamilyTags = familyLock;
      activeFamilyLabel = activeLabel;
      capabilityLocks = capLock;
      tagPlaces = places;
    } catch {
      // Non-fatal: the rows will fall back to the unrecommended badge.
    }
  }

  async function toggleKeep(name: string, kept: boolean) {
    if (kept) await unkeepModel(name);
    else await keepModel(name);
    await reload();
  }

  async function startDelete(model: ModelMeta, requiredBy: string | null = null) {
    if (!hardware) return;
    deleteTarget = {
      name: model.name,
      size: model.size,
      kept: model.kept,
      runtime: model.runtime,
      requiredBy,
    };
    deleteUsage = null;
    deleteError = "";
    deleteUsageLoading = true;
    try {
      deleteUsage = await lookupModelUsage(model.name, hardware, activeMode);
    } catch {
      deleteUsage = null;
    } finally {
      deleteUsageLoading = false;
    }
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    deleting = true;
    deleteError = "";
    try {
      // Manual delete trumps the pin: clear the keep flag first so it doesn't
      // resurrect the entry on the next reload.
      if (deleteTarget.kept) {
        try { await unkeepModel(deleteTarget.name); } catch {}
      }
      // Route the delete to the right backend — local-runtime models
      // (ASR / diarize) live under `~/.myownllm/models/`, not in
      // Ollama's library. The runtime string carries the kind for
      // local models (see model-lifecycle.ts).
      if (deleteTarget.runtime === "asr") {
        await invoke("asr_model_remove", { name: deleteTarget.name });
      } else if (deleteTarget.runtime === "diarize") {
        await invoke("diarize_model_remove", { name: deleteTarget.name });
      } else if (deleteTarget.runtime === "tts") {
        await invoke("tts_model_remove", { name: deleteTarget.name });
      } else {
        await invoke("ollama_delete_model", { name: deleteTarget.name });
      }
      deleteTarget = null;
      deleteUsage = null;
      await reload();
    } catch (e) {
      deleteError = String(e);
    } finally {
      deleting = false;
    }
  }

  function closeDelete() {
    if (deleting) return;
    deleteTarget = null;
    deleteUsage = null;
    deleteError = "";
  }

  /** Cross-family / cross-mode usages worth bolding in the dialog. The
   *  delete is hard-blocked when isActiveTag is true, so the active triple
   *  is filtered out either way and the dialog lists what the user might not
   *  expect — what they'd silently re-pull later if they switch family or
   *  mode after deleting. */
  async function getActiveTriple(): Promise<{ provider: string; family: string; mode: Mode } | null> {
    try {
      const config = await loadConfig();
      return { provider: config.active_provider, family: config.active_family, mode: activeMode };
    } catch {
      return null;
    }
  }
  let activeTriple = $state<{ provider: string; family: string; mode: Mode } | null>(null);
  $effect(() => {
    if (deleteTarget) {
      getActiveTriple().then((t) => (activeTriple = t));
    }
  });
  function otherUses(usage: ModelUsage | null): ModelUsage["uses"] {
    if (!usage || !activeTriple) return usage?.uses ?? [];
    return usage.uses.filter(
      (u) =>
        !(
          u.provider === activeTriple!.provider &&
          u.familyName === activeTriple!.family &&
          u.mode === activeTriple!.mode
        ),
    );
  }

  function ageLabel(isoDate: string): string {
    const ms = Date.now() - new Date(isoDate).getTime();
    const hours = Math.floor(ms / 3_600_000);
    if (hours < 1) return "just now";
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function sizeLabel(bytes: number): string {
    return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";
  }

  /** Render a recommended-place for the soft badge: a chat family keeps its
   *  "family" suffix ("Qwen 3.6 family"); a shared capability reads as just
   *  its label ("Speak", "Voice activity"). */
  function placeLabel(p: { label: string; kind: "family" | "capability" }): string {
    return p.kind === "family" ? `${p.label} family` : p.label;
  }
</script>

<div class="section">
  <div class="h-tabs">
    <button class:active={tab === "installed"} onclick={() => (tab = "installed")}>Installed</button>
    <button class:active={tab === "overrides"} onclick={() => (tab = "overrides")}>Model Overrides</button>
  </div>

  {#if tab === "installed"}
    {#if loading}
      <div class="loading">Loading…</div>
    {:else if models.length === 0}
      <div class="empty">No models pulled yet.</div>
    {:else}
      <div class="scroll-affordance-wrap">
      <div class="list scroll-fade" use:scrollAffordance>
        {#each models as m}
          {@const cname = canonicalModelTag(m.name)}
          {@const famLocked = activeFamilyTags.has(cname)}
          {@const capLabel = capabilityLocks[cname]}
          {@const locked = famLocked || !!capLabel}
          {@const places = tagPlaces[cname] ?? []}
          {@const otherPlaces = places.filter((p) => !(famLocked && p.kind === "family" && p.label === activeFamilyLabel) && !(capLabel && p.kind === "capability" && p.label === capLabel))}
          <div class="model-row" class:unrecommended={!locked && places.length === 0}>
            <div class="model-info">
              <div class="name-row">
                <span class="name">{m.name}</span>
                <span class="runtime-tag" class:local={m.runtime !== "ollama"}>
                  {m.runtime}
                </span>
              </div>
              <span class="size">{sizeLabel(m.size)}</span>
            </div>
            <div class="model-meta">
              {#if famLocked}
                <span class="rec-badge primary" title="In use by the active family">
                  ✓ active · {activeFamilyLabel} family
                </span>
              {:else if capLabel}
                <span class="rec-badge primary" title="Backs the {capLabel} feature">
                  ✓ {capLabel}
                </span>
              {:else if places.length === 1}
                <span class="rec-badge soft">in {placeLabel(places[0])}</span>
              {:else if places.length > 1}
                <span class="rec-badge soft">in {places.length} places</span>
              {:else}
                <span class="unrec-badge">unrecommended · {ageLabel(m.last_recommended)}</span>
              {/if}
              {#if locked && otherPlaces.length > 0}
                <span class="rec-meta">
                  also in {otherPlaces.length === 1 ? placeLabel(otherPlaces[0]) : `${otherPlaces.length} other places`}
                </span>
              {/if}
            </div>
            <button
              class="pin-btn"
              class:pinned={m.kept}
              onclick={() => toggleKeep(m.name, m.kept)}
              title={m.kept
                ? "Locked — kept on disk, won't be auto-cleaned. Click to unlock."
                : "Unlocked — click to lock (keep on disk, never auto-clean)."}
              aria-label={m.kept ? `Unlock ${m.name}` : `Lock ${m.name}`}
            >
              {m.kept ? "🔒" : "🔓"}
            </button>
            <button
              class="trash-btn"
              onclick={() => startDelete(m, locked ? (capLabel || activeFamilyLabel) : null)}
              title="Delete this model"
              aria-label="Delete {m.name}"
            >
              🗑
            </button>
          </div>
        {/each}
      </div>
      <div class="scroll-more-hint" aria-hidden="true">
        <span class="scroll-more-chevron">⌄</span>
        <span>more below</span>
      </div>
      </div>
    {/if}
  {:else}
    <!-- Model Overrides — same UI as the Family tab's detail screen,
         seeded with whichever family the user is currently chatting in.
         Switching tiers here writes the same family_overrides config
         entries the Family tab does, so the chat slot picks up the new
         pick immediately. -->
    {#if activeFamily}
      <FamilyDetail
        familyName={activeFamily}
        showBack={false}
        onChanged={onChanged ?? (() => {})}
        {onClose}
      />
    {:else}
      <div class="loading">Loading…</div>
    {/if}
  {/if}

  {#if deleteTarget}
    <div
      class="confirm-overlay"
      onclick={closeDelete}
      role="presentation"
    ></div>
    <div class="confirm" role="dialog" aria-label="Delete model">
      <h3>Delete this model?</h3>
      <p class="confirm-name">{deleteTarget.name}</p>
      <p class="confirm-size">Frees {sizeLabel(deleteTarget.size)} of disk space.</p>

      {#if deleteUsageLoading}
        <p class="confirm-info">Checking where this model is used…</p>
      {:else if deleteUsage?.isActiveTag}
        <p class="confirm-warn-lead">
          <strong>⚠ This is the model currently in use.</strong>
          Deleting it now interrupts it until it re-downloads on next use.
        </p>
      {:else if otherUses(deleteUsage).length > 0}
        <p class="confirm-warn-lead">
          Heads up — this is the recommended model for:
        </p>
        <ul class="confirm-uses">
          {#each otherUses(deleteUsage) as u}
            <li>
              <strong>{u.familyLabel}</strong>
              <span class="use-meta">· {u.mode} mode</span>
              {#if u.provider !== activeTriple?.provider}
                <span class="use-meta">· {u.provider}</span>
              {/if}
            </li>
          {/each}
        </ul>
        <p class="confirm-warn-tail">
          You can still delete it; MyOwnLLM will re-pull when you switch.
        </p>
      {/if}

      {#if deleteTarget.requiredBy}
        <p class="confirm-info">
          Backs <strong>{deleteTarget.requiredBy}</strong> — the app re-downloads
          it automatically when it's needed again.
        </p>
      {/if}

      {#if deleteTarget.kept}
        <p class="confirm-info">This model is locked (kept). Deleting will unlock it.</p>
      {/if}

      {#if deleteError}
        <p class="confirm-error">{deleteError}</p>
      {/if}
      <div class="confirm-actions">
        <button class="cancel" disabled={deleting} onclick={closeDelete}>Cancel</button>
        <button
          class="delete"
          disabled={deleting || deleteUsageLoading}
          onclick={confirmDelete}
        >
          {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .section { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .h-tabs { display: flex; align-items: center; border-bottom: 1px solid #1e1e1e; flex-shrink: 0; gap: .25rem; padding-right: .5rem; }
  .h-tabs button {
    padding: .55rem; background: none; border: none; color: #666;
    font-size: .8rem; cursor: pointer; border-bottom: 2px solid transparent;
    flex: 0 0 auto; padding-left: 1rem; padding-right: 1rem;
  }
  .h-tabs button.active { color: #e8e8e8; border-bottom-color: #6e6ef7; }
  .loading, .empty { padding: 2rem; text-align: center; color: #555; font-size: .85rem; }
  .list { flex: 1; overflow-y: scroll; padding: .5rem; display: flex; flex-direction: column; gap: .25rem; min-height: 0; --scroll-fade-bg: #111; }
  .model-row {
    padding: .5rem .6rem; border-radius: 7px; background: #1a1a1a;
    display: flex; align-items: center; gap: .5rem;
  }
  .model-row.unrecommended { border-left: 3px solid #444; }
  .model-info { flex: 1; display: flex; flex-direction: column; gap: .15rem; min-width: 0; }
  .name-row { display: flex; align-items: center; gap: .4rem; min-width: 0; }
  .name { font-size: .83rem; font-family: monospace; color: #ccc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .runtime-tag {
    font-size: .62rem;
    color: #888;
    background: #1a1a22;
    padding: 0 .35rem;
    border-radius: 4px;
    text-transform: lowercase;
    border: 1px solid #25252f;
    font-family: monospace;
    flex-shrink: 0;
  }
  .runtime-tag.local {
    /* Non-Ollama runtimes (moonshine / parakeet / diarize / etc.)
       — these live under ~/.myownllm/models/ rather than Ollama's
       library. */
    color: #d4a64a;
    border-color: #4a3a1a;
    background: #1f1812;
  }
  .size { font-size: .72rem; color: #555; }
  .model-meta { display: flex; flex-direction: column; gap: .15rem; align-items: flex-end; }
  .rec-badge { font-size: .7rem; color: #4a4; }
  .rec-badge.primary {
    color: #b3b3ff;
    background: #1a1a2a;
    padding: .1rem .45rem;
    border-radius: 4px;
    font-weight: 600;
  }
  .rec-badge.soft { color: #777; }
  .rec-meta { font-size: .68rem; color: #555; font-style: italic; }
  .unrec-badge { font-size: .7rem; color: #777; }
  .pin-btn { background: none; border: none; cursor: pointer; font-size: .9rem; opacity: .5; }
  .pin-btn:hover, .pin-btn.pinned { opacity: 1; }
  .trash-btn { background: none; border: none; cursor: pointer; font-size: .9rem; opacity: .5; }
  .trash-btn:hover { opacity: 1; color: #f66; }
  .confirm-overlay {
    position: fixed; inset: 0; background: rgba(0, 0, 0, .65); z-index: 30;
  }
  .confirm {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(380px, 90vw);
    background: #161616; border: 1px solid #2a2a2a; border-radius: 10px;
    padding: 1rem 1.1rem; z-index: 31;
    box-shadow: 0 12px 40px rgba(0, 0, 0, .6);
  }
  .confirm h3 { font-size: .9rem; font-weight: 600; margin-bottom: .5rem; }
  .confirm-name {
    font-family: monospace; font-size: .85rem; color: #e8e8e8;
    background: #0d0d0d; padding: .4rem .6rem; border-radius: 5px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    margin-bottom: .5rem;
  }
  .confirm-size { font-size: .78rem; color: #888; margin-bottom: .85rem; }
  .confirm-info {
    font-size: .75rem; color: #aaa; background: #1a1a22;
    padding: .4rem .6rem; border-radius: 5px; margin-bottom: .6rem;
  }
  .confirm-warn-lead {
    font-size: .78rem; color: #ddd; margin-bottom: .35rem;
  }
  .confirm-warn-tail {
    font-size: .73rem; color: #888; margin-top: .25rem; margin-bottom: .75rem;
    font-style: italic;
  }
  .confirm-uses {
    list-style: none;
    background: #1f1a0d; border: 1px solid #3a2c10;
    border-radius: 6px; padding: .45rem .65rem; margin-bottom: .35rem;
    display: flex; flex-direction: column; gap: .25rem;
  }
  .confirm-uses li { font-size: .8rem; color: #f0d9a0; }
  .confirm-uses li strong { color: #ffd166; font-weight: 700; }
  .confirm-uses .use-meta { color: #a89070; font-weight: 400; margin-left: .15rem; }
  .confirm-error {
    font-size: .75rem; color: #f88; background: #2a1a1a;
    padding: .4rem .6rem; border-radius: 5px; margin-bottom: .75rem;
    word-break: break-word;
  }
  .confirm-error strong { color: #ffb3b3; }
  .confirm-actions { display: flex; justify-content: flex-end; gap: .5rem; }
  .confirm-actions button {
    padding: .4rem .9rem; border-radius: 6px; font-size: .8rem;
    cursor: pointer; border: 1px solid transparent;
  }
  .confirm-actions button:disabled { opacity: .5; cursor: default; }
  .confirm-actions .cancel {
    background: #1e1e1e; color: #ccc; border-color: #2a2a2a;
  }
  .confirm-actions .cancel:hover:not(:disabled) { background: #252525; }
  .confirm-actions .delete {
    background: #5a2424; color: #ffd6d6; border-color: #7a3434;
  }
  .confirm-actions .delete:hover:not(:disabled) { background: #6a2c2c; }
</style>
