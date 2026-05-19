# Cloud Mesh Connection Engine

The mesh's job: keep N MyOwnLLM devices reachable to each other across NAT,
network blips, OS sleep, and rate-limited public relays — without flooding
the network, without losing the user's roster, and without requiring a
restart to apply settings.

This document is the spec for how that's done and the guarantees the engine
provides. If you're changing anything in `src/mesh-client.svelte.ts` or the
files it owns, this is the source-of-truth contract.

The implementation lives in:

| File                            | Role                                              |
|---------------------------------|---------------------------------------------------|
| `src/mesh-client.svelte.ts`     | Connection engine. The whole 4-layer model.       |
| `src/mesh-scheduler-worker.ts`  | Worker-side periodic ticker (wake-honest clock).  |
| `src/mesh-protocol.ts`          | Wire-format envelope + crypto helpers.            |
| `src/mesh.ts`                   | Tauri command bindings (identity, network IDs).   |
| `src/mesh-state.svelte.ts`      | UI-only reactive state for the Settings tab.      |
| `src-tauri/src/mesh/*.rs`       | Rust side: identity, roster, signing.             |

## The four layers

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │ Layer 4 · App protocol                                              │
 │   ping/pong · catalog_announce · capabilities_update                │
 │   infer · move · file · transcribe · session                        │
 │   Single 30s heartbeat tick (scheduler worker)                      │
 └────────────────────────────▲────────────────────────────────────────┘
                              │
 ┌────────────────────────────┴────────────────────────────────────────┐
 │ Layer 3 · Cryptographic handshake                                   │
 │   hello → auth_response (ed25519 sig over nonce + both pubkeys)     │
 │   30s watchdog · 4 hello sends (0s/5s/12s/22s)                      │
 │   Approver role = lex-lesser pubkey                                 │
 └────────────────────────────▲────────────────────────────────────────┘
                              │
 ┌────────────────────────────┴────────────────────────────────────────┐
 │ Layer 2 · WebRTC + ICE                                              │
 │   STUN candidates · TURN relay candidates                           │
 │   Per-PC iceconnectionstatechange listener                          │
 │   onJoinError = terminal pending-handshake failure                  │
 │   `recent_ice_failure_at` drives Settings TURN banner               │
 └────────────────────────────▲────────────────────────────────────────┘
                              │
 ┌────────────────────────────┴────────────────────────────────────────┐
 │ Layer 1 · Signaling (Trystero / Nostr)                              │
 │   redundancy 8 default (or user-supplied relay list)                │
 │   `getRelaySockets()` polled every 10s                              │
 │   EVENT-author counting distinguishes "alone" vs "peer present"     │
 │   `isSignalingHealthy()` = ≥1 relay socket OPEN                     │
 └─────────────────────────────────────────────────────────────────────┘
```

Each layer is observable independently — that's what makes the engine
diagnosable. The `phase` field publishes the worst (or most actionable)
layer's state to the UI as a single enum.

## The reconnection ladder

Six escalating recovery mechanisms. Each is strictly cheaper than the next
and only fires when the cheaper one has been ruled out:

| Tier | Trigger                                              | Action                                        | Schedule (jittered ±20%)              |
|------|------------------------------------------------------|-----------------------------------------------|---------------------------------------|
| 1    | App-level message arrives                            | Reset `last_recv_at`                          | Continuous                            |
| 2    | Wake event (lifecycle OR tick gap)                   | Ping all + 1.5s probe                         | Coalesced to 2s window                |
| 3    | Wake probe: ALL peers silent                         | `pc.restartIce()` per PC + 4s recovery window | Once per wake (auto-falls to Tier 4)  |
| 4    | Silence > 75s OR wake probe + ICE restart failed     | Per-peer re-handshake (hello)                 | 2s, 5s, 10s, 20s, 30s (per peer)      |
| 5    | 3 re-handshakes failed OR rostered peer offline 60s+ | Trystero room rejoin                          | 90s, 3m, 5m, 10m (global, throttled)  |
| 6    | Active network changed OR transport config edited    | Stop + Start                                  | Immediate                             |

**Tier 3 is the network-swap layer.** When the OS jumps interfaces (phone
hotspot↔home Wi-Fi, ethernet plugged/unplugged), the local IPs that ICE
candidate pairs were anchored to vanish and every PC goes silent. The
naive recovery — tear down the room and rebuild — is wildly disproportionate:
the relay sockets reconnect on their own through the new interface, both
sides' auth state is intact, and the only thing actually broken is the
candidate pairs. So Tier 3 calls `pc.restartIce()` on each silent peer's
RTCPeerConnection; Trystero's own `onnegotiationneeded` handler ferries
the fresh offer/answer through the still-up signaling, new candidates form
on whatever interface is now reachable, and the datachannel resumes with
all app state preserved. The other side doesn't fire `peer-leave` and
doesn't reset auth — it just sees a brief ICE flap. With three devices,
the device that swapped networks restarts ICE on its two PCs while the
other two devices' connection to each other never blinks.

The Tier 3 → Tier 5 fallback is automatic: if no peer pongs within
`ICE_RESTART_RECOVERY_MS` after the restart kick, the wake-probe path
escalates to `maybeForceRediscovery`. Total wake-to-rejoin latency stays
short (~5.5s) so a user who really does need a full rebuild isn't left
staring at a frozen UI.

**Tier 5 is gated by `hasActivePeer()`.** If at least one peer is in
`active` status, the whole stack (signaling + ICE + handshake) is
demonstrably working — a rejoin would tear down that peer's datachannel
for no benefit and push a fresh round of presence-announces through every
relay, which is the failure mode that drove the original gate (flaky
hotspot + Damus rate-limiting). When no peer is active, the throttle
(90s/3m/5m/10m) paces actual rejoins to keep anti-spam happy.

An earlier version of the gate keyed off `isSignalingHealthy()` (≥1 relay
OPEN). That turned out to be too aggressive in the opposite direction:
it skipped every rejoin while relays were open, even when the actionable
case was "signaling sees the other peer's announces but our local Trystero
peer-table is stuck on a dead `RTCPeerConnection` and won't produce a
fresh `onPeerJoin`." The cure for that case IS a rejoin; refusing one
stranded the mesh in `peer-discovered` with no path forward. The current
gate fires only when we have evidence (an active peer) that the whole
stack is working.

**Tier 6's transport comparison** lives in `reconcile()`. We snapshot the
applied signaling/STUN/TURN arrays into `applied_signaling`, `applied_stun`,
`applied_turn` at `start()`. On the next `reconcile()` call we compare,
and if any of those changed, we restart. **This is what makes STUN/TURN
edits in Settings apply without a relaunch** — the prior shape (which only
compared `network_id`) silently no-op'd on transport-only edits.

## Tunables

All in `src/mesh-client.svelte.ts`. Change with care; each comment near
the declaration captures the rationale.

| Constant                               | Value                | Purpose                                                       |
|----------------------------------------|----------------------|---------------------------------------------------------------|
| `HANDSHAKE_TIMEOUT_MS`                 | 30s                  | Drop peer that never sends auth_response                      |
| `HANDSHAKE_HELLO_RETRY_SCHEDULE_MS`    | [5s, 7s, 10s]        | Cover the post-rejoin data-channel-settle race                |
| `HEARTBEAT_INTERVAL_MS`                | 30s                  | Ping cadence on every active connection                       |
| `HEARTBEAT_TIMEOUT_MS`                 | 75s                  | Enter re-handshake loop after this much silence               |
| `WAKE_DETECTION_THRESHOLD_MS`          | 60s (= 2× interval)  | Tick-gap that means the OS slept us                           |
| `WAKE_PROBE_DELAY_MS`                  | 1.5s                 | Post-wake fast staleness check                                |
| `WAKE_COALESCE_MS`                     | 2s                   | Dedup lifecycle event clumps                                  |
| `REHANDSHAKE_BACKOFF_MS_SCHEDULE`      | [2,5,10,20,30] s     | Per-peer hello-retry cadence (jittered ±20%)                  |
| `REHANDSHAKE_JITTER_FRACTION`          | 0.20                 | Desync N-peer simultaneous reconnects                         |
| `REHANDSHAKE_RESCUE_ATTEMPTS`          | 3                    | Failures before escalating to room rejoin                     |
| `REDISCOVERY_BACKOFF_SCHEDULE_MS`      | [90s, 3m, 5m, 10m]   | Global throttle on Trystero rejoins                           |
| `REDISCOVERY_REJOIN_GAP_MS`            | 1.5s                 | Leave-to-join gap to let transport tear down                  |
| `OFFLINE_ROSTERED_CHECK_INTERVAL_MS`   | 60s                  | Asymmetric-sleep safety net                                   |
| `ICE_POLL_INTERVAL_MS`                 | 3s                   | Pick up new `RTCPeerConnection` objects from Trystero         |
| `SIGNALING_DIAG_INTERVAL_MS`           | 10s                  | Refresh signaling-relay health snapshot                       |
| `DEFAULT_SIGNALING_REDUNDANCY`         | 5                    | Built-in Nostr relay count, after we filter `SIGNALING_RELAY_DENYLIST` out of Trystero's shuffle. Was 8 (to dilute Damus); the deny-filter is the targeted fix and dilution was no longer needed |
| `SIGNALING_RELAY_DENYLIST`             | damus.io, chorus.pjv.me | Hosts always skipped in the deterministic-shuffle slice; both rate-limit the announce loop                       |
| `CATALOG_REFRESH_INTERVAL_MS`          | 60s                  | Safety-net re-broadcast for catalog                           |
| `CATALOG_DEBOUNCE_MS`                  | 1.5s                 | Coalesce burst mutations into one announce                    |

## Edge cases

Every row here has been hit in practice. The right column is what the engine
does today; the file/line column is where to look if the behavior needs
adjustment.

| Edge case                                              | Detection                                           | Recovery                                                                                | Where                                  |
|--------------------------------------------------------|-----------------------------------------------------|-----------------------------------------------------------------------------------------|----------------------------------------|
| Laptop sleeps, wakes minutes later                     | Worker tick gap > 60s                               | `handleWake` pings all peers; full rejoin if all unresponsive after 1.5s                | `runHeartbeatTick`, `handleWake`       |
| Tab focus event clump (3 events in <100ms)             | `last_lifecycle_wake_at` < 2s ago                   | Drop all but first; gate at lifecycle hook                                              | `installLifecycleHooks`                |
| Symmetric NAT / CGNAT / phone hotspot                  | ICE state `failed` + zero `relay` candidates        | Phase = `ice-failed-needs-turn`; Settings banner; user adds TURN; reconcile restarts    | `watchPeerIce`, `computePhase`         |
| Rate-limited Nostr relay (`relay.damus.io` "noting too much") | Now never picked — host appears in `SIGNALING_RELAY_DENYLIST` and the deny-filter strips it from the shuffle before slice. Same treatment for `chorus.pjv.me`. Old build co-existence is preserved because the next-N relays in the deterministic order (schnorr.me, nostrdice.com, x.kojira.io, relay-can.zombi.cloudrodion.com) are still in the old top-8 | `pickFilteredSignalingRelays`, `SIGNALING_RELAY_DENYLIST` |
| Peer powered off                                       | `onPeerLeave` from Trystero                         | Drop connection state; offline-rostered card surfaces; catalog cache preserved          | `handlePeerLeave`, `dropConnection`    |
| Peer powered back on                                   | `onPeerJoin` for new (fresh) `peer_id`              | Capabilities cache reseeds UI immediately; fresh handshake begins                       | `handlePeerJoin`, `capabilities_cache` |
| Asymmetric sleep (one side wakes, other has stale sub) | Rostered peer absent from connection set for 60s    | `offlineRosteredCheckTick` → `maybeForceRediscovery` (gated)                            | `offlineRosteredCheckTick`             |
| ICE flap drops peer, Trystero peer-table stuck on dead PC | `hasActivePeer()` false + EVENTs still arriving | Gate allows rejoin (throttled); fresh announce produces new `onPeerJoin`                | `maybeForceRediscovery`, `hasActivePeer` |
| Network swap (hotspot↔LAN, ethernet plugged/unplugged) | All peers silent in wake probe                     | Tier 3: `pc.restartIce()` per PC, Trystero ferries the renegotiation; falls to Tier 5 in 4s if no recovery | `handleWake`, `restartIceForUnresponsivePeers` |
| Fresh data channel swallows first hello                | No auth_response after 5s                           | Retry at +5s, +12s, +22s (3 retries inside 30s watchdog)                                | `handlePeerJoin`                       |
| N peers go silent together (router reboot)             | Identical backoff schedules without jitter          | ±20% jitter applied per attempt → desynced retries                                      | `jitterBackoff`, `heartbeatTickConn`   |
| User edits STUN list                                   | `applied_stun` ≠ active network's stun_servers      | Stop + Start with new ICE config                                                        | `reconcile`, `sameStringList`          |
| User edits TURN credentials                            | `applied_turn` differs (url OR username OR cred)    | Stop + Start with new ICE config                                                        | `reconcile`, `sameTurnList`            |
| User edits signaling relay list                        | `applied_signaling` ≠ new list                      | Stop + Start with new relayConfig                                                       | `reconcile`, `sameStringList`          |
| User switches active network                           | `network_id` mismatch                               | Stop + Start with new room handle, roster, accepting policy                             | `reconcile`                            |
| Heavy main thread (multi-MB file SHA-256)              | Worker keeps stamping `performance.now()`           | Wake detection sees no gap; heartbeat doesn't mis-fire                                  | scheduler worker, `runHeartbeatTick`   |
| Trystero leave/rejoin race (half-cleaned transport)    | New peer would join into stale state                | 1.5s gap between `leave()` and `joinRoom()`                                             | `forceRediscovery`                     |
| Inbound message before `onPeerJoin` fires              | `handleMessage` has no conn for `peer_id`           | Spawn conn-state on demand if message kind is `hello`                                   | `handleMessage`                        |
| ICE banner flicker when N peers join in sequence       | Initial sync `onChange` clearing on healthy peer    | `is_initial=true` suppresses the "clear banner on success" side; only real transitions clear | `watchPeerIce`                    |
| User clicks Reconnect button rapidly                   | `rehandshake_backoff_until` set after each click    | Subsequent clicks no-op until window passes                                             | `reconnectPeer`                        |
| Stranger in same Trystero room (guessed Network ID)    | Hello arrives from non-rostered peer                | Handshake completes; prompt user; pre-approval no inference/move/file allowed           | `peerStatus`, all RPC handlers         |
| Move / file / infer in flight when peer drops          | `dropConnection` walks all pending maps             | Each promise resolves with descriptive error so callers unblock                         | `dropConnection`                       |
| Protocol mismatch (old peer talks to new build)        | `hello.protocol` ≠ PROTOCOL_VERSION                 | Send `deny`, drop connection                                                            | `handleHello`                          |
| Identity-key rotation (user blew away `~/.myownllm/.secrets`) | `device_id` change at next reconcile         | Old roster entries become unmatched; new device must be re-approved by peers            | `reconcile`                            |
| Authenticated peer dropped within last 90s             | `dropConnection` on `first_active_at > 0` rostered peer | Status → `reconnecting`; if same `device_pubkey` returns inside the window, UI flips back to `active` without intermediate `offline`/`handshaking` | `dropConnection`, `recent_disconnects`, `computePeers`, `pruneRecentDisconnects` |

## Invariants the engine maintains

If any of these break, it's a bug:

1. **One Trystero room joined at a time.** `start()` early-returns if `this.room` is non-null.
2. **`reconcile()` is idempotent on no-op changes.** Re-calling it with no config delta does not restart.
3. **Transport config changes always restart.** `applied_signaling`/`applied_stun`/`applied_turn` are the trust anchor.
4. **`recent_ice_failure_at` only changes on observed transitions.** The synchronous initial inspection in `watchPeerIce` is read-only.
5. **`consecutive_rediscovery_attempts` resets on any successful `onPeerJoin`.** A peer turning up proves signaling + WebRTC are working.
6. **The scheduler worker is the only authoritative wake clock.** Main-thread `Date.now()` is fine for protocol payloads but never used for wake detection.
7. **All backoff schedules carry jitter where multiple peers can sync.** Per-peer rehandshakes are jittered; the global rediscovery counter doesn't need it (only one fires at a time).
8. **Hello sends are bounded.** At most 4 per peer per handshake window (initial + 3 retries). The 30s watchdog drops the peer if none reach.
9. **`stop()` is total.** Every timer, every pending callback, every cached map is cleared. A subsequent `start()` is a fresh universe.
10. **State only flows one direction across the data channel.** Inbound messages only mutate `last_recv_at` + the specific fields the message kind owns; nothing reads from a remote peer to decide what we do next on a different peer.

## Anti-patterns

Spotted before and easy to slip back into:

- **Don't add per-peer setIntervals.** The single global heartbeat tick walks `this.connections` once per fire. Adding a per-conn `setInterval(30000)` would mean N timers, N main-thread wake-ups, and `Date.now()`-based wake-detection bugs that the scheduler worker exists to prevent.
- **Don't compare `Date.now()` deltas for wake detection.** Use the worker's `performance.now()` stamp. The whole reason the worker exists is that a busy main thread fakes wake-up gaps the OS never actually had.
- **Don't call `forceRediscovery()` directly from auto-recovery paths.** Always go through `maybeForceRediscovery(reason)` — that's the gate that checks `isSignalingHealthy()` and the per-window throttle. The only places that bypass the gate are the user-clicked Reconnect path and the manual "force rediscovery" command.
- **Don't read `loadConfig()` mid-session to pick up transport changes.** The connection engine doesn't poll config; UI persists config and then calls `meshClient.reconcile()`. The reconcile path knows how to detect the change. Reading config elsewhere creates two sources of truth.
- **Don't add new persistent state to `ConnectionState` without checking what happens on Trystero peer-id reissue.** A peer that disconnects and reconnects gets a new `peer_id` — the old `ConnectionState` is discarded by `dropConnection`. State that needs to survive (capabilities, catalog, roster) lives on the `MeshClient` keyed by `device_pubkey`, not on `ConnectionState`.
- **Don't fire signal-publishing actions from within a hot loop.** Trystero's `joinRoom()` publishes presence to every relay in its list. A `setInterval(joinRoom, 60000)` would burn through anti-spam budgets in minutes. The `REDISCOVERY_BACKOFF_SCHEDULE_MS` throttle is the only authorized publisher; nothing else should trigger a rejoin.
- **Don't widen wake-event sources without a coalescing window.** Tauri's webview can fire `visibilitychange` + `focus` + `pageshow` in <100ms. If you add another lifecycle source (e.g. `freeze` / `resume` from Page Lifecycle API), route it through the same `wake()` closure in `installLifecycleHooks` so the `WAKE_COALESCE_MS` gate covers it.

## State management overview

The reactive (`$state`) fields published to UI:

| Field                       | Type                       | Read by                                      |
|-----------------------------|----------------------------|----------------------------------------------|
| `status`                    | off/starting/online/error  | Legacy. Status pill compatibility.           |
| `phase`                     | `MeshPhase`                | Status pill (preferred), settings banners.   |
| `peers`                     | `PeerEntry[]`              | Connections list, sidebar peer pickers.      |
| `diag`                      | `DiagEntry[]`              | Activity panel.                              |
| `recent_ice_failure_at`     | number                     | Settings → Networks → Settings TURN banner.  |
| `my_capabilities`           | `Capabilities`             | Status tab identity card.                    |
| `accepting`                 | `AcceptingPolicy`          | Status tab accepting dropdown.               |
| `resources` / `files`       | resource maps              | Connections tab in-use panel.                |
| `inbound_offers`            | offer array                | Sidebar inbound-file banner.                 |
| `is_rediscovering`          | boolean                    | Connection cards (transient "rediscovering"). |

The non-reactive private fields fall into four groups:

- **Identity & room handles**: `identity`, `network_id`, `network_handle`, `room`, `sendMesh`, `my_peer_id`.
- **Applied transport snapshot**: `applied_signaling`, `applied_stun`, `applied_turn`. The single source of truth for "what does Trystero currently have baked in."
- **Connection map**: `connections: Map<peer_id, ConnectionState>`. The hot path. One entry per live Trystero peer.
- **Caches keyed by pubkey** (survive peer-id reissue): `roster_pubkeys`, `roster_labels`, `suffix_cache`, `catalog_cache`, `capabilities_cache`.
- **Timers**: scheduler worker handle, ICE poll timer, signaling diag timer, lifecycle event listeners.
- **In-flight RPC maps**: `pending_infers_{in,out}`, `pending_moves_{in,out}`, `pending_files_{in,out}`, `pending_transcribes_{in,out}`, `pending_session_{fetches,saves}`, `pending_pulls_out`, `pending_offers`. Each is cleared on `dropConnection` for the relevant peer and on `stop()` for everything.

The discipline rule: anything that needs to survive a peer reconnect (different peer_id, same device_pubkey) is keyed by pubkey; anything tied to the live channel is keyed by peer_id.

## How to add a new connection feature without breaking the engine

A checklist for the next contributor adding, say, a new `metrics_announce` message or a peer-discovery improvement:

1. **Decide which layer it lives at.** App protocol (Layer 4) is the default. Touching Layer 3 (handshake) needs a `PROTOCOL_VERSION` bump.
2. **If you add state to `ConnectionState`**: clear it in `dropConnection` and reset it in `createConnState`. Don't expect it to survive a peer-id reissue.
3. **If you add a cache keyed by pubkey**: clear it in `stop()` and in the network-switch path inside `start()` (the existing `catalog_cache.clear()` / `capabilities_cache.clear()` site).
4. **If you add a timer**: register it via the scheduler worker (`scheduleTick`) so it stays honest under main-thread load. If you can't (DOM access needed), make sure it's cleared in `stop()` and survives a `stop()`/`start()` cycle by being re-spawned in `start()`.
5. **If you add an outbound action that publishes**: confirm it doesn't reset relay sockets. Anything that triggers a rejoin must go through `maybeForceRediscovery(reason)` so the gate + throttle apply.
6. **If you read config**: read it once via `loadConfig()` at start of a turn, not mid-flight. For applying config changes, use the `reconcile()` path — extend its comparison if your config field is part of the transport snapshot.
7. **Log via `logDiag`**, not `console.log`. Honor the Quiet-mode flag (`info` is suppressible, `warn`/`error` always land).
8. **Test the four-peer mass-wake case.** Open four laptops on the same mesh, sleep them all, wake them at once. If your change holds up — backoff jitter desyncs them, signaling stays healthy, rejoin throttle holds — you're good. If you see a relay rate-limit warning in the diag log, you've added load somewhere.

## What's intentionally NOT in this engine

- **Per-relay quality scoring.** We use redundancy 8 with Trystero's deterministic shuffle. Adding per-relay weights would mean diverging from the appId-derived ordering, which would split the mesh (a peer on the old build picks different relays than a peer on the new one).
- **TURN health probing.** Currently passive: we learn TURN is dead by watching ICE fail. Active probing would mean periodic STUN/TURN allocations that have a real bandwidth cost, especially on metered TURN tiers (Cloudflare's 1000 GB/month is huge, but a periodic probe across N devices is still wasteful).
- **Connection multiplexing.** Each peer is one WebRTC datachannel via Trystero's typed action. Layer 4 RPC framing (id-based) does the multiplexing logically; we don't open separate channels per RPC kind.
- **Mesh-level encryption.** ed25519 authenticates each peer; the WebRTC layer encrypts in transit; conversation payloads are passed through. Adding mesh-level E2EE would matter only if we ever introduce a relay path (a peer relaying for two others) and isn't a concern at the current direct-peer-only topology.

## Diagnosing problems

When a user reports "connection problems," walk the diag log from the bottom up:

1. **`phase: off`** → mesh is stopped. Check `status`.
2. **`phase: signaling-connecting`** → zero relay sockets open. Check the user's network. If they're on Wi-Fi but DNS is bad, sockets sit in CONNECTING forever.
3. **`phase: signaling-up`** → ≥1 relay open but only our own EVENTs seen. Either we're alone in the room (wrong Network ID on the other side?) or relays are dropping inbound EVENTs (rate-limited subscriber).
4. **`phase: peer-discovered`** → peer's EVENTs arriving, WebRTC negotiating. If stuck here, look for `webrtc:` summary lines in the diag — empty `candidates` means STUN failed; presence of `host`/`srflx` but absence of `relay` means TURN missing.
5. **`phase: ice-failed-needs-turn`** → terminal. User must add a TURN server. Settings banner is already lit.
6. **`phase: peer-active`** → working. Any "stale" reports past this point are post-wake recovery issues, not connection setup issues.

The Activity panel surfaces the same data the diag log holds; Quiet logs suppresses `info` so users running busy sessions don't see the steady-state chatter.

## Change log highlights

- **Transport-config live reconcile** (commit ⌃): `reconcile()` now compares `applied_signaling`/`applied_stun`/`applied_turn` against the active network's fields. STUN/TURN edits apply without an app restart.
- **Jittered re-handshake backoff**: ±20% randomization on `REHANDSHAKE_BACKOFF_MS_SCHEDULE` lookups. Desyncs N-peer simultaneous reconnects so we don't all-at-once retry on the same tick.
- **Exponential hello-retry schedule** [5s, 7s, 10s]: replaces the fixed 5s interval. Cuts presence-relay pressure on dead peers from 6 sends per handshake window down to 4.
- **Lifecycle wake coalescing** (2s): a single tab-switch event clump no longer triggers multiple `handleWake()` ping bursts.
- **`watchPeerIce` initial inspection no longer clears banner**: `is_initial=true` runs the listener once at attach but only handles the failed case; the "ICE connected → clear banner" side is reserved for real transitions, so the banner doesn't flicker as new peers join with already-healthy state.
- **`DEFAULT_SIGNALING_REDUNDANCY` 5 → 8**: dilutes the rate-limiter impact of any single misbehaving relay (Damus especially) from 1/5 to 1/8 of capacity.
- **Targeted relay deny-filter + redundancy 8 → 5**: dilution didn't actually remove the rate-limiting relays from the top-N — `relay.damus.io` and `chorus.pjv.me` were still being picked, just outvoted. Trystero's announce cadence is hardcoded at 5.333s/relay plus a 4-event warmup burst (`announceWarmupIntervalsMs = [233, 533, 1333]` in core/strategy.mjs), so 8 relays meant ~88 events/min steady-state plus 32-event bursts on every rejoin — well past Damus's ~1 EVENT/sec free-pubkey threshold. The fix is `SIGNALING_RELAY_DENYLIST` + `pickFilteredSignalingRelays`: we replicate Trystero's `strToNum`/`shuffle` algorithm locally so we get the same deterministic shuffle order, filter the denylisted hosts BEFORE slicing, then pass the result via `relayConfig.urls` (which wholly overrides Trystero's internal slice). Redundancy drops back to 5 quiet relays; mesh stays interoperable because the 5 we pick all sit inside the old build's top-8.
- **STUN/TURN config-applied diag log**: previously the only way to confirm a transport-config edit had landed was to watch for ICE failures and infer. Now `start()` emits a single `[mesh] STUN: …; TURN: …` line right after the join-room header, listing every URL handed to WebRTC and the username (not credential) for each TURN entry. A wrong host (`global.relay.metered.ca` vs `relay.metered.ca`) or a credential field that didn't save is visible at first glance. A separate `[mesh] signaling relays: …` line lists the actual relay hosts we picked so a denylist or Trystero-default change is auditable too.
- **`REDISCOVERY_BACKOFF_SCHEDULE_MS` first interval 60s → 90s**: gives flaky-hotspot recovery a longer window before re-publishing presence; previously 60s tripped Damus's anti-spam.
- **Scheduler worker with `performance.now()` stamps**: replaces N main-thread setIntervals. Heavy file-encoding or SHA-256 work on the main thread no longer fakes wake-detection gaps and no longer cycles every peer through forced rediscovery.
- **`isSignalingHealthy()` gate on auto-rediscovery**: skip the Trystero leave/rejoin churn when relays are demonstrably fine — fixes the symptom of "rostered peer offline → unnecessary rejoin → rate-limited → genuine outage."
- **`hasActivePeer()` gate replaces `isSignalingHealthy()` gate**: the earlier signaling-only gate stranded the mesh in `peer-discovered` when ICE flapped and Trystero's local peer-table got stuck on a dead RTCPeerConnection. The new gate skips rejoin only when there's an actively-authenticated peer holding a working datachannel — which is the actual "mesh is working, don't churn it" signal. When no peer is active, the throttle alone paces rejoins.
- **ICE-restart layer (Tier 3) ahead of room rejoin**: a network swap (phone hotspot↔LAN, ethernet plugged/unplugged) used to take the room-rejoin sledgehammer — 8 relay sockets torn down, ~20 PCs discarded, every authenticated peer demoted to handshaking. The relay sockets were going to reconnect on their own anyway, and the only thing actually broken were the ICE candidate pairs. Now when the wake probe finds all peers silent, we call `pc.restartIce()` per PC; Trystero's `onnegotiationneeded` ferries the renegotiation through the still-up signaling, new candidates form on whatever interface is now reachable, and the datachannel resumes with all app state preserved. Room rejoin still fires if the restart doesn't recover within 4s, so the worst case is unchanged.
- **Stable peer identity (`recent_disconnects` + `reconnecting` status)**: ephemeral Trystero `peer_id` made every brief drop look like a fresh peer arrival — the UI churned through `active → offline → handshaking → active` for what was really one device with the same `device_pubkey` doing a network blip. Now when an authenticated peer drops, the pubkey enters `recent_disconnects` with a 90s grace window and the UI renders them as `reconnecting…` (amber pulsing dot, cached catalog stays visible). If a new connection lands inside the window with the same pubkey, the marker clears and the card flips straight back to `active`. After grace expires the janitor sweeps the entry and the card transitions cleanly to `offline`. No protocol change — pure UI/state-layer stabilization keyed off the durable identity we already had.
- **Leave-cause diagnostics (`last_ice_state`, `selected_candidate_summary`, `first_active_at`)**: `peer left` log lines now print "ICE=failed (8s ago), pair=srflx↔relay, lived=4m" so the difference between "network/TURN broke" and "datachannel died on its own" is observable in the diag panel. Observability only; informs the design of future fixes.
