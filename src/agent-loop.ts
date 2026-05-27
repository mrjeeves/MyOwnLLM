/**
 * Chat agent loop with tool calling.
 *
 * Wraps a single chat completion (`ollama_chat_stream`, or its mesh
 * equivalent via `meshClient.sendInferRequest`) and turns it into an
 * agent: when the model emits one or more `tool_calls`, we run the
 * named tool on this device, append the result as a `role: "tool"`
 * message, and re-run the chat with the augmented transcript. We stop
 * when a turn finishes without any tool calls — that turn's
 * `content` + `thinking` are the user-visible reply.
 *
 * The loop runs entirely on the caller's device. The mesh peer (when
 * routing is pinned) just streams the model back; tool side-effects
 * always happen here because the things being managed (saved
 * networks, the user's mesh client) live on this device.
 *
 * Cancellation is cooperative — callers pass a `signal: AbortSignal`
 * that we check before each turn. Mid-turn the underlying stream
 * is cancellable via `ollama_chat_cancel` / `infer_cancel`; we
 * surface the cancel handle so the Chat UI's Stop button can fire
 * it directly.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ToolCall, StoredMessage } from "./conversations";
import { TOOLS_BY_NAME, type Tool } from "./agent-tools";
import { meshClient } from "./mesh-daemon.svelte";
import type { Mode } from "./types";

/** Per-frame payload the chat-stream event channel emits. Matches the
 *  shape both `ollama_chat_stream` (local) and the mesh's
 *  `infer_chunk` (after we extend it) produce. */
interface StreamFrame {
  delta?: string;
  thinking_delta?: string;
  tool_call?: ToolCall | { function: { name: string; arguments: unknown } };
  done?: boolean;
  cancelled?: boolean;
}

/** One turn the loop emits to the UI as it runs. `assistant_delta` /
 *  `thinking_delta` paint text in real-time; `tool_call_started` /
 *  `tool_call_finished` surface tool-pill state; `done` is the
 *  terminal event with the final message list. */
export type AgentEvent =
  | { kind: "assistant_delta"; delta: string }
  | { kind: "thinking_delta"; delta: string }
  | { kind: "tool_call_started"; call: ToolCall }
  | {
      kind: "tool_call_finished";
      call: ToolCall;
      ok: boolean;
      /** Truncated for the pill; full text lives in the message log. */
      result_preview: string;
    }
  | { kind: "turn_finished"; assistant: StoredMessage }
  | { kind: "done"; messages: StoredMessage[]; cancelled: boolean }
  | { kind: "error"; message: string };

export interface AgentRunArgs {
  /** Initial transcript. The loop appends assistant turns (with
   *  tool_calls) and tool messages to this array as it runs. Callers
   *  pass the same array reference they want updated. */
  messages: StoredMessage[];
  /** Tools the model is allowed to call. Each must also be in
   *  `TOOLS_BY_NAME` so the dispatcher can find its handler. */
  tools: Tool[];
  /** Local Ollama tag — used when `viaDevicePubkey` is null. */
  model: string;
  /** Currently-active family (used by the mesh path to pick the
   *  peer's matching model). */
  family: string;
  /** Active mode — same role as `family` for the mesh path. */
  mode: Mode;
  /** Whether to ask reasoning models to think. */
  think: boolean;
  /** Pin to a mesh peer by device_pubkey. Null = run locally. */
  viaDevicePubkey: string | null;
  /** Signal that fires when the user clicks Stop. We check this
   *  between turns and propagate cancel into the active stream. */
  signal: AbortSignal;
  /** Soft cap on tool-calling rounds. Each round is one model turn
   *  plus the tool executions it requested. The default is generous
   *  for a triage flow (e.g. status → list_peers → reconnect_peer)
   *  but bounded so a confused model can't burn through unlimited
   *  rounds. */
  maxRounds?: number;
  /** Called for each agent event. The UI uses this to paint deltas,
   *  show tool pills, and finalize messages. */
  onEvent: (event: AgentEvent) => void;
}

const DEFAULT_MAX_ROUNDS = 8;

/** Run the agent loop. Resolves once the model has produced a turn
 *  with no tool calls, the user cancelled, or `maxRounds` is hit. */
export async function runAgent(args: AgentRunArgs): Promise<void> {
  const {
    messages,
    tools,
    model,
    family,
    mode,
    think,
    viaDevicePubkey,
    signal,
    maxRounds = DEFAULT_MAX_ROUNDS,
    onEvent,
  } = args;

  const toolDefs = tools.map((t) => t.definition);

  for (let round = 0; round < maxRounds; round += 1) {
    if (signal.aborted) {
      onEvent({ kind: "done", messages, cancelled: true });
      return;
    }

    let turn: { content: string; thinking: string; tool_calls: ToolCall[]; cancelled: boolean };
    const turnStart = Date.now();
    try {
      turn = await runSingleTurn({
        messages,
        toolDefs,
        model,
        family,
        mode,
        think,
        viaDevicePubkey,
        signal,
        onEvent,
      });
    } catch (e) {
      onEvent({ kind: "error", message: String(e instanceof Error ? e.message : e) });
      onEvent({ kind: "done", messages, cancelled: false });
      return;
    }

    // Persist the assistant turn — even one that ends in tool_calls
    // gets recorded so the conversation reload reproduces the agent's
    // intermediate reasoning rather than collapsing to just the final
    // user-visible reply.
    const assistant: StoredMessage = {
      role: "assistant",
      content: turn.content,
      duration_ms: Date.now() - turnStart,
    };
    if (turn.thinking) assistant.thinking = turn.thinking;
    if (turn.tool_calls.length > 0) assistant.tool_calls = turn.tool_calls;
    messages.push(assistant);
    onEvent({ kind: "turn_finished", assistant });

    if (turn.cancelled) {
      onEvent({ kind: "done", messages, cancelled: true });
      return;
    }
    if (turn.tool_calls.length === 0) {
      // Natural stop — the model has nothing more to call, this turn
      // is the user-visible answer.
      onEvent({ kind: "done", messages, cancelled: false });
      return;
    }

    // Execute every tool the model asked for, in order. Each appends
    // a `role: "tool"` message that the next round sees.
    for (const call of turn.tool_calls) {
      if (signal.aborted) {
        onEvent({ kind: "done", messages, cancelled: true });
        return;
      }
      onEvent({ kind: "tool_call_started", call });
      const tool = TOOLS_BY_NAME[call.function.name];
      let content: string;
      let ok = true;
      if (!tool) {
        ok = false;
        content = JSON.stringify({
          error: `unknown tool '${call.function.name}' — must be one of: ${Object.keys(TOOLS_BY_NAME).join(", ")}`,
        });
      } else {
        try {
          content = await tool.handler(call.function.arguments ?? {});
        } catch (e) {
          ok = false;
          content = JSON.stringify({
            error: String(e instanceof Error ? e.message : e),
          });
        }
      }
      const result: StoredMessage = {
        role: "tool",
        name: call.function.name,
        tool_call_id: call.id,
        content,
      };
      messages.push(result);
      onEvent({
        kind: "tool_call_finished",
        call,
        ok,
        result_preview: content.length > 200 ? content.slice(0, 197) + "…" : content,
      });
    }
  }

  // Round budget exhausted. Surface as an error so the UI can show
  // something rather than silently dropping the loop.
  onEvent({
    kind: "error",
    message: `agent loop hit ${maxRounds}-round cap without converging`,
  });
  onEvent({ kind: "done", messages, cancelled: false });
}

/** Translate StoredMessage[] into the wire shape Ollama expects.
 *  Tool messages stay role="tool" and carry `name` + `tool_call_id`;
 *  assistant turns with tool_calls include them so the model
 *  re-grounds against its prior call when continuing. User turns
 *  with image attachments carry an `images: [base64...]` array,
 *  which Ollama's chat API hands to vision models verbatim. */
function toWireMessages(messages: StoredMessage[]): unknown[] {
  return messages.map((m) => {
    const out: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.thinking) out.thinking = m.thinking;
    if (m.tool_calls && m.tool_calls.length > 0) {
      out.tool_calls = m.tool_calls.map((c) => ({
        function: { name: c.function.name, arguments: c.function.arguments },
      }));
    }
    if (m.name) out.name = m.name;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.images && m.images.length > 0) out.images = m.images;
    return out;
  });
}

interface TurnRunArgs {
  messages: StoredMessage[];
  toolDefs: ReturnType<typeof toToolDefs>;
  model: string;
  family: string;
  mode: Mode;
  think: boolean;
  viaDevicePubkey: string | null;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}

function toToolDefs(tools: Tool[]) {
  return tools.map((t) => t.definition);
}

async function runSingleTurn(args: TurnRunArgs) {
  const { messages, toolDefs, viaDevicePubkey, signal, onEvent } = args;

  let content = "";
  let thinking = "";
  const toolCalls: ToolCall[] = [];
  let cancelled = false;

  const onChunk = (frame: StreamFrame) => {
    if (frame.delta) {
      content += frame.delta;
      onEvent({ kind: "assistant_delta", delta: frame.delta });
    }
    if (frame.thinking_delta) {
      thinking += frame.thinking_delta;
      onEvent({ kind: "thinking_delta", delta: frame.thinking_delta });
    }
    if (frame.tool_call) {
      // Ollama emits `{function: {name, arguments}}` per call without
      // an id of its own — assign one ourselves so the result message
      // can pair via `tool_call_id`. crypto.randomUUID is available
      // both in the Tauri WebView and in jsdom-style test envs.
      const raw = frame.tool_call as { function: { name: string; arguments: unknown } };
      const argsObj =
        typeof raw.function.arguments === "string"
          ? safeParseArgs(raw.function.arguments)
          : ((raw.function.arguments as Record<string, unknown>) ?? {});
      toolCalls.push({
        id: crypto.randomUUID().slice(0, 12),
        function: { name: raw.function.name, arguments: argsObj },
      });
    }
  };

  if (viaDevicePubkey) {
    await runMeshTurn(args, onChunk).catch((e) => {
      throw e;
    });
  } else {
    cancelled = await runLocalTurn(args, onChunk);
  }

  // If we exited via cancel, mark it on the return so the caller
  // doesn't loop further. (Mesh-path cancellation is surfaced via
  // the abort signal, mirrored into the runMeshTurn helper.)
  if (signal.aborted) cancelled = true;

  return { content, thinking, tool_calls: toolCalls, cancelled };
}

function safeParseArgs(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Local-path single turn: drives `ollama_chat_stream` through the
 *  same event channel the regular chat UI uses, so all the existing
 *  cancellation plumbing (`ollama_chat_cancel`) still works. */
async function runLocalTurn(
  args: TurnRunArgs,
  onChunk: (frame: StreamFrame) => void,
): Promise<boolean> {
  const { messages, toolDefs, model, think, signal } = args;
  const streamId = crypto.randomUUID();
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    void invoke("ollama_chat_cancel", { streamId }).catch(() => {});
  };
  if (signal.aborted) {
    return true;
  }
  signal.addEventListener("abort", onAbort);
  try {
    unlisten = await listen<StreamFrame>(
      `myownllm://chat-stream/${streamId}`,
      (e) => {
        const f = e.payload;
        if (f.cancelled) cancelled = true;
        onChunk(f);
      },
    );
    await invoke("ollama_chat_stream", {
      streamId,
      model,
      messages: toWireMessages(messages),
      think,
      tools: toolDefs,
    });
  } finally {
    signal.removeEventListener("abort", onAbort);
    unlisten?.();
  }
  return cancelled;
}

/** Mesh-path single turn: ships the prompt + tools to a pinned peer
 *  via `meshClient.sendInferRequest`, mirroring the local-path
 *  callbacks so the calling loop is path-agnostic. */
async function runMeshTurn(
  args: TurnRunArgs,
  onChunk: (frame: StreamFrame) => void,
): Promise<void> {
  const { messages, toolDefs, family, mode, think, viaDevicePubkey, signal } = args;
  if (!viaDevicePubkey) return;
  const peer = meshClient.peers.find((p) => p.device_pubkey === viaDevicePubkey);
  if (!peer || peer.status !== "active") {
    throw new Error(
      "Pinned peer is offline. Pick another host or 'this device' in the bar above to send.",
    );
  }
  await new Promise<void>((resolve, reject) => {
    let cancelHandle: (() => void) | null = null;
    const onAbort = () => {
      cancelHandle?.();
    };
    signal.addEventListener("abort", onAbort);
    meshClient
      .sendInferRequest({
        target_peer_id: peer.peer_id,
        messages: toWireMessages(messages) as Array<{
          role: "system" | "user" | "assistant" | "tool";
          content: string;
        }>,
        family,
        mode,
        think,
        tools: toolDefs,
        on_chunk: (frame) => onChunk(frame as StreamFrame),
        on_done: () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        on_error: (msg) => {
          signal.removeEventListener("abort", onAbort);
          reject(new Error(msg));
        },
      })
      .then((handle) => {
        cancelHandle = handle.cancel;
      })
      .catch((e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      });
  });
}
