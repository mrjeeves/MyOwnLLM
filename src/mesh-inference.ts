// Remote-inference RPC over the daemon. Replaces the legacy
// `mesh-protocol.ts` `infer_request` / `_chunk` / `_done` / `_error` /
// `_cancel` wire frames that `mesh-client.svelte.ts` used to ship
// over Trystero data channels. Two halves:
//
// - **Caller** (`sendInferRequest`): opens an outbound streaming RPC
//   via the daemon, accumulates `chunk` events, resolves with the
//   final delta concatenation on `end`. The legacy callback-style
//   `on_chunk` / `on_done` / `on_error` API is preserved so the
//   `agent-loop` + `chat-slot` consumers don't have to be rewritten.
//
// - **Handler** (`installInferenceHandler`): registers the `infer`
//   method with the daemon. When a peer calls it, we route the
//   request to the local Ollama daemon (via the existing
//   `myownllm://chat-stream/<id>` event channel that the GUI already
//   uses) and forward each delta + thinking_delta + tool_call back
//   to the peer as stream chunks. Closing on `done`. Cancellation
//   from the peer surfaces as the daemon dropping our stream
//   sender, which Ollama observes as the cancel signal.
//
// Wire shape (chunk payloads):
//   { delta: string }
//   { thinking_delta: string }
//   { tool_call: { function: { name, arguments } } }
//   { finish_reason: string }  // on the last chunk if non-stop
//
// End frame carries `error: string | null`. A clean stop leaves
// `error` null; an inference error sets it to the message.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { RpcInboundCall } from "./mesh-daemon.svelte";

// ----------------------------------------------------------------------
// Wire payloads — both directions speak the same chunk shape
// ----------------------------------------------------------------------

interface InferRequestPayload {
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    name?: string;
    tool_call_id?: string;
    tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  }>;
  family: string;
  mode: string;
  think?: boolean;
  tools?: unknown[];
}

interface InferChunkPayload {
  delta?: string;
  thinking_delta?: string;
  tool_call?: { function: { name: string; arguments: unknown } };
  finish_reason?: string;
}

// ----------------------------------------------------------------------
// Caller side — sendInferRequest
// ----------------------------------------------------------------------

/** Subset of MeshDaemonClient needed by the caller. Defined as a
 *  structural type rather than importing the class so this module
 *  doesn't reach into the store's internals. */
interface InferenceClient {
  callRpcStream(
    peer: string,
    method: string,
    payload: unknown,
    sub: {
      onChunk: (p: unknown) => void;
      onEnd: (error: string | null) => void;
    },
  ): Promise<string>;
  releaseRpcCallStream(request_id: string): void;
}

export interface SendInferRequestArgs {
  target_peer_id: string;
  messages: InferRequestPayload["messages"];
  family: string;
  mode: string;
  think?: boolean;
  tools?: unknown[];
  on_chunk: (frame: InferChunkPayload) => void;
  on_done: (cancelled: boolean) => void;
  on_error: (message: string) => void;
}

/** Initiate a remote inference. Returns the daemon request_id and
 *  a `cancel()` that drops the local subscription — the peer's
 *  side observes a stream-drop via its own RPC machinery. */
export async function sendInferRequest(
  client: InferenceClient,
  args: SendInferRequestArgs,
): Promise<{ id: string; cancel: () => void }> {
  const payload: InferRequestPayload = {
    messages: args.messages,
    family: args.family,
    mode: args.mode,
    think: args.think,
    tools: args.tools,
  };
  let cancelled = false;
  const request_id = await client.callRpcStream(
    args.target_peer_id,
    "infer",
    payload,
    {
      onChunk: (p) => {
        if (cancelled) return;
        args.on_chunk(p as InferChunkPayload);
      },
      onEnd: (error) => {
        if (cancelled) {
          args.on_done(true);
          return;
        }
        if (error) {
          args.on_error(error);
        } else {
          args.on_done(false);
        }
      },
    },
  );
  return {
    id: request_id,
    cancel: () => {
      cancelled = true;
      client.releaseRpcCallStream(request_id);
      // The daemon's `mesh_daemon_rpc_call_stream` doesn't expose an
      // explicit cancel — the underlying RPC future is owned by the
      // daemon. Dropping the subscription stops chunks from reaching
      // the UI; the peer will continue producing for a few tokens
      // until its own end-of-stream observation fires. This matches
      // the legacy behaviour where `infer_cancel` was best-effort.
      args.on_done(true);
    },
  };
}

// ----------------------------------------------------------------------
// Handler side — installInferenceHandler
// ----------------------------------------------------------------------

interface HandlerClient {
  registerRpcHandler(
    method: string,
    streaming: boolean,
    handler: (call: RpcInboundCall) => void,
  ): Promise<() => Promise<void>>;
  streamRpcChunk(request_id: string, payload: unknown): Promise<void>;
  streamRpcEnd(request_id: string, error: string | null): Promise<void>;
}

interface LocalCapabilities {
  accepting: "available" | "if_idle" | "busy" | "yes" | "no";
  llms: Array<{ tag: string; family: string; mode: string }>;
}

/** Install the local-side `infer` handler. When a peer calls us,
 *  we route the request to Ollama via the GUI's existing chat-stream
 *  bus and forward each emitted frame back to the peer as a stream
 *  chunk. The returned release function unregisters the handler.
 *
 *  `getCapabilities` is a function (not a value) so the handler
 *  always sees the latest snapshot — capabilities can change as the
 *  user pulls / removes models between calls. */
export async function installInferenceHandler(
  client: HandlerClient,
  getCapabilities: () => LocalCapabilities,
): Promise<() => Promise<void>> {
  return client.registerRpcHandler("infer", true, (call) => {
    void handleInfer(client, getCapabilities(), call);
  });
}

async function handleInfer(
  client: HandlerClient,
  caps: LocalCapabilities,
  call: RpcInboundCall,
): Promise<void> {
  if (caps.accepting === "busy" || caps.accepting === "no") {
    await client.streamRpcEnd(call.request_id, "local accepting policy is busy");
    return;
  }
  const payload = call.payload as InferRequestPayload;
  // Pick a model: exact (family + mode) → mode match → first.
  const exact = caps.llms.find(
    (m) => m.family === payload.family && m.mode === payload.mode,
  );
  const modeMatch = caps.llms.find((m) => m.mode === payload.mode);
  const model = exact?.tag ?? modeMatch?.tag ?? caps.llms[0]?.tag ?? "";
  if (!model) {
    await client.streamRpcEnd(call.request_id, "no local LLM available");
    return;
  }

  // Drive Ollama via the existing `ollama_chat_stream` Tauri command +
  // `myownllm://chat-stream/<id>` event bus. Each frame on that bus
  // forwards to the peer as one stream chunk.
  const local_stream_id = `mesh-${call.request_id}`;
  const eventName = `myownllm://chat-stream/${local_stream_id}`;
  interface StreamFrame {
    delta?: string;
    thinking_delta?: string;
    tool_call?: { function: { name: string; arguments: unknown } };
    done?: boolean;
    cancelled?: boolean;
    error?: string;
  }
  let unlisten: (() => void) | null = null;
  let finished = false;
  try {
    const handle = await listen<StreamFrame>(eventName, (e) => {
      if (finished) return;
      const f = e.payload;
      if (f.delta !== undefined) {
        void client.streamRpcChunk(call.request_id, { delta: f.delta });
      }
      if (f.thinking_delta !== undefined) {
        void client.streamRpcChunk(call.request_id, {
          thinking_delta: f.thinking_delta,
        });
      }
      if (f.tool_call !== undefined) {
        // The caller — not us — executes the tool. Forward verbatim.
        void client.streamRpcChunk(call.request_id, {
          tool_call: f.tool_call,
        });
      }
      if (f.done) {
        finished = true;
        void client.streamRpcEnd(
          call.request_id,
          f.error ?? null,
        );
        unlisten?.();
      } else if (f.error) {
        finished = true;
        void client.streamRpcEnd(call.request_id, f.error);
        unlisten?.();
      }
    });
    unlisten = () => handle();

    // Kick off the Ollama stream. Fire-and-forget: completion is
    // signaled via the `done: true` event frame above, not by the
    // returned promise. We still await it so errors thrown
    // synchronously (e.g. "ollama not installed") surface as an
    // immediate RPC error rather than a wedged in-flight.
    await invoke("ollama_chat_stream", {
      streamId: local_stream_id,
      model,
      messages: payload.messages,
      think: payload.think ?? null,
      tools: payload.tools ?? null,
    });
  } catch (e) {
    if (!finished) {
      finished = true;
      try {
        await client.streamRpcEnd(call.request_id, String(e));
      } catch {
        // ignore — daemon may have already torn the stream down.
      }
      unlisten?.();
    }
  }
}
