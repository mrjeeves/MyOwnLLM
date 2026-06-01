# Myo — Decisions & Rationale

This file records **why** Myo is shaped the way it is. `PLAN.md` says *what* to
build; this says *why*, plus the alternatives that were considered and rejected.
Read it before changing any of these — they were deliberate product calls made
with the project owner, not defaults. If you think one is wrong, raise it
explicitly; don't quietly drift.

> **The north star.** *Myo **is** the AI — not an app with an AI inside it.* One
> voice-first (touch-second, type-third) full-service agent with its own brain,
> ears, voice, memory, networking, and files. **The interface dissolves into the
> conversation:** the user mostly just talks and *watches the agent work*. UI is
> an *output of the agent*, materialized on the fly — never a fixed frame the
> agent lives inside. A thin mid-layer lets the user step in to approve, tweak,
> or edit at any moment. Everything runs and stays **local**.

---

## The architectural pre-commitments (settled before the five forks)

These were established from the code audit (see `odysseus-integration.md`,
`myownllm-integration.md`) and frame everything else:

1. **Build *around* Odysseus as the brain — no fork, no Myo-native tool system.**
   Odysseus already has the agent loop, tools, RAG, memory, email/calendar/docs,
   research, and TTS. Myo does **not** reimplement any of it and does **not**
   add a parallel MCP/tool system. Odysseus is tracked **upstream** as a
   loosely-coupled local sidecar (REST + SSE). The only thing Odysseus lacks
   (mid-run per-action approval) is added later as a **no-op-by-default,
   upstreamable** hook — never a divergent patch.
   - *Rejected:* forking Odysseus, or building a second agent loop in Myo. Both
     create permanent maintenance divergence and throw away a deep, working brain.

2. **Single brain in v1 = Odysseus's agent loop.** Myo's shell is a thin
   orchestrator + renderer. MyOwnLLM's own agent loop returns *later* as an
   offline/local brain behind the same `engines::brain` seam.

3. **MyOwnLLM = ears + model engine; MyOwnMesh = networking (v2).** Reuse
   MyOwnLLM's excellent ASR/diarization (extracted as a `myo-asr` crate) and its
   `:1473` OpenAI-compatible server (auto-registered as Odysseus's model
   provider). Mesh/multi-device is deferred to v2.

4. **"The AI serves UI" is *partly real today.*** Odysseus's `/api/tools/*/render`
   iframe route is an unused stub — but its agent loop already emits a rich
   **intent stream** (streamed documents, `ui_control` panel directives, tool
   activity). Myo's job is to **render that stream natively** (voice/touch-shaped)
   and extend it — *not* to invent generative UI from scratch.

---

## The five product forks (decided with the owner)

### Fork 1 — How do three projects become one? → **One fresh "Myo" shell over three engines**

- **Chosen:** a brand-new Tauri 2 + Svelte 5 shell ("Myo") that is a **renderer of
  agent intent**, orchestrating Odysseus / MyOwnLLM / MyOwnMesh as swappable
  "senses" behind one internal **Myo Core API**.
- **Why:** the vision needs a voice-first, dissolved interface. Neither existing
  UI is that. A *thin* shell over swappable engines keeps every underlying
  project independently upstream-trackable (no fork) while giving Myo total
  freedom over the experience.
- **Rejected:**
  - *Extend MyOwnLLM's UI in place* — it's model-management-shaped, not a
    dissolved agent companion; would entangle Myo with MyOwnLLM's release cycle.
  - *Extend Odysseus's PWA* — it's a web chat UI, not voice-first, and lives in
    the Python repo we want to track upstream untouched.
  - *Loose multi-app federation* — three apps is the opposite of "Myo is the AI."
- **Consequence:** the shell is **a registry of surface-kind → component**, not a
  set of fixed screens. Adding a new agent-emitted surface = registering a
  renderer. That extensibility *is* the "dissolved/generative UI."

### Fork 2 — How does the user control the agent? → **Four category toggles: Web / Files / Code / Reach-out**

- **Chosen:** a Control surface with **four coarse capability toggles** —
  **Web**, **Files**, **Code**, **Reach-out** — each composed onto Odysseus's
  *existing* permission knobs (`disabled_tools` + per-turn `allow_bash` /
  `allow_web_search`, with the admin/public role as backstop). Default posture:
  **Web on, others off.** Per-action approve/tweak/edit is the **next** layer
  (tier-b), not v1.
- **Why:** voice-first means control must be *glanceable and calm*, not a
  spreadsheet of switches. Four plain-language categories map cleanly onto the
  real tool families and — crucially — cost **zero Odysseus changes** (coarse
  control for free by driving knobs that already exist). The agent can even flip
  them itself via `ui_control toggle`.
- **Rejected:**
  - *Granular per-tool allowlist* — too fiddly; wrong altitude for voice.
  - *A single "autonomy" slider* — too coarse/opaque; users can't reason about it.
  - *No visible control ("just trust it")* — loses the trust a full-service local
    agent needs; the owner explicitly wants a step-in layer.
- **Consequence:** tier-a (knob-driving) ships in v1 with no fork. The
  **fine-grained per-action approval** (pause a mutating tool → approve/tweak/edit
  → resume) is a minimal, **upstreamable, no-op-by-default** callback at
  Odysseus's single tool-execution choke point — the immediate next milestone.
  See `odysseus-integration.md` §9–§10.

### Fork 3 — How does the user talk to Myo? → **Open-mic + barge-in (full-duplex)**

- **Chosen:** **always-listening open mic** with **barge-in** (interrupt by
  speaking) and an always-visible **hard-mute**. The home surface is an **ambient
  presence indicator** (listening / thinking / speaking), *not* a push-to-talk
  button.
- **Why:** this is the most "dissolved," calmest interaction — you just talk, like
  to a person, and interrupt naturally. It is the strongest expression of "Myo is
  the AI."
- **Rejected:**
  - *Push-to-talk* — reintroduces a button/frame; not dissolved. (Kept only as the
    **degraded** mode where a webview lacks usable echo cancellation, and as the
    CI/headless path.)
  - *Wake-word ("Hey Myo")* — adds friction and a false-trigger surface; a
    companion you're already in a session with shouldn't need summoning.
- **Consequence (the hard engineering bit):** full-duplex demands **echo
  cancellation so the ASR never hears the TTS.** Therefore **audio capture lives
  in the WebView** (`getUserMedia({echoCancellation,noiseSuppression,
  autoGainControl})`), a browser VAD (Silero via onnxruntime-web) does
  endpointing, PCM frames stream to `myo-asr`, and **TTS plays in the same audio
  context as the AEC reference.** Barge-in = VAD-during-playback → cancel + duck.
  `myo-asr`'s own `cpal` path becomes the headless/CI capture. **ASR is local, so
  always-on audio never leaves the device.** AEC quality must be validated
  *per-webview* (CoreAudio / WebKitGTK / WebView2).

### Fork 4 — How does the user *watch the agent work*? → **A single evolving stage + recallable history**

- **Chosen:** one focal **Stage** at a time, with finished surfaces collapsing
  into a **History** you can recall (by voice or touch), plus an **ambient
  ActivityStrip** for the live tool feed and a persistent **Presence** orb for
  voice state. So the screen is: **Presence orb + Stage + ActivityStrip +
  HistoryRail.**
- **Why:** voice-first means *looking*, not window-managing. A single evolving
  stage is calm and never makes the user arrange panes. History keeps everything
  recoverable; the ambient strip keeps "watch it work" always glanceable.
- **Focus policy (important):** a streaming artifact or an agent-opened panel
  takes the Stage; the **live tool feed *is* the Stage when nothing else is
  live**, otherwise it demotes to the ambient strip; the agent (`ui_control`) or
  the user (`myo_surface_action recall`) can redirect focus; **blurred surfaces
  park in History with their state intact** and are recallable by voice ("bring
  back that doc") via a **per-session surface referent registry** (stable
  surfaceId + kind + title) that makes deixis like "that document" resolvable.
- **Rejected:**
  - *Tabbed / multi-window workspace* — window management is exactly what
    voice-first should dissolve.
  - *Ephemeral surfaces (vanish on blur)* — breaks "watch it work" continuity and
    voice recall ("go back to…").
  - *Dashboard grid* — a fixed frame; contradicts "surfaces materialize from
    agent intent."

### Fork 5 — How much does Myo remember? → **Continuous presence (automatic local memory)**

- **Chosen:** Myo is **one ongoing relationship, not sessions.** Odysseus's
  **memory + RAG run on by default**, so Myo recalls across turns and days
  ("last time you…") with no thread management. A subtle "recalled from memory"
  cue shows when it draws on the past.
- **Why:** this is the most companion-like, most "Myo is the AI" option — and the
  **lowest-build**, since Odysseus already has the memory machinery
  (`manage_memory`, RAG retrieval, the `memories_used` event, incognito gating).
- **Counterweight (mandatory):** a thing that remembers everything must be
  **visible, forgettable, and pausable.** So: a **Memory surface** to review and
  forget, and **one-tap incognito** to stop recording — all **local, nothing
  leaves the device.** Reuse Odysseus's existing incognito flag.
- **Rejected:**
  - *Topic/session threads* — organized but tool-like, less "eternal companion."
  - *Presence + named threads (hybrid)* — nice, but more to build/explain than v1
    needs; can come later.
  - *Ephemeral + opt-in memory* — max privacy but least magical and most user
    effort; wrong default for a companion.

---

## Logistics decisions

- **Myo's code home → its own `mrjeeves/Myo` repo.** (This handoff lives on a
  MyOwnLLM branch only because the authoring environment was scoped to
  `odysseus` / `MyOwnLLM` / `MyOwnMesh` and could not push a new repo. See
  `getting-started.md`.)
- **Platforms → all 5 targets from day one:** `windows-x86_64`, `linux-x86_64`,
  `linux-aarch64`, `macos-x86_64`, `macos-aarch64` (Windows x64 only — no
  Windows-on-ARM). The owner's test fleet spans all five. CI = 5-target matrix;
  mic-permission + WebRTC/AEC wired for macOS (CoreAudio), Linux (WebKitGTK), and
  Windows (WebView2).
- **Vendored Odysseus → git submodule** for dev; freeze/pin for the end-user
  installer.

---

## Things that are explicitly **out of scope for v1** (don't build these yet)

- Fine-grained per-action approval (tier-b) — *next* milestone, hook is designed.
- Multi-device / mesh (MyOwnMesh) — v2.
- Offline/local brain (MyOwnLLM agent loop) — later.
- Native renderers for *every* `ui_control` panel target — v1 renders what it has
  and **gracefully ignores unknown kinds** (log + skip); new ones are added by
  registering a renderer.
- Consolidating the two model catalogs / de-duping `myo-asr` back into MyOwnLLM —
  fast-follow, not v1-blocking.
