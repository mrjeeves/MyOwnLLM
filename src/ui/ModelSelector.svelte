<script lang="ts">
  import { meshClient } from "../mesh-client.svelte";
  import { canServeInference, canServeTranscribe } from "../mesh-capabilities";
  import type { Mode } from "../types";

  let {
    kind,
    localModel,
    family,
    mode,
    viaPeerId,
    onViaChange,
    disabled = false,
  } = $props<{
    /** "text" routes via `infer_request` and pulls peers that advertise
     *  an LLM. "transcribe" routes via `transcribe_request` and pulls
     *  peers that advertise an ASR backend. */
    kind: "text" | "transcribe";
    /** Local model tag — what we'd run if no peer is picked. Shown as
     *  the pill label when local-only, and as the "this device" row in
     *  the dropdown when peers are available. */
    localModel: string;
    /** Active family — biases peer matching for the text kind. Unused
     *  for transcribe (any ASR-capable peer qualifies). */
    family: string;
    /** Active mode — biases peer matching for the text kind. */
    mode: Mode;
    /** Current routing target. `null` means run locally. */
    viaPeerId: string | null;
    onViaChange: (peerId: string | null) => void;
    /** Disables the picker (e.g. while a stream is in flight). */
    disabled?: boolean;
  }>();

  // Peers that can actually serve this kind of work. We filter to
  // active + authorized + not-busy so the dropdown never offers a peer
  // that would error out on click. The list is reactive — peers
  // appearing/disappearing morph the pill ↔ select shape on the fly.
  const eligiblePeers = $derived(
    meshClient.peers.filter((p) => {
      if (p.status !== "active") return false;
      if (!p.authorized) return false;
      if (kind === "text") return canServeInference(p.capabilities, family, mode);
      return canServeTranscribe(p.capabilities);
    }),
  );

  // Drop a stale pick if the chosen peer is no longer eligible (went
  // offline, shelved, busy, dropped the capability). Without this the
  // selector would silently retain a routing target that wouldn't
  // actually receive frames.
  $effect(() => {
    if (!viaPeerId) return;
    if (!eligiblePeers.some((p) => p.peer_id === viaPeerId)) {
      onViaChange(null);
    }
  });

  // Render mode: plain pill when no peer can serve, styled select when
  // any peer can. The user picked "Text until a peer joins" — keeps
  // the visual weight off the UI when there's nothing to choose.
  const showSelect = $derived(eligiblePeers.length > 0);

  function shortPeerLabel(label: string, suffix: string, fallback: string): string {
    if (label) return suffix ? `${label} -${suffix}` : label;
    return suffix ? `${fallback.slice(0, 8)}…-${suffix}` : `${fallback.slice(0, 8)}…`;
  }

  /** What we display as the "model" for a remote peer. We don't know
   *  the exact tag the peer will pick on the receiving side (their
   *  resolver runs the match) — surface the kind-appropriate
   *  capability advertisement instead so the user has a hint. */
  function peerModelHint(peerCap: typeof meshClient.peers[number]["capabilities"]): string {
    if (kind === "text") {
      const exact = peerCap.llms.find((m) => m.family === family && m.mode === mode);
      const modeMatch = peerCap.llms.find((m) => m.mode === mode);
      return (exact ?? modeMatch ?? peerCap.llms[0])?.tag ?? "(no LLM)";
    }
    const asr = peerCap.asr[0];
    return asr ? `${asr.backend}-${asr.tier}` : "(no ASR)";
  }

  function onSelectChange(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    onViaChange(v === "" ? null : v);
  }
</script>

{#if showSelect}
  <div class="selector" class:routed={viaPeerId} class:disabled>
    <span class="kind-dot" aria-hidden="true"></span>
    <select
      class="picker"
      value={viaPeerId ?? ""}
      onchange={onSelectChange}
      {disabled}
      title={viaPeerId
        ? "Inference is routed through a peer over the Cloud Mesh"
        : "Pick a peer to run this on, or leave on this device"}
    >
      <option value="">{localModel || "(no local model)"} · this device</option>
      {#each eligiblePeers as p (p.peer_id)}
        <option value={p.peer_id}>
          {peerModelHint(p.capabilities)} · {shortPeerLabel(p.label, p.device_suffix, p.device_pubkey)}
        </option>
      {/each}
    </select>
  </div>
{:else}
  <span class="selector pill" title={localModel}>
    <span class="kind-dot" aria-hidden="true"></span>
    <span class="model-name">{localModel || "(no model)"}</span>
  </span>
{/if}

<style>
  .selector {
    display: inline-flex;
    align-items: center;
    gap: .4rem;
    padding: 0 .15rem 0 .55rem;
    height: 1.65rem;
    border: 1px solid #2a2a2a;
    border-radius: 999px;
    background: #131313;
    font-size: .76rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    color: #cfcfcf;
    max-width: 22rem;
    min-width: 0;
    transition: border-color .15s, background .15s;
  }
  .selector:hover { border-color: #3a3a55; }
  .selector.routed {
    border-color: #4a3a7a;
    background: #1a1730;
    color: #d8d8ff;
  }
  .selector.disabled { opacity: .55; }
  .pill {
    cursor: default;
    padding-right: .65rem;
  }
  .model-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .kind-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #4caf50;
    box-shadow: 0 0 4px #4caf50;
    flex-shrink: 0;
  }
  .selector.routed .kind-dot {
    background: #b899f7;
    box-shadow: 0 0 5px #b899f7;
  }
  .picker {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 0 .5rem 0 0;
    min-width: 0;
    max-width: 19rem;
    text-overflow: ellipsis;
  }
  .picker:focus { outline: none; }
  .picker:disabled { cursor: default; }
  .picker option {
    background: #131313;
    color: #cfcfcf;
  }
</style>
