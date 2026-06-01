# Myo — Project Handoff Package

> **Myo *is* the AI — not an app with an AI inside it.** One voice-first
> (touch-second, type-third) local companion with its own brain, ears, voice,
> memory, networking, and files, where **the interface dissolves into the
> conversation**: you mostly just talk and *watch the agent work*. UI is an
> *output of the agent*, materialized on the fly — never a fixed frame. A thin
> mid-layer lets you step in to approve, tweak, or edit anything. Everything runs
> and stays **local**.

Myo is built by composing three existing local-AI projects as swappable
"senses" behind one thin shell:

- **Odysseus** = the **brain** (Python/FastAPI agent loop, tools, RAG, memory,
  email/calendar/docs, research, TTS) — tracked upstream, no fork.
- **MyOwnLLM** = the **ears** (ASR/diarization, extracted as a `myo-asr` crate)
  and the **model engine** (`:1473` OpenAI-compatible server).
- **MyOwnMesh** = **networking** for multi-device (v2).

---

## ⚠️ What this directory is

This `/myo` folder is a **self-contained handoff package**. It lives on a
**MyOwnLLM branch used purely as a transfer vehicle** — the authoring agent's
GitHub scope was limited to `odysseus` / `MyOwnLLM` / `MyOwnMesh` and could not
push the intended new repo. **The next agent that builds Myo will have only this
package** (plus, ideally, write access to the new `mrjeeves/Myo` repo). So every
contract needed to integrate the three projects is captured here as **real,
verified code excerpts** — you should not need the original source to build v1.

**Myo's real home is its own `mrjeeves/Myo` repo.** Do not treat MyOwnLLM as
Myo's home; it's only carrying this folder.

---

## 📚 Files (read in this order)

| # | File | What it is |
|---|---|---|
| 1 | **`getting-started.md`** | **Start here.** The next-agent runbook: what you have, first moves (ordered), hard rules, definition-of-done. |
| 2 | **`PLAN.md`** | The complete integration plan — architecture, Myo Core API, repo skeleton, ordered implementation steps, verification, risks. **The master spec.** |
| 3 | **`decisions-and-rationale.md`** | *Why* Myo is shaped this way: the five product decisions + rejected alternatives. Read before changing direction. |
| 4 | **`odysseus-integration.md`** | The **brain's** HTTP/SSE contract with verified code excerpts — health/auth, `chat_stream`, the full **SSE event vocabulary** (the "dissolved UI" protocol), TTS, model-endpoint registration, the 4-layer permission model, the tool catalog, the future approval choke-point, memory. *You will not have the Odysseus source — this is your bible for the brain.* |
| 5 | **`myownllm-integration.md`** | The **ASR engine** to extract (`myo-asr`), the FrameSink seam, the model sidecar, the supervision pattern to port, Tauri bundling, and per-arch onnxruntime for the 5-target matrix. |
| 6 | **`myownmesh-v2.md`** | The **mesh** reference for the v2 multi-device milestone (embedded-lib API + control-socket IPC, pairing, how MyOwnLLM embeds it). |

All line references in these docs were verified against the real source on branch
`claude/practical-shannon-RPFiK`.

---

## The five product decisions (settled with the owner)

1. **One shell** — a fresh Tauri 2 + Svelte 5 "Myo" that *renders agent intent*, not fixed screens.
2. **4-category control** — Web / Files / Code / Reach-out toggles composed onto Odysseus's *existing* permission knobs (coarse control, **no fork**). Per-action approve/tweak/edit is the upstreamable next layer.
3. **Open-mic + barge-in** — full-duplex with echo cancellation so it never hears itself; hard-mute always one tap away.
4. **Single evolving stage + history** — Presence orb + one focal Stage + ambient ActivityStrip + recallable History; surfaces are voice-addressable.
5. **Continuous presence** — automatic local memory + RAG across days; visible, forgettable, pausable.

See `decisions-and-rationale.md` for the full reasoning and what was rejected.

---

## Platforms

Ship **5 target-triples** from day one: `windows-x86_64`, `linux-x86_64`,
`linux-aarch64`, `macos-x86_64`, `macos-aarch64` (Windows x64 only — no
Windows-on-ARM). The owner's test fleet spans all five. Stand up the 5-target CI
matrix early; AEC differs per webview (CoreAudio / WebKitGTK / WebView2).

---

## v1 definition of done

Speak → transcribe (MyOwnLLM ASR) → answer (Odysseus agent) → speak back
(Odysseus TTS), **full-duplex with barge-in**, while Myo natively renders the
agent's live intent stream (activity, streamed **editable** document artifacts,
agent `ui_control` panels) on a **single evolving stage with recallable
history**, backed by a **continuous-presence memory** (visible/forgettable/
pausable) and a **four-toggle control surface** (Web/Files/Code/Reach-out)
driving Odysseus's existing permission knobs — on all **5 platforms**. The
`PLAN.md` "Verification" section is the acceptance checklist.

---

## Hard rules (don't violate — see `getting-started.md` §6)

- **Don't fork Odysseus** and **don't build a Myo-native MCP/tool system.** Build
  *around* Odysseus; the only Odysseus change is a later, upstreamable,
  no-op-by-default approval hook.
- **Don't reimplement** the brain/tools/RAG/memory/TTS (Odysseus has them) or ASR
  (MyOwnLLM has it).
- **Voice-first, dissolved UI, everything local.**
- **Unknown agent event kinds: log + ignore, never crash.**
