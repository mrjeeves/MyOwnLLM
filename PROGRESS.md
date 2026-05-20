# Mesh re-handshake after network swap — root cause found, patch shipped

**Status:** Root cause located and patched in commit `<TBD>` on this branch
(PR #186). Awaiting in-the-wild verification by the user on the next
network swap. If the patch works as expected, recovery time should drop
from ~95s to under 15s and we can close this out.

If it doesn't work, this doc still serves the next agent — see "If the
patch doesn't help" at the bottom.

## The bug, in one paragraph

Nostr relays drop subscription state when the underlying WebSocket
closes — that's per-spec (NIP-01 subscriptions are per-connection).
Trystero v0.24.0's `@trystero-p2p/core` reconnects the WebSocket
transparently inside `makeSocket` (`utils.mjs:70-96`) but its
`strategy.mjs` calls the strategy's `subscribe()` callback exactly
once at room init (line 222) and never re-runs it. So after any
event that closes the socket (network swap is the visible case;
relay churn / mobile-screen-off / Wi-Fi blip would all hit the
same path), the new socket reopens but the relay has no record of
our REQs and forwards nothing. The connection looks perfectly fine
from `getRelaySockets()` — `readyState === 1`, our presence publishes
go out — but **zero inbound EVENTs arrive**, so natural re-handshake
silently stalls. Eventually `forceRediscovery`'s heavy room rebuild
fires a fresh `joinRoom()` (which calls `subscribe()` from scratch)
and everything works in ~1s because that's what fresh subscriptions
do.

This explains every observation the prior hypotheses couldn't:

- **Why the gap is silent on both sides.** The swap-side is a
  publish-only zombie (no inbound). The non-swap side's sockets
  are healthy and it does send `{peerId: selfId}` follower
  acknowledgements to our announces, but they're tossed by the
  relay because we're not subscribed.
- **Why the signaling diag goes quiet for the whole 90s.** The
  fingerprint (open count, distinct authors seen, PC tier) doesn't
  change — sockets are open, author counts are cumulative-since-start
  so they don't decrement, no new candidate errors fire. Change-gated
  log → nothing to log.
- **Why post-rebuild is instant.** `joinRoom` calls the strategy's
  `subscribe()` afresh on the new sockets. Relay starts forwarding.
  Within one announce interval (5.333s) the offer-answer round-trip
  completes.
- **Why prior pool-flush / `offerAnswered` hypotheses didn't help.**
  Both addressed Trystero-internal state that wasn't the bottleneck.
  The bottleneck is upstream of all peer-state machinery: we never
  see the announces because our subscription is dead at the relay.

## The patch

`patches/@trystero-p2p__core@0.24.0.patch` adds a hunk on
`dist/utils.mjs::makeSocket`:

1. **Track outgoing subscriptions.** `client.send` intercepts strings
   that parse as `["REQ", subId, …]` (added to `activeSubscriptions
   Map<subId, reqMsg>`) and `["CLOSE", subId]` (removed). Non-JSON /
   non-array payloads (EVENT publishes, MQTT binary frames, etc.)
   fall through untouched via the JSON.parse-error no-op path.

2. **Replay on every subsequent `onopen`.** A `hasOpenedOnce` flag
   gates the replay so the first open behaves exactly like upstream
   (strategy will send its own REQ via `subscribe()` callback). Every
   reopen after that calls `scheduleReplay()`.

3. **Anti-flood backoff.** `scheduleReplay` shares per-socket state
   (`resubscribeAttempt`, `lastResubscribeAt`, `pendingResubscribeTimer`)
   that enforces a schedule of **5s / 10s / 15s / 30s / 60s, sticking
   at 60s**. Reset to attempt 0 after `60s` of quiet so a long-stable
   socket that finally blips doesn't sit at the cap. If a reconnect
   lands while a replay is already scheduled, the scheduler is a
   no-op (one in-flight replay per URL).

4. **Observable.** One log line per replay event:
   `[trystero-patch] <host> replayed N subscription(s) on reconnect
   (attempt=M, next-eligible-in=Ks)`. Not per-message — state-transition
   only, in line with the existing patch's log discipline.

The other hunks on this patch (the `getConnectedPeerHealth =
transient on disconnected` fix in `shared-peer.mjs`, the
`flushStaleOfferPool` on `onPeerLeave` in `strategy.mjs`, the
defensive `offerAnswered` clears in `signal-handler.mjs`, and all
the `_mom*` instrumentation) all stay — they're correct fixes for
adjacent problems and the instrumentation is what made this
diagnosis possible.

## What to verify in the wild

Get one network-swap reproduction with the patched build on at
least the swap-side (ideally both, since the same code runs on
both). With DevTools open and console filtered for `[trystero-patch]`:

1. **Module-load markers fire.** `[trystero-patch] signal-handler.mjs
   loaded` and `[trystero-patch] strategy.mjs loaded` print once per
   page load. If they don't, the patched bundle isn't running — see
   "Don't trust pnpm 'Already up to date'" in the old notes.

2. **`replayed N subscription(s)` fires on the swap.** Within a few
   seconds of the WebSocket onclose burst (the 5 `WebSocket connection
   to 'wss://…' failed: The network connection was lost.` lines), you
   should see one `[trystero-patch] <relay> replayed 2 subscription(s)
   on reconnect (attempt=1, next-eligible-in=10s)` line per relay
   that reopens. N=2 because Trystero subscribes to root + self topics.

3. **Natural re-handshake completes inside the grace window.** Look
   for `received offer` (if we're the answering side) or `sending
   offer` (if we're the leader) within 15-30s of the peer-left, not
   the 90+s it was previously taking. The `_mom*` state machine
   should transition `connected → offering → connected` or
   `connected → ??? → connected` (the latter for the answering
   side, which doesn't have a clean intermediate state — that's a
   gap in the patch's state machine, noted below).

4. **No `auto rediscovery #1 — N peer(s) aged out of grace`.** That
   message firing means the patch didn't help in time and the heavy
   rebuild still had to backstop. If you see it, capture the trace
   — we want to know whether the replays fired but didn't restore
   message flow (relay-side problem? subscription rejected?) or
   whether the replays didn't fire (`hasOpenedOnce` not flipping?
   wrong code path?).

5. **No reply storms.** With 5 relays and the laptop's network
   flapping, the worst case is 5 × (one replay per backoff slot).
   If you swap repeatedly with the laptop, the second swap's
   replays should be 10s apart (per the backoff), the third 15s,
   etc. — visible in the `next-eligible-in` log values.

## Setup, both ends

- **Windows desktop** — the OTHER end this run. Doesn't swap. Static
  LAN.
- **Apple Silicon laptop** ("Neo") — the swap-side this run.
  Switching between LAN Wi-Fi and phone hotspot. **Note**: prior
  versions of this doc said the desktop was swapping. The user
  is now testing with the laptop swapping. Both sides need the
  patched build; the logic on the swap-side is where the fix
  primarily acts but the non-swap side benefits from the same
  patch on its own future swaps.

Both run `just dev` (which calls `pnpm install --frozen-lockfile`
then `pnpm tauri dev`). pnpm re-applies the patch on every install
via `patchedDependencies` in `package.json`. Vite's dep pre-bundle
is disabled for trystero packages (`vite.config.ts`
`optimizeDeps.exclude`) and `package.json`'s `postinstall` wipes
`node_modules/.vite` so patch changes always reach the dev bundle
on the next `just dev` — verify these stay in place.

## How to read the swap-side trace now

State-transition logs from the existing instrumentation:
- `<peerid>… first seen (announce)`
- `<peerid>… received offer <ofId> (we are answering)`
- `<peerid>… sending offer <ofId>`
- `<peerid>… replacing offer <old> (after Ns, no answer) with <new>`
- `<peerid>… STILL no answer for offer <ofId> after Ns`
- `<peerid>… received answer for <ofId> after Ns`
- `<peerid>… fresh → connected` / `… → connected`
- `<peerid>… connected → disconnected` (NB: this only fires via
  `clearConnectedPeer` in signal-handler.mjs; the strategy.mjs
  `onPeerLeave` path doesn't route through it, so leaves seen
  through `room.onPeerLeave` log via `[mesh] peer left` instead.
  Not a bug, just a quirk of the state-machine coverage.)
- `<peerid>… ICE health=transient — entered 7.5s grace`

New from this round:
- `<relay-host> replayed N subscription(s) on reconnect (attempt=M,
  next-eligible-in=Ks)` — fires per relay each time we successfully
  resubscribe after a reopen. The `next-eligible-in` value confirms
  the backoff schedule is moving as designed.

`[mesh] peer left` includes `pair=<localCandidateType>↔<remoteCandidateType>`
and `lived=Ns`. `[mesh] signaling: …` is change-gated (5-min
heartbeat), so silence during a stable gap is expected.

## Iterations that have already been tried

In commit order on this branch:

| Commit | What it did | What we learned |
|---|---|---|
| `8c01989` | Patched `state.offerAnswered = false` in `clearConnectedPeer` and `strategy.onPeerLeave` because we thought `offerAnswered` was sticky | **Wrong hypothesis.** `attachSharedPeerToRoom`'s `resetOfferState` already clears `offerAnswered` at connect time, so it's `false` by the time these callbacks fire. Kept the clears defensively. |
| `0f2e015` | Per-event diagnostic firehose | **Too noisy** — drowned the console. Replaced with state-transition logging in `ad8a1b9`. |
| `039de8d` | `vite.config.ts` `optimizeDeps.exclude` for trystero packages + module-load markers in the patch | **Real reliability fix.** Keep these. |
| `3581327` | `package.json` postinstall script that nukes `node_modules/.vite` | **Real reliability fix.** Belt-and-suspenders. Keep. |
| `9c7f688` | `shared-peer.mjs::getConnectedPeerHealth` returns `"transient"` for `connectionState === "disconnected"` | **Correct fix.** Right behavior; the upstream `"live"` short-circuit was too forgiving. Keep. |
| `ad8a1b9` | `flushStaleOfferPool` in `strategy.mjs::onPeerLeave` + state-transition instrumentation | **Correct fix for the offer-side stale-candidate problem, but not the bottleneck.** The 90s window persisted because we couldn't even RECEIVE announces — see this commit. |
| `<this>` | `utils.mjs::makeSocket` replays Nostr `REQ` subscriptions on every WebSocket reopen with 5/10/15/30/60s backoff | **Root-cause fix (pending in-the-wild verification).** The 90s gap was the relay forwarding zero events to a reconnected-but-resubscribed socket. |

## Why earlier hypotheses missed this

The prior round was looking at `peerStates[peerId]` and offer-pool
contents to explain why `handleAnnouncement` wouldn't send a fresh
offer. That assumed `handleAnnouncement` was being CALLED in the
first place — i.e. that announces were arriving. They weren't,
because subscriptions were dead at the relay. The state-transition
instrumentation logged nothing during the gap not because
`handleAnnouncement` early-returned, but because no message ever
made it to `createSignalHandler`.

The clue that broke this open: the signaling diag is **change-gated**
(`fingerprint_changed && heartbeat_due`), so total silence during
the 90s gap means "state is stable" — not "relays are down." Sockets
were sitting at `readyState === 1`, looking perfectly healthy, but
silently subscribe-less. The user's comment "starting a connection
is so fast, but reconnecting is impossibly slow" pointed straight
at this: cold start runs `subscribe()`; reconnect doesn't.

## If the patch doesn't help

If a verified swap on this build still shows 90s of dead air, here
are the most likely next places to look, in order:

1. **The patch isn't running.** Module-load markers are the
   sanity check. Also `grep -c "replayed.*subscription"
   dist/assets/nostr-*.js` should return ≥1 in the built bundle.
2. **The replays fire but the relay rejects them.** Some Nostr
   relays may close the connection on a duplicate-subId REQ
   instead of just refreshing the subscription. If you see
   `[trystero-patch] <host> replayed …` followed by another
   `WebSocket connection to 'wss://…' failed`, the replay
   triggered the rejection. Workaround: regen `subId` per
   reconnect (would require also updating Trystero's `msgHandlers`
   map to remap the new subId to the same handler — a deeper
   patch).
3. **The other side has a different bug.** Capture the non-swap
   side's trace (the desktop) during the same swap. Look for
   whether the desktop sees our resubscribe-triggered events
   in inbound EVENT counters. If the desktop's relays are
   forwarding our announces but the offer/answer still isn't
   completing, the issue moved into the WebRTC layer.
4. **The backoff is too long for the failure mode.** If
   reconnects come in bursts faster than 5s, the first replay
   fires but subsequent replays are deferred. Could shorten the
   first-slot to ~2s if that's what the trace shows.

## Files to know (unchanged from the prior handoff)

- `patches/@trystero-p2p__core@0.24.0.patch` — the patch file. Use
  `pnpm patch @trystero-p2p/core@0.24.0` to open an editable copy at
  `node_modules/.pnpm_patches/@trystero-p2p/core@0.24.0`, then
  `pnpm patch-commit <path>` to regenerate.
- `src/mesh-client.svelte.ts` — the application's mesh client.
  Constants: `RECONNECTING_GRACE_MS = 90_000`,
  `ICE_DISCONNECTED_RESTART_MS = 1_000`.
- `CONNECTION-ENGINE.md` — the architecture / journal doc.
  "Known upstream limitations" updated for this round.
- `vite.config.ts` — `optimizeDeps.exclude` keeps trystero out
  of the pre-bundle cache.
- `package.json` — `postinstall` nukes `.vite`; `patchedDependencies`
  applies the patch.

## What NOT to do (still applies)

- **Don't revert grace timing.** 90s remains a fine backstop for
  the rebuild path. We just shouldn't need it to fire.
- **Don't add log-spam per-event.** State transitions only.
- **Don't speculate without evidence.** Get a trace.
- **Don't trust pnpm "Already up to date".** Module-load marker is
  the only way to be sure the patched bundle is running.
