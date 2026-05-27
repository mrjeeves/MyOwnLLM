<script lang="ts">
  import { meshClient } from "../mesh-daemon.svelte";
  import { canServeInference, canServeTranscribe } from "../mesh-capabilities";
  import type { Mode } from "../types";

  let {
    kind,
    localModel,
    family,
    mode,
    viaDevicePubkey,
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
    /** Current routing target as a stable `device_pubkey`. `null`
     *  means run locally. We persist pubkey rather than the
     *  Trystero `peer_id` because the latter regenerates per session;
     *  a reload or a peer hop would silently lose the pin otherwise. */
    viaDevicePubkey: string | null;
    onViaChange: (devicePubkey: string | null) => void;
    /** Disables the picker (e.g. while a stream is in flight). */
    disabled?: boolean;
  }>();

  /** Peers we'd accept routing to right now — active + authorized +
   *  not-busy + has the right capability. Offline rostered peers are
   *  handled separately below so a transient drop doesn't make the
   *  pinned host vanish from the list. */
  const eligiblePeers = $derived(
    meshClient.peers.filter((p) => {
      if (p.status !== "active") return false;
      if (!p.authorized) return false;
      if (kind === "text") return canServeInference(p.capabilities, family, mode);
      return canServeTranscribe(p.capabilities);
    }),
  );

  /** The peer matching the persisted pin, regardless of current
   *  status. Used to surface "(offline)" / unavailable states
   *  without forgetting which host the user picked. */
  const pinnedPeer = $derived(
    viaDevicePubkey
      ? meshClient.peers.find((p) => p.device_pubkey === viaDevicePubkey) ?? null
      : null,
  );
  const pinnedIsActive = $derived(pinnedPeer?.status === "active");
  /** Pin set but its peer either isn't reachable or doesn't currently
   *  serve this kind. Parent surfaces gate their send paths on this
   *  so a flaky network doesn't quietly route to local instead. */
  const pinnedIsUnavailable = $derived(
    !!viaDevicePubkey && !pinnedIsActive,
  );

  /** Render mode: plain pill when local-only and no offline pin to
   *  surface; styled select otherwise. We keep the dropdown shape
   *  whenever ANY peer (active or offline-with-pin) is relevant so
   *  the user can swap hosts without first un-pinning. */
  const showSelect = $derived(
    eligiblePeers.length > 0 || pinnedIsUnavailable,
  );

  function shortPeerLabel(label: string, suffix: string, fallback: string): string {
    if (label) return suffix ? `${label} -${suffix}` : label;
    return suffix ? `${fallback.slice(0, 8)}…-${suffix}` : `${fallback.slice(0, 8)}…`;
  }

  /** What we display as the "model" for a remote peer. We don't know
   *  the exact tag the peer will pick on the receiving side (their
   *  resolver runs the match) — surface the kind-appropriate
   *  capability advertisement instead so the user has a hint. Returns
   *  null when the peer hasn't advertised anything in this kind yet
   *  (typical for offline peers we've never seen with content). */
  function peerModelHint(
    peerCap: typeof meshClient.peers[number]["capabilities"],
  ): string | null {
    if (kind === "text") {
      const exact = peerCap.llms.find((m) => m.family === family && m.mode === mode);
      const modeMatch = peerCap.llms.find((m) => m.mode === mode);
      return (exact ?? modeMatch ?? peerCap.llms[0])?.tag ?? null;
    }
    const asr = peerCap.asr[0];
    return asr ? `${asr.backend}-${asr.tier}` : null;
  }

  /** Label for the pinned peer when it's offline — used in both the
   *  pill display and the dropdown's offline row. Falls back to the
   *  device-id display when the peer has no friendly label and the
   *  cached capabilities are empty. */
  function offlineLabelFor(peer: NonNullable<typeof pinnedPeer>): string {
    const hint = peerModelHint(peer.capabilities);
    const who = shortPeerLabel(peer.label, peer.device_suffix, peer.device_pubkey);
    return hint ? `${hint} · ${who} (offline)` : `${who} (offline)`;
  }

  function onSelectChange(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    onViaChange(v === "" ? null : v);
  }
</script>

{#if showSelect}
  <div
    class="selector"
    class:routed={pinnedIsActive}
    class:offline={pinnedIsUnavailable}
    class:disabled
    title={pinnedIsUnavailable
      ? "The pinned peer is offline. Pick another host or 'this device' to keep going."
      : pinnedIsActive
        ? "Inference is routed through a peer over the Cloud Mesh"
        : "Pick a peer to run this on, or leave on this device"}
  >
    <span class="kind-dot" aria-hidden="true"></span>
    <select
      class="picker"
      value={viaDevicePubkey ?? ""}
      onchange={onSelectChange}
      {disabled}
    >
      <option value="">{localModel || "(no local model)"} · this device</option>
      {#each eligiblePeers as p (p.device_pubkey)}
        {@const hint = peerModelHint(p.capabilities)}
        <option value={p.device_pubkey}>
          {hint ? `${hint} · ` : ""}{shortPeerLabel(p.label, p.device_suffix, p.device_pubkey)}
        </option>
      {/each}
      {#if pinnedIsUnavailable && pinnedPeer}
        <!-- Surface the offline pin as its own option so the user
             can see which host they're tied to without having to
             expand the dropdown twice (select doesn't preserve a
             "current value not in options" entry in a useful way
             on all browsers). -->
        <option value={pinnedPeer.device_pubkey}>
          {offlineLabelFor(pinnedPeer)}
        </option>
      {/if}
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
  /* Offline pin: amber. Distinct from .routed (purple — active) and
     from the unrouted default so a glance tells the user the host
     they picked is currently away. Matches the .rec-paused palette
     used elsewhere. */
  .selector.offline {
    border-color: #5a4220;
    background: #2a1f0e;
    color: #f0c47a;
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
  .selector.offline .kind-dot {
    background: #d4a64a;
    box-shadow: 0 0 5px #d4a64a;
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
