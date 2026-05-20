# Mesh re-handshake after LAN↔WAN swap — open handoff

You are continuing work on a real bug. **Read this whole file before writing
any code.** Multiple hypotheses have already been tried and disproven, and
the most recent fix did fire in the wild but still didn't solve the user's
problem. Be precise about which question you're answering before you
propose a change.

## What's broken (user-visible)

Two devices, MyOwnLLM running on each (Tauri desktop). They join the same
mesh ("cpjeeves-home") via Trystero's Nostr strategy. They connect, talk
for ~30 seconds, then the user switches the **desktop's** network (Wi-Fi
↔ Ethernet, different SSID). The desktop side detects the drop fast
(`peer left ICE=disconnected (5s ago)`) — that part works.

What **doesn't** work: the natural re-handshake. For 90 seconds after the
peer-left, no new offer/answer pair completes. Eventually the
`RECONNECTING_GRACE_MS = 90_000` timer expires and our own
`forceRediscovery()` fires a heavy `room.leave() + joinRoom()` rebuild,
which **always** reconnects within ~5 seconds. So the user lives with
~95s of "offline" UX every time they switch networks — feels broken.

The goal is to make the natural re-handshake work so we don't need to
fall back to the rebuild backstop.

## Branch / PR / repo

- Repo: `mrjeeves/MyOwnLLM`
- Branch: `claude/fix-ice-restart-timeout-XIDXj`
- PR: **#186** — open
- Latest commit at handoff time: `ad8a1b9` (see "Iterations" below for
  what each commit does)

## Setup, both ends

The two ends in the user's environment:
- A Windows desktop (the side that swaps networks)
- An Apple Silicon "Neo" laptop (the other end — confusingly called "Pi"
  in older messages; it is **not** a Raspberry Pi)

Both run `just dev` (which calls `pnpm install --frozen-lockfile` then
`pnpm tauri dev`). Both need the patched build deployed before testing.
The user already has both ends on this branch; **don't** assume their
machines are stale, but if a trace looks wrong ask them to confirm
`git log -1` matches.

A real reproduction is one network swap with both ends running this
branch and DevTools open on the swap-side. Filter the console for
`[trystero-patch]`.

## What the patch currently does

The patched files live in `node_modules/.pnpm/@trystero-p2p+core@0.24.0_patch_hash=*/node_modules/@trystero-p2p/core/dist/`
and the patch file is `patches/@trystero-p2p__core@0.24.0.patch`. pnpm
re-applies it on every install via the `patchedDependencies` field in
`package.json`. Vite's dep pre-bundle is disabled for trystero packages
(`vite.config.ts` `optimizeDeps.exclude`) and `package.json`'s
`postinstall` script wipes `node_modules/.vite` so patch changes always
reach the dev bundle on the next `just dev` — verify these stay in place.

Three functional changes to the upstream library are live:

1. **`shared-peer.mjs::getConnectedPeerHealth`** now returns `"transient"`
   (not `"live"`) when `connection.connectionState === "disconnected"`,
   even if `channel.readyState` is still `"open"`. This was a real bug:
   the data channel can linger at `"open"` for 15-30s after ICE has
   gone disconnected, and the upstream short-circuit prevented the
   existing 7.5s `disconnectedPeerGraceMs` window in
   `createSignalHandler` from ever engaging. The fix is correct and
   helps on the non-swap side.
2. **`signal-handler.mjs::clearConnectedPeer`** defensively clears
   `state.offerAnswered = false` (alongside the existing `connectedPeer
   = null`). Tracing shows `offerAnswered` is usually already false at
   this point because `attachSharedPeerToRoom` calls `resetOfferState`
   at connect time — but the defensive clear is free.
3. **`strategy.mjs::flushStaleOfferPool`** (this is the one the user is
   currently testing): the `room`'s `onPeerLeave` callback destroys
   every pre-cached peer in `pool.pool`, throttled to once per 10s.
   The hypothesis was that `OfferPool.warmup()` pre-allocates 20
   offer-peers whose `getOffer()` SDP bakes in our pre-swap ICE
   candidates, so post-swap checkouts hand out unanswerable offers
   for the first ~57s until `offerTtl` fires the `restartIce` branch.
   `OfferPool.checkout` handles an empty pool by allocating fresh
   peers on demand.

Instrumentation is state-transition based (see `_mom*` helpers in
`signal-handler.mjs` plus a couple of hooks in `strategy.mjs`). Logs
fire on lifecycle transitions and on stuck thresholds (15s/30s/60s/120s
since an unanswered offer). **Do not regress this to a per-event
firehose** — the user explicitly called that out as making things
worse. If you need more visibility, add a tracked event with a clear
single-line log, not a `console.warn` in a hot path.

Module-load markers (`[trystero-patch] signal-handler.mjs loaded` and
`[trystero-patch] strategy.mjs loaded`) fire once per page load and let
the user confirm at-a-glance that the patched build is running. Don't
remove them.

## Latest trace (commit `ad8a1b9` in the wild)

The user reproduced one swap and shared the full DevTools console. Key
lines, in order:

```
[trystero-patch] signal-handler.mjs loaded
[trystero-patch] strategy.mjs loaded
[trystero-patch] MmInySIg… first seen (announce)
[trystero-patch] MmInySIg… received offer 63ilGb5x (we are answering)
[trystero-patch] MmInySIg… fresh → connected (held 0s)
[mesh] peer joined: MmInySIg…
[mesh] auth ok with fustnkbg… (approver=false)
[mesh] peer active: fustnkbg…
... (34s of healthy connection) ...
[mesh] ICE disconnected >1s for MmInySIg… — kicking restartIce()
[trystero-patch] MmInySIg… ICE health=transient — entered 7.5s grace
[mesh] peer left: MmInySIg… — ICE=disconnected (5s ago), pair=host↔host, lived=34s
[trystero-patch] offer-pool flushed 20 stale entries (reason=peer-left:MmInySIg)
... (90 seconds of silence from trystero-patch — only [mesh] signaling diag firing) ...
[mesh] 1 peer(s) aged out of reconnecting grace — now offline
[mesh] auto rediscovery #1 — kicking rediscovery
[mesh] rediscovery — leaving and rejoining mesh room
... (mesh restarts) ...
[trystero-patch] MmInySIg… received offer mpu6F7H2 (we are answering)
[mesh] peer joined: MmInySIg…  ← post-rebuild reconnect
```

This trace is decisive on three things:

1. **The flush fires** (`offer-pool flushed 20 stale entries`) at the
   right moment. Good. But it doesn't help in this scenario, because:
2. **We are the answering side in both attempts** (`received offer
   63ilGb5x` initially, `received offer mpu6F7H2` post-rebuild). The
   pool flush only matters for the side that **sends** offers. The
   other end (Apple Silicon laptop) is the leader. Our pool is
   irrelevant here.
3. **The leader (MmInySIg) doesn't send a fresh offer for 90s**. We
   keep sending it `{peerId: selfId}` announce-back-ids (the
   non-leading-side response to incoming announcements — silently, no
   log), and it never responds with a new offer. Then our local
   `forceRediscovery` rebuilds the room, and *immediately* after our
   rejoin presence event lands, MmInySIg sends offer `mpu6F7H2` and
   we're reconnected within seconds.

That last point is the open question.

## The open question

**Why does the leader (MmInySIg) only send us a fresh offer after our
local rebuild, and not in response to the 90 seconds of regular
presence announces we send beforehand?**

From our pre-rebuild perspective, we send the leader the same kind of
Nostr presence events we always send. From the leader's
`createSignalHandler` perspective, those events arrive as
announcements. With both ends on this branch, the leader's state for
us should be:

- `state.connectedPeer = null` (cleared by their own
  `strategy.onPeerLeave` when their underlying connection to us died)
- `state.offerAnswered = false` (cleared by `attachSharedPeerToRoom`'s
  `resetOfferState` at connect time, and again defensively by our
  patched `clearConnectedPeer`)
- `state.answeringPeer = null`
- `state.offerPeer = null`
- `state.offerRelays = []`

If all that holds, their `handleAnnouncement` should reach
`ensureOffer → signalPeer(offer)` and send us a new offer. It
doesn't, for 90s. **Something on the leader's side is preventing the
new offer.**

Possibilities the next agent should chase, in rough order of likelihood:

### Hypothesis A: the leader's connection state hasn't actually been cleared

`strategy.onPeerLeave` only fires when `room.mjs`'s `exitPeer` runs,
which only runs when `binding.handlers.close` fires, which only runs
when `SharedPeerManager.clear` runs, which only runs when the raw
peer's underlying close event fires. On the **non-swap** side, that
close event might not fire until WebRTC's full ICE consent freshness
timeout (15-30s). During that window, the leader's `state.connectedPeer`
is still set; our patched `getConnectedPeerHealth` returns
`"transient"`; `createSignalHandler` would clear via the 7.5s grace —
**but only when it receives a message from us with the peer attached**.

The leader receives Nostr presence events from us (just `{peerId:
selfId}`). The signal-handler code path for an announcement with
`state.connectedPeer` set is:

```js
if (connectedPeer && state) {
    const health = getConnectedPeerHealth(connectedPeer);
    if (health === "live") return;
    // ... transient grace handling ...
}
```

If the leader's local PC state is `"disconnected"`, `health =
"transient"`, the grace window engages, and after 7.5s of incoming
announces from us their `state.connectedPeer` is cleared. Then the
next announce should trigger `handleAnnouncement` → fresh offer.

If the leader's local PC state stays `"connected"` (their channel
appears healthy from their side even though the link is dead), then
`health = "live"` and they early-return on every announce forever.

**Action for next agent:** get a trace from the leader's side during
a swap. The user has tested both sides on this branch. Ask them to
open DevTools on the **non-swap** end and reproduce. Look for what
`getConnectedPeerHealth` returns when our messages arrive after our
network change. If it stays `"live"`, the patch needs to also consider
`iceConnectionState === "disconnected"` and possibly RTT-based
liveness signals.

### Hypothesis B: the leader's offer pool is also stale somehow

Less likely — the leader's IP didn't change. But their pool peers
might have been created during a period where their network was
flapping. Their `peer.created` timestamps and `offerTtl` interaction
might be relevant. Check: when the leader does eventually send a
post-rebuild offer, is it from a fresh pool peer or a long-cached one?

### Hypothesis C: the answer is being sent but lost in transit

We're confident the leader doesn't send a fresh offer because our
`handleOffer:received offer` log doesn't fire. But there could be a
Nostr relay routing issue where messages from the leader to us during
the 90s window go via a different path than messages after our
rebuild. The user's mesh routes via 5 Nostr relays. Check whether
the `signaling: 5/5 open` lines during the wait window show inbound
EVENTs from the leader's pubkey (the trace shows two authors
`cfe5d8aa…` and `11b21a59…` — figure out which is the leader).

### Hypothesis D: there's a third state field I haven't identified

`signal-handler.mjs` has a few more state fields I haven't fully
chased: `offerInitPromise`, `offerExpiryTimer`, `offerSignalRelays`,
`offerSignalBacklog`, `offerRelayTimers`, `pendingCandidates`. One
of these might be stuck on the leader's side after disconnect.
`pendingCandidates` is the one I'd suspect most — if it accumulated
stale ICE candidates during the dying connection, the leader might
be trying to apply them to the new answer-peer and failing silently.

### Hypothesis E: it's not the leader, it's that *our* peer state is
gone on their side

When OUR side fires `room.leave()` during the rebuild, the leader
should see our connection vanish (Nostr stops publishing our
presence to them briefly, then a fresh-room presence event arrives).
Maybe what unsticks them isn't our re-presence but the *gap* — they
might have something gated on "we haven't seen this peer for X seconds,
treat them as new". If so, an equivalent on the swap side would be a
mechanism to explicitly tell the leader "discard your state for me".
This is hard to do without their cooperation, but Trystero's
`{peerId: selfId, hasOutgoingOffer: ...}` payload has a
`hasOutgoingOfferHint` field we could repurpose — or we could add a
new payload flag in the patch.

## Iterations that have already been tried

In commit order on this branch, what we tried and what we learned:

| Commit | What it did | What we learned |
|---|---|---|
| `8c01989` | Patched `state.offerAnswered = false` in `clearConnectedPeer` and `strategy.onPeerLeave` because we thought `offerAnswered` was sticky | **Wrong hypothesis.** `attachSharedPeerToRoom`'s `resetOfferState` already clears `offerAnswered` at connect time, so it's `false` by the time these callbacks fire. The patch was a no-op. Kept the clears defensively. |
| `0f2e015` | Per-event diagnostic firehose | **Too noisy** — drowned the console. User explicitly called this out. Replaced with state-transition logging in `ad8a1b9`. |
| `039de8d` | `vite.config.ts` `optimizeDeps.exclude` for trystero packages + module-load markers in the patch | **Real reliability fix.** pnpm-patch changes were getting lost in vite's dep pre-bundle cache. Module-load markers let us verify the patched bundle is what's running. Keep these. |
| `3581327` | `package.json` postinstall script that nukes `node_modules/.vite` | **Real reliability fix.** Same problem, belt-and-suspenders on top of `optimizeDeps.exclude`. Keep this. |
| `9c7f688` | `shared-peer.mjs::getConnectedPeerHealth` returns `"transient"` for `connectionState === "disconnected"` | **Correct fix.** This is the right behavior — the upstream `"live"` short-circuit was too forgiving. Helps on the non-swap side specifically. Keep this. |
| `ad8a1b9` (current) | `flushStaleOfferPool` in `strategy.mjs::onPeerLeave` + state-transition instrumentation | **Functional but insufficient.** The flush fires correctly (verified in trace), but it only helps the side that sends offers, and the user's test scenario has them as the *answering* side. Need to investigate the leader's behavior. |

## Files to know

- `patches/@trystero-p2p__core@0.24.0.patch` — the patch file. Do not
  edit this directly; use `pnpm patch @trystero-p2p/core@0.24.0` to
  open an editable copy, then `pnpm patch-commit <dir>` to regenerate
  the patch. The editable copy lives at
  `node_modules/.pnpm_patches/@trystero-p2p/core@0.24.0`.
- `src/mesh-client.svelte.ts` — the application's mesh client.
  Constants worth knowing: `RECONNECTING_GRACE_MS = 90_000`,
  `ICE_DISCONNECTED_RESTART_MS = 1_000`. The `forceRediscovery` path
  (the heavy rebuild backstop) is at `forceRediscovery` / `reconcile`.
- `CONNECTION-ENGINE.md` — the architecture / journal doc. Section
  "Known upstream limitations (and how we patch them)" is the current
  state-of-knowledge; the journal at the bottom is the chronological
  history. **Update both** when you ship a real fix.
- `vite.config.ts` — `optimizeDeps.exclude` keeps trystero out of the
  pre-bundle cache.
- `package.json` — `postinstall` nukes `.vite`; `patchedDependencies`
  applies the patch.

## What NOT to do

- **Don't revert grace timing back to 30s.** The user has called out
  that giving up by making the rebuild fire fast is not the answer.
  90s of grace gives the natural re-handshake room to engage. Find
  the bug.
- **Don't add log-spam per-event.** State transitions only. If you
  need volume during a specific debugging session, gate it behind a
  `localStorage.trysteroPatchVerbose` flag so it's off by default.
- **Don't speculate without evidence.** Every hypothesis above came
  from a clear signal in a trace. Get a trace before changing code.
- **Don't trust pnpm "Already up to date".** On Windows in
  particular, pnpm's patch-application check is unreliable. The
  module-load marker is the only way to be sure the patched bundle
  is running. If the marker isn't in the console, something is
  wrong — typical fix is `Remove-Item -Recurse -Force node_modules
  && just dev`. The postinstall + `optimizeDeps.exclude` should
  prevent this but don't always.

## Reading the diag logs

State-transition logs:
- `<peerid>… first seen (announce)` — first announcement from this peer
- `<peerid>… received offer <ofId> (we are answering)` — they led
- `<peerid>… sending offer <ofId>` — we led, first send for this offer
- `<peerid>… replacing offer <old> (after Ns, no answer) with <new>` — we generated a new offer
- `<peerid>… STILL no answer for offer <ofId> after Ns` — stuck (15s/30s/60s/120s thresholds)
- `<peerid>… received answer for <ofId> after Ns`
- `<peerid>… fresh → connected (held 0s)` — handshake completed
- `<peerid>… connected → disconnected (held Ns) lived=Ns reason=...`
- `<peerid>… ICE health=transient — entered 7.5s grace` — connection unhealthy
- `offer-pool flushed N stale entries (reason=...)` — our pool flush fired

Application-level mesh logs are tagged `[mesh]` and come from
`mesh-client.svelte.ts`. The `peer left` line includes
`pair=<localCandidateType>↔<remoteCandidateType>` and `lived=Ns`
which are useful.

## Suggested first 30 minutes

1. Read this file. Read `CONNECTION-ENGINE.md`'s "Known upstream
   limitations" section.
2. Skim the latest trace excerpt above. Identify the 90-second silent
   window.
3. Pull the branch and run a no-swap sanity check (`git pull && just
   dev` on either machine, watch for the two module-load markers).
4. **Before writing any patch code**, ask the user to capture a
   trace from the *other* end (non-swap side) during a swap.
   Specifically, you want to see what their `getConnectedPeerHealth`
   returns when our presence announce arrives after our network
   change. That trace will tell you whether Hypothesis A or some
   other one is right.

## Caveats / gotchas

- The user has two devices: **Windows desktop** (the swap-side) and
  **Apple Silicon laptop** (the other end). Older messages call the
  laptop "Pi" — this is incorrect, it's a Mac.
- Trystero's `selfId` is generated once per `import` of the library.
  In one trace we saw the laptop's `selfId` change between cycles
  (`mKkDmcjz` → `wdMvW9K2`) — that means their app/process restarted
  between cycles. Don't assume the same selfId across reproductions.
- The user is sometimes Windows PowerShell. Common gotcha:
  execution policy. They have it set to `RemoteSigned -Scope
  CurrentUser` now. If a fresh test machine has issues, that's
  probably the cause.
- `just dev` runs `pnpm install --frozen-lockfile` then `pnpm tauri
  dev`. The frozen-lockfile flag means pnpm won't update the
  lockfile even if the patch changes — but it does still re-apply
  patches whose hash matches the lockfile entry, so this is fine in
  the common case.

Good luck. The user has been patient through five iterations. Be
honest about what you find.
