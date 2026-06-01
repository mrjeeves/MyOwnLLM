# Odysseus Integration Reference (for Myo)

> **What this is.** A self-contained spec of the HTTP API + SSE event stream that **Odysseus** (a Python/FastAPI local-AI agent backend) exposes, so that **Myo** (a Tauri 2 + Svelte 5 voice-first shell) can use Odysseus as its "brain" without ever reading the Odysseus source.
>
> Every code excerpt below was read from the real source on branch `claude/practical-shannon-RPFiK` and carries a `file:line` reference. Line numbers were verified by opening the files; they may drift slightly across commits but the anchoring code is exact.
>
> **The big idea Myo is built on:** Odysseus "dissolves" its UI into an SSE *intent stream*. The agent doesn't render HTML — it emits typed events (`delta`, `tool_start`, `doc_update`, `ui_control`, …) and the client renders them. Myo's whole renderer keys off Section 5. The old "AI serves HTML in an iframe" idea (`/api/tools/*/render`) is **not** how it works today (Section 3).

---

## 0. Quick facts

| Thing | Value |
|---|---|
| Launch | `uvicorn app:app --host 127.0.0.1 --port 7000` (Docker uses `0.0.0.0`; loopback for Myo) |
| Base URL | `http://127.0.0.1:7000` |
| Version | `APP_VERSION = "0.9.1"` — `core/constants.py:5` |
| Python | 3.12 (`Dockerfile:1` → `FROM python:3.12-slim`) |
| App version endpoint | `GET /api/version` |
| The chat entry point | `POST /api/chat_stream` (multipart form, returns SSE) |
| Auth for Myo | loopback internal token (Section 2) — Myo needs **no user account** |
| Agent loop source | `src/agent_loop.py` (function `stream_agent_loop`) |
| Chat route source | `routes/chat_routes.py` (function `chat_stream`) |

---

## 1. Health & version (auth-exempt)

**What it is.** Two unauthenticated probe endpoints. Both are in the auth-exempt allowlist so Myo can poll them before/without authenticating.

`app.py:664` (version) and `app.py:669` (health):
```python
@app.get("/api/version")
async def get_version():
    from core.constants import APP_VERSION
    return {"version": APP_VERSION}

@app.get("/api/health")
async def health_check() -> Dict[str, str]:
    return {"status": "healthy", "timestamp": datetime.utcnow().isoformat()}
```

They are listed in the auth-exempt exact-match set, `app.py:113`:
```python
AUTH_EXEMPT_EXACT = {
    "/api/auth/setup", "/api/auth/signup", "/api/auth/login", "/api/auth/logout",
    "/api/auth/status", "/api/auth/features", "/api/auth/settings",
    "/api/auth/integrations/presets",
    "/api/health",
    "/api/version",
    "/login",
}
AUTH_EXEMPT_PREFIXES = ["/static"]
```

- `GET /api/health` → `{"status":"healthy","timestamp":"<iso>"}`
- `GET /api/version` → `{"version":"0.9.1"}`

**Why Myo needs it.** Readiness probe — poll `/api/health` to know when the backend is up before opening the chat stream; show the backend version in an "about" panel via `/api/version`.

---

## 2. Loopback internal auth (Myo gets admin with NO user account)

**What it is.** A per-process internal token that lets a *loopback* (127.0.0.1/::1) caller bypass all auth and act as admin. This was built so Odysseus's own tool layer could HTTP-loopback to admin-gated routes; Myo reuses the exact same mechanism — it runs on the same host as Odysseus, sets the header, and is treated as an internal/admin caller.

**Two headers:**
- `X-Odysseus-Internal-Token: <token>` — must equal the server's token.
- `X-Odysseus-Owner: <username>` — optional; impersonate this user so created notes/calendar/memory land in their account (otherwise owner is `"internal-tool"`).

**The token.** `core/middleware.py:16`:
```python
INTERNAL_TOOL_TOKEN = os.environ.get("ODYSSEUS_INTERNAL_TOKEN") or secrets.token_hex(32)
INTERNAL_TOOL_HEADER = "X-Odysseus-Internal-Token"
```
> **CRITICAL:** the token is read **once at import time**. If `ODYSSEUS_INTERNAL_TOKEN` is not set in the environment *before* uvicorn boots, Odysseus generates a random one Myo can't know. **Myo must set `ODYSSEUS_INTERNAL_TOKEN` to a shared secret and launch Odysseus with that env var set**, then send the same value in the header.

**Middleware bypass (loopback + token only).** `app.py:172`:
```python
from core.middleware import INTERNAL_TOOL_HEADER, INTERNAL_TOOL_TOKEN as _ITT
_hdr = request.headers.get(INTERNAL_TOOL_HEADER)
_client_host = request.client.host if request.client else None
if _hdr and _hdr == _ITT and _client_host in ("127.0.0.1", "::1"):
    _impersonate = (request.headers.get("X-Odysseus-Owner") or "").strip()
    request.state.current_user = _impersonate or "internal-tool"
    request.state.api_token = False
    return await call_next(request)
```

**How `require_admin` honors it** — so Myo passes admin gates with no user. `core/middleware.py:20`:
```python
def require_admin(request: Request):
    try:
        if request.headers.get(INTERNAL_TOOL_HEADER) == INTERNAL_TOOL_TOKEN:
            return
        if getattr(request.state, "current_user", None) == "internal-tool":
            return
    except Exception:
        pass
    auth_mgr = getattr(request.app.state, "auth_manager", None)
    if os.getenv("AUTH_ENABLED", "true").lower() == "false":
        return
    if not auth_mgr or not auth_mgr.is_configured:
        raise HTTPException(403, "Admin only")
    user = getattr(request.state, "current_user", None)
    if not user or not auth_mgr.is_admin(user):
        raise HTTPException(403, "Admin only")
```

**Why Myo needs it.** This is Myo's auth strategy. Send `X-Odysseus-Internal-Token` (and `X-Odysseus-Owner: <the user>`) on **every** request from loopback. Myo then has full admin access — chat, model registration, memory, settings — without provisioning a user, password, or session cookie. Optionally also set `AUTH_ENABLED=false` (Section 13) to drop auth entirely, but the token path is cleaner because it preserves per-user ownership of notes/memory via `X-Odysseus-Owner`.

---

## 3. The unused render stub (proves "AI serves UI in iframe" is NOT done today)

**What it is.** There is **no** `/api/tools/*/render` route handler anywhere in Odysseus. The path appears **only** in security-headers middleware, which special-cases CSP framing for a route that does not exist. This is vestigial.

`core/middleware.py:58`:
```python
# Tool render endpoints are served inside iframes — allow framing by self
is_tool_render = path.startswith("/api/tools/") and path.endswith("/render")
```
…and the only effect, `core/middleware.py:76`:
```python
elif is_tool_render:
    # Tool iframe content: skip all framing headers — the iframe's
    # sandbox="allow-scripts" attribute provides isolation.
    pass
```

Verification: a repo-wide grep for `api/tools/` in `app.py`, `routes/`, and `core/` returns **only** `core/middleware.py:59`. No FastAPI route decorates `/api/tools/{...}/render`.

**Why Myo needs it.** Confirms the architecture: Odysseus does **not** render tool UIs as server-served iframes. Myo must render the **SSE intent stream** (Section 5) itself — that is the "dissolved UI". Ignore the render stub entirely.

---

## 4. Chat (agent, streaming) — `POST /api/chat_stream`

**What it is.** The single entry point for a conversational/agent turn. Accepts a **multipart form** (not JSON, although a JSON body is also tolerated for a couple of fields) and returns an **SSE stream** that ends with `data: [DONE]`.

**Route + form-field parsing.** `routes/chat_routes.py:189`:
```python
@router.post("/api/chat_stream")
async def chat_stream(request: Request) -> StreamingResponse:
    ...
    form_data = await request.form()
    message = form_data.get("message")
    session = form_data.get("session")
    attachments = form_data.get("attachments")
    use_web = form_data.get("use_web")
    use_research = form_data.get("use_research")
    time_filter = form_data.get("time_filter")
    preset_id = form_data.get("preset_id")
    allow_bash = form_data.get("allow_bash")
    allow_web_search = form_data.get("allow_web_search")
    use_rag = form_data.get("use_rag")
    search_context = form_data.get("search_context")  # pre-fetched web results (compare mode)
    compare_mode = str(form_data.get("compare_mode", "")).lower() == "true"
    incognito = str(form_data.get("incognito", "")).lower() == "true"
    chat_mode = str(form_data.get("mode", "")).lower()  # 'chat' or 'agent'
    ...
    active_doc_id = form_data.get("active_doc_id", "").strip()
```

**Form fields Myo will send:**

| Field | Type | Meaning |
|---|---|---|
| `message` | str | The user's message (may be empty if attachments present) |
| `session` | str | Session id (create one first via `POST /api/session`, Section 6) |
| `mode` | `"agent"` / `"chat"` | `agent` = full tool loop; `chat` = plain reply (auto-escalates to agent on tool-intent) |
| `allow_bash` | `"true"`/other | Per-turn: enable the `bash` tool this turn |
| `allow_web_search` | `"true"`/other | Per-turn: enable the `web_search` tool this turn |
| `use_web` | `"true"`/other | Inject web-search context |
| `use_research` | `"true"`/other | Run deep research (background task, emits `research_*` events) |
| `use_rag` | `"true"`/other | Inject personal-doc RAG context |
| `incognito` | `"true"`/other | No persistent memory / chat history this turn (Section 14) |
| `compare_mode` | `"true"`/other | Multi-model compare panes |
| `preset_id` | str | Persona/preset id |
| `active_doc_id` | str | Id of the doc currently open in the editor (so the agent can "see" it) |
| `attachments` | str/list | Attached files |

**Important:** the `Authorization` header is NOT used by Myo. Instead send the loopback headers from Section 2 (`X-Odysseus-Internal-Token`, `X-Odysseus-Owner`). Optionally send `X-Tz-Offset: <minutes east of UTC>` so natural-language times resolve in the user's timezone (`routes/chat_routes.py:207`).

**Per-turn capability flags → `disabled_tools`.** `routes/chat_routes.py:386`:
```python
# Build disabled-tools set from frontend toggles + user privileges
disabled_tools = set()
if str(allow_bash).lower() != "true":
    disabled_tools.add("bash")
if str(allow_web_search).lower() != "true":
    disabled_tools.add("web_search")

# Nobody/incognito mode: deny tools that would expose persistent memory/identity
if incognito:
    disabled_tools.update({
        "manage_memory",   # persistent memory store
        "search_chats",    # past chat history
        "manage_skills",   # skill presets tied to user
    })
```
> Semantics: **bash and web_search are DISABLED unless you explicitly pass `allow_bash=true` / `allow_web_search=true`.** Everything else is allowed by default (subject to role gating, Section 9). Global admin-disabled tools are also merged in, `routes/chat_routes.py:424`:
> ```python
> _global_disabled = get_setting("disabled_tools", [])
> if _global_disabled and isinstance(_global_disabled, list):
>     disabled_tools.update(_global_disabled)
> ```

**How agent mode dispatches.** `routes/chat_routes.py:792` (inside the SSE generator):
```python
async for chunk in stream_agent_loop(
    sess.endpoint_url, sess.model, messages,
    headers=sess.headers,
    temperature=ctx.preset.temperature,
    max_tokens=ctx.preset.max_tokens,
    prompt_type=preset_id,
    max_tool_calls=_tool_budget,
    context_length=ctx.context_length,
    active_document=active_doc,
    session_id=session,
    disabled_tools=disabled_tools if disabled_tools else None,
    owner=_user,
    fallbacks=_fallback_candidates,
):
```

**Response.** `Content-Type: text/event-stream`. Each event is a line `data: <json>\n\n` (plus occasional `: heartbeat N` comments and `event: error` lines). Stream terminates with `data: [DONE]\n\n`.

**Why Myo needs it.** This is *the* API call for every spoken/typed turn. POST the form, then parse the SSE stream per Section 5.

---

## 5. ★ THE SSE EVENT VOCABULARY (the "dissolved UI" protocol)

**This is the most important section.** Myo's renderer is a dispatch table keyed on each event's `type` (or the bare `delta` key). Below is **every** event type, with the exact emit site so the payload shape is precise.

Two source layers emit events:
- **Chat-route wrapper** (`routes/chat_routes.py`) — context-level events (sources, memories, model info, compaction, research, message-saved).
- **Agent loop** (`src/agent_loop.py`, `stream_agent_loop`) — per-round / per-tool events.

The loop documents its own contract at `src/agent_loop.py:1239`:
```
Yields SSE events:
  - data: {"delta": "text"}                             (text chunks)
  - data: {"type": "tool_start", "tool": "...", ...}    (before execution)
  - data: {"type": "tool_output", "tool": "...", ...}   (after execution)
  - data: {"type": "agent_step", "round": N}            (next round)
  - data: {"type": "metrics", "data": {...}}            (final metrics)
  - data: [DONE]                                        (end)
```

### 5.1 Parsing rule (must implement exactly)

For each SSE `data:` line, JSON-parse the payload, then dispatch:
1. If the line is `data: [DONE]` → stream finished.
2. If it starts with `event: error` or `event: ` → an error/forwarded event (render as error text).
3. Lines starting with `:` are heartbeats — ignore.
4. **Check `data.type` FIRST**, because some typed events (`tool_call_delta`) also carry a `delta`-ish field. Only if there is no recognized `type` and the object has a `"delta"` key, treat it as a streamed text chunk. This ordering is enforced server-side at `src/agent_loop.py:1528`:
   ```python
   # IMPORTANT: check type-based events BEFORE "delta" key,
   # because tool_call_delta also has an "arg_delta" field.
   ```

### 5.2 Text streaming — `delta` (NO `type` field)

The assistant's prose. A bare object with a `delta` string and no `type`. `src/agent_loop.py:1590` forwards the upstream chunk; explicit emits look like:
```python
yield f'data: {json.dumps({"delta": _synth})}\n\n'          # agent_loop.py:1682
yield f'data: {json.dumps({"delta": _note})}\n\n'           # agent_loop.py:1755
yield 'data: ' + json.dumps({"delta": _anchor}) + '\n\n'    # agent_loop.py:2034 (research link)
```
Payload: `{"delta": "<text fragment>"}`. Optionally `{"delta": "...", "thinking": true}` for reasoning tokens (accumulated separately upstream — treat `thinking` deltas as collapsible/secondary). **Concatenate `delta` values to build the live transcript.**

### 5.3 Tool lifecycle

**`tool_start`** — emitted before a tool runs. `src/agent_loop.py:1878`:
```python
yield f'data: {json.dumps({"type": "tool_start", "tool": block.tool_type, "command": cmd_display, "round": round_num})}\n\n'
```
Payload keys: `type`, `tool` (tool name), `command` (short display string), `round` (int).

**`tool_progress`** — periodic progress for long-running `bash`/`python`. `src/agent_loop.py:1911`:
```python
yield f'data: {json.dumps({"type": "tool_progress", "tool": block.tool_type, "round": round_num, **evt})}\n\n'
```
`evt` is spread in; its shape is `{"elapsed_s": <float>, "tail": "<recent output lines>"}` (from `src/tool_execution.py:103`). So full payload: `{type, tool, round, elapsed_s, tail}`.

**`tool_output`** — emitted after a tool finishes. `src/agent_loop.py:1995`:
```python
tool_output_data = {"type": "tool_output", "tool": block.tool_type, "command": cmd_display,
                    "output": output_text, "exit_code": result.get("exit_code")}
if "ui_event" in result:
    tool_output_data["ui_event"] = result["ui_event"]
    for k in ("toggle_name", "state", "mode", "model", "endpoint_url", "theme_name", "colors"):
        if k in result: tool_output_data[k] = result[k]
# generate_image data
for k in ("image_url", "image_prompt", "image_model", "image_size", "image_quality"):
    if k in result: tool_output_data[k] = result[k]
# browser screenshots (base64)
if result.get("images"):
    img = result["images"][0]
    tool_output_data["screenshot"] = f"data:{img['mimeType']};base64,{img['data']}"
yield f'data: {json.dumps(tool_output_data)}\n\n'
```
Base keys: `type`, `tool`, `command`, `output` (truncated text), `exit_code` (nullable). **Conditional keys:**
- If the tool was `generate_image`: `image_url`, `image_prompt`, `image_model`, `image_size`, `image_quality`.
- If a browser tool: `screenshot` = a `data:` URL of the first returned image.
- If the tool was a `ui_control`: `ui_event` plus the relevant subset of `toggle_name`/`state`/`mode`/`model`/`endpoint_url`/`theme_name`/`colors` (see 5.5).

> Note: `doc_id`/`doc_title` appear in the **persisted history** record (`tool_event`, `agent_loop.py:2037`), but live doc state arrives via the dedicated `doc_*` events below — render those.

### 5.4 Document panel events (live editor)

These drive a side "document/editor" panel. The agent streams document content as it writes.

**`doc_stream_open`** — a new document starts streaming. `src/agent_loop.py:1550` / `:1615` / `:1717`:
```python
yield f'data: {json.dumps({"type": "doc_stream_open", "title": title, "language": lang})}\n\n'
```
Keys: `type`, `title`, `language`.

**`doc_stream_delta`** — incremental content for the open doc. `src/agent_loop.py:1565` / `:1623`:
```python
yield f'data: {json.dumps({"type": "doc_stream_delta", "content": decoded})}\n\n'
```
Keys: `type`, `content` (the **full content so far**, not a fragment — replace, don't append).

**`doc_update`** — a finalized document (after a `create_document`/`update_document`/`edit_document` tool, or a preprocess auto-open). `src/agent_loop.py:1944` and `:2016`; also wrapper `routes/chat_routes.py:473`:
```python
yield f'data: {json.dumps({"type": "doc_update", "doc_id": result["doc_id"], "content": result["content"], "version": result["version"], "title": result.get("title", ""), "language": result.get("language")})}\n\n'
```
Keys: `type`, `doc_id`, `content`, `version` (int), `title`, `language`. **`doc_id` is the canonical id** — echo it back next turn as the `active_doc_id` form field so the agent can see the doc.

**`doc_suggestions`** — inline edit suggestions (track-changes style). `src/agent_loop.py:1940`:
```python
yield f'data: {json.dumps({"type": "doc_suggestions", "doc_id": result["doc_id"], "suggestions": result["suggestions"]})}\n\n'
```
Keys: `type`, `doc_id`, `suggestions` (list).

### 5.5 `ui_control` — the agent driving Myo's UI

**What it is.** When the agent calls the `ui_control` tool, the result carries a `ui_event` and Odysseus emits a dedicated `ui_control` event (and also stamps the fields onto `tool_output`). Myo should treat `ui_control` as **commands to mutate its own UI**.

Emit site, `src/agent_loop.py:1949`:
```python
if "ui_event" in result:
    yield f'data: {json.dumps({"type": "ui_control", "data": result})}\n\n'
```
So the payload is `{"type": "ui_control", "data": {<the tool result>}}` and `data.ui_event` is the discriminator.

**The complete `ui_event` vocabulary** (from the result dicts in `src/ai_interaction.py`, function `do_ui_control` at `:1239`):

| `data.ui_event` | Extra keys in `data` | Meaning | Source |
|---|---|---|---|
| `toggle` | `toggle_name` ∈ {web, bash, research, incognito, document_editor}, `state` (bool) | Turn a capability on/off | `ai_interaction.py:1287` |
| `set_mode` | `mode` ∈ {agent, chat} | Switch chat/agent mode | `ai_interaction.py:1300` |
| `switch_model` | `model` (id), `endpoint_url` | Switch the active model | `ai_interaction.py:1339` |
| `set_theme` | `theme_name` | Apply a preset theme | `ai_interaction.py:1367` |
| `create_theme` | `theme_name`, `colors` (object of hex) | Create + apply a custom theme | `ai_interaction.py:1424` |
| `highlight` | (target info) | Highlight a UI element | `ai_interaction.py:1439` |
| `clear_highlight` | — | Clear highlight | `ai_interaction.py:1447` |
| `open_panel` | `panel` ∈ {documents, gallery, email, sessions, notes, memories/brain, skills, settings, cookbook} | Open a modal/panel | `ai_interaction.py:1491` |
| `open_email_reply` | `uid`, `folder`, `mode` ∈ {reply, reply-all, ai-reply} | Open an email reply draft (does NOT send) | `ai_interaction.py:1506` |
| `research_started` | — | Deep research kicked off | `tool_implementations.py:3726` |

The tool's own schema (`src/tool_schemas.py:329`) documents the valid `action` values the model picks from: `toggle`, `open_panel`, `open_email_reply`, `set_mode`, `switch_model`, `set_theme`, `create_theme`, `get_toggles`. Preset theme names (`set_theme`): `dark, light, midnight, paper, nord, monokai, gruvbox, dracula, cyberpunk, retrowave, forest, ocean, ume, copper, terminal, vaporwave, lavender, gpt, coffee, claude`.

**Why Myo needs it.** This is how the agent "controls the app" by voice ("open my email", "switch to dark theme", "turn on web search"). Myo maps each `ui_event` to a local UI action. Unknown/unsupported events can be safely ignored.

### 5.6 Agent control / progress events

**`agent_prep`** — prep-phase timings (tool selection, prompt build). `src/agent_loop.py:1409`:
```python
yield f"data: {json.dumps({'type': 'agent_prep', 'data': {k: round(v,3) for k,v in prep_timings.items()}})}\n\n"
```
Keys: `type`, `data` (dict of phase→seconds). Useful for a "thinking…" spinner.

**`agent_step`** — start of the next round. `src/agent_loop.py:1745`, `:1824`, `:2070`:
```python
yield f'data: {json.dumps({"type": "agent_step", "round": round_num + 1})}\n\n'
```
Keys: `type`, `round` (int).

**`budget_exceeded`** — tool-call budget hit; loop stops. `src/agent_loop.py:1865`:
```python
yield f'data: {json.dumps({"type": "budget_exceeded", "limit": max_tool_calls, "used": total_tool_calls})}\n\n'
```
Keys: `type`, `limit`, `used`.

**`metrics`** — final per-turn metrics (tokens, durations, context %). `src/agent_loop.py:2085`:
```python
yield f"data: {json.dumps({'type': 'metrics', 'data': metrics})}\n\n"
```
Keys: `type`, `data` (dict). Emitted once near the end.

### 5.7 Context / sources / model events (chat-route wrapper)

**`model_info`** — which model is answering; sent early so Myo can label the turn. `routes/chat_routes.py:632`:
```python
_model_info = {"type": "model_info", "model": sess.model}
if _model_suffix: _model_info["suffix"] = _model_suffix     # e.g. "Research"
if ctx.preset.character_name: _model_info["character_name"] = ...
yield f'data: {json.dumps(_model_info)}\n\n'
```
Keys: `type`, `model`, optional `suffix`, optional `character_name`.

**`rag_sources`** — personal-doc RAG context used. `routes/chat_routes.py:476`:
```python
yield f"data: {json.dumps({'type': 'rag_sources', 'data': ctx.rag_sources})}\n\n"
```
Keys: `type`, `data` (list of sources).

**`web_sources`** — web search results/citations. Wrapper `routes/chat_routes.py:480` and from inside the loop `src/agent_loop.py:1926`:
```python
yield f'data: {json.dumps({"type": "web_sources", "data": _extracted_sources})}\n\n'
```
Keys: `type`, `data` (list). Render as a citations row.

**`memories_used`** — which saved memories were injected into context. `routes/chat_routes.py:484`:
```python
yield f"data: {json.dumps({'type': 'memories_used', 'data': ctx.used_memories})}\n\n"
```
Keys: `type`, `data` = list of `{"text", "category", "type"}` where `type` ∈ {`pinned`, `recalled`} (see `src/chat_processor.py:209`/`:225`). **This is the event Myo surfaces as "I remembered X about you."**

**`attachments`** — metadata for attachments the user sent. `routes/chat_routes.py:466`:
```python
yield f"data: {json.dumps({'type': 'attachments', 'data': ctx.preprocessed.attachment_meta})}\n\n"
```

**`compacted`** — the conversation was auto-compacted (context trimmed/summarized). `routes/chat_routes.py:616`:
```python
yield f"data: {json.dumps({'type': 'compacted', 'context_length': ctx.context_length})}\n\n"
```
Keys: `type`, `context_length`.

**`message_saved`** — the assistant message was persisted; gives its DB id. `routes/chat_routes.py:764` and `:847`:
```python
yield f'data: {json.dumps({"type": "message_saved", "id": _saved_id})}\n\n'
```
Keys: `type`, `id`. Use to reconcile/anchor the message in local history.

### 5.8 Deep-research events (only when `use_research=true`)

All in `routes/chat_routes.py`:
- **`research_progress`** — `:589` → `{"type":"research_progress","data": <progress dict>}` (streamed while research runs; the dict may include `started_at`, `avg_duration`).
- **`research_sources`** — `:598` → `{"type":"research_sources","data": [...]}`.
- **`research_findings`** — `:602` → `{"type":"research_findings","data": [...]}`.
- **`research_done`** — `:605` → `{"type":"research_done","data":{"session_id": <id>}}` then `data:[DONE]`. Signals Myo to fetch/render the final report for that session.

> Research runs as a background task that survives refresh. During it the stream sends `: heartbeat N` comments (`:593`).

### 5.9 Other events you may observe (lower priority)

These exist in the broader codebase (teacher-escalation, skill learning, probing). Myo can ignore unknown types gracefully, but they are real:
`teacher_takeover`, `escalation_failed`, `skill_saved`, `skill_save_failed`, `skill_test_start`, `probe_start`, `probe_done`, `evaluating`, `pinned`, `recalled`, `tool_result`. (Discovered via grep over `routes/` + `src/` for `"type":`.) Also low-level upstream stream events `tool_call_delta`, `tool_calls`, `usage` are normally consumed *inside* the loop and not forwarded, except `tool_call_delta` indirectly drives `doc_stream_*`.

**Renderer guidance for Myo.** Implement a switch on `type`; fall through to "ignore" for anything unrecognized. Treat `{delta}` (no type) as transcript text. Treat `doc_*` as the editor panel. Treat `ui_control` as app commands. Treat `*_sources` / `memories_used` as info chips. End on `[DONE]`.

---

## 6. Session — `POST /api/session`

**What it is.** Creates a chat session (a conversation + its model binding). You need a `session` id before calling `/api/chat_stream`.

Router prefix is `/api` (`routes/session_routes.py:33`), route `routes/session_routes.py:162`:
```python
@router.post("/session", response_model=SessionResponse)
def create_session(
    request: Request,
    name: str = Form(""),
    endpoint_url: str = Form(""),
    model: str = Form(""),
    rag: str = Form(None),
    skip_validation: str = Form(None),
    api_key: str = Form(""),
    endpoint_id: str = Form(""),
):
    skip_val = str(skip_validation).lower() == "true"
    if not endpoint_url and not skip_val:
        raise HTTPException(400, "endpoint_url is required (choose from /api/models)")
```
- Full path: **`POST /api/session`** (multipart form).
- If you don't pass a `model`, it probes `/v1/models` on `endpoint_url` and picks the first chat model (skipping embedding/tts/whisper/etc.), `routes/session_routes.py:186`.
- Pass `skip_validation=true` to trust the caller and avoid the probe (useful for placeholder sessions).
- Response model `SessionResponse` includes the session `id` (use it as the `session` form field in chat).

> Tip: you typically don't need to pass `endpoint_url`/`model` if a default endpoint is configured (Section 8 auto-sets one); but the cleanest path is to register MyOwnLLM first, then create sessions that use it.

**Why Myo needs it.** One session per conversation thread. Create it on first message, reuse the id for the rest of the thread.

---

## 7. TTS — `POST /api/tts/synthesize`

**What it is.** Server-side text-to-speech. Returns either raw audio or base64. Critical for Myo's voice-first output.

Router prefix `/api/tts` (`routes/tts_routes.py:19`), route `routes/tts_routes.py:30`:
```python
class TTSRequest(BaseModel):
    text: str
    format: str = "audio"  # "audio" or "base64"

@router.post("/synthesize")
async def synthesize_speech(request: TTSRequest):
    if not tts_service.available:
        raise HTTPException(status_code=503, detail={"message": "TTS service not available"})
    if request.format == "base64":
        audio_b64 = tts_service.synthesize_to_base64(request.text)
        ...
        return {"audio": audio_b64}
    else:  # audio
        audio_data = tts_service.synthesize(request.text)
        ...   # returns Response with audio/mpeg or audio/wav
```
- `POST /api/tts/synthesize` with JSON body `{"text": "...", "format": "base64"}` → `{"audio": "<base64>"}`.
- With `"format":"audio"` (default) → raw audio bytes (`audio/mpeg` or `audio/wav`, auto-detected).
- **Returns 503 unless a provider is enabled.**

**Default is disabled.** `src/settings.py:43`:
```python
"tts_provider": "disabled",
```
**Available providers** (`services/tts/tts_service.py:18`):
```
"disabled"        — no TTS (default)
"browser"         — client-side Web Speech API (no server synthesis)
"local"           — Kokoro-82M on GPU
"endpoint:<id>"   — OpenAI-compatible /audio/speech via a ModelEndpoint
```
`available` logic, `services/tts/tts_service.py:43`:
```python
@property
def available(self) -> bool:
    settings = self._load_settings()
    provider = settings["tts_provider"]
    if provider == "disabled": return False
    if provider == "browser":  return True
    if provider == "local":
        kokoro = self._get_kokoro()
        return kokoro is not None and kokoro.available
    if provider.startswith("endpoint:"): return True
    return False
```
**To enable:** set the `tts_provider` setting (via the settings API / `data/settings.json`) to `"local"` (Kokoro) or `"endpoint:<modelEndpointId>"`. Also `tts_voice` (default `"alloy"`), `tts_model` (default `"tts-1"`), `tts_speed` (`"1"`).

**Voice input (Myo is voice-first):** there's a matching **STT** route, `routes/stt_routes.py:23`:
```python
@router.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    if not stt_service.available:
        raise HTTPException(status_code=503, detail={"message": "STT service not available or set to browser mode"})
    ...
    return {"text": text}
```
`POST /api/stt/transcribe` (multipart `file=<audio>`) → `{"text": "..."}`. Also gated by an STT provider setting; returns 503 if disabled/browser-mode.

**Why Myo needs it.** Speak responses (`/api/tts/synthesize`) and transcribe the user (`/api/stt/transcribe`). If Myo prefers to do TTS/STT itself (native Tauri), set the provider to `browser`/`disabled` and skip these.

---

## 8. Point the brain → MyOwnLLM — `POST /api/model-endpoints`

**What it is.** Registers an OpenAI-compatible LLM endpoint with Odysseus. Myo registers MyOwnLLM (`http://127.0.0.1:1473`) here so Odysseus uses it as its model provider.

Router prefix `/api` (`routes/model_routes.py:314`), route `routes/model_routes.py:808`:
```python
@router.post("/model-endpoints")
def create_model_endpoint(
    request: Request,
    name: str = Form(""),
    base_url: str = Form(...),
    api_key: str = Form(""),
    skip_probe: str = Form("false"),
    require_models: str = Form("false"),
    model_type: str = Form("llm"),
    supports_tools: str = Form(""),  # "true"/"false"/"" (unknown)
    shared: str = Form("true"),
):
    require_admin(request)
    base_url = base_url.strip().rstrip("/")
    for suffix in ["/models", "/chat/completions", "/completions", "/v1/messages"]:
        if base_url.endswith(suffix):
            base_url = base_url[:-len(suffix)].rstrip("/")
    ...
    _st_raw = (supports_tools or "").strip().lower()
    _st = True if _st_raw in ("true","1","yes") else (False if _st_raw in ("false","0","no") else None)
```
- Full path: **`POST /api/model-endpoints`** (multipart form). Requires admin → satisfied by Myo's loopback token (Section 2).
- Form fields Myo sends: `base_url=http://127.0.0.1:1473` (the `/v1` suffixes are auto-stripped), `model_type=llm`, `supports_tools=true` (so the agent uses native function-calling — important for tools to work), optional `name`.

**Auto-default-when-none** — the first endpoint registered becomes the default chat endpoint/model automatically. `routes/model_routes.py:872`:
```python
db.add(ep); db.commit()
# Auto-set as default chat endpoint if none configured yet
settings = _load_settings()
if not settings.get("default_endpoint_id"):
    settings["default_endpoint_id"] = ep.id
    settings["default_model"] = model_ids[0] if model_ids else ""
    _save_settings(settings)
```
Response: `{"id": "<8-char>", "name": "...", "models": [...], "online": <bool>}`.

**Why Myo needs it.** One-time setup: register MyOwnLLM's `:1473` as Odysseus's provider. Because it's the first/only endpoint, it auto-becomes the default — sessions created afterward use it with no extra config. Pass `supports_tools=true` so the agent loop enables OpenAI-style tool calls (the loop also auto-detects tool support by model name + endpoint flag, `src/agent_loop.py:1337`).

---

## 9. The layered permission model (coarse control for free — no fork)

Odysseus already enforces tool permissions at **four** independent layers. Myo can map its 4 category toggles + incognito onto these *without forking Odysseus*.

### (a) Role gating over a fixed sensitive-tool set

A hard-coded set of "admin-only" tools; non-admins are blocked at execution time. `src/tool_security.py:14`:
```python
NON_ADMIN_BLOCKED_TOOLS = {
    "bash", "python", "read_file", "write_file",
    "search_chats", "manage_memory", "manage_skills", "manage_tasks",
    "manage_endpoints", "manage_mcp", "manage_webhooks", "manage_tokens",
    "manage_documents", "manage_settings",
    "api_call", "app_api",
    "send_email", "reply_to_email", "list_emails", "read_email",
    "resolve_contact", "manage_contact", "manage_calendar",
    "vault_search", "vault_get", "vault_unlock",
    "download_model", "serve_model", "stop_served_model", "cancel_download",
    "adopt_served_model",
}
```
The gate, `src/tool_security.py:49`:
```python
def is_public_blocked_tool(tool_name):
    if not tool_name: return False
    return tool_name in NON_ADMIN_BLOCKED_TOOLS or tool_name.startswith("mcp__")
```
**Enforced** in the execution dispatcher, `src/tool_execution.py:550`:
```python
if is_public_blocked_tool(tool) and not _owner_is_admin(owner):
    desc = f"{tool}: BLOCKED"
    result = {"error": f"Tool '{tool}' is restricted to admin users on this deployment. ...", "exit_code": 1}
    return desc, result
```
(There's also a stricter `_ADMIN_TOOLS` subset checked at `src/tool_execution.py:544`: `manage_endpoints, manage_mcp, manage_webhooks, manage_tokens, manage_settings, download_model, serve_model, stop_served_model, cancel_download`.)

> Since Myo authenticates as **admin** (loopback token, Section 2), these gates are a no-op for Myo's own calls. They matter if Myo ever exposes Odysseus to a *non-admin* `X-Odysseus-Owner` user.

### (b) Per-turn capability flags

Cross-reference **Section 4**: the `allow_bash` / `allow_web_search` / `incognito` form fields build a per-request `disabled_tools` set in `routes/chat_routes.py:386`. This is the cheapest knob — Myo flips these per message.

### (c) Persistent `disabled_tools` allowlist

A global, persisted list of disabled tool names in settings.

- **Read in the agent loop:** `disabled_tools` is passed into `stream_agent_loop` and unioned with policy blocks; the chat route merges the global setting at `routes/chat_routes.py:424` (`get_setting("disabled_tools", [])`). The loop normalizes it at `src/agent_loop.py:1250`:
  ```python
  disabled_tools = set(disabled_tools or [])
  public_blocked_tools = blocked_tools_for_owner(owner)
  if public_blocked_tools:
      disabled_tools.update(public_blocked_tools)
  ```
- **HTTP route to read/set it** (`routes/model_routes.py:1203`, prefix `/api`):
  ```python
  @router.get("/tools")
  def list_tools():
      disabled = set(settings.get("disabled_tools", []))
      tools = [{"id": tag, "enabled": tag not in disabled} for tag in sorted(TOOL_TAGS)]
      return {"tools": tools}

  @router.post("/tools")           # body: {"disabled": [...]}
  def update_tools(body: ToolsUpdate, request: Request):
      require_admin(request)
      settings["disabled_tools"] = body.disabled
      _save_settings(settings)
      return {"ok": True, "disabled": body.disabled}
  ```
  → **`GET /api/tools`** and **`POST /api/tools`** `{"disabled":[...]}`.
- **Agent-editable** (the model can toggle tools itself via `manage_settings` actions `disable_tool`/`enable_tool`/`list_tools`), `src/tool_implementations.py:1681` (inside `do_manage_settings`, defined at `:1457`):
  ```python
  if action == "disable_tool":
      for t in targets:
          if t not in current: current.append(t)
  else:  # enable_tool
      current = [t for t in current if t not in targets]
  settings["disabled_tools"] = current
  save_settings(settings)
  ```
  Aliases the agent understands (`src/tool_implementations.py` ~1650): `shell→bash`, `search→web_search`, `memory→manage_memory`, `notes→manage_notes`, `calendar→manage_calendar`, `email→mcp__email__*`, etc.

### (d) Per-MCP-server tool disabling + scoped API tokens

**Per-MCP-server disabling** — turn off individual tools on a given MCP server. `routes/mcp_routes.py` (prefix `/api/mcp`, `:19`), handler at `:314`:
```python
@router.patch("/servers/{server_id}/tools")
async def update_disabled_tools(server_id: str, request: Request):
    """Bulk update disabled tools list for a server.
    Expects JSON body: {"disabled": ["tool_name_1", "tool_name_2"]}"""
    ...
    srv.disabled_tools = json.dumps(disabled) if disabled else None
    return {"id": server_id, "disabled_count": len(disabled)}
```
→ **`PATCH /api/mcp/servers/{server_id}/tools`** `{"disabled":[...]}`. (The loop applies this via `_load_mcp_disabled_map()`, `src/agent_loop.py:1264`.)

**Scoped API tokens** — bearer tokens carry comma-separated scopes (default `"chat"`). Validated/stamped in the auth middleware, `app.py:217`:
```python
matched_scopes = []
for tid, thash, owner, scopes in candidates:
    if _bcrypt.checkpw(raw_token.encode(), thash.encode()):
        matched_id = tid; matched_owner = owner; matched_scopes = scopes or []
        break
...
request.state.api_token_scopes = matched_scopes   # app.py:249
```
Default scope is `"chat"` (`routes/api_token_routes.py:14` → `DEFAULT_SCOPES = "chat"`), and routes that care read it, e.g. `routes/webhook_routes.py:198` → `scopes = set(getattr(request.state, "api_token_scopes", []) or [])`.

> Myo doesn't use bearer tokens (it uses the loopback header), so scopes are mostly relevant if Myo mints tokens for *other* clients.

**Why Myo needs it.** Map Myo's 4 category toggles + incognito to layer (b) (per-turn `allow_*`/`incognito`) for ephemeral control, and to layer (c) (`POST /api/tools`) for sticky "this user has Code disabled" preferences — all without forking.

---

## 10. The tool-execution choke point (for a FUTURE fine-grained approval hook)

**What it is.** Every tool call funnels through one async function, `execute_tool_block`, in `src/tool_execution.py:477`:
```python
async def execute_tool_block(
    block: Any,
    session_id: Optional[str] = None,
    disabled_tools: Optional[set] = None,
    owner: Optional[str] = None,
    progress_cb: Optional[Callable[[Dict], Awaitable[None]]] = None,
) -> Tuple[str, Dict]:
    ...
    tool = block.tool_type
    content = block.content
```
The permission gates run first (`src/tool_execution.py:537`–`:560`):
```python
# Reject tools the user disabled this request
if disabled_tools and tool in disabled_tools:
    return f"{tool}: BLOCKED", {"error": f"Tool '{tool}' is disabled by user.", "exit_code": 1}
if tool in _ADMIN_TOOLS and not _owner_is_admin(owner):
    return f"{tool}: BLOCKED", {"error": f"Tool '{tool}' requires an admin user.", "exit_code": 1}
if is_public_blocked_tool(tool) and not _owner_is_admin(owner):
    return f"{tool}: BLOCKED", {"error": "... restricted to admin users ...", "exit_code": 1}
```
…and immediately after, dispatch begins as a long `if/elif tool == "...": result = await do_xxx(...)` chain (first branches around `src/tool_execution.py:566` onward for `bash`, then the doc/manage/etc. handlers). Each handler **runs to completion and returns** `(desc, result)`.

**The single seam for an approval hook.** A no-op-by-default pre-exec callback would wrap **right here** — after the gates at `:560` pass and before the dispatch chain — inside `execute_tool_block`. Signature today already threads `owner`, `session_id`, `disabled_tools`, `progress_cb`; an approval callback would slot alongside `progress_cb`.

**The gap.** Once a tool is permitted it executes fully — **there is no mid-run consent / interruption**. The caller in the agent loop launches it as a task and only drains progress events; it cannot pause for user approval mid-execution:
```python
# src/agent_loop.py:1891
async def _run_tool():
    return await execute_tool_block(block, session_id=session_id,
                                    disabled_tools=disabled_tools, owner=owner,
                                    progress_cb=_push_progress)
_tool_task = asyncio.create_task(_run_tool())
```
**Why Myo needs it.** If Myo wants per-tool "are you sure?" approval, this `execute_tool_block` boundary is the exact place to add a `pre_exec_cb(tool, content, owner) -> bool` gate. **This (mid-run, fine-grained approval) is the one thing Odysseus lacks today** — everything else (allow/deny up front) already exists.

---

## 11. Tool catalog & categories (map Myo's 4 toggles to real tool names)

**Canonical built-in tool name set** (`TOOL_TAGS`), `src/agent_tools.py:29`:
```python
TOOL_TAGS = {"bash", "python", "web_search", "read_file", "write_file",
             "create_document", "update_document", "edit_document",
             "search_chats", "chat_with_model", "create_session", "list_sessions",
             "send_to_session", "pipeline", "manage_session", "manage_memory",
             "list_models", "ui_control", "generate_image", "manage_tasks",
             "api_call", "ask_teacher", "manage_skills", "suggest_document",
             "manage_endpoints", "manage_mcp", "manage_webhooks", "manage_tokens",
             "manage_documents", "manage_settings", "manage_notes", "manage_calendar",
             "resolve_contact", "manage_contact", "list_email_accounts", "send_email",
             "list_emails", "read_email", "reply_to_email", "bulk_email", "archive_email",
             "delete_email", "mark_email_read",
             "download_model", "serve_model", "list_served_models", "stop_served_model",
             "list_downloads", "cancel_download", "search_hf_models", "list_cached_models",
             "list_serve_presets", "serve_preset", "adopt_served_model", "list_cookbook_servers",
             "edit_image", "trigger_research", "manage_research", "app_api"}
```
> Note on names: `web_search`, `bash`, `python`, `read_file`, `write_file`, `generate_image`, `manage_memory` etc. are first-class. A few capabilities are **MCP-served** (namespaced `mcp__...`) rather than appearing in `TOOL_TAGS`: e.g. `generate_image` is also exposed via `mcp_servers/image_gen_server.py`, `manage_memory` via `mcp_servers/memory_server.py`, and email tools may appear as `mcp__email__*`. There is **no** tool literally named `builtin_browser` in `TOOL_TAGS`; browser/screenshot output surfaces through `tool_output.screenshot` (Section 5.3) — treat "browser" as part of the Web category via whatever browser tool the deployment's MCP exposes. `research` is a **per-request flag** (`use_research`) plus the `trigger_research`/`manage_research` tools, not a single "research" tool.

**Suggested mapping for Myo's 4 category toggles** (+ infra):

| Myo category | Odysseus tools |
|---|---|
| **Web** | `web_search`, `trigger_research`, `manage_research` (+ `use_research`/`use_web` flags); browser via MCP |
| **Files** | `read_file`, `write_file`, `create_document`, `edit_document`, `update_document`, `suggest_document`, `manage_documents` |
| **Code** | `bash`, `python` |
| **Reach-out** | `send_email`, `reply_to_email`, `list_emails`, `read_email`, `list_email_accounts`, `bulk_email`, `archive_email`, `delete_email`, `mark_email_read`, `manage_calendar`, `resolve_contact`, `manage_contact` |
| **Management / infra** | `manage_endpoints`, `manage_mcp`, `manage_webhooks`, `manage_tokens`, `manage_settings`, `manage_skills`, `manage_tasks`, `manage_session`, `manage_memory`, `api_call`, `app_api`, model-serving (`download_model`, `serve_model`, `stop_served_model`, `cancel_download`, `adopt_served_model`, `list_*`, `serve_preset`), `generate_image`, `edit_image`, `ui_control` |

To toggle a category off for the user, add its tool names to the `disabled_tools` list via `POST /api/tools` (sticky) or the per-turn flags (ephemeral). `GET /api/tools` returns the authoritative current list of `{id, enabled}`.

**Why Myo needs it.** Myo's category switches must reference real tool names; this table is the mapping.

---

## 12. Mutating tools (which tools are writes — for future approval gating)

Tools that **mutate state** (write files, send messages, change settings, run code) vs. read-only. Based on the schemas in `src/tool_schemas.py` and the handler names in `src/tool_execution.py`:

**Mutating / effectful (would warrant approval):**
- Filesystem / shell: `write_file`, `bash`, `python`
- Documents: `create_document`, `edit_document`, `update_document`, `suggest_document`, `manage_documents`
- Messaging / outreach: `send_email`, `reply_to_email`, `bulk_email`, `archive_email`, `delete_email`, `mark_email_read`, `manage_contact`, `manage_calendar`
- Persistent state: `manage_memory`, `manage_skills`, `manage_tasks`, `manage_notes`, `manage_settings`, `manage_session`
- Infra / serving: `manage_endpoints`, `manage_mcp`, `manage_webhooks`, `manage_tokens`, `download_model`, `serve_model`, `stop_served_model`, `cancel_download`, `adopt_served_model`, `serve_preset`
- Generic side-effecting loopback: `api_call`, `app_api`
- Media: `generate_image`, `edit_image`
- UI: `ui_control` (mutates app state)

**Read-only (safe to auto-run):**
- `read_file`, `web_search`, `search_chats`, `list_emails`, `read_email`, `list_email_accounts`, `resolve_contact`, `list_sessions`, `list_models`, `list_served_models`, `list_downloads`, `search_hf_models`, `list_cached_models`, `list_serve_presets`, `list_cookbook_servers`

> The agent loop already tracks an "effectful tool" notion for its completion-verifier (`_VERIFIER_EFFECTFUL_TOOLS`, used at `src/agent_loop.py:2052`) — a similar set. Use the mutating list above as the seed for Myo's future per-tool approval prompts (Section 10).

**Why Myo needs it.** When Myo later adds the approval hook, it should prompt only for mutating tools, auto-allowing reads.

---

## 13. Packaging facts

**Mandatory deps** (`requirements.txt`): `fastapi`, `uvicorn`, `python-multipart`, `python-dotenv`, `httpx`, `pydantic`, `pydantic-settings`, `SQLAlchemy`, `pypdf`, `beautifulsoup4`, `charset-normalizer`, `numpy`, `chromadb-client`, `fastembed`, `youtube-transcript-api`, `markdown`, `icalendar`, `caldav`, `cryptography`, `bcrypt`, `mcp`, `pyotp`, `qrcode[pil]`, `croniter`, `pytest`, `pytest-asyncio`.

> Note: `chromadb-client` + `fastembed` are core (RAG, semantic memory, tool selection). At runtime the in-app **vector document RAG is disabled** anyway (`app.py:348` — chromadb client couldn't instantiate), and the system **degrades to a keyword fallback** for tool selection if embeddings are missing (`src/agent_loop.py:1306`). So practically, a v1 can run with the keyword fallback if the vector stack misbehaves.

**Optional deps** (`requirements-optional.txt`):
- `duckduckgo-search` — a search provider option (alternatives: SearXNG, Brave, Tavily, Serper, Google PSE).
- `PyMuPDF` — PDF **form-filling** only. **AGPL-3.0** — installing it imposes AGPL on a network-served app. MIT core (PDF *text* extraction via `pypdf`) works without it.

**What can be disabled for a Myo v1** (all degrade gracefully):
- **SearXNG / web search providers** — optional; web search just returns nothing/disabled.
- **ntfy** (push notifications) — optional.
- **tmux / Cookbook** (LLM serving + model downloads) — the whole `serve_*`/`download_*` surface; not needed if MyOwnLLM is the model host.
- **PyMuPDF** — skip to avoid AGPL; lose only PDF form-filling.
- **ChromaDB** — falls back to **fastembed keyword** path for tool selection; vector doc RAG is already off.

**Python:** 3.12 (`Dockerfile:1`: `FROM python:3.12-slim`). `pyproject.toml` only configures pytest (no version pin there).

**Launch:**
```bash
ODYSSEUS_INTERNAL_TOKEN=<shared-secret> \
AUTH_ENABLED=true \
ODYSSEUS_INPROCESS_POLLERS=1 \
ODYSSEUS_INPROCESS_TASKS=1 \
uvicorn app:app --host 127.0.0.1 --port 7000
```
Env vars (verified):
- `ODYSSEUS_INTERNAL_TOKEN` — the loopback admin secret (Section 2). **Must be set before boot.**
- `AUTH_ENABLED` — `app.py:109`; `"false"` disables the auth middleware entirely (`AUTH_ENABLED=true` keeps it on; default true). With the loopback token Myo doesn't need to disable it.
- `LOCALHOST_BYPASS` — `app.py:110`; `"true"` lets ALL 127.0.0.1/::1 requests through with no token (`app.py:191`). Coarser than the token; default false.
- `ODYSSEUS_INPROCESS_POLLERS` — `routes/email_pollers.py:964`; `0` disables in-process email pollers (drive externally). Default `1`.
- `ODYSSEUS_INPROCESS_TASKS` — `app.py:847`; `0` disables the in-process scheduled-task runner. Default `1`.

> Docker's default `CMD` binds `0.0.0.0:7000` (`Dockerfile:47`); for Myo bind loopback (`127.0.0.1`) so only Myo (and the agent's own loopback) can reach it.

**Why Myo needs it.** To bundle/launch Odysseus as a managed sidecar process with the right env and minimal optional deps.

---

## 14. Memory / continuity (continuous presence + one-tap pause/incognito)

**What it is.** Odysseus has a persistent, owner-scoped memory store plus RAG retrieval that injects relevant memories into each turn. Myo v1 is a "continuous presence" with automatic LOCAL memory and a one-tap pause.

**The memory tool — `manage_memory`** (MCP-served), `mcp_servers/memory_server.py:51`:
```python
name="manage_memory",
... "action": {"enum": ["list", "add", "edit", "delete", "search"]}
```
The agent calls it to add/list/edit/delete/search memories. It is owner-scoped (memories attributed to `X-Odysseus-Owner`).

**Injection into context + the `memories_used` event.** Memories are loaded and injected before the model runs, in `src/chat_processor.py:194`:
```python
self._last_used_memories = []
if use_memory:
    mem_entries = self.memory_manager.load(owner=owner)
    pinned   = [m for m in mem_entries if m.get("pinned")]
    extended = [m for m in mem_entries if not m.get("pinned")]
    if pinned:
        ... preface.append(untrusted_context_message("saved memory: pinned user facts", ...))
        for m in pinned:
            self._last_used_memories.append({"text": m["text"], "category": ..., "type": "pinned"})
    if extended:
        relevant = self._hybrid_retrieve(message, extended, k=3)   # RAG retrieval
        for m in relevant:
            self._last_used_memories.append({"text": m["text"], "category": ..., "type": "recalled"})
```
`_last_used_memories` is surfaced as the `memories_used` SSE event (Section 5.7) via `routes/chat_helpers.py:423` → emitted at `routes/chat_routes.py:484`. **This is how Myo shows "I remembered X."**

**Incognito / pause gating.** Memory (and skills, and history writes) are all gated by `incognito`. `routes/chat_helpers.py:384`:
```python
mem_enabled = not incognito and not no_memory and uprefs.get("memory_enabled", True)
...
skills_enabled = not incognito and uprefs.get("skills_enabled", True)
```
…and the user message itself isn't persisted in incognito, `routes/chat_helpers.py:290`:
```python
if not incognito:
    # persist user message
```
Plus the chat route adds memory/identity tools to `disabled_tools` when `incognito` (Section 4, `routes/chat_routes.py:394`). Sessions named `"Nobody"`/`"Incognito"` are hidden from the session list (`routes/session_routes.py:158`).

**Two ways for Myo to control memory:**
1. **Per-turn pause** — set `incognito=true` on `/api/chat_stream`. No memory read, no memory write, no history persist. This is the one-tap pause.
2. **Persistent preference** — `memory_enabled` user pref (`uprefs.get("memory_enabled", True)`); when false, memory is off for all turns.

**Review / forget memory — HTTP API** (`routes/memory_routes.py`, prefix `/api/memory`):
- `GET /api/memory` → `{"memory": [...]}` — list all of the user's memories. (`:109`)
- `POST /api/memory/add` (form `text`, `category`, `source`, `session_id`) — add. (`:68`)
- `POST /api/memory/search` (form `query`, `category?`, `session_id?`) — search. (`:115`)
- `DELETE /api/memory/{memory_id}` — forget one. (`:498`)
- `POST /api/memory/{memory_id}/pin` — pin (always-injected core fact). (`:451`)
- `PUT /api/memory/{memory_id}` — edit. (`:476`)
- `GET /api/memory/timeline`, `GET /api/memory/by-session/{id}` — review by time/session. (`:131`, `:160`)

(Write routes call `require_privilege(request, "can_manage_memory")` — satisfied by Myo's admin loopback.)

**Why Myo needs it.** "Continuous presence" = let memory run by default (don't send `incognito`), surface `memories_used` so the user sees what's remembered, and wire:
- **Pause memory** → send `incognito=true` (per-turn) or flip the `memory_enabled` pref (sticky).
- **Review/forget memory** → `GET /api/memory` to list, `DELETE /api/memory/{id}` to forget, `PUT`/`pin` to curate.

---

## Gotchas / surprises

1. **`ODYSSEUS_INTERNAL_TOKEN` is read once at import.** If it isn't in the env *before* uvicorn starts, Odysseus invents a random token and Myo's loopback header will never match. Always launch Odysseus with this env var set.
2. **`/api/chat_stream` is multipart FORM, not JSON.** A JSON body is accepted only for a couple of fields; the real inputs (`message`, `session`, `mode`, `allow_*`, `incognito`, …) come from `await request.form()`.
3. **`bash` and `web_search` are OFF unless explicitly enabled** per turn (`allow_bash=true` / `allow_web_search=true`). Everything else is on by default.
4. **Check `data.type` BEFORE the `delta` key** when parsing SSE — `tool_call_delta` carries an `arg_delta` and would be mis-rendered as transcript text otherwise.
5. **`doc_stream_delta.content` is cumulative** (full content so far), not a fragment — replace the editor buffer, don't append. (Contrast with `delta`, which IS appended.)
6. **The `/api/tools/*/render` iframe route does not exist** — it's only a CSP special-case in middleware. Don't build against it; render the SSE intent stream instead.
7. **`ui_control` is the agent issuing commands to your UI.** The discriminator is `data.ui_event` (values in §5.5), and the same fields are *also* duplicated onto `tool_output` — don't double-apply; prefer the `ui_control` event.
8. **No mid-run tool approval exists.** Once permitted, a tool runs to completion; the loop only forwards progress. The lone seam to add consent is `execute_tool_block` (`src/tool_execution.py:477`).
9. **Vector RAG for personal docs is disabled at runtime** (`app.py:348`) despite chromadb being a "core" dep; tool selection silently falls back to keyword matching if embeddings are unavailable. Don't rely on semantic doc RAG for v1.
10. **TTS/STT default to `disabled`** and return **503** until a provider is configured (`tts_provider` / STT provider settings). Enable `local` (Kokoro) or an `endpoint:<id>`, or do voice natively in Myo and leave these off.
11. **First registered model endpoint auto-becomes the default** (`routes/model_routes.py:872`) — register MyOwnLLM once and sessions just work; you don't have to set `default_model` yourself.
12. **`X-Odysseus-Owner` matters for data ownership.** Without it, agent-created notes/calendar/memory are owned by `"internal-tool"` and become invisible to the human user. Always pass the user's name.
13. **Some "tools" aren't in `TOOL_TAGS`** — `manage_memory`, `generate_image`, and email tools can be **MCP-served** (`mcp__...`), and `research`/`web`/`incognito` are **per-request flags**, not tools. There is no tool literally named `builtin_browser`.
14. **`research_done` then `[DONE]` ends a research turn early** — when `use_research=true`, the stream returns right after `research_done` (`routes/chat_routes.py:606`); fetch the report for that `session_id` separately.
15. **Two SSE producers.** Context-level events (`model_info`, `*_sources`, `memories_used`, `compacted`, `message_saved`, `research_*`) come from the chat-route wrapper; per-round/tool events come from `stream_agent_loop`. Your single SSE parser sees both interleaved.
