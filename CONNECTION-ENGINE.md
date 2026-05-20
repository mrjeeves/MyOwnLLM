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
 │   `disconnected` → 6s watchdog → proactive `pc.restartIce()`        │
 │   onJoinError = terminal pending-handshake failure                  │
 │   Phase splits TURN-not-configured vs TURN-unreachable diagnoses    │
 └────────────────────────────▲────────────────────────────────────────┘
                              │
 ┌────────────────────────────┴────────────────────────────────────────┐
 │ Layer 1 · Signaling (Trystero / Nostr)                              │
 │   5 relays, picked from Trystero defaults with deny-filter applied  │
 │   (damus.io / chorus.pjv.me excluded due to rate limits)            │
 │   `getRelaySockets()` polled every 10s                              │
 │   EVENT-author counting distinguishes "alone" vs "peer present"     │
 │   `isSignalingHealthy()` = ≥1 relay socket OPEN                     │
 └─────────────────────────────────────────────────────────────────────┘
```

Each layer is observable independently — that's what makes the engine
diagnosable. The `phase` field publishes the worst (or most actionable)
layer's state to the UI as a single enum.

## The reconnection ladder

Seven escalating recovery mechanisms (numbered with a half-tier so the
classic naming survives). Each is strictly cheaper than the next and
only fires when the cheaper one has been ruled out:

| Tier | Trigger                                              | Action                                        | Schedule (jittered ±20%)              |
|------|------------------------------------------------------|-----------------------------------------------|---------------------------------------|
| 1    | App-level message arrives                            | Reset `last_recv_at`                          | Continuous                            |
| 2    | Wake event (lifecycle OR tick gap)                   | Ping all + 1.5s probe                         | Coalesced to 2s window                |
| 2.5  | Per-peer ICE = `disconnected`                        | `pc.restartIce()` after 6s if still disconnected | Per-peer setTimeout, cleared on recover/fail/drop |
| 3    | Wake probe: ALL peers silent                         | `pc.restartIce()` per PC + 4s recovery window | Once per wake (auto-falls to Tier 4)  |
| 4    | Silence > 75s OR wake probe + ICE restart failed     | Per-peer re-handshake (hello)                 | 2s, 5s, 10s, 20s, 30s (per peer)      |
| 5    | 3 re-handshakes failed OR rostered peer offline 60s+ | Trystero room rejoin                          | 90s, 3m, 5m, 10m (global, throttled)  |
| 6    | Active network changed OR transport config edited    | Stop + Start                                  | Immediate                             |

**Tier 2.5 is the per-peer ICE-disconnected layer.** WebRTC's ICE state
machine transitions to `disconnected` when at least one connectivity check
starts failing — it'll try to self-recover for ~5-15s before escalating to
`failed`. On a fast LAN flap that's fine; the path heals on its own. On a
TURN-via-TCP connection where a NAT pinhole closes, or a LAN↔WAN swap that
invalidates the local host candidate, ICE never makes it back to
`connected` and the SCTP datachannel / Trystero peer-state times out
~5s after the disconnect — dropping us into the room-rejoin sledgehammer
with all auth state lost. Tier 2.5 schedules a `setTimeout` per peer when
ICE enters `disconnected`; if the peer is still disconnected after
`ICE_DISCONNECTED_RESTART_MS` (3s), `proactiveIceRestart()` fires
`pc.restartIce()` to kick a fresh candidate exchange. The 3s window is
specifically sized to fire BEFORE Trystero's ~5s give-up boundary — at 6s
the watchdog was consistently outrun by Trystero's teardown and never even
got a chance to attempt restartIce on the network-swap path. Often the
restart picks up a different working path (alternate TURN URL, fresh srflx
mapping, new host candidate on the post-swap interface) and the datachannel
resumes without the peer ever dropping. Tier 2.5's watchdog is cleared the
moment ICE transitions to `connected`/`completed`/`failed` or the
connection is dropped, so a normal recovery short-circuits the kick.

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
| `ICE_DISCONNECTED_RESTART_MS`          | 1s                   | Per-peer watchdog before proactive `restartIce()` (Tier 2.5). Fires within Trystero's ~5s give-up window, leaving ~4s for the restart renegotiation to complete |
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
| Symmetric NAT / CGNAT / phone hotspot, no TURN configured | ICE state `failed` + zero `relay` candidates + `applied_turn.length === 0` | Phase = `ice-failed-no-turn`; Settings banner says "add TURN"; user adds TURN; reconcile restarts | `watchPeerIce`, `computePhase`, `iceFailureGuidance` |
| TURN configured but unreachable (DNS blocked, wrong creds, all UDP blocked) | ICE state `failed` + zero `relay` candidates + `applied_turn.length > 0` | Phase = `ice-failed-turn-unreachable`; Settings banner says "TURN isn't reachable — check URL/creds/transport"; user edits TURN; reconcile restarts | `watchPeerIce`, `computePhase`, `iceFailureGuidance` |
| Rate-limited Nostr relay (`relay.damus.io` "noting too much") | Now never picked — host appears in `SIGNALING_RELAY_DENYLIST` and the deny-filter strips it from the shuffle before slice. Same treatment for `chorus.pjv.me`. Old build co-existence is preserved because the next-N relays in the deterministic order (schnorr.me, nostrdice.com, x.kojira.io, relay-can.zombi.cloudrodion.com) are still in the old top-8 | `pickFilteredSignalingRelays`, `SIGNALING_RELAY_DENYLIST` |
| Peer powered off                                       | `onPeerLeave` from Trystero                         | Drop connection state; offline-rostered card surfaces; catalog cache preserved          | `handlePeerLeave`, `dropConnection`    |
| Peer powered back on                                   | `onPeerJoin` for new (fresh) `peer_id`              | Capabilities cache reseeds UI immediately; fresh handshake begins                       | `handlePeerJoin`, `capabilities_cache` |
| Asymmetric sleep (one side wakes, other has stale sub) | Rostered peer absent from connection set for 60s    | `offlineRosteredCheckTick` → `maybeForceRediscovery` (gated)                            | `offlineRosteredCheckTick`             |
| ICE flap drops peer, Trystero peer-table stuck on dead PC | `hasActivePeer()` false + EVENTs still arriving | Gate allows rejoin (throttled); fresh announce produces new `onPeerJoin`                | `maybeForceRediscovery`, `hasActivePeer` |
| Network swap (hotspot↔LAN, ethernet plugged/unplugged) | All peers silent in wake probe                     | Tier 3: `pc.restartIce()` per PC, Trystero ferries the renegotiation; falls to Tier 5 in 4s if no recovery | `handleWake`, `restartIceForUnresponsivePeers` |
| TURN-via-TCP NAT pinhole closes mid-conversation       | Per-peer ICE state = `disconnected`                 | Tier 2.5: 6s watchdog → proactive `pc.restartIce()` on that one peer; recovers without dropping handshake | `watchPeerIce`, `proactiveIceRestart`  |
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
| Network swap (LAN→WAN or vice versa) drops a previously-active peer | Peer in `recent_disconnects` AND `offlineRosteredCheckTick` would otherwise force-rediscover | Skip the heavy room-rebuild during the grace window — natural Trystero discovery (5.333s presence-announce cadence) has 90s to find the peer on the new network. UI stays on "reconnecting…" continuously rather than churning through a stop+start cycle. If grace expires without recovery, `pruneRecentDisconnects` triggers `maybeForceRediscovery` immediately as a backstop | `offlineRosteredCheckTick`, `pruneRecentDisconnects` |

## Invariants the engine maintains

If any of these break, it's a bug:

1. **One Trystero room joined at a time.** `start()` early-returns if `this.room` is non-null.
2. **`reconcile()` is idempotent on no-op changes.** Re-calling it with no config delta does not restart.
3. **Transport config changes always restart.** `applied_signaling`/`applied_stun`/`applied_turn` are the trust anchor.
4. **`recent_ice_failure_at` only changes on observed transitions.** The synchronous initial inspection in `watchPeerIce` is read-only.
5. **`consecutive_rediscovery_attempts` resets on any successful `onPeerJoin`.** A peer turning up proves signaling + WebRTC are working.
6. **The scheduler worker is the only authoritative wake clock.** Main-thread `Date.now()` is fine for protocol payloads but never used for wake detection. The worker-spawn-failure fallback uses `performance.now()` from a main-thread `setInterval` — less reliable for wake-gap math but the only option when `new Worker()` throws.
7. **All backoff schedules carry jitter where multiple peers can sync.** Per-peer rehandshakes are jittered; the global rediscovery counter doesn't need it (only one fires at a time).
8. **Hello sends are bounded.** At most 4 per peer per handshake window (initial + 3 retries). The 30s watchdog drops the peer if none reach.
9. **`stop()` is total for live channels and timers; pubkey-keyed caches survive a same-network restart.** Every timer, every pending callback, the connections map, the room handle, and the lifecycle hooks are torn down on `stop()`. But the pubkey-keyed caches (`catalog_cache`, `capabilities_cache`, `roster_pubkeys`, `roster_labels`, `recent_disconnects`) are NOT cleared by `stop()` — they're cleared by `start()` only when the network actually changed (`network_id !== opts.networkId`). That's what makes the rediscovery stop+start cycle preserve the sidebar's cached catalogs and the "reconnecting" grace markers, instead of flashing every offline rostered peer to blank during the rejoin window. A subsequent `start()` for the SAME network resumes with those caches intact; a `start()` for a DIFFERENT network wipes them in the network-changed branch.
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
- **Caches keyed by pubkey** (survive peer-id reissue AND survive a same-network rediscovery): `roster_pubkeys`, `roster_labels`, `suffix_cache`, `catalog_cache`, `capabilities_cache`, `recent_disconnects`. Cleared only in the network-changed branch of `start()`.
- **Timers**: scheduler worker handle, ICE poll timer, signaling diag timer, lifecycle event listeners, plus the fallback-path `heartbeat_timer` / `offline_check_timer` / `catalog_refresh_timer` / `reconnect_prune_timer` for worker-less environments. Per-`ConnectionState` timers (`handshake_timer`, `handshake_hello_retry_timer`, `ice_disconnected_watchdog`) are cleared in `dropConnection` and in the `stop()` teardown loop.
- **In-flight RPC maps**: `pending_infers_{in,out}`, `pending_moves_{in,out}`, `pending_files_{in,out}`, `pending_transcribes_{in,out}`, `pending_session_{fetches,saves}`, `pending_pulls_out`, `pending_offers`, `pending_move_guids`. Each is reaped per-peer on `dropConnection` (matching by `peer_id`) and settled-with-rejection on `stop()` so all outbound callers' promises unblock with a "mesh stopped" error rather than hanging forever.

The discipline rule: anything that needs to survive a peer reconnect (different peer_id, same device_pubkey) is keyed by pubkey; anything tied to the live channel is keyed by peer_id. The pubkey-keyed caches also need to survive a same-network rediscovery (`stop()` followed by `start()` for the same `network_id`) — see invariant #9 for the gate that enforces this.

## How to add a new connection feature without breaking the engine

A checklist for the next contributor adding, say, a new `metrics_announce` message or a peer-discovery improvement:

1. **Decide which layer it lives at.** App protocol (Layer 4) is the default. Touching Layer 3 (handshake) needs a `PROTOCOL_VERSION` bump.
2. **If you add state to `ConnectionState`**: clear it in `dropConnection` and reset it in `createConnState`. Don't expect it to survive a peer-id reissue.
3. **If you add a cache keyed by pubkey**: clear it ONLY in the network-changed branch of `start()` (the `network_changed === true` block where `catalog_cache.clear()` / `capabilities_cache.clear()` / `recent_disconnects.clear()` etc. live). Do NOT clear it in `stop()` — that would destroy the cache across a same-network rediscovery and break the doc's "pubkey-keyed survives peer-id reissue" invariant. The whole point of pubkey-keyed state is that the live peer-id is ephemeral; tearing it down on stop defeats that.
4. **If you add a timer**: register it via the scheduler worker (`scheduleTick`) so it stays honest under main-thread load. If you can't (DOM access needed), make sure it's cleared in `stop()` and survives a `stop()`/`start()` cycle by being re-spawned in `start()`.
5. **If you add an outbound action that publishes**: confirm it doesn't reset relay sockets. Anything that triggers a rejoin must go through `maybeForceRediscovery(reason)` so the gate + throttle apply.
6. **If you read config**: read it once via `loadConfig()` at start of a turn, not mid-flight. For applying config changes, use the `reconcile()` path — extend its comparison if your config field is part of the transport snapshot.
7. **Log via `logDiag`**, not `console.log`. Honor the Quiet-mode flag (`info` is suppressible, `warn`/`error` always land).
8. **Test the four-peer mass-wake case.** Open four laptops on the same mesh, sleep them all, wake them at once. If your change holds up — backoff jitter desyncs them, signaling stays healthy, rejoin throttle holds — you're good. If you see a relay rate-limit warning in the diag log, you've added load somewhere.

## Known upstream limitations (and how we patch them)

Trystero v0.24.0 has internal-state behaviors that block natural
recovery from network swaps. The relevant ones are documented here
along with how we work around them.

**Trystero natural re-handshake doesn't engage after a peer drops — under investigation.** The original hypothesis was that `peerStates[peerId].offerAnswered` was sticky after first connection and blocked subsequent announce processing. Field testing disproved that: the `[trystero-patch]` warning we wired up to log when the patch's `state.offerAnswered = false` actually clears something **never fires in the wild**. Re-reading the code path confirms why: `strategy.mjs`'s `attachSharedPeerToRoom` calls `resetOfferState(state, pool)` at connection time, which sets `state.offerAnswered = false`. By the time the peer drops and `clearConnectedPeer` or `strategy.onPeerLeave` runs, `offerAnswered` is already false — the guarded `if (state.offerAnswered)` is always false, the patch is a no-op.

The real bug is somewhere else. The mesh-side instrumentation
(`peer … reconnected within grace (Ns) — natural Trystero
re-handshake (no rebuild)` vs `post-rebuild`) tells the truth in
the user's logs: every reconnect after a swap is `post-rebuild`,
meaning the heavy `stop()` + `start()` rejoin is what saves us.
Natural re-handshake never engages. Yet our trace shows:
- `strategy.onPeerLeave` does fire (mesh-side `peer left` log
  comes from the same `exitPeer` call).
- After it, `state.connectedPeer = null`, `state.offerAnswered`
  already false, `state.offerPeer` already null (from
  `resetOfferState` at connect time), `state.answeringPeer` null,
  `state.offerRelays = []`.
- So `handleAnnouncement` on the next presence announce **should**
  pass all the early-return checks and start a fresh offer.
- But it doesn't.

To find what's actually blocking it,
`patches/@trystero-p2p__core@0.24.0.patch` carries a **diagnostic
overlay** alongside the (now defensive) `offerAnswered = false`
clears. Every interesting choke point logs a one-line
`[trystero-patch:diag] <where> peer=<id>… cp=<0|1> oa=<0|1>
op=<0|1> ap=<0|1> or=<n> orp=<n> …` record with the relevant
state flags (cp=connectedPeer, oa=offerAnswered, op=offerPeer,
ap=answeringPeer, or=offerRelays truthy count, orp=placeholder
count). Instrumented sites:

- `clearConnectedPeer` entry, no-op path, and offerAnswered-clear
  path (signal-handler.mjs)
- `handleAnnouncement` entry, every early-return reason
  (skip-state, skip-no-placeholder, skip-post-ensureOffer), and
  the sending-offer success path
- `handleOffer` entry and the skip-busy path
- `handleAnswer` entry (leased-peer vs state-peer branches) and
  the skip path with the specific reason
- `createSignalHandler` unhealthy-peer branches and the
  announce-block decision tree (skip-busy, send-back-id,
  skip-existing-relay, set-placeholder)
- `strategy.onPeerLeave` (the room-level callback) — unconditional
  entry log so we see whether it fires at all
- `strategy.connectPeer` entry — confirms whether new
  handshake attempts are even reaching this point
- `strategy.attachSharedPeerToRoom` entry — confirms the
  state-reset moment on (re)connect

Workflow: ship this patch, reproduce a LAN↔WAN swap in the wild
with the dev tools open, filter the console for
`[trystero-patch:diag]`, and look for what `handleAnnouncement`
does (or fails to do) for the dropped peer's `peer_id` between
the `strategy.onPeerLeave` event and the eventual `post-rebuild`
reconnect. The trace should make the structural blocker visible.

While we hunt the real bug, grace stays at the
backstop-sized 90s and the rediscovery schedule stays
`[90s, 3m, 5m, 10m]`. `ICE_DISCONNECTED_RESTART_MS` stays at
1s — that's about beating Trystero's 5s data-channel close
timer for restartIce, independent of whatever is blocking
natural recovery. UX cost: a network swap that should
recover in seconds via natural re-handshake currently waits
~90s for the rebuild backstop. Acceptable while we
instrument; not acceptable as a steady state.

**Upstream PR.** A one-line equivalent of this patch belongs
upstream in `dmotz/trystero` so every Trystero user benefits and
we can drop the patch on the next release. When that lands, remove
the `pnpm.patchedDependencies` entry and the `patches/` file.

## What's intentionally NOT in this engine

- **Per-relay quality scoring.** We use redundancy 5 with Trystero's deterministic shuffle and an explicit deny-filter (`SIGNALING_RELAY_DENYLIST`) for known-noisy hosts. Adding per-relay reliability metrics would mean diverging from the appId-derived ordering further, which risks splitting the mesh if two builds compute different "best" relays from observed performance. The current deny-filter is a stable, version-controlled allowlist — easier to reason about than a live scoring loop.
- **TURN health probing.** Currently passive: we learn TURN is dead by watching ICE fail (and now distinguish "no TURN configured" from "TURN configured but unreachable" in the phase machine — see `ice-failed-no-turn` vs `ice-failed-turn-unreachable`). Active probing would mean periodic STUN/TURN allocations that have a real bandwidth cost, especially on metered TURN tiers (Cloudflare's 1000 GB/month is huge, but a periodic probe across N devices is still wasteful). The leave-cause diag log captures `pair=relay↔srflx`-style summaries which gives us most of the same forensic value without the live cost.
- **Per-URL TURN preference tracking.** When the user has multiple TURN URLs configured (the metered.ca config from the user's session had four — `turn:` UDP/80, `turn:` TCP/80, `turn:` UDP/443, `turns:` TCP/443), we currently pass them all to WebRTC and let ICE pick. We don't track which URL actually produced the working relay candidate, so a successful connection through one URL doesn't help future attempts skip the dead ones. The leave-cause diag now records the local/remote candidate types (`relay↔srflx`) which gives partial visibility; per-URL preference is a future addition if the audit shows real cost from the "try all" behavior.
- **Connection multiplexing.** Each peer is one WebRTC datachannel via Trystero's typed action. Layer 4 RPC framing (id-based) does the multiplexing logically; we don't open separate channels per RPC kind.
- **Mesh-level encryption.** ed25519 authenticates each peer; the WebRTC layer encrypts in transit; conversation payloads are passed through. Adding mesh-level E2EE would matter only if we ever introduce a relay path (a peer relaying for two others) and isn't a concern at the current direct-peer-only topology.

## Diagnosing problems

When a user reports "connection problems," walk the diag log from the bottom up:

1. **`phase: off`** → mesh is stopped. Check `status`.
2. **`phase: signaling-connecting`** → zero relay sockets open. Check the user's network. If they're on Wi-Fi but DNS is bad, sockets sit in CONNECTING forever.
3. **`phase: signaling-up`** → ≥1 relay open but only our own EVENTs seen. Either we're alone in the room (wrong Network ID on the other side?) or relays are dropping inbound EVENTs (rate-limited subscriber).
4. **`phase: peer-discovered`** → peer's EVENTs arriving, WebRTC negotiating. If stuck here, look for `webrtc:` summary lines in the diag — empty `candidates` means STUN failed; presence of `host`/`srflx` but absence of `relay` will resolve to either `ice-failed-no-turn` or `ice-failed-turn-unreachable` on the next failed-state observation (see below).
5. **`phase: ice-failed-no-turn`** → terminal. User has no TURN configured. Settings banner says "add a TURN server" with provider hints (Cloudflare Calls, Coturn).
6. **`phase: ice-failed-turn-unreachable`** → terminal. User has TURN configured but ICE never got a `relay` candidate. Three likely causes the banner enumerates: DNS doesn't resolve the TURN host (ad-blocking DNS intercepting trafficmanager.net etc.), wrong credentials (TURN's 401 looks identical to "host unreachable" from ICE's view), or UDP fully blocked (suggest `turns:host:443?transport=tcp`). Settings → Networks → Settings → TURN to edit.
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
- **Per-peer ICE-disconnected watchdog (Tier 2.5)**: previously `disconnected` was treated as transient with no action; the engine relied on WebRTC's natural consult-and-retry to restore the path. That worked for LAN flaps but lost the TURN-via-TCP case — a NAT pinhole on the relay closes, ICE goes `disconnected` permanently, the SCTP datachannel times out, Trystero fires `onPeerLeave` with all auth state lost. The user observed this directly: 36s connection lifetime with `ICE=disconnected (5s ago), pair=relay↔srflx, lived=36s` in the leave log. The fix is a per-peer setTimeout scheduled in `watchPeerIce` whenever ICE enters `disconnected`: after `ICE_DISCONNECTED_RESTART_MS` (6s), `proactiveIceRestart()` calls `pc.restartIce()` to kick a fresh candidate exchange. The watchdog is cleared on any transition out of `disconnected` (recovered or escalated to `failed`) and on drop, so a normal recovery short-circuits the kick. Sibling of the Tier 3 wake-probe ICE-restart but scoped to one peer and triggered by observed state rather than wake.
- **Pubkey-keyed caches survive same-network rediscovery**: an audit caught that `catalog_cache.clear()` / `capabilities_cache.clear()` / `roster_pubkeys.clear()` / `roster_labels.clear()` were running on every `start()` call, including the start half of `forceRediscovery`'s stop+start cycle. Doc invariants and several code paths assumed those caches survived peer-id reissue (they're explicitly pubkey-keyed for exactly this reason), but the implementation wiped them on every rediscovery. Result: offline-rostered sidebar peers lost their catalogs every time the rediscovery throttle released. Same bug applied to `recent_disconnects` — it was being cleared in `stop()` itself, so the "reconnecting" grace markers added in a previous PR were destroyed across rediscovery, defeating the whole point. The fix gates the cache wipe on `network_id !== opts.networkId` — a fresh `start()` only clears the pubkey-keyed maps when the user actually switched networks; same-network restarts (rediscovery, transport-config edit) preserve them. `recent_disconnects.clear()` moved out of `stop()` and into the same network-changed branch.
- **Phase machine: `ice-failed-needs-turn` split into `ice-failed-no-turn` + `ice-failed-turn-unreachable`**: the old single phase advised "Add a TURN server" regardless of whether the user already had one configured. When the user had TURN configured but it was unreachable (DNS blocked by an ad-blocker intercepting trafficmanager.net, wrong credentials, all-UDP path blocked), they were told to "add a TURN server" they already had — confusing and wrong. The fix branches `computePhase` on `applied_turn.length`: zero TURN configured → `ice-failed-no-turn` (provider-suggestion banner); ≥1 configured → `ice-failed-turn-unreachable` (causes-and-checks banner enumerating DNS / credentials / UDP-blocked). A shared `iceFailureGuidance()` helper builds the diag log warning so the `handleJoinError` and `watchPeerIce` failed-state paths emit the same message and can't drift apart. Settings status panel reads both phases for its action hint text.
- **Worker-fallback heartbeat + post-stop guards on wake callbacks**: an audit caught that `startScheduler`'s worker-spawn-failure branch set up offline-check / catalog-refresh / reconnect-prune timers but forgot the heartbeat — silently disabling wake detection, the rehandshake loop, and every per-peer liveness path in worker-less environments. The fix adds a `heartbeat_timer` field with matching teardown in `stop()`; the fallback now fires `runHeartbeatTick(performance.now())` on the same `HEARTBEAT_INTERVAL_MS` cadence the worker would. Worker-less environments are rare (the diag log already prints a warn when the worker spawn throws) but the failure-mode silence was a real reliability hole. Same commit added `if (this.status === "off" || !this.room) return` guards to both setTimeouts inside `handleWake`, which previously ran their full bodies post-stop — at best a no-op on a cleared connections map, at worst calling `maybeForceRediscovery` against a torn-down room. Belt-and-suspenders with `stopping`.
- **`pending_moves_out` rejection in `stop()` + `is_rediscovering` reset**: every other pending RPC map was settled (with a "mesh stopped" error) and cleared in `stop()` — `pending_moves_out` was the one silent omission, so outbound move callers held onto promises that would never resolve across a stop cycle. Now mirrored with the rest of the maps. Also added an `is_rediscovering = false` reset to the same site: the `forceRediscovery` try/finally was the only normalizer, and any code path that calls `stop()` directly (user-initiated stop, error path in reconcile, etc.) would otherwise leave the UI's "rediscovering…" indicator stuck on. Pure correctness — no behavior change in the common case.
- **Trystero `offerAnswered` state-stickiness root cause + shorter grace/throttle to mask it**: prior attempts to make network-swap recovery feel less fragile (Tier 2.5 watchdog, 90s grace, mid-grace rediscovery suppression) all assumed that natural Trystero discovery would eventually re-handshake a dropped peer if we just waited long enough. The user's logs proved this assumption wrong: `pcCount` never increased during grace, meaning Trystero was receiving the peer's announce events and silently ignoring them. Root cause located in `@trystero-p2p/core/dist/signal-handler.mjs`: when we answer a peer's offer, `peerStates[peerId].offerAnswered` is set to `true` (line 302) and an offer-expiry timer is scheduled at `offerPostAnswerTtlMs = 23.3s`. If the connection lives past 23s, that timer's callback short-circuits (`current.connectedPeer` is truthy) and never reschedules. From that point on, `offerAnswered` is permanently `true` for the lifetime of the room — `clearConnectedPeer` (which fires when the PC dies) clears `connectedPeer` but does NOT touch `offerAnswered`. Subsequent announces hit the early-return at line 352 (`offerAnswered: true`) and never trigger a fresh handshake. The only mechanism that clears this state is a full room rejoin (new `ctx.peerStates` map). `ctx.peerStates` is closure-scoped in the strategy factory and not exposed via the room object, so we can't reach in to surgically reset just the stuck flag. Documented as a known upstream limitation; engine response is to shorten grace and throttle so the unavoidable rejoin happens fast: `RECONNECTING_GRACE_MS` 90s → 30s, `REDISCOVERY_BACKOFF_SCHEDULE_MS` first interval 90s → 30s, `ICE_DISCONNECTED_RESTART_MS` 3s → 1s. Net effect: worst-case reconnect drops from ~120s (90s grace + 30s rebuild) to ~60s (30s grace + 30s rebuild) for the LAN↔WAN swap case the user repeatedly hit.
- **LAN↔WAN swap UX: ICE watchdog 6s → 3s, suppress rediscovery during grace, kick on grace expiry**: the previous round of fixes added Tier 2.5 and the `reconnecting` grace state, but the user still observed slow + fragile recovery on LAN↔WAN swaps with visible "tearing down and building up over and over." The leave-cause logs revealed three compounding issues:
   1. The 6s ICE-disconnected watchdog never fired — Trystero killed the datachannel ~5s after ICE goes `disconnected` (`ICE=disconnected (5s ago)` in every leave log), beating our watchdog by 1s. The watchdog wasn't even attempting restartIce. Lowered to 3s so the watchdog fires before Trystero's give-up boundary, leaving a ~2s window for the restart negotiation to begin.
   2. `offlineRosteredCheckTick` was firing `maybeForceRediscovery` mid-grace-window (the 60s tick during the 90s grace). That triggered the heavy stop+start, tearing down our room while natural Trystero discovery was still trying to find the peer on their new network. The fix: skip peers currently in `recent_disconnects` during the tick. Lets natural discovery (presence-announce every 5.333s) have its 90s shot without interference.
   3. With the mid-grace rediscovery suppressed, a peer that DIDN'T recover via natural discovery would have waited up to OFFLINE_ROSTERED_CHECK_INTERVAL_MS (60s) after grace expired for the next tick to fire rediscovery. That added 0-60s of "offline" UI on top of the 90s grace. Fixed by extending `pruneRecentDisconnects`: when an expiry sweep finds rostered-and-still-offline peers, `maybeForceRediscovery` fires immediately as a backstop. Worst-case recovery latency now equals one grace window (90s) instead of "grace + next-tick (up to 150s)."
   Net UX: visible churn during recovery drops from "tearing down and building up over and over" to "reconnecting…" displayed continuously for up to 90s, with the heavy hammer firing only as a real fallback when natural discovery genuinely fails.
- **`pnpm patch` for Trystero `offerAnswered` + revert grace/throttle to backstop sizing**: the previous round documented the upstream `offerAnswered` stickiness as unfixable from outside the library and shortened `RECONNECTING_GRACE_MS` (90s → 30s) and the first `REDISCOVERY_BACKOFF_SCHEDULE_MS` interval (90s → 30s) so the unavoidable rebuild fired fast. Reassessment: the patch IS reachable from outside via pnpm-patches. `patches/@trystero-p2p__core@0.24.0.patch` adds `state.offerAnswered = false` to both paths that clear `state.connectedPeer` — the `clearConnectedPeer` helper in `signal-handler.mjs` AND the strategy's `onPeerLeave` room callback in `strategy.mjs`. `package.json`'s `pnpm.patchedDependencies` field re-applies it on every install. Each path emits a `[trystero-patch]` console.warn so we can verify in the wild that the patch is engaging; the mesh-side `peer … reconnected within grace (Ns) — natural Trystero re-handshake (no rebuild)` log distinguishes patch-driven recovery from rebuild-driven recovery (compares `last_force_rediscovery_at` against the original disconnect timestamp). With the patch in place, natural Trystero discovery (presence announces every 5.333s) re-handshakes a dropped peer in seconds rather than being structurally blocked, so the heavy rebuild returns to backstop duty. Grace reverted to 90s, throttle first interval reverted to 90s, schedule extended to `[90s, 3m, 5m, 10m]`. `ICE_DISCONNECTED_RESTART_MS` stays at 1s — that's about beating Trystero's 5s data-channel close timer for restartIce renegotiation, independent of the `offerAnswered` bug. Companion upstream PR for `dmotz/trystero` so every Trystero user benefits and we can drop the patch on the next release.
- **`offerAnswered` hypothesis disproved + diagnostic patch overlay for the real bug**: live testing of the prior patched build with `[trystero-patch]` instrumentation showed `[trystero-patch]` never fires in the wild AND natural re-handshake still doesn't work — every reconnect after a swap is `post-rebuild`, never natural. Re-reading the code: `attachSharedPeerToRoom` calls `resetOfferState(state, pool)` at connection time (strategy.mjs line 116), which sets `state.offerAnswered = false`. So by the time `clearConnectedPeer` or the strategy's `onPeerLeave` runs on disconnect, `offerAnswered` is already false. The guarded `if (state.offerAnswered)` in both patch sites is always false; the patch is structurally a no-op. The `offerAnswered`-stickiness theory was wrong, but the symptom (natural re-handshake refusing to engage after a peer drop) is still real and reproducible. Trace says state IS clean post-drop: `state.connectedPeer = null` (cleared by strategy.onPeerLeave), `state.offerAnswered = false`, `state.offerPeer = null`, `state.answeringPeer = null`, `state.offerRelays = []`. `handleAnnouncement` on the next presence event SHOULD start a fresh offer and doesn't. Patch reframed as a **diagnostic overlay**: keep the defensive `state.offerAnswered = false` clears, but make every interesting choke point emit a one-line `[trystero-patch:diag]` log with the current state flags (`cp`, `oa`, `op`, `ap`, `or`, `orp`). Instrumented sites: `clearConnectedPeer` (entry / no-op / cleared-offerAnswered), `handleAnnouncement` (entry, all early-return reasons, sending-offer), `handleOffer` (entry, skip-busy), `handleAnswer` (entry, skip with specific reason), `createSignalHandler` (unhealthy branches, announce-block decision tree), `strategy.onPeerLeave` (unconditional entry), `strategy.connectPeer` (entry), `strategy.attachSharedPeerToRoom` (entry). Volume is bounded — the per-message early-return on `health === "live"` is skipped silently so steady-state traffic stays quiet. Grace stays at backstop-sized 90s while we capture the trace; cost is ~90s of "broken-feeling" UX per swap until we find the real blocker. Next step: reproduce LAN↔WAN swap with dev tools open, filter `[trystero-patch:diag]`, look at what `handleAnnouncement` does (or fails to do) for the dropped peer's `peer_id` between `strategy.onPeerLeave` and the eventual `post-rebuild` reconnect.
