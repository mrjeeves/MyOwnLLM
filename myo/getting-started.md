# Myo — Getting Started (for the next agent)

You are picking up the **Myo** project. This `/myo` directory is your
**source of truth** — it was authored by a previous agent that had all three
source repos locally but could **not** push to the new `mrjeeves/Myo` repo
(its GitHub scope was limited to `odysseus` / `MyOwnLLM` / `MyOwnMesh`). So it
packaged everything you need here, on a **MyOwnLLM branch used purely as a
transfer vehicle**.

Read this first, then `README.md` for the full index.

---

## 1. What you have vs. what you need

**You have (in this `/myo` directory — self-contained, no source access assumed):**
- `PLAN.md` — the complete integration plan (architecture, Core API, repo
  skeleton, ordered implementation steps, verification, risks). **The master.**
- `decisions-and-rationale.md` — *why* every major choice was made + rejected
  alternatives. Read before changing direction.
- `odysseus-integration.md` — **the brain's HTTP/SSE contract with real code
  excerpts.** You will *not* be given the Odysseus source by default, so this is
  your integration bible for the brain.
- `myownllm-integration.md` — the ASR engine to extract (`myo-asr`), the model
  sidecar, supervision pattern, Tauri bundling, onnxruntime/per-arch delivery.
- `myownmesh-v2.md` — mesh networking reference for the v2 multi-device milestone.

**You will also want (the owner's repos — request/clone as needed):**
- **`mrjeeves/Myo`** — your build target. Likely **empty**; you scaffold it.
- **`mrjeeves/MyOwnLLM`** — the ASR source for the `myo-asr` extraction. *Note:
  this transfer branch is literally a MyOwnLLM checkout, so the ASR source is
  already next to you* (`../src-tauri/src/asr`, `diarize`, `transcribe.rs`,
  `frame_sink.rs`, `resolver.rs`, `hardware.rs`, `models.rs`, `ort_setup.rs`,
  `ort_install.rs`).
- **`mrjeeves/odysseus`** — vendored at runtime as a submodule (the brain).
- **`mrjeeves/MyOwnMesh`** — v2 only.

> **Reality check:** confirm with the owner that you have **write access to
> `mrjeeves/Myo`** before scaffolding. If you also have the three source repos,
> great; if not, everything you need to integrate is captured in the docs here.

---

## 2. Knowledge map — which doc answers what

| Question | Doc |
|---|---|
| What am I building, in what order? | `PLAN.md` → "Implementation steps" |
| Why is it shaped this way? Can I change X? | `decisions-and-rationale.md` |
| How do I call the brain / parse its stream? | `odysseus-integration.md` |
| What's the agent event vocabulary I render? | `odysseus-integration.md` §5 (SSE) + `PLAN.md` "Agent intent stream" |
| How do I get capability control without forking? | `odysseus-integration.md` §9 + `PLAN.md` tier-a |
| How do I extract/reuse the ASR engine? | `myownllm-integration.md` §1–§3 |
| How do I supervise the sidecars? | `myownllm-integration.md` §5 |
| How do I ship 5 platforms? | `myownllm-integration.md` §6–§7 + `PLAN.md` risks 9 |
| What's the Myo Core API (Tauri cmds + events)? | `PLAN.md` "Myo Core API" |
| How do I know v1 works? | `PLAN.md` "Verification" |

---

## 3. First moves (in order)

1. **Read** `PLAN.md`, then `decisions-and-rationale.md`, then the three
   integration docs. Don't start coding until the intent-stream contract
   (`odysseus-integration.md` §5) is clear — the entire renderer keys off it.
2. **Confirm access** to `mrjeeves/Myo` (and ideally the three source repos).
3. **Scaffold `mrjeeves/Myo`** per `PLAN.md` → "Myo repo skeleton": a Cargo
   workspace (`src-tauri` + `crates/*`), Tauri 2 + Svelte 5, a `justfile`
   mirroring `MyOwnLLM/Justfile`. Wire **all 5 targets** from the start (mic
   perms + WebRTC/AEC for macOS/Linux/Windows — see `myownllm-integration.md`
   §6).
4. **Extract `crates/myo-asr`** from MyOwnLLM (history-preserving `git mv` if you
   have the MyOwnLLM repo; otherwise copy with attribution). Delete
   `impl FrameSink for WebviewWindow`; switch `transcribe.rs` start/upload
   signatures to `sink: Arc<dyn FrameSink>`. (`myownllm-integration.md` §1–§3.)
5. **Engine supervision** (`PLAN.md` step 3): port MyOwnLLM's `DaemonChild`
   pattern to launch + health-check Odysseus (uvicorn) and `myownllm serve`.
6. **Brain client** (`PLAN.md` step 4): loopback client with internal-token
   headers; **parse the full SSE vocabulary** into the normalized `myo://`
   intent stream.
7. **ASR adapter + open-mic** (step 5), **`ensure_ready` auto-config** (step 6),
   then **voice spine + surface renderer + control surface** (step 7).
8. **Verify** continuously against `PLAN.md` → "Verification" (it has non-audio /
   CI hooks so you can test without a mic, and direct `curl` probes for the
   brain).

> The dependency spine is: **myo-asr crate → supervision → brain client →
> ASR/open-mic → ensure_ready → spine+renderer.** The renderer (step 7) is where
> the five product decisions become visible — build it to `decisions-and-
> rationale.md`, not from your own UI instincts.

---

## 4. Platform / CI (do this early, not last)

Ship **5 target-triples**: `windows-x86_64`, `linux-x86_64`, `linux-aarch64`,
`macos-x86_64`, `macos-aarch64` (Windows x64 only). Stand up the 5-target CI
matrix **before** the codebase grows — cross-compilation of native deps
(onnxruntime, `myo-asr`, the bundled sidecar, Kokoro) is the kind of thing that's
cheap to keep green and expensive to retrofit. Reuse MyOwnLLM's `ort_install.rs`
for per-arch onnxruntime. AEC differs per webview (CoreAudio / WebKitGTK /
WebView2) — validate each; fall back to half-duplex push-to-talk where AEC is
unusable.

---

## 5. Branch / PR conventions

- The three **source** repos use branch `claude/practical-shannon-RPFiK` — this
  transfer branch is on MyOwnLLM. **Do not** treat MyOwnLLM as Myo's home; it's
  only carrying `/myo`.
- For **`mrjeeves/Myo`**, agree a branch name with the owner and open PRs there.
- The `myo-asr` extraction touches MyOwnLLM; the future fine-grained-approval
  hook touches Odysseus (as an **upstreamable, no-op-by-default** PR). Keep those
  on the respective repos' branches — never a divergent fork.

---

## 6. Hard rules (from the owner — don't violate)

- **Do not fork Odysseus** and **do not build a Myo-native MCP/tool system.**
  Build *around* Odysseus; the only Odysseus change is the upstreamable approval
  hook, and that's a *later* milestone.
- **Don't reimplement the brain, the tools, RAG, memory, or TTS** — Odysseus has
  them. Don't reimplement ASR — MyOwnLLM has it.
- **Voice-first, touch-second, type-third.** The home screen is an ambient
  presence indicator, not a button. Keep the interface *dissolved*.
- **Everything local.** No always-on audio or memory ever leaves the device.
- **Unknown agent event kinds:** log + ignore, never crash. The renderer must
  tolerate Odysseus emitting new event types.
- If a decision in `decisions-and-rationale.md` seems wrong, **raise it with the
  owner** — don't silently change the product's feel.

---

## 7. Definition of done for v1

Speak → transcribe (MyOwnLLM ASR) → answer (Odysseus agent) → speak back
(Odysseus TTS), **full-duplex with barge-in**, while Myo natively renders the
agent's live intent stream (activity, streamed **editable** document artifacts,
agent `ui_control` panels) on a **single evolving stage with recallable
history**, backed by a **continuous-presence memory** (visible/forgettable/
pausable), and a **four-toggle control surface** (Web/Files/Code/Reach-out)
driving Odysseus's existing permission knobs — on all **5 platforms**. The
`PLAN.md` "Verification" section is the acceptance checklist.
