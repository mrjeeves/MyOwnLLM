# Myo — Integration Plan

## Context

You maintain three complementary local-AI projects: **Odysseus** (`/home/user/odysseus`, Python/FastAPI + JS-PWA — a deep agentic brain: agent loop, tools, RAG, email/calendar/docs/research, TTS; v0.9.1, MIT, third-party), **MyOwnLLM** (`/home/user/MyOwnLLM`, Tauri 2 + Svelte 5 — excellent voice-in ASR/diarization, automatic hardware-tier model selection, an OpenAI server on `:1473`, one-line install), and **MyOwnMesh** (`/home/user/MyOwnMesh`, pure-Rust tailscale-less mesh: WebRTC + Nostr signaling + ed25519 + 6-char pairing; already embedded by MyOwnLLM).

**The vision: Myo *is* the AI — not an app with an AI inside it.** Myo is a single, **voice-first (touch-second, type-third)** full-service agent with its own brain, ears, voice, networking, and file systems. Critically, **the interface dissolves into the conversation**: the user mostly just talks and *watches the agent work*. UI is not a fixed frame the agent lives in — UI surfaces are an **output of the agent**, materialized on the fly when the agent decides they help (a document, a file view, an editor, a panel). A thin **mid-layer** lets the user step in at any moment to **approve, tweak, or fully edit** what the agent is doing or what it surfaced — but the default is converse-and-watch.

**Binding decisions:**
1. **Spine = a fresh "Myo" shell over 3 engines** (new Tauri 2 + Svelte 5), orchestrating the projects as swappable engines ("senses") behind one internal API. The shell is a **renderer of agent intent**, not a set of fixed screens.
2. **Odysseus = the brain, tracked upstream** as a loosely-coupled local sidecar (REST). No divergent forks.
3. **Build *around* Odysseus — no Myo-native MCP, no parallel tool system.** Myo plugs into Odysseus as the brain and adds control **screens/layers** on top. Control comes in two tiers: **(a) coarse — free, zero Odysseus change** — Myo drives Odysseus's *existing* permission knobs (`disabled_tools`, per-turn `allow_bash`/`allow_web_search`, admin/public role) from a Myo control surface, surfaced as **4 category toggles — Web / Files / Code / Reach-out**; **(b) fine-grained per-action approve/tweak/edit** — a minimal, no-op-by-default, **upstreamable** pause/resume hook at Odysseus's one tool-execution choke point (the only thing Odysseus genuinely lacks), as the next layer after v1.
4. **v1 = voice round-trip + dissolved UI surfaces**: speak → transcribe (MyOwnLLM ASR) → answer (Odysseus agent) → speak back (Odysseus TTS), **with Myo natively rendering the agent's live intent stream** (activity, streamed document artifacts, and the agent's own `ui_control` panel directives) **and a control surface driving Odysseus's existing permission knobs** (tier-a). Fine-grained approval (tier-b) is the immediate next milestone. Mesh/multi-device deferred.
5. **Myo is a continuous presence, not sessions.** One ongoing relationship — Odysseus's **memory + RAG run on by default**, so Myo recalls across turns and days ("last time you…") with no thread management. The counterweight for a thing that remembers everything: memory stays **local-first, visible, and forgettable** (a Memory surface to review/forget) with one-tap **pause/incognito**, reusing Odysseus's existing incognito gating. Nothing leaves the device.

---

## What the code already gives us (decisive findings)

**"The AI serves UI as it sees fit" is *partly real today.*** The `/api/tools/*/render` iframe routes are an unused stub (`core/middleware.py:58`), but Odysseus's agent loop already emits a rich **intent stream** that *is* agent-driven UI. Myo's job is to **render that stream natively (voice/touch-shaped) and extend it** — not to invent generative UI.

**Odysseus is *not* permission-less — it has a layered authorization model**, just not interactive per-action approval:
1. **Role gating** — a defined sensitive-tool set (`bash`, `python`, `read/write_file`, `send_email`, `manage_*`, `vault_*`, all `mcp__*`) blocked for non-admin/public users (`tool_security.py:14-53`, enforced `tool_execution.py:550`).
2. **Per-turn capability flags** — `allow_bash`, `allow_web_search`, + mode/incognito gating, set by the *caller* on each `chat_stream` request (`chat_routes.py:386-414`).
3. **Persistent `disabled_tools`** allowlist in settings — editable via a route and by the agent itself (`agent_loop.py:1250`, `model_routes.py:1208-1222`, `tool_implementations.py:1662-1688`).
4. **Per-MCP-server tool disabling** (`mcp_routes.py:314-331`); **scoped API tokens** (`app.py:217-249`); admin/2FA auth.

**What's missing:** mid-run, per-action "approve THIS call before it runs" consent — approved tools run to completion (`tool_execution.py:537-560`). **So Myo gets *coarse* control for free** by driving knobs (1)-(3) from a control surface; only *fine-grained* per-action approval needs the minimal hook at `execute_tool_block()` (`tool_execution.py:477,537-560`).

---

## Architecture

```
        ┌──────────────────────────── Myo (Tauri 2 + Svelte 5) ────────────────────────────┐
 voice ►│  VOICE/CONVERSATION SPINE   ── open-mic; talk + watch + barge-in                  │
 touch ►│        │                                                                          │
 type  ►│   Surface Renderer  ◄── normalized myo:// intent stream ──┐                       │
        │   (registry: surface-kind → Svelte component; the         │                       │
        │    "dissolved UI" — assistant text, activity feed,        │                       │
        │    editable document artifact, agent-driven panels,       │                       │
        │    + Control surface driving Odysseus's permission knobs)  │                       │
        │        ▲ user edits/actions/capability toggles            │                       │
        │   ─────┼──────────────────────────────────────────────────┤  Myo Core API         │
        │   engines/ (swappable "senses")                            │  (Tauri cmds+events)  │
        │     brain_odysseus  ──┐        asr_local ──┐               │                       │
        └───────────────────────┼───────────────────┼───────────────┴───────────────────────┘
                  HTTP (loopback)│        in-process │ (linked crate)
              ┌──────────────────▼───┐   ┌───────────▼──────────┐   ┌──────────────────────┐
              │ Odysseus uvicorn:7000│   │ crates/myo-asr       │   │ MyOwnLLM serve :1473  │
              │ = BRAIN (agent loop, │   │ = EARS (Moonshine/   │   │ = MODEL ENGINE        │
              │ tools, TTS, +existing│   │ Parakeet + diarize)  │   │ (auto-registered as   │
              │ permission knobs)    │   └──────────────────────┘   │  Odysseus's provider) │
              │ + [next] approval hook                              └──────────────────────┘
              └──────────────────────┘
   MyOwnMesh = NETWORKING (deferred to v2).   Files = Odysseus read/write_file + doc workspace.
```

**Senses map:** brain = Odysseus agent loop; ears = `myo-asr`; voice = Odysseus TTS (+ WebSpeech fallback); model engine = MyOwnLLM `:1473`; networking = MyOwnMesh (v2); files = Odysseus `read_file`/`write_file` + versioned document workspace. **Control = Myo drives Odysseus's existing knobs (v1) + the upstreamable per-action hook (next).**

**Single brain in v1:** Odysseus's agent loop. Myo's shell is a thin orchestrator + renderer; no second agent loop, **no Myo-native MCP/tool system** — Myo builds around Odysseus. MyOwnLLM's own agent loop returns later as an offline/local brain behind the same `engines::brain` seam.

---

## Verified contracts (code-confirmed)

**Engine wiring**

| Concern | Contract | Source |
|---|---|---|
| Brain health/version | `GET /api/health`→`{"status":"healthy"}`; `GET /api/version`→`{"version":"0.9.1"}` (auth-exempt) | `odysseus/app.py:122-123,669` |
| Loopback auth | Header `X-Odysseus-Internal-Token:<tok>` + `X-Odysseus-Owner:<user>`, 127.0.0.1/::1 only; `tok`=env `ODYSSEUS_INTERNAL_TOKEN` (set before uvicorn boots). `require_admin` honors it → admin routes work with no account. | `odysseus/app.py:172-186`; `odysseus/core/middleware.py:16-44` |
| Chat (agent, streaming) | `POST /api/chat_stream`, **multipart form** `message`,`session`,`mode=agent` (+ capability flags below); **SSE** (vocab below) → `data:[DONE]` | `odysseus/routes/chat_routes.py:189-246` |
| Session | `POST /api/session` (one per conversation, reuse id) | `odysseus/routes/session_routes.py:162` |
| TTS | `POST /api/tts/synthesize` `{text,format:"base64"}`→`{"audio":"<b64>"}`. **503 unless a provider enabled** — default `tts_provider="disabled"`. | `odysseus/routes/tts_routes.py:30-66`; `odysseus/src/settings.py:43` |
| Point brain→MyOwnLLM | `POST /api/model-endpoints` (form `base_url=http://127.0.0.1:1473/v1`,`model_type=llm`,`supports_tools=true`). **Auto-sets default endpoint+model when none configured.** | `odysseus/routes/model_routes.py:808-888` (auto-default `872-877`) |
| Model engine | `myownllm serve --port 1473`; `GET /healthz`, `/v1/models`, `/v1/chat/completions`. No transcription over HTTP. | `MyOwnLLM/src-tauri/src/api.rs:69-76,114-200` |
| ASR seam | One-method trait `FrameSink::emit_frame(event,frame)`; only Tauri coupling = `impl FrameSink for WebviewWindow` (10 lines); `CaptureSink` runs it windowless. | `MyOwnLLM/src-tauri/src/frame_sink.rs:23-40` |
| Sidecar supervision | `DaemonChild` (kill-on-`Drop`), candidate-path resolution, probe-then-spawn; `quiet_command`; `externalBin`. | `MyOwnLLM/src-tauri/src/mesh/daemon.rs:457-920`; `MyOwnLLM/src-tauri/src/process.rs:20` (**not** `mesh/process.rs`); `.../tauri.conf.json` |

**Agent intent stream (the "dissolved UI" protocol Myo renders)** — emitted by `/api/chat_stream` / `src/agent_loop.py`:

| Event `type` | Shape (keys) | Myo surface |
|---|---|---|
| `delta` | `{delta}` | assistant text → TTS |
| `tool_start` / `tool_progress` / `tool_output` | `{tool,command,round}` / `{tool,round,progress}` / `{tool,command,output,exit_code, image_url?,screenshot?,doc_id?,ui_event?}` | **activity feed**, inline image/screenshot |
| `doc_stream_open` / `doc_stream_delta` / `doc_update` / `doc_suggestions` | `{title,language}` / `{content}` / `{doc_id,title,language,content,version}` / `{doc_id,suggestions[]}` | **editable document artifact surface** |
| `ui_control` | `{data:{ui_event: open_panel\|toggle\|set_mode\|switch_model\|set_theme\|highlight\|open_email_reply, …}}` | **agent-driven UI** — Myo honors directives natively |
| `agent_step` / `agent_prep` / `budget_exceeded` | `{round}` / … / `{limit,used}` | progress / "thinking" |
| `research_*`, `web_sources`, `rag_sources`, `memories_used`, `model_info`, `compacted`, `metrics`, `message_saved` | various | ancillary surfaces / metadata |

**Control knobs Myo drives (existing — no fork):** per-turn `allow_bash` / `allow_web_search` (+ mode/incognito) on each `chat_stream` form (`chat_routes.py:386-414`); persistent `disabled_tools` via route/settings (`model_routes.py:1208-1222`, read `agent_loop.py:1250`); admin-vs-public role gate over the sensitive set (`tool_security.py:14-74`); per-MCP disables (`mcp_routes.py:314-331`); token scopes (`app.py:217-249`).

**Tier-a category → tools (v1):** **Web** = `web_search`, `trigger_research`/`manage_research` (+ `use_research`/`allow_web_search`; browser surfaces via MCP — there is **no** `builtin_browser` tool); **Files** = `read_file`, `write_file`, `create/edit/update/suggest_document`, `manage_documents`; **Code** = `bash`, `python` (`allow_bash`); **Reach-out** = `send_email`, `reply_to_email`, `list/read_email`, `bulk/archive/delete/mark_email`, `manage_calendar`, `resolve/manage_contact`. Default posture: **Web on, others off**. Management/infra/vault tools (`manage_*`, `vault_search/get/unlock`, `api_call`, `app_api`, model-serving) map to no v1 category → disabled by default; admin/public role is the backstop. (Exact `TOOL_TAGS` names + full mapping: `odysseus-integration.md` §11.)

**Fine-grained approval hook (next layer; upstreamable):** wrap `execute_tool_block()` (`tool_execution.py:537-560`) in a pluggable pre-exec callback → emit `approval_request {id,tool,args,preview}` over SSE, block on `POST /api/approvals/{id}` → `{decision:approve|edit|deny,args?}`. Default = auto-approve (no behavior change). Mutating tools listed in `src/tool_schemas.py`.

---

## Myo repo skeleton (Cargo workspace; new repo)

```
Myo/
├─ Cargo.toml                 # [workspace] members = ["src-tauri","crates/*"]
├─ package.json, vite/svelte/ts config, index.html, justfile
├─ src/                       # Svelte 5 — renderer of agent intent (NOT fixed screens)
│  ├─ lib/core-api.ts         # typed wrappers over Tauri cmds + myo:// events
│  ├─ lib/converse.svelte.ts  # open-mic spine: VAD endpointing + barge-in turn-taking FSM
│  ├─ lib/surface-registry.ts # surface-kind → Svelte component map (the "generative UI")
│  ├─ lib/stage.svelte.ts     # single evolving stage: focus policy + history/recall + surface referent registry (voice deixis)
│  ├─ lib/audio-io.ts         # full-duplex: getUserMedia(echoCancellation)+VAD capture; TTS playback (base64→Audio, WebSpeech fallback)
│  └─ surfaces/               # Presence (voice-state orb), Stage (focal-surface host), HistoryRail (recall),
│                             #   ActivityStrip (ambient "what it's doing"), Assistant, DocumentArtifact (editable),
│                             #   AgentPanel (honors ui_control), Control (capability knobs), Memory (review/forget/pause), [next] ApprovalCard
├─ src-tauri/                 # Rust orchestrator (crate `myo`); id works.allmystuff.myo
│  ├─ tauri.conf.json         # externalBin: myownllm; resources: odysseus tree; mic perms
│  ├─ binaries/               # bundled sidecars
│  └─ src/
│     ├─ main.rs              # builder + generate_handler![…]
│     ├─ core_api/converse.rs, surfaces.rs, capabilities.rs, engines.rs
│     ├─ supervisor/{mod,odysseus,myownllm,process}.rs   # launch+health+auto-config
│     ├─ engines/{brain_odysseus,asr_local}.rs           # thin clients (swap layer)
│     └─ frame_sink_myo.rs    # impl myo_asr::FrameSink for WebviewWindow → myo://transcript
└─ crates/myo-asr/            # extracted MyOwnLLM ASR/diarize engine (Step 2)
```

---

## Myo Core API (the stable seam)

**Commands:** `myo_engines_status`, `myo_engines_ensure_ready`, `myo_converse_open{diarize?}` (begin always-on listening; the spine auto-allocates a turnId per detected utterance and returns it), `myo_converse_close{}`, `myo_converse_mute{on}` (hard privacy mute — mic dead), `myo_converse_cancel{turnId}` (also fired automatically on barge-in), `myo_converse_say{text}`→`{turnId}` (text bypass/CI), `myo_converse_feed_wav{path}`→`{turnId}` (WAV bypass/CI), `myo_surface_action{turnId,surfaceId,action,payload}` (user edits/clicks on a rendered surface flow back to the agent — v1: document edits, panel state, **recall/focus** a history surface back onto the stage), `myo_capabilities_get/set{web?,files?,code?,reachOut?}` (**the 4 tier-a category toggles → composed onto Odysseus's per-turn `allow_*` + persistent `disabled_tools`; admin/public role as backstop**), `myo_memory_list{query?}` / `myo_memory_forget{id}` (review/forget what Myo remembers — drives Odysseus memory), `myo_converse_incognito{on}` (pause memory / privacy mode — Odysseus incognito), `myo_tts_speak{text}`, `myo_settings_get/set`, and reserved `myo_approval_decide{id,decision,args?}` (tier-b, next).

**Events (normalized intent stream):** `myo://assistant/{turnId}` `{kind:delta|done}` · `myo://transcript/{turnId}` `{kind:partial|final,text,speaker?}` · `myo://activity/{turnId}` `{tool,phase:start|progress|output,…}` · `myo://artifact/{turnId}` `{kind:open|delta|update|suggestions,docId,…}` · `myo://ui/{turnId}` `{directive,…}` (agent-driven) · `myo://stage/{turnId}` `{focus:surfaceId,history:[{surfaceId,kind,title}]}` (focus/recall changes) · `myo://progress/{turnId}` `{kind:agent_step|prep|budget|research_*,…}` · `myo://audio/{turnId}` `{kind:ready|playing|ended,b64?,mime?}` · `myo://engine/{name}` · reserved `myo://approval/{turnId}` `{id,tool,args,preview}` (next).

The Svelte **surface-registry** maps each event kind → a component; adding a new agent-emitted surface kind is just registering a renderer. That extensibility *is* the dissolved/generative UI.

---

## Implementation steps (ordered)

**1. Scaffold Myo.** Tauri 2 + Svelte 5 in a Cargo workspace; `justfile` mirroring `MyOwnLLM/Justfile`. macOS mic-permission usage string + Linux WebKitGTK WebRTC flag + Windows WebView2 mic capability — **all wired from the start across the 5 target-triples** (`windows-x86_64`, `linux-x86_64`, `linux-aarch64`, `macos-x86_64`, `macos-aarch64`; Windows x64 only).

**2. Extract `crates/myo-asr`** (reuse). Move (history-preserving) from `MyOwnLLM/src-tauri/src/`: `asr/*`, `diarize/*`, `transcribe.rs`, `frame_sink.rs`, `resolver.rs`, `hardware.rs`, `models.rs`, `ort_setup.rs`, `ort_install.rs`, `process.rs` (+ `manifests/default.json`, repo-root `.ort-version` pinning ORT 1.24.2). Only `frame_sink.rs`/`transcribe.rs`/`models.rs` touch Tauri: delete `impl FrameSink for WebviewWindow` (`frame_sink.rs:31-40`); change `transcribe.rs` start/upload signatures to `sink: Arc<dyn FrameSink>` (bodies already call `sink.emit_frame`). Fast-follow: point MyOwnLLM at the crate to de-dup. (Exact file list + LOC: `myownllm-integration.md` §1.)

**3. Engine supervision** (`supervisor/`, porting `mesh/daemon.rs` + `src-tauri/src/process.rs`): `odysseus.rs` probes `GET /api/health` then spawns `uvicorn app:app --host 127.0.0.1 --port 7000` (cwd=bundled dir) with env `ODYSSEUS_INTERNAL_TOKEN=<random>`, `AUTH_ENABLED=true`, `ODYSSEUS_INPROCESS_POLLERS=0`, `ODYSSEUS_INPROCESS_TASKS=0`; kill-on-`Drop`. `myownllm.rs` spawns bundled `myownllm serve --port 1473`, polls `/healthz`. Progress on `myo://engine/*`.

**4. Brain client** (`engines/brain_odysseus.rs`): loopback client with internal-tool headers. `ensure_session()`; `chat_stream(session,text,caps)` — **post the per-turn capability flags** (`allow_bash`/`allow_web_search`/mode) from Myo's control state, and **parse the FULL SSE vocabulary** (table above), normalizing each event into the `myo://` intent stream; `tts(text)` (`format:base64`); plus `get/set_capabilities()` → drives Odysseus's `disabled_tools` route.

**5. ASR adapter** (`engines/asr_local.rs` + `frame_sink_myo.rs`): wrap `myo_asr::transcribe::{start,stop,start_upload}` with a Myo `FrameSink` re-emitting on `myo://transcript`. **Open-mic capture lives in the WebView** — `getUserMedia({echoCancellation,noiseSuppression,autoGainControl})` + a browser VAD (Silero via onnxruntime-web) streams PCM frames to `myo_asr` so the TTS is echo-cancelled and **barge-in works full-duplex**; `myo_asr`'s own `cpal` live path (`start`) becomes the headless/CI capture. `feed_wav`→`start_upload` (mic-untouched path, `MyOwnLLM/.../main.rs:400-418`). Tier via `myo_asr::resolver::resolve("transcribe"|"diarize")`.

**6. `ensure_ready` auto-config** (`supervisor/mod.rs`): both engines healthy → `POST /api/model-endpoints` (`base_url=…:1473/v1`) so Odysseus auto-defaults to MyOwnLLM → enable TTS provider (local Kokoro if present) + verify `GET /api/tts/stats`; WebSpeech fallback if unavailable.

**7. Voice spine + surface renderer + control surface** (`core_api/{converse,surfaces,capabilities}.rs` + Svelte `surfaces/`): voice-first loop (ASR→brain→TTS). The shell subscribes to the `myo://` stream and renders via `surface-registry`: **Assistant** (streamed text + speech), **ActivityFeed** (`myo://activity` — watch it work, incl. images/screenshots), **DocumentArtifact** (`myo://artifact` — materializes + streams the agent's document into an *editable* pane; edits flow back via `myo_surface_action`), **AgentPanel** (`myo://ui` — honor `ui_control` natively; render the panels Myo has, gracefully ignore the rest for v1), **Control** (tier-a: 4 capability toggles — **Web / Files / Code / Reach-out** — each composing Odysseus's `disabled_tools` + per-turn `allow_*`; the agent can also surface/flip these via `ui_control toggle`), **Memory** (review/forget what Myo remembers; one-tap incognito to pause memory). **The renderer is one evolving stage:** a persistent **Presence** orb (voice state) + a single focal **Stage** + an ambient **ActivityStrip** + a **HistoryRail**. Focus policy — a streaming artifact or agent-opened panel takes the Stage; the live tool feed *is* the Stage when nothing else is live, else it demotes to the strip; the agent (`ui_control`) or the user (`myo_surface_action recall`) can redirect focus; blurred surfaces park in History with state intact and are recallable by voice ("bring back that doc") via a per-session surface referent registry. Voice-first/touch-second/type-third throughout.

**8. (Next milestone) Fine-grained approval hook.** The upstreamable no-op-by-default callback in `execute_tool_block()` (`tool_execution.py:537-560`) + `POST /api/approvals/{id}` + `approval_request` SSE; Myo's reserved `myo://approval` + `myo_approval_decide` + an ApprovalCard surface (approve/tweak/edit) drop into the registry with no shell changes. Deferred past v1 because tier-a control already makes v1 "controllable."

---

## Odysseus packaging (track upstream)

- **v1/dev:** Odysseus as a git **submodule** under `src-tauri/resources/odysseus/` (the later approval hook is an upstreamable PR, not a divergent patch). First run: managed venv at `~/.myo/odysseus-venv`, `pip install -r requirements.txt`, launch uvicorn. System Python 3.12 (documented prereq).
- **Deps:** mandatory = `requirements.txt`. **ChromaDB not required** (fastembed degrades to keyword fallback). Disable for v1: SearXNG, ntfy, tmux/Cookbook, PyMuPDF.
- **End-user installer (post-v1):** freeze Odysseus (PyInstaller/embeddable Python) into a `binaries/odysseus-launcher`; reuse MyOwnLLM's `ort_install.rs` to deliver onnxruntime (needed by both `myo-asr` and Odysseus fastembed/Kokoro) — per target-triple (`windows-x86_64`, `linux-x86_64`, `linux-aarch64`, `macos-x86_64`, `macos-aarch64`).

---

## UX principles — voice-first, UI dissolved into conversation

- **Default = talk + watch (open-mic).** The home surface is an **ambient presence indicator** (listening / thinking / speaking) — not a press-to-talk button; you just speak, and you interrupt by speaking (barge-in). A visible **hard-mute** is always one tap away. Touch and type are first-class but secondary inputs the user (or the agent) can summon.
- **Surfaces materialize from agent intent**, never from fixed navigation: agent writes a doc → DocumentArtifact appears; agent calls `ui_control open_panel` → that panel opens; a tool runs → ActivityFeed shows it.
- **One evolving stage, not a window pile.** A single focal Stage shows the agent's current primary output; finished surfaces collapse into a recallable History (kept with their state), and the live tool feed runs as an ambient strip — so "watch it work" stays glanceable without clutter. Surfaces are voice-addressable ("go back to the budget doc") via a per-session surface referent registry.
- **Myo remembers — a continuous presence.** One ongoing relationship across days (automatic local memory + RAG; a subtle "recalled from memory" cue when it draws on the past), not sessions you manage. Because it remembers everything, memory is **visible, forgettable, and pausable**: a Memory surface to review/forget, and one-tap incognito to stop recording — all local, nothing leaves the device.
- **Step-in, not drive:** any surface is editable/approvable in place. v1: edit documents, adjust panels, **toggle the agent's capabilities** (tier-a control). Next: approve/tweak/edit individual actions before they run (tier-b).

---

## Roadmap after v1

1. **Fine-grained approval (immediate next):** land the upstreamable Odysseus hook + Myo's ApprovalCard — agent pauses on a mutating tool → approve/tweak/edit → resume. (Coarse control already shipped in v1.)
2. **Multi-device via MyOwnMesh:** bundle `myownmesh` as `externalBin`; 6-char pairing; replace Odysseus Tailscale LLM discovery (`odysseus/src/model_discovery.py`) with mesh-advertised `:1473` endpoints registered as model-endpoints; reuse `MyOwnLLM/src/mesh-transcribe.ts` for remote ASR; use mesh `RpcRegister`/`EventsSubscribe`.
3. **Broaden native surfaces** for the remaining `ui_control` panel targets (email/notes/memories/skills…).
4. **Offline/local brain fallback** (MyOwnLLM agent loop behind `engines::brain`).
5. **Consolidate the two model catalogs** (MyOwnLLM manifest tiers + Odysseus `ModelEndpoint`); de-dup `myo-asr`.

---

## Risks & mitigations

1. **Python packaging (highest)** — venv+system Python for v1; freeze post-v1; submodule keeps upstream tracking.
2. **onnxruntime (two consumers)** — reuse `ort_install.rs`; accept fastembed keyword-fallback for v1.
3. **TTS off by default** — `ensure_ready` enables a provider; WebSpeech fallback guarantees voice-out.
4. **Rendering fidelity of the intent stream** — map each Odysseus event to a registry entry; treat unknown kinds gracefully (log + ignore) so new agent events never break the shell.
5. **Control depth** — tier-a (knob-driving) gives coarse, pre-authorization control with **no fork**; true per-action approval needs the tier-b hook (kept no-op-by-default + upstreamable). v1 ships tier-a; flag tier-b as the next layer.
6. **Open-mic audio (echo, barge-in, false-triggers)** — full-duplex needs echo cancellation so ASR never hears the TTS: capture in the WebView via `getUserMedia({echoCancellation,noiseSuppression,autoGainControl})`, run VAD there, stream PCM to `myo-asr`, and play TTS in the same context as the AEC reference. Barge-in = VAD-during-playback → cancel + duck. False-triggers bounded by a VAD threshold + an always-visible hard mute; **ASR is local, so always-on audio never leaves the device.** Degrade to half-duplex PTT on any WebView lacking usable AEC. macOS Info.plist mic string + Linux WebKitGTK WebRTC flag + Windows WebView2 mic capability. WAV/text hooks let CI pass without a mic.
7. **Loopback auth env timing** — Myo injects `ODYSSEUS_INTERNAL_TOKEN` before uvicorn starts.
8. **Chat is form-data + SSE (not OpenAI)** — brain client posts multipart and parses Odysseus's event shapes.
9. **Multi-platform fleet (Windows + macOS + Linux — 5 target-triples)** — every native dep needs per-triple builds: onnxruntime (reuse `ort_install.rs`, which resolves per platform+arch), the `myo-asr` crate, the MyOwnLLM `externalBin` sidecar (cross-compile per triple), Kokoro TTS. Bundle sidecars per-triple via Tauri target-triple resources; CI runs a **5-target matrix** (`windows-x86_64`, `linux-x86_64`, `linux-aarch64`, `macos-x86_64`, `macos-aarch64`). AEC quality varies by webview — WebKitGTK (Linux) and WebView2 (Windows) are the riskier ones; risk 6's half-duplex PTT fallback applies per-target.

---

## Verification (v1)

**Run engines:** `cd MyOwnLLM && just serve 1473` → `curl :1473/healthz` + `/v1/models`. `uvicorn app:app --host 127.0.0.1 --port 7000` (+3 env vars) → `curl :7000/api/health` healthy, `/api/version`=0.9.1. `cd Myo && just dev` → boots, `myo_engines_ensure_ready` registers provider + enables TTS.

**Voice round-trip (open-mic):** speak (mic always open) → VAD opens a turn → `myo://transcript` partials → silence endpoints the turn → `myo://assistant` deltas → TTS plays (`myo://audio` ready→playing→ended). **Barge-in:** talk over the TTS → playback stops, the turn cancels, a new turn opens — and no self-transcription appears (proving AEC; validate per-webview: macOS CoreAudio, Linux WebKitGTK, Windows WebView2). **Mute:** `myo_converse_mute{on:true}` → mic dead, no transcripts.

**Dissolved-UI surfaces:** prompt the agent to write a document → assert a DocumentArtifact opens + streams (`myo://artifact` open→delta→update) and is editable (edit → `myo_surface_action` → persists). Trigger a tool → assert ActivityFeed shows `tool_start`→`tool_output`. Provoke `ui_control open_panel` → assert the panel opens. Open a 2nd artifact → assert the 1st collapses to History (state intact) and the new one takes the Stage; `myo_surface_action{action:recall}` on the 1st → it returns to the Stage. With an artifact streaming, assert the tool feed runs as the ambient ActivityStrip (not stage-stealing).

**Control (tier-a):** toggle a capability in the Control surface → assert it writes Odysseus `disabled_tools` (re-`GET` settings) and that the next turn passes the matching `allow_*` flag; with `bash` disabled, ask the agent to run a shell command → assert it's blocked, not executed.

**Continuous memory:** state a fact ("my project ships Friday") in one turn → in a later turn (or after reopening the session) ask about it → assert recall (a `memories_used`/RAG hit; the answer reflects it). `myo_converse_incognito{on:true}` → state a new fact → assert it is **not** persisted (absent on next recall). `myo_memory_forget{id}` on the first fact → assert it's gone from later recall.

**Non-audio / CI hooks:** `invoke("myo_converse_say",{text:"write a haiku as a document"})` → assistant + artifact, no mic. `invoke("myo_converse_feed_wav",{path:"fixtures/hello.wav"})` → ASR via `start_upload` → transcript finalizes → brain+TTS. Direct probes: `curl -N -H "X-Odysseus-Internal-Token:<tok>" -H "X-Odysseus-Owner:myo" -F message=hi -F session=<sid> -F mode=agent -F allow_bash=false :7000/api/chat_stream`; TTS `…/api/tts/synthesize -d '{"text":"hi","format":"base64"}'`; `GET :7000/api/model-endpoints` → MyOwnLLM present & default.

---

## Logistics (decided)

- **Where Myo's code lives → its own `mrjeeves/Myo` repo.** **Caveat (hard blocker this session):** that repo is **outside my current GitHub write-scope** — this environment is configured for `odysseus`, `MyOwnLLM`, `MyOwnMesh` + branch `claude/practical-shannon-RPFiK` only, and calls to `mrjeeves/Myo` are **denied**, so I cannot clone/push it here. To target it directly, add `mrjeeves/Myo` (and the dev branch) to the environment's repo scope. **Unblocked path meanwhile:** the `myo-asr` extraction *must* touch **MyOwnLLM** anyway (Step 2), so I build it — plus the Myo Tauri/Svelte scaffold — on MyOwnLLM's `claude/practical-shannon-RPFiK` branch and `git mv` the scaffold into `mrjeeves/Myo` once access lands. Any Odysseus hook PR lands on in-scope `odysseus` regardless.
- **Platforms → all 5 targets from day one.** The test fleet is **`windows-x86_64`, `linux-x86_64`, `linux-aarch64`, `macos-x86_64`, `macos-aarch64`** (Windows x64 only — no Windows-on-ARM). So v1 wires mic-permission + WebRTC/AEC for all three OSes — macOS Info.plist mic string (CoreAudio AEC), Linux WebKitGTK WebRTC flag, Windows WebView2 mic capability (WinRT AEC) — with native builds of every dep (onnxruntime, `myo-asr`, the MyOwnLLM sidecar, Kokoro) for all 5 triples. CI = 5-target matrix.
- **Vendored Odysseus:** git **submodule** for dev (per packaging section); freeze/pin for the end-user installer.
