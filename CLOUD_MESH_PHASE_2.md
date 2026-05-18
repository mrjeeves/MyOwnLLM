# Cloud Mesh — Phase 2

Phase 1 (PR #172) landed the substrate: identity, Network ID,
Trystero transport, bidirectional auth handshake with verification
codes, roster, Move RPC for conversations, and a settings tab with
persistent offline-rostered peers visible in the Connections list.
**Two MyOwnLLM instances with the same Network ID can now find each
other, mutually authenticate, approve, and move conversations
between themselves.**

Phase 2 (this branch) builds on that substrate: ring topology with
bounded connections, capability advertisement, catalog gossip with a
unified Network view, remote inference over the mesh, 2-phase Move
semantics, an Activity-log quiet toggle, and a per-device accepting
policy. The protocol stays at version 1 — every Phase 2 change is
additive (new optional fields on `hello`, new message kinds), so
v0.2.14 Phase 1 peers and Phase 2 peers can share a mesh without
either side breaking.

This doc is for a fresh agent picking up the work after Phase 2 has
landed. Read the updated `src/mesh-client.svelte.ts`,
`src/mesh-protocol.ts`, `src/mesh-capabilities.ts`,
`src-tauri/src/mesh/`, and the Cloud Mesh sub-tabs
(`src/ui/settings/CloudMesh*.svelte`) before designing further work.
The remaining items below are scoped to mic / transcription / file
routing — the protocol scaffolding is now in place, the lift is the
WebRTC MediaStream bridge and the cpal handoff.

---

## What's already done (Phase 1, recap)

- **Identity** — long-lived ed25519 keypair persisted to
  `~/.myownllm/.secrets/identity.json` (0600 / 0700 perms on Unix).
  Device ID surfaced as `pubkey-SUFFIX` where SUFFIX is a 5-char
  uppercase-hex tag derived from `sha256(base32_pubkey_string)`.
  TypeScript mirror in `mesh-protocol.ts::pubkeySuffix`.
- **Network ID** — short human name (`office-mesh`-style, 3–64 chars
  of `[a-z0-9_-]`). Hashed under domain tag `myownllm-network-v1:`
  to a 52-char base32 handle; that's the Trystero room id. The name
  is what the user shares; the handle is what hits the wire.
- **Transport** — Trystero (`joinRoom` + `makeAction("mesh")`).
  Default strategy is Nostr; the Settings tab has a list of relay
  URLs (empty = Trystero defaults) and a disclosure with `docker
  run` commands for self-hosting `strfry` or `nostr-rs-relay`.
- **Auth handshake** — `hello` (pubkey + nonce + label + 6-char
  verification code), `auth_response` (signs peer's nonce under
  `myownllm-mesh-auth-v1:` domain tag), `approve`, `deny`.
  Bidirectional: host (lex-lesser pubkey) prompts first ("X wants
  to connect"), guest prompts second after receiving host's approve
  ("X authorized you, confirm?"). Both sides roster each other on
  their own approval.
- **Roster** — `~/.myownllm/mesh/roster.json`, per–Network ID.
  Switching Network ID wipes the roster. Auto-allow on reconnect
  for any pubkey the roster contains.
- **Move RPC** — right-click on a Sidebar conversation → "Move to
  device → \<peer\>". Source loads, ships, deletes-on-ack; receiver
  declines duplicates by GUID.
- **UI** — Settings → Cloud Mesh tab has sub-tabs (Status /
  Connections / Settings / HTTP). Status drives a wizard from
  fresh → drafted → starting → solo → approvals → online, with the
  compact identity card + lock controls inside the wizard body and
  pending Network requests + the Activity log below. Connections
  holds the live mesh surface: the Ring (auto-healing active set),
  Indirect (shelved + offline), Resources in use (live in/out
  inferences + moves), and the Catalog grid. Settings is the
  signaling / STUN / TURN config. HTTP (previously "LAN") is the
  axum-served browser UI for phones / tablets.
- **Settings-attention indicator** — unified primitive
  (`src/settings-attention.svelte.ts`) that the dot on any Settings
  sub-tab subscribes to; lights up on the Cloud Mesh tab when
  there's a pending Network Request.

---

## What's done in Phase 2

### ✅ Ring topology with bounded connections

`selectRingNeighbors` in `mesh-protocol.ts` is the pure selector.
Each node computes the same ring (sort all authorized + present
pubkeys lex; treat as a ring; take the two immediate neighbors plus
the closest non-neighbor under capacity) and emits `shelve` /
`unshelve` for peers that crossed states. Both ends pick each other
symmetrically because the input — the sorted pubkey set — is
deterministic.

- Default `n_preferred = 3` (`RING_DEFAULT_PREFERRED`). At or below
  3 active peers the selector returns the full set: a 2-laptop home
  mesh and a 3-device office stay fully connected, shelving is a
  non-event until the mesh genuinely grows.
- Floor of `RING_MIN_PREFERRED = 2` ensures the ring stays
  connected end-to-end even if a peer advertises a smaller
  `max_connections`.
- Shelved peers stay open as heartbeat-only — the Trystero data
  channel is kept warm so an `unshelve` can flip them back to
  active without re-doing WebRTC setup. UI status: `shelved`,
  shown as `standby` in the Connections card.
- Re-evaluation fires on every `maybePromoteToActive` (peer
  becomes active) and every `dropConnection` (peer leaves), which
  is exactly when the ring needs to rebalance.

### ✅ Connection resilience & ring shifting on churn

`reevaluateRing` runs after every connection lifecycle event, so a
joining or leaving peer triggers shelve/unshelve cascades right
away. The pre-existing wake-from-suspend / re-handshake / forced
rediscovery paths from Phase 1 still apply unchanged — the ring is
overlay logic on top of Trystero's connection state.

### ✅ Capability advertisement

`Capabilities` (in `mesh-protocol.ts`) carries LLMs, ASR backends,
diarize support, hardware fingerprint, input/output sensors, and
the self-reported accepting policy. Sent in `hello` and
re-broadcast as `capabilities_update` whenever the snapshot
changes. The snapshot is computed by `snapshotCapabilities` in
`mesh-capabilities.ts` against `detect_hardware`,
`ollama_list_models`, `asr_models_list`, `diarize_models_list`,
and `audio_input_devices`.

- The Cloud Mesh → Status tab has an `accepting` dropdown in the
  Activity block:
  `available` / `limited` / `busy`. Set to `busy`, the device
  refuses incoming `infer_request` messages and is filtered out
  of peer-side routing pickers.
- Capability changes hook into `onModeSwap` in `App.svelte` (model
  warmed) and could extend further to a device-change watcher on
  cpal in the future. Each callsite simply calls
  `meshClient.noteCapabilitiesChanged()`.
- Connections list shows a `LLM` / `ASR` / `mic` / `busy` /
  `limited` badge row under each active peer plus a one-line
  hardware summary (`Pi 5 · 4 GB RAM`, etc.).

### ✅ Catalog gossip + sidebar integration + Pull

`catalog_announce` is wired both ways. On every
`maybePromoteToActive` we send our current catalog to the
just-active peer, and `App.svelte`'s `refreshConversations` calls
`meshClient.noteCatalogChanged()` after each mutation — that
collapses into a debounced broadcast within `CATALOG_DEBOUNCE_MS`
(1.5 s). A 60 s safety-net refresh catches out-of-band mutations
that bypass the save path.

The catalog renders **directly in the main sidebar**: each
connected peer becomes an expandable group under a "Network"
divider with their hosted conversations as child rows.
`CatalogEntry` carries the source's folder `path` so the peer's
folder structure renders verbatim on the receiver side — same
folder/conversation tree shape as the local sidebar, recursively.
The peer's "Work/Projects/Q4" appears as nested expandable folders
on every connected device, not as a flat list of titles.

Right-click menu on a remote conversation → **← Pull from \<peer\>**
which sends a `move_request` to the source. The source validates
the requester is `active`-state (mutually authenticated + rostered),
then drives the regular Move handshake (`move_offer` → `accept`
→ `payload` → `complete`) with the requester as the destination.
On failure (conversation not found, requester not authorized,
move in flight) the source replies `move_request_decline`.

`move_payload` now echoes the source folder back in `target_folder`,
so a pulled or pushed conversation lands in the same folder on the
receiver (creating intermediate folders if needed). What you saw in
the sidebar is what you get on disk — Pull `peer-A/Work/Q4 planning`
and it shows up under your own `Work/` folder, not in root.

Right-click on a local conversation still shows the existing
**Push to device → \<peer\>** submenu (renamed from "Move to
device" for symmetry with Pull). Right-click on a peer name in
the sidebar opens **Cloud Mesh → Connections** via the
`settings-route.svelte.ts` shared store — Chat / TranscribeView
both subscribe to the route signal and open their settings panel
on the requested tab + sub-tab.

The `CloudMeshConnections.svelte` sub-tab no longer renders the
catalog grid (that role moved to the sidebar). What remains:

- **Ring** section — active peers our local selector is routing
  through, auto-healed on every join / leave
- **Indirect** section — shelved + offline rostered peers
- **Resources in use** — live `→` outbound and `←` inbound rows
  for every in-flight inference and Move

Each ring / indirect peer row surfaces a capability summary +
badges (LLM, ASR, mic, busy / limited) so the user can see at a
glance what each peer can do.

### ✅ Remote inference (chat) over the mesh

`infer_request` / `infer_chunk` / `infer_done` / `infer_error` /
`infer_cancel` are the five new message kinds. The Chat view has a
new "via" picker just above the input row — when set to a peer,
`doSend` routes through `meshClient.sendInferRequest` instead of
the local `ollama_chat_stream` invoke. The peer's mesh client
serves the request by:

1. Validating that the requester is in `active` state (roster
   peer who's authenticated, not just a stranger in the same
   Trystero room).
2. Checking local accepting policy isn't `busy`.
3. Picking a locally-pulled tag that matches the requested
   family/mode (or any LLM if no match).
4. Subscribing to `myownllm://chat-stream/<id>` and forwarding
   each frame as `infer_chunk` over the data channel.
5. Sending a terminal `infer_done` on natural end or cancel.

The "via" picker is hidden when no peer is reachable for
inference, so single-device users never see it. The Stop button
sends `infer_cancel` over the channel.

### ✅ 2-phase Move

`move_prepare` / `move_commit` / `move_abort` are broadcast to
every active peer (not just the destination). The catalog UI
reads them as `pending_move=true` on the source row instead of
flickering between two copies during the transfer window. The
existing direct `move_offer` → `accept` → `payload` → `complete`
exchange between source and destination still drives content
delivery; the broadcast is purely advisory.

Source side: `moveConversation` calls `broadcastMovePrepare`
before sending the offer; `handleMoveComplete` calls
`broadcastMoveCommit` after the local delete. Receiver:
`handleMovePayload` calls `broadcastMoveCommit` after a
successful write. Both sides clear the flag and broadcast
`move_abort` on failure paths.

### ✅ Saved networks + always-visible sidebar Network section

The mesh model is "one active network at a time" but the user can
save several (`home-mesh`, `office-mesh`, `camping-mesh`) and swap
which is active with one click. Each saved network keeps its own
roster file + per-network settings (signaling, STUN, TURN,
accepting policy) so switching back to a previously-used network
skips re-authentication and reuses the chosen relay set. This sets
up the foundation for automatic resource allocation, which depends
on a well-defined "current network" surface.

**Config shape (`cloud_mesh`):**
- `networks: NetworkConfig[]` — saved entries, each with a stable
  internal `id`, canonical `network_id` (which IS the display
  name — no separate label field), `locked` flag, per-network
  signaling / STUN / TURN, and per-network `accepting` policy.
  The Network ID isn't a secret: anyone using the same handle
  lands in the same room and can knock (you'll see their
  request), but joining still requires approval. "Pick a more
  unique handle if you're seeing stranger requests" is the
  intended remedy.
- `active_network_id: string | null` — id of the currently-joined
  network. Null = mesh client stays off.
- `diag_quiet` stays global (it's a UI preference, not a per-
  network policy).

The legacy single-network shape is migrated on load: a `network_id`
+ `locked` + signaling/STUN/TURN at the top level becomes a single-
element `networks: []` array with the same fields, and
`active_network_id` is pointed at it so the user's previous network
stays live across the upgrade.

**Roster files (`src-tauri/src/mesh/roster.rs`):**
Per-network at `~/.myownllm/mesh/rosters/{network_id}.json`.
`load`, `save`, `add_peer`, `remove_peer` all operate on a single
network's file; new `delete(network_id)` wipes one. The legacy
single `roster.json` is migrated on first read of any network ID,
keyed by its self-reported `network_id` field, then removed. New
`mesh_roster_delete` Tauri command exposes the deletion to the UI's
"Forget network" flow.

**mesh-client:**
- `reconcile` reads the active network instead of top-level fields
  and joins (or stops) accordingly. Switching the active network
  triggers an automatic stop + start.
- `setAccepting` persists onto the active network only (no-op
  when none active).
- `start` snapshots accepting from the active network so the very
  first `hello` carries the right value.

**Config helpers (`src/config.ts`):**
`activeNetwork(cfg)`, `addNetwork(init, opts)`,
`updateNetwork(id, patch)`, `removeNetwork(id)`,
`setActiveNetwork(id)`. Each persists through `updateConfig` and
returns the updated `Config`.

**UI:**
- **Sidebar** always renders a "Network" section at the bottom with
  the saved networks list + an "+ Add" button. The active network
  is highlighted with a green left-border and expanded to show its
  connected peers (and their conversation trees). Inactive networks
  are collapsed; click the header to switch. Right-click → switch /
  settings / forget. Right-click peer → settings.
- **Status tab** wizard scopes to the active network. When no
  active network is set, the wizard reads "No active network" and
  points the user at the saved-networks list below + the + Add
  Network button. Per-saved-network row: Switch + Forget.
- **Settings tab** (Addresses) gets a network picker so the user
  can edit a non-active network's signaling/STUN/TURN without
  switching to it first.

**Add Network modal (`AddNetworkModal.svelte`):**
Shared between the Sidebar's "+ Add" and the Status tab's "+ Add
network" buttons. Single Network ID input (with Generate button
for a 52-char hash) — no separate label, because the Network ID
IS the display name. Three save modes: Save (don't activate),
Save & activate (activate, don't lock), Save & start (activate +
lock = start joining immediately, ⌘/Ctrl + Enter shortcut).
Inline hint explains the "not a secret" semantics.

### ✅ Diagnostics off button

The Activity panel has a `quiet logs` checkbox next to the
`accepting` dropdown. When checked, `logDiag` becomes a no-op for
`info` events — warnings and errors still land in the ring buffer.
Persisted via `cloud_mesh.diag_quiet` in config so a relaunch
retains the preference.

---

## What's NOT done in Phase 2 — follow-up items

The headline pieces from the original Phase 2 doc that still
need work, plus where the half-done pieces sit:

### Mic routing across the mesh (#4 from the original doc)

**Status:** capability + UX scaffolding ready; the actual WebRTC
MediaStream → cpal bridge is the remaining lift.

- Capabilities now advertise `inputs.mic` per device.
- Trystero's `room.addStream(stream, peerId)` and
  `room.onPeerStream((stream, peerId) => …)` are typed in the
  Trystero version we pin (0.24.0) and ready to use.
- Two paths from there:
  1. **WebView-side capture** (`MediaRecorder` → chunked PCM
     → Tauri command → cpal stream). Familiar but adds latency.
  2. **WebRTC-track-to-PCM** that bypasses cpal entirely and
     feeds the ASR backend directly via a Rust callback.
- Pick #1 for v1; benchmark before considering #2. The risk is
  that path #1 has Linux/Windows variability in WebView audio
  capabilities that need real-device testing.
- Mic dropdown UX: extend `Hardware → Microphone` to include
  remote mics from `peers` where `capabilities.inputs.mic` is
  true. `MicConfig` gains a new `current: { kind: "local"
  | "remote"; device_name: string; peer_pubkey?: string }`
  field (and `local_default` to fall back to when the peer
  drops). Wire in `TranscribeView.svelte`'s mic picker.

### Remote transcription (#6 from the original doc)

Depends on mic routing. Same pattern as remote inference: an
`asr_request` RPC, stream `asr_chunk` frames back. The diarize
state needs to live with the conversation — start with "Move
the conversation to the transcription host first, then route
audio" (option 1 from the original doc).

### File sharing (#9 from the original doc)

Once the data channel layer handles arbitrary bytes (chunking +
reassembly + progress events), drop it in. Same shape as the
existing Move-payload but for arbitrary files.

### Trystero strategy picker (#10 from the original doc)

Currently we use Nostr (default). Trystero strategies are
per-import — runtime switching means loading multiple trystero
builds. Probably do this as a build-time config rather than
runtime; document the alternate strategies (`trystero/torrent`,
`trystero/mqtt`, `trystero/ipfs`) in DOCS.md so power users can
fork and rebuild.

### Mobile / touch friendliness (#10 from the original doc)

The Cloud Mesh tab UI was designed for a desktop window. Phone
form factor will need the tiles + tabs reflowing. The Network
sub-tab's grid in particular needs a card-stack mode for narrow
viewports.

---

## What NOT to do in Phase 2 follow-up

- **Don't replace the auth handshake.** It works, it's
  cryptographically solid (ed25519 signatures over
  domain-tagged challenge), and it's bidirectional by design.
  Any "let's just use TLS / Noise / X" rewrite is wasted effort.
- **Don't add a CRDT for catalog/roster yet.** OR-Set with
  signed ops will be useful once we hit multi-network or
  cross-device-edit conflicts, but the simple
  "broadcast on change, last-write-wins per field" model is
  fine for the current scope (single user, single mesh, single
  hosting peer per conversation).
- **Don't ship a TURN server.** STUN handles ~95% of NAT
  cases; the remaining 5% (symmetric NAT, both peers behind
  it) is for the user to add their own TURN credentials in
  Settings → Cloud Mesh → Settings. Running a TURN service
  costs real bandwidth and we're not on the hook for it.
- **Don't bump `PROTOCOL_VERSION` for additive changes.** The
  version stays at 1 across all Phase 2 work because every
  change is additive (new optional fields, new message kinds
  that v1 receivers silently drop in the default `switch`
  arm). Bump only when an existing message's wire shape
  changes incompatibly. This lets a v0.2.14 (Phase 1) peer
  and a Phase 2 peer share a mesh, with the v1 side simply
  not seeing the ring shelving / remote inference / catalog
  niceties.

---

## Where to start (follow-up work)

1. Read `src/mesh-client.svelte.ts` end to end — it's ~1900 lines
   now but the structure is the same as Phase 1 (lifecycle →
   discovery → handshake → protocol handlers). The new bits group
   under section headings (`// ---- capabilities ----`,
   `// ---- ring topology ----`, `// ---- catalog gossip ----`,
   `// ---- remote inference ----`). The protocol is in
   `mesh-protocol.ts` and the capability snapshot in
   `mesh-capabilities.ts`.
2. Run two instances locally, lock the same Network ID, watch
   the Activity panel during connect → approve → catalog
   announce → move. The Connections sub-tab fills in once both
   sides flip to `active`.
3. For mic routing, start by extending `MicConfig` with the new
   `current` shape, hooking `room.addStream` on the source
   device and `room.onPeerStream` on the receiver. Get the
   stream into a `MediaRecorder` first to prove end-to-end
   audio delivery before tackling the cpal bridge.
4. Each major area opens its own PR on top of this one.
