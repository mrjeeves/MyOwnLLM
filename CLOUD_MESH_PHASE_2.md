# Cloud Mesh — Phase 2

Phase 1 (PR #172) landed the substrate: identity, Network ID,
Trystero transport, bidirectional auth handshake with verification
codes, roster, and Move RPC. Phase 2 (this branch, PR #174) turns
that substrate into the actual mesh product — ring topology, peer
capability advertisement, catalog gossip integrated into the main
sidebar, remote inference + pull/push moves with folder
preservation, and a multi-network model where the user can save
and switch between several meshes with one click.

This doc is for a fresh agent picking up the work after Phase 2
has landed. Read the updated `src/mesh-client.svelte.ts`,
`src/mesh-protocol.ts`, `src/mesh-capabilities.ts`, `src/config.ts`
(multi-network helpers), `src-tauri/src/mesh/roster.rs` (per-
network roster files), and the Networks sub-tabs
(`src/ui/settings/CloudMesh*.svelte`) before designing further.

The remaining items below are scoped to mic / transcription / file
routing — the protocol scaffolding is in place, the lift is the
WebRTC MediaStream bridge and the cpal handoff.

---

## What's in Phase 2

### ✅ Ring topology with auto-healing

`selectRingNeighbors` in `mesh-protocol.ts` is the pure selector.
Each node sorts all authorized + present pubkeys, treats them as a
ring, and takes both immediate ring-neighbors plus the closest
non-neighbor under capacity. Both ends pick each other
symmetrically because the input — the sorted pubkey set — is
deterministic.

- Default `n_preferred = 3` (`RING_DEFAULT_PREFERRED`); at or
  below that, the selector returns the full set so small meshes
  stay full-mesh.
- Floor of `RING_MIN_PREFERRED = 2` keeps the ring connected.
- Shelved peers stay open as heartbeat-only — the Trystero data
  channel is kept warm so an `unshelve` can flip them back to
  active without re-doing WebRTC setup.
- `reevaluateRing` runs on every `maybePromoteToActive` (peer
  becomes active) and every `dropConnection` (peer leaves), so a
  join or leave triggers shelve/unshelve cascades immediately.

### ✅ Capability advertisement

`Capabilities` (in `mesh-protocol.ts`) carries LLMs, ASR backends,
diarize support, hardware fingerprint, input/output sensors, and
the self-reported accepting policy. Sent in `hello` and
re-broadcast as `capabilities_update` whenever the snapshot
changes (`snapshotCapabilities` in `mesh-capabilities.ts`).
Connections list shows `LLM` / `ASR` / `mic` / `busy` /
`limited` chips per peer plus a one-line hardware summary.

### ✅ Catalog gossip + sidebar integration

`CatalogEntry` carries `guid`, `title`, `mode`, `updated_at`,
optional `pending_move`, and optional `path` (folder location on
the host). Sent via `catalog_announce` on every peer-active flip
and re-broadcast after every conversation mutation via
`meshClient.noteCatalogChanged()` (debounced 1.5 s). 60 s
safety-net refresh catches mutations that bypass the save path.

The catalog renders **directly in the main sidebar**: each
connected peer becomes an expandable group under the Networks
section, with the peer's hosted conversations rendered using the
host's folder structure (intermediate folders materialize
automatically so deep paths like `Work/Projects/Q4` show up
verbatim).

### ✅ Pull + Push with folder preservation

`move_request { id, guid }` + `move_request_decline { id, reason }`
are the Pull RPC. Requester sends → source validates the
requester is `active`-state + the conversation exists → source
drives the regular `move_offer` / `accept` / `payload` / `complete`
flow with the requester as the destination.

`move_payload.target_folder` echoes the source's folder so the
receiver saves into the same path (creating intermediate folders
as needed). What you see in the sidebar is what you get on disk
— Pull `peer-A/Work/Q4 planning` and it lands under your own
`Work/` folder, not in root.

Sidebar context menus:
- **Local conversation** → Push to device → \<peer\>
- **Remote conversation** → ← Pull from \<peer\>
- **Peer name** → Settings (opens Networks → Connections)
- **Network row** → Switch to / Settings / Forget

### ✅ Remote inference

Five message kinds: `infer_request`, `infer_chunk`, `infer_done`,
`infer_error`, `infer_cancel`. The Chat compose row has a "via:"
picker — when set to a peer, `doSend` routes through
`meshClient.sendInferRequest` instead of the local
`ollama_chat_stream` invoke. The peer subscribes to its own
`myownllm://chat-stream/<id>` event bus and forwards each frame.
Authorization gate: only `active` (rostered + mutually
authenticated) peers can issue requests.

### ✅ 2-phase Move broadcast

`move_prepare` / `move_commit` / `move_abort` broadcast to every
active peer so the Network view shows `moving…` instead of
flickering between two copies during a transfer. The direct
offer/accept/payload/complete exchange between source and
destination still drives content delivery; the broadcast is
purely advisory.

### ✅ Multi-network with one active at a time

The user can save several mesh networks (home-mesh, office-mesh,
camping-mesh) and switch between them with one click. Only one
is joined at a time, but each keeps its own roster + per-network
settings so switching back skips re-authentication. This sets up
the foundation for automatic resource allocation, which depends
on a well-defined "current network."

**Config shape (`cloud_mesh`):**
- `networks: NetworkConfig[]` — saved entries. Each has a stable
  internal `id`, canonical `network_id` (which IS the display
  name — no separate label field, since two parallel names
  confuses), `locked` flag, per-network `signaling_servers`,
  `stun_servers`, `turn_servers`, and `accepting` policy.
- `active_network_id: string | null` — id of the currently-
  joined network. Null = mesh client stays off.
- `diag_quiet: boolean` — global UI preference, not per-network.

The Network ID isn't a secret: anyone using the same handle
lands in the same room and can knock (the user sees their
request), but joining still requires approval. "Pick a more
unique handle if you're seeing stranger requests" is the
intended remedy — surfaced inline on the Status tab when 3+
pending requests pile up.

**Legacy migration:** the pre-multi-network flat shape
(`network_id` + `locked` + signaling/STUN/TURN/accepting at
top level) is detected on load and migrated into a single-
element `networks[]` with the same fields and
`active_network_id` pointing at it. The user's previous network
stays live across the upgrade.

**Per-network roster files** (`src-tauri/src/mesh/roster.rs`):
`~/.myownllm/mesh/rosters/{network_id}.json`. `load`, `save`,
`add_peer`, `remove_peer` operate on a single network's file;
new `delete(network_id)` wipes one (used by Forget). A legacy
single `roster.json` is migrated on first read of any network
ID, keyed by its self-reported `network_id` field, then removed.
New `mesh_roster_delete` Tauri command exposes the deletion to
the UI.

**mesh-client:**
- `reconcile` reads `activeNetwork(cfg)` and joins (or stops) its
  room. Switching the active network triggers stop + start.
- `setAccepting` persists onto the active network only (no-op
  when none active).
- `start` snapshots accepting from the active network so the
  very first `hello` carries the right value.

**Config helpers (`src/config.ts`):**
`activeNetwork(cfg)`, `addNetwork({network_id}, {activate?,
locked?})`, `updateNetwork(id, patch)`, `removeNetwork(id)`,
`setActiveNetwork(id)`. `addNetwork` de-dupes by `network_id`:
re-adding a saved network is a no-op (and switches to it when
`activate: true`), matching user intent.

**UI surface (after the final iteration):**

The settings tab is labeled **Networks** (was "Cloud Mesh"; the
internal id stays `cloud-mesh`). Five sub-tabs:

- **Status** — identity card (label + suffix + dim device_id on
  one line); status pill row with accepting dropdown inline;
  saved-networks list (active row gets a lock toggle, others get
  Switch + Forget); pending Network requests when present.
  Wizard-style step derivation removed — the status pill is the
  single source of "what's the mesh doing."
- **Connections** — Ring (active routed peers, auto-heals);
  Indirect (shelved + offline rostered); Resources in use (live
  inference + move rows).
- **Activity** — ring-buffered diagnostic log + quiet-logs toggle.
  Moved off Status so steady-state chatter doesn't crowd the
  controllable surfaces.
- **Settings** — per-network signaling/STUN/TURN with a picker so
  the user can edit a non-active network's transport without
  switching to it first.
- **HTTP** (previously "LAN") — the axum-served browser UI.

**Sidebar:** Always-visible "Networks" section at the bottom of
the conversation list with a small settings gear that opens
Settings → Networks → Status (the canonical place to manage
saved networks). Active network has a green left-border and is
expanded by default to show its connected peers + their
conversation trees. Inactive networks dimmed and clickable to
switch. Right-click → switch / settings / forget. Right-click
peer → settings.

**Add Network modal (`AddNetworkModal.svelte`):**
Mounted from the Status tab's "+ Add network" button. Single
Network ID input (with Generate button for a 52-char hash) — no
separate label field. Three save modes: Save (don't activate),
Save & activate (activate, don't lock), Save & start (activate
+ lock, ⌘/Ctrl + Enter shortcut).

### ✅ Diagnostics off button

Quiet-logs checkbox on the Activity tab. When checked, `logDiag`
becomes a no-op for `info` events — warnings + errors still land
in the ring buffer. Persisted via global `cloud_mesh.diag_quiet`.

---

## Persistence layout

```
~/.myownllm/
├── .secrets/
│   └── identity.json    (ed25519 keypair; 0600 on Unix)
├── config.json          (cloud_mesh.networks[] + active_network_id)
└── mesh/
    └── rosters/
        ├── home-mesh.json    (per-network approved peers; 0600 on Unix)
        ├── acme-office.json
        └── ...
```

Identity is one keypair across every network. Rosters are per-
network — switching between saved networks preserves their
rosters independently.

---

## What's NOT done in Phase 2 — follow-up items

### Mic routing across the mesh

**Status:** capability + UX scaffolding ready; the actual WebRTC
MediaStream → cpal bridge is the remaining lift.

- Capabilities advertise `inputs.mic` per device.
- Trystero's `room.addStream(stream, peerId)` and
  `room.onPeerStream((stream, peerId) => …)` are typed in the
  Trystero version we pin (0.24.0) and ready to use.
- Two paths from there:
  1. **WebView-side capture** (`MediaRecorder` → chunked PCM
     → Tauri command → cpal stream). Familiar but adds latency.
  2. **WebRTC-track-to-PCM** that bypasses cpal entirely and
     feeds the ASR backend directly via a Rust callback.
- Pick #1 for v1; benchmark before considering #2.
- Mic dropdown UX: extend `Hardware → Microphone` to include
  remote mics from peers where `capabilities.inputs.mic` is
  true. `MicConfig` gains a new `current: { kind: "local" |
  "remote"; device_name: string; peer_pubkey?: string }` field
  (and `local_default` to fall back to when the peer drops).

### Remote transcription

Depends on mic routing. Same pattern as remote inference: an
`asr_request` RPC, stream `asr_chunk` frames back. Start with
"Move the conversation to the transcription host first, then
route audio" to side-step diarize-state-with-conversation
questions.

### File sharing

Once the data channel layer handles arbitrary bytes (chunking +
reassembly + progress events), drop it in. Same shape as
Move-payload but for arbitrary files.

### Trystero strategy picker

Currently Nostr (default). Strategies are per-import — runtime
switching means loading multiple trystero builds. Probably do
this as a build-time config rather than runtime.

### Mobile / touch friendliness

The Networks tab UI was designed for a desktop window. Phone
form factor will need the tiles + tabs reflowing.

### Wizard ergonomics

The Status tab dropped its step-derived wizard in favor of a
single status pill + inline controls. If onboarding tests show
new users still get stuck, consider re-adding a "What to do
next" coachmark anchored to the status pill — the step copy
that used to live in the wizard body is gone but the underlying
state machine (idle / drafted / starting / solo / approvals /
online / error) is recoverable from `statusPill.tone + active +
meshClient.status`.

---

## What NOT to do in Phase 2 follow-up

- **Don't replace the auth handshake.** It works, it's
  cryptographically solid (ed25519 signatures over
  domain-tagged challenge), and it's bidirectional by design.
- **Don't add a CRDT for catalog/roster yet.** OR-Set with
  signed ops will be useful eventually but "broadcast on
  change, last-write-wins per field" is fine for current scope.
- **Don't ship a TURN server.** STUN handles ~95% of NAT
  cases; the remaining 5% is for the user to add their own
  TURN credentials in Networks → Settings → TURN servers.
- **Don't add multi-network at the same time.** The user
  explicitly chose "single active network, save and switch."
  That's what unlocks future automatic resource allocation —
  which depends on a single well-defined "current network."
- **Don't add a separate label field on `NetworkConfig`.** The
  Network ID IS the display name. Two parallel names was
  attempted in an earlier draft of this PR and reverted — the
  user reads one handle, peers see one handle, the sidebar
  shows one handle. Confusion-free.
- **Don't bump `PROTOCOL_VERSION` for additive changes.** The
  version stays at 1 across all Phase 2 work because every
  change is additive. A v0.2.14 (Phase 1) peer and a Phase 2
  peer can share a mesh, with the v1 side simply not seeing
  the ring shelving / remote inference / catalog niceties.

---

## Where to start (follow-up work)

1. Read `src/mesh-client.svelte.ts` end to end — it's ~2200
   lines but the structure groups under section headings
   (`// ---- capabilities ----`, `// ---- ring topology ----`,
   etc.). The protocol is in `mesh-protocol.ts` (~500 lines),
   capability snapshot in `mesh-capabilities.ts`, multi-
   network helpers in `src/config.ts`.
2. Run two instances locally on the same Network ID, watch
   the Activity tab during connect → approve → catalog
   announce → move → pull. The sidebar Networks section
   fills in once both sides flip to `active`.
3. For mic routing, start by extending `MicConfig` with the
   new `current` shape, hooking `room.addStream` on the source
   device and `room.onPeerStream` on the receiver. Get the
   stream into a `MediaRecorder` first to prove end-to-end
   audio delivery before tackling the cpal bridge.
4. Each major area opens its own PR on top of this one.
