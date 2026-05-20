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
  import { resolveModel, modeFor } from "../../manifest";
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
  /** Every model tag listed in any tier (model or fallback) of the active
   *  family inside the active provider. These are the rows we lock from
   *  deletion: switching modes within the active family stays cheap because
   *  the user can't accidentally delete a tag they'd need on the next mode
   *  swap. Switching families (CLI or Family tab) recomputes this set. */
  let activeFamilyTags = $state<Set<string>>(new Set());
  /** The active family's display label, surfaced in the row badge so users
   *  can read "active · Gemma 4" instead of decoding their config. */
  let activeFamilyLabel = $state<string>("");
  /** Per-tag list of every (provider, family) pair that lists the tag in
   *  any tier — so a row in family `qwen3` reads "in Qwen 3 family" rather
   *  than the old "in N providers" which lost the family signal entirely. */
  let tagFamilies = $state<Record<string, Array<{ provider: string; familyName: string; familyLabel: string }>>>({});

  let deleteTarget = $state<{
    name: string;
    size: number;
    kept: boolean;
    runtime: string;
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

  /** Walk every saved provider's manifest and bucket every tag into:
   *  (a) the active-family lock set, and
   *  (b) the per-tag family map for row badges. One pass over O(providers
   *  × families × modes × tiers) — cheap enough to redo on every reload. */
  async function computeFamilyMembership() {
    try {
      const [allManifests, config] = await Promise.all([getAllManifests(), loadConfig()]);
      const lockSet = new Set<string>();
      const map: Record<string, Array<{ provider: string; familyName: string; familyLabel: string }>> = {};
      let activeLabel = "";

      // Walk every (provider, family, mode) triple via `modeFor` so
      // shared_modes — most notably the manifest-wide transcribe and
      // diarize ladders — contributes its tiers to both the lock set and
      // the tagFamilies map. Without this, whisper / pyannote tags
      // inherited from shared_modes show as "unrecommended" in the list
      // even though every family that supports transcribe would re-pull
      // them on demand.
      const ALL_MODES: Mode[] = ["text", "vision", "code", "transcribe", "diarize"];
      for (const { provider, manifest } of allManifests) {
        for (const [familyName, family] of Object.entries(manifest.families ?? {})) {
          const isActiveFam =
            provider.name === config.active_provider && familyName === config.active_family;
          if (isActiveFam) activeLabel = family.label;

          for (const mode of ALL_MODES) {
            const modeSpec = modeFor(manifest, family, mode);
            if (!modeSpec) continue;
            for (const tier of modeSpec.tiers) {
              for (const tag of [tier.model, tier.fallback]) {
                if (!tag) continue;
                // Diarize tiers use composite tags joined with `+`
                // (e.g. `pyannote-seg-3.0+wespeaker-r34`). Each
                // component pulls down as its own ONNX file under
                // `~/.myownllm/models/diarize/` and shows up as a
                // separate row in the Models list. Register every
                // component — not just the composite — so the
                // individual rows pick up the family-membership badge
                // instead of reading as unrecommended.
                for (const part of expandComposite(tag)) {
                  if (isActiveFam) lockSet.add(part);
                  const list = map[part] ?? [];
                  if (!list.find((e) => e.provider === provider.name && e.familyName === familyName)) {
                    list.push({ provider: provider.name, familyName, familyLabel: family.label });
                  }
                  map[part] = list;
                }
              }
            }
          }
        }
      }
      // Mode overrides can point at a tag outside the active family. Whichever
      // tag the resolver picks for the active mode is the "live" model and
      // also belongs in the lock set, even if it doesn't appear in any tier
      // of the active family. Transcribe and diarize are locked
      // unconditionally as well (regardless of which mode the user is
      // currently in) — the picked whisper / pyannote models are one
      // toggle away from being needed and they don't appear in the ollama
      // family tiers, so the activeMode probe alone misses them on every
      // text/code/vision session. We resolve directly against the active
      // manifest rather than via lookupModelUsage so picks from
      // `shared_modes` (which most LLM families inherit rather than
      // redeclare) are captured.
      if (hardware) {
        const activeEntry = allManifests.find(
          (e) => e.provider.name === config.active_provider,
        );
        if (activeEntry) {
          for (const mode of [activeMode, "transcribe" as Mode, "diarize" as Mode]) {
            try {
              const tag = resolveModel(
                hardware,
                activeEntry.manifest,
                mode,
                config.mode_overrides,
                config.active_family,
                config.family_overrides,
              );
              // Diarize resolves to a composite ("seg+embedder") —
              // expand so each on-disk component is locked, not just
              // the joined string nobody else has on disk.
              for (const part of expandComposite(tag)) {
                lockSet.add(part);
              }
            } catch {}
          }
        }
      }

      activeFamilyTags = lockSet;
      activeFamilyLabel = activeLabel;
      tagFamilies = map;
    } catch {
      // Non-fatal: the rows will fall back to the unrecommended badge.
    }
  }

  async function toggleKeep(name: string, kept: boolean) {
    if (kept) await unkeepModel(name);
    else await keepModel(name);
    await reload();
  }

  async function startDelete(model: ModelMeta) {
    if (!hardware) return;
    deleteTarget = {
      name: model.name,
      size: model.size,
      kept: model.kept,
      runtime: model.runtime,
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
    // Active-family lock is enforced at the row level (no trash button is
    // rendered for those tags). Belt + suspenders here in case state slips.
    if (activeFamilyTags.has(deleteTarget.name)) return;
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
        // No `diarize_model_remove` Tauri command yet — diarize
        // models are pulled and removed alongside the transcribe
        // toggle. Surface a clear error so the user knows where to
        // manage them.
        throw new Error(
          "Diarize models are managed via the Transcribe pane's 'Identify speakers' toggle.",
        );
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
          {@const inActive = activeFamilyTags.has(m.name)}
          {@const fams = tagFamilies[m.name] ?? []}
          {@const otherFams = fams.filter((f) => !(inActive && f.familyLabel === activeFamilyLabel))}
          <div class="model-row" class:unrecommended={!inActive && fams.length === 0}>
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
              {#if inActive}
                <span class="rec-badge primary" title="Locked — part of the active family">
                  ✓ active · {activeFamilyLabel} family
                </span>
              {:else if fams.length === 1}
                <span class="rec-badge soft">in {fams[0].familyLabel} family</span>
              {:else if fams.length > 1}
                <span class="rec-badge soft">in {fams.length} families</span>
              {:else}
                <span class="unrec-badge">unrecommended · {ageLabel(m.last_recommended)}</span>
              {/if}
              {#if inActive && otherFams.length > 0}
                <span class="rec-meta">
                  also in {otherFams.length === 1 ? `${otherFams[0].familyLabel} family` : `${otherFams.length} other families`}
                </span>
              {/if}
            </div>
            <button
              class="pin-btn"
              class:pinned={m.kept}
              onclick={() => toggleKeep(m.name, m.kept)}
              title={m.kept ? "Unpin" : "Pin (never clean up)"}
            >
              {m.kept ? "📌" : "📍"}
            </button>
            {#if inActive}
              <span
                class="trash-btn locked"
                title="Active family ({activeFamilyLabel}) — switch family to delete"
                aria-hidden="true"
              >🔒</span>
            {:else}
              <button
                class="trash-btn"
                onclick={() => startDelete(m)}
                title="Delete this model"
                aria-label="Delete {m.name}"
              >
                🗑
              </button>
            {/if}
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
        <p class="confirm-error">
          <strong>This is the model currently in use.</strong>
          Switch family or mode first, then delete.
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

      {#if deleteTarget.kept}
        <p class="confirm-info">This model is pinned. Deleting will unpin it.</p>
      {/if}

      {#if deleteError}
        <p class="confirm-error">{deleteError}</p>
      {/if}
      <div class="confirm-actions">
        <button class="cancel" disabled={deleting} onclick={closeDelete}>Cancel</button>
        <button
          class="delete"
          disabled={deleting || deleteUsageLoading || deleteUsage?.isActiveTag}
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
  .trash-btn.locked {
    cursor: default;
    opacity: .35;
  }
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
