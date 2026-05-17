# Cloud Mesh — Phase 2

Phase 1 (this branch, PR #172) lands the substrate: identity, Network ID,
Trystero transport, bidirectional auth handshake with verification codes,
roster, Move RPC for conversations, and a settings tab with persistent
offline-rostered peers visible in the Connections list. **Two MyOwnLLM
instances with the same Network ID can now find each other, mutually
authenticate, approve, and move conversations between themselves.** That
is the working baseline.

Phase 2 is what turns that baseline into the actual product the README
promises: every device becoming a window into the same mesh, with mic
audio, transcription, and inference flowing across devices based on who
has the capability and who has the user's attention. Phase 2 also covers
the topology + resilience work needed to make the mesh comfortable at
more than a handful of devices.

This doc is for a fresh agent picking up the work after the Phase 1
context has been compacted. Read the existing `src/mesh-client.svelte.ts`,
`src/mesh-protocol.ts`, `src-tauri/src/mesh/`, and the Cloud Mesh
sub-tabs (`src/ui/settings/CloudMesh*.svelte`) before designing — most
of the substrate is in place and Phase 2 builds on top.

---

## What's already done (Phase 1)

- **Identity** — long-lived ed25519 keypair persisted to
  `~/.myownllm/.secrets/identity.json` (0600 / 0700 perms on Unix).
  Device ID surfaced as `pubkey-SUFFIX` where SUFFIX is a 5-char
  uppercase-hex tag derived from `sha256(base32_pubkey_string)`.
  TypeScript mirror in `mesh-protocol.ts::pubkeySuffix`.
- **Network ID** — short human name (`office-mesh`-style, 3–64 chars of
  `[a-z0-9_-]`). Hashed under domain tag `myownllm-network-v1:` to a 52-
  char base32 handle; that's the Trystero room id. The name is what the
  user shares; the handle is what hits the wire.
- **Transport** — Trystero (`joinRoom` + `makeAction("mesh")`). Default
  strategy is Nostr; the Settings tab has a list of relay URLs (empty =
  Trystero defaults) and a disclosure with `docker run` commands for
  self-hosting `strfry` or `nostr-rs-relay`.
- **Auth handshake** — `hello` (pubkey + nonce + label + 6-char
  verification code), `auth_response` (signs peer's nonce under
  `myownllm-mesh-auth-v1:` domain tag), `approve`, `deny`. Bidirectional:
  host (lex-lesser pubkey) prompts first ("X wants to connect"), guest
  prompts second after receiving host's approve ("X authorized you,
  confirm?"). Both sides roster each other on their own approval.
- **Roster** — `~/.myownllm/mesh/roster.json`, per–Network ID. Switching
  Network ID wipes the roster. Auto-allow on reconnect for any pubkey
  the roster contains.
- **Move RPC** — right-click on a Sidebar conversation → "Move to
  device → \<peer\>". Source loads, ships, deletes-on-ack; receiver
  declines duplicates by GUID. Not 2-phase yet; duplicates possible if
  delete fails post-ack.
- **UI** — Settings → Cloud Mesh tab has three sub-tabs (Identity /
  Settings / LAN). Identity has: compact identity card (device body +
  suffix pill + label inline; network id + lock + Generate + Copy),
  thin status bar, Network Requests (with suffix + verification code
  tiles side-by-side for at-a-glance confirmation), Connections
  (showing offline rostered peers too, de-emphasized), Activity log
  (ring-buffered diagnostic events).
- **Settings-attention indicator** — unified primitive
  (`src/settings-attention.svelte.ts`) that the dot on any Settings
  sub-tab subscribes to; lights up on the Cloud Mesh tab when there's
  a pending Network Request.

---

## Phase 2 work, ordered roughly by dependency

### 1. Ring topology with bounded connections

**Why.** Currently Trystero gives us full mesh — every node opens a
WebRTC connection to every other node in the room. Fine for the
2–5 device case; quadratic blow-up at 10+ where weaker devices (Pi,
phone) start dropping under the connection count.

**Design.**

- Maintain a logical "ring neighbors" set per node: up to N peers
  (default 3, configurable). N=1 = leaf (signaling-only via
  neighbors), N≥2 = router-eligible.
- Selection rule (deterministic so peers don't fight): sort all
  authorized + present peers by their pubkey, treat as a ring, take
  the two ring-neighbors (one in each direction) plus the
  lexically-closest non-neighbor that's also under capacity. That
  gives ring redundancy (each node has two ring partners) plus one
  shortcut for routing latency.
- Capacity awareness: each node advertises its `max_connections`
  in `hello` (extended). A node that says "I can hold 8" absorbs
  more of the load when nearby nodes are at their floor of 2.
- Trystero opens its connections eagerly; we can't tell it "don't
  connect to this peer." Instead, after handshake, the non-preferred
  peer is **shelved**: we set its status to `shelved`, send `shelve`
  in the protocol (peer puts us in the same state), and the data
  channel is kept open as a heartbeat-only channel — no app traffic.
  Whenever the preferred set changes (a neighbor goes offline, a
  new peer joins), we re-evaluate and unshelve the right peers.
- Implementation entry point: a new `RingState` class alongside
  `MeshClient` that observes `peers` changes and emits `shelve` /
  `unshelve` messages. `MeshMessage` gains two variants.

**UX.** Shelved peers still show in Connections but with a
"standby" status badge. The user shouldn't have to think about
it — the ring re-balances silently when peers join or leave.

**Open question.** Should shelved peers be closed entirely (saves
WebRTC budget but reconnect latency) or kept idle? Trystero will
re-open dropped peers automatically next time discovery runs, so
close-and-reopen is viable. Start with shelved-but-open; revisit
under measurement.

### 2. Connection resilience & "ring shifting" on churn

**Why.** Currently each onPeerLeave drops the connection state and
the peer either reappears (good) or stays offline (shown as
offline-rostered). The ring needs to actively rebalance when
nodes come and go.

**Design.**

- When a ring-neighbor leaves: walk the next-closest pubkey in the
  ring direction and promote that peer to ring-neighbor (send
  `unshelve`). Update local ring state.
- When a new peer joins and is closer to us in the ring than a
  current shelved peer: shift positions. The peer who's now further
  away gets a `shelve` from us.
- Persist last-known reachable peers (already in roster) so a
  fresh launch can attempt to greet ring-positioned roster entries
  even before Trystero discovery has caught up. This requires a
  small extension: store the last-known peer-id-on-Trystero per
  roster entry as a hint for reconnection. Optional — Trystero
  rediscovers anyway.

**Caveat.** All of this is overlay on top of Trystero. Trystero
itself doesn't care; the shelve/unshelve protocol is application-
layer, used only to gate which connections do useful work.

### 3. Capability advertisement

**Why.** Mic routing, remote inference, remote transcription, file
sharing — each needs to know who in the mesh can serve what. A peer
running on a Pi 5 with no GPU isn't the right target for a Llama-70B
request; a phone isn't where you want to send a transcription job.

**Design.**

- Each node publishes a `Capabilities` blob in `hello` (and on
  change, via a new `capabilities_update` message):

  ```ts
  interface Capabilities {
    /** Loaded LLMs available for remote inference. */
    llms: Array<{ tag: string; family: string; mode: Mode }>;
    /** Available ASR backends + their hardware tier. */
    asr: Array<{ backend: "moonshine" | "parakeet"; tier: string }>;
    /** Available speaker diarization. */
    diarize: boolean;
    /** Hardware fingerprint summary for routing heuristics. */
    hardware: { gpu_type: GpuType; ram_gb: number; vram_gb: number | null };
    /** Sensors / IO surfaces this device exposes for sharing. */
    inputs: { mic: boolean; camera: boolean };
    outputs: { speaker: boolean; display: boolean };
    /** Self-reported workload preference: how willing are we to
     *  accept jobs from peers? "available" / "limited" / "busy". */
    accepting: "available" | "limited" | "busy";
  }
  ```

- Per-peer capabilities cached on `ConnectionState`. UI surfaces
  a small badge row per peer showing what they can do ("LLM",
  "ASR", "mic", "camera"). Mostly informational for v1; routing
  uses it programmatically.

- Capabilities update on local hardware changes (model pull,
  ASR backend swap, mic unplugged). Hook into the existing
  `model-lifecycle` recompute and the cpal device-change
  callback (which we don't currently subscribe to — TODO).

### 4. Mic routing across the mesh

**This is the headline Phase 2 feature.** It's what makes the
mesh feel like the product the README promises: phone audio in,
desktop transcription out.

**Design.**

- The Hardware settings tab's mic picker already lists local
  audio inputs (via `audio_input_devices` Tauri command, backed
  by cpal). Extend the list to include **remote mics** from
  active peers that advertise `inputs.mic: true`. Render them
  with a small device label + peer suffix.
- New config fields on `MicConfig`:
  ```ts
  /** Mic the user picked for this device, in order of preference.
   *  When the first entry is a remote mic and the peer is online,
   *  audio streams from there; if the peer drops, fall back to
   *  `local_default`. */
  current: { kind: "local" | "remote"; device_name: string; peer_pubkey?: string };
  local_default: { device_name: string };
  ```
- Transport: WebRTC **media track**, not the data channel. Trystero
  supports media via `room.addStream(stream, peerId)`. On the
  source device, `getUserMedia({ audio: { deviceId: ... } })`
  followed by `room.addStream(stream, target)`. On the
  consumer side, `room.onPeerStream((stream, peerId) => ...)`.
- The cpal-based transcribe pipeline currently consumes the local
  audio device directly. For remote audio, we need to bridge the
  MediaStream into the cpal stream. Two options:
  - **WebView-side capture** (`MediaRecorder` → chunked PCM →
    Tauri command → cpal stream). Familiar but adds latency.
  - **A separate WebRTC-track-to-PCM path** that bypasses cpal
    entirely and feeds the ASR backend directly via a Rust
    callback. Cleaner but rewrites half the audio plumbing.
  - Pick #1 for v1; benchmark, then decide.
- Failure mode: peer drops mid-transcription. Detect via
  `room.onPeerLeave` (we already handle this), revert
  `current` to `local_default`, log a notice in the
  transcribe UI ("switched to local mic — peer disconnected").

### 5. Remote inference (chat) over the mesh

**Why.** Same shape as mic routing but for LLM responses. A
laptop joins the mesh; suddenly the phone can issue chat
prompts that get answered by the laptop's Gemma rather than
forcing the phone to load its own model.

**Design.**

- New RPC: `infer_request` carrying `{prompt, family, mode, stream:bool}`.
- Receiver runs against its local `ollama` instance and streams
  tokens back via a series of `infer_chunk` messages, terminated
  by `infer_done` or `infer_error`.
- Routing: chat-mode UI gets a "via" picker (default: local). When
  set to a peer, all `ollama_chat_stream` calls in `App.svelte`'s
  chat path are intercepted and routed over the mesh instead.
- Cancellation: `infer_cancel`. The existing
  `ollama_chat_cancel` Tauri command becomes a no-op for
  remote-routed sessions; we send `infer_cancel` to the peer.
- Auth: only peers in the local roster can issue infer requests.
  Adversarial peers in the same room (knowing the Network ID
  isn't enough — they need to have been approved) can't abuse
  a remote inference budget. The auth handshake already
  enforces this; just make sure `infer_request` validation
  rejects non-active peers.

### 6. Remote transcription (the same, for ASR + diarize)

Mirrors mic routing + remote inference. The transcription
pipeline runs on a capable device; the mic-bearing device just
streams audio in and renders transcript out.

**Tricky part.** The diarize state (speaker embeddings,
clustering history) needs to live with the *conversation*, not
the device. Either:
- The conversation lives on the transcription host (Move
  semantics already gives us this), or
- The diarize state is shipped along with the audio stream
  (heavier, more state to sync).

Start with option 1: if you want a conversation transcribed
remotely, **Move it to the device that'll do the work first**,
then route audio. Simplest semantics.

### 7. Catalog gossip + "Network" view

**Why.** Currently the Move-conversation menu lists every
active peer, but a user can't see which peers already host
which conversations. Without a catalog, the user has to keep
the mental map themselves.

**Design.**

- `catalog_announce` is already wired in `mesh-protocol.ts` —
  type defined, never sent or handled. Phase 2 turns it on:
  on every `peerStatus → active` transition, send our local
  conversation catalog (GUIDs + titles + modes + updated_at)
  to the peer. On any local mutation (new conversation, Move
  in / out, rename, delete), broadcast an updated catalog.
- Peer's catalog cached in `ConnectionState.catalog`.
- New view: **Settings → Cloud Mesh → Network** (fourth sub-
  tab) showing a unified list of conversations across the
  mesh: rows are conversations, columns are peers, cell shows
  "host" / "—". Click a cell to Move that conversation there
  (if it's not already there).

### 8. 2-phase Move

The current Move is single-RTT (`offer` → `accept` → `payload`
→ `complete` → source-delete). If receiver dies between writing
and acking, source still has it (duplicate but no loss). If
source dies between ack and delete, both keep it (duplicate).

For 2-phase:
- `move_prepare` (replicated to other peers as a "transfer
  in-flight" marker)
- `move_commit` once receiver has durably written
- `move_finalize` once source has deleted

Worth doing once we have catalog gossip — the in-flight markers
become part of the catalog so other peers see "this is being
moved" rather than two copies.

### 9. File sharing

Once mic routing works, generalize the data-channel layer to
support file sends. RTC data channels have a 16 KB chunk limit
in some browsers; chunking + reassembly + a progress event API.
Same shape as Move-payload but for arbitrary bytes.

### 10. Cleanup and small fixes

- **Diagnostics off button.** The Activity log defaults to
  verbose. Add a toggle to quiet it in steady-state and dump
  to a file on demand.
- **Trystero strategy picker.** Currently we use Nostr (default);
  expose a picker so users can pin to BitTorrent / MQTT / IPFS
  if their network blocks Nostr relays. Trystero strategies are
  per-import — runtime switching means we'd load multiple
  trystero builds. Probably do this as a build-time config
  rather than runtime.
- **Mobile/touch friendliness.** The Cloud Mesh tab UI was
  designed for a desktop window. Phone form factor will need
  the tiles + tabs reflowing.

---

## What NOT to do in Phase 2

- **Don't replace the auth handshake.** It works, it's
  cryptographically solid (ed25519 signatures over
  domain-tagged challenge), and it's bidirectional by design.
  Any "let's just use TLS / Noise / X" rewrite is wasted effort.
- **Don't add a CRDT for catalog/roster yet.** OR-Set with
  signed ops will be useful once we hit multi-network or
  cross-device-edit conflicts, but for Phase 2's scope (single
  user, single mesh, single hosting peer per conversation) the
  simple "broadcast on change, last-write-wins per field"
  model is fine.
- **Don't ship a TURN server.** STUN handles ~95% of NAT
  cases; the remaining 5% (symmetric NAT, both peers behind
  it) is for the user to add their own TURN credentials in
  Settings → Cloud Mesh → Settings. Running a TURN service
  costs real bandwidth and we're not on the hook for it.

---

## Where to start

1. Read `src/mesh-client.svelte.ts` end to end — it's ~900 lines
   but the structure is straightforward (lifecycle → discovery →
   handshake → protocol handlers). The protocol is in
   `mesh-protocol.ts` (~250 lines). Rust side is split across
   `src-tauri/src/mesh/{identity,signing,roster,commands}.rs`.
2. Run the app on two devices, lock the same Network ID, watch
   the Activity panel during connect → approve → move. You'll
   see exactly what events fire in what order.
3. Pick item 1 (ring topology) or item 4 (mic routing) as the
   first lift. Items 2 & 3 follow naturally from 1; items 5–7
   follow naturally from 4. Item 8 is independent and small.
4. Each commit on the same branch (this PR's already large; new
   work likely opens a fresh PR after this one merges).
