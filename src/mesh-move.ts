// Conversation move + remote session view over the daemon.
// Replaces the legacy `move_offer` / `move_accept` / `move_payload`
// / `move_complete` / `move_request` / `session_fetch_request` /
// `session_save_request` wire frames with four single-shot daemon
// RPCs:
//
// - **`session_fetch`** — caller asks a peer for one of its
//   conversations by `guid`. Single-shot, returns the full
//   conversation JSON or `{error}` if not found / access denied.
//   Used both for click-to-open (no delete) and as the first leg
//   of pull (followed by `move_drop`).
//
// - **`session_save`** — caller pushes an updated conversation to
//   the peer that hosts it. The host writes to disk + returns
//   `{ok: true}`. Used after every turn of an open remote
//   conversation so the host's persisted state stays in sync.
//
// - **`move_take`** — caller pushes a full conversation to the
//   peer and asks the peer to take ownership. Peer saves locally
//   (creating folders as needed), returns `{ok: true, guid}` on
//   success. Caller deletes its local copy after success.
//
// - **`move_drop`** — caller asks the peer to delete its local
//   copy of a conversation (typically because the caller just
//   pulled it via `session_fetch` and now owns it).
//
// All four are single-shot — conversations are small (typically
// <1 MB), well under the wire-frame limits the daemon enforces.
// A future chunking pass can layer typed channels in if we ever
// see real conversation sizes that need them.

import { invoke } from "@tauri-apps/api/core";

import type { RpcInboundCall } from "./mesh-daemon.svelte";

// Conversation shape opaque to this module — we ship it verbatim
// between peers. The Tauri side validates on read/write.
type Conversation = unknown;

// ----------------------------------------------------------------------
// Caller side
// ----------------------------------------------------------------------

interface MoveClient {
  callRpc(peer: string, method: string, payload: unknown): Promise<unknown>;
}

/** Read a conversation from a peer's local disk. Doesn't delete. */
export async function fetchRemoteSession(
  client: MoveClient,
  target_peer_id: string,
  guid: string,
): Promise<Conversation> {
  const resp = (await client.callRpc(target_peer_id, "session_fetch", {
    guid,
  })) as { conversation?: Conversation; error?: string };
  if (resp?.error) throw new Error(resp.error);
  if (!resp?.conversation) throw new Error("host returned no conversation");
  return resp.conversation;
}

/** Push an updated conversation to its host. */
export async function saveRemoteSession(
  client: MoveClient,
  target_peer_id: string,
  conversation: Conversation,
): Promise<void> {
  const resp = (await client.callRpc(target_peer_id, "session_save", {
    conversation,
  })) as { ok?: boolean; error?: string };
  if (resp?.error || !resp?.ok) {
    throw new Error(resp?.error ?? "host refused save");
  }
}

/** Push: send our local copy to `target_peer_id`. Peer takes
 *  ownership; we delete our local copy on success. The local-side
 *  load + delete go through the existing `mesh-conversations` Tauri
 *  surface. */
export async function moveConversation(
  client: MoveClient,
  guid: string,
  target_peer_id: string,
): Promise<void> {
  const conversation = await invoke<Conversation | null>("load_conversation", {
    guid,
  });
  if (!conversation) throw new Error("conversation not found locally");
  // Look up the source folder so the receiver can land the
  // conversation in the same place (creating intermediate folders
  // if needed). Falls back to root if the conversation isn't in the
  // listing for any reason.
  let source_folder = "";
  try {
    const list = await invoke<{ conversations: Array<{ id: string; path?: string }> }>(
      "list_conversations",
    );
    source_folder = list.conversations.find((c) => c.id === guid)?.path ?? "";
  } catch {
    // ignore — root is the safe default
  }
  const resp = (await client.callRpc(target_peer_id, "move_take", {
    guid,
    conversation,
    source_folder,
  })) as { ok?: boolean; error?: string };
  if (!resp?.ok || resp?.error) {
    throw new Error(resp?.error ?? "peer refused move");
  }
  await invoke("delete_conversation", { guid });
}

/** Pull: fetch a conversation from `source_peer_id`, save locally,
 *  then ask the source to drop its copy. Three RPCs but logically
 *  atomic from the user's perspective. If `move_drop` fails after
 *  we've already saved locally, the source still has its copy and
 *  the user ends up with both — surface a warning rather than
 *  roll back the local save, since the local save is what they
 *  asked for. */
export async function pullConversation(
  client: MoveClient,
  guid: string,
  source_peer_id: string,
): Promise<void> {
  const conversation = await fetchRemoteSession(client, source_peer_id, guid);
  await invoke("save_conversation", { guid, conversation });
  try {
    const resp = (await client.callRpc(source_peer_id, "move_drop", {
      guid,
    })) as { ok?: boolean; error?: string };
    if (!resp?.ok) {
      // Best-effort — local save already succeeded.
      throw new Error(resp?.error ?? "source refused drop");
    }
  } catch (e) {
    throw new Error(
      `saved locally but couldn't ask source to delete: ${e}`,
    );
  }
}

// ----------------------------------------------------------------------
// Handler side
// ----------------------------------------------------------------------

interface HandlerClient extends MoveClient {
  registerRpcHandler(
    method: string,
    streaming: boolean,
    handler: (call: RpcInboundCall) => void,
  ): Promise<() => Promise<void>>;
  respondRpc(
    request_id: string,
    ok: unknown | null,
    error: string | null,
  ): Promise<void>;
}

export async function installMoveHandlers(
  client: HandlerClient,
): Promise<() => Promise<void>> {
  const r1 = await client.registerRpcHandler("session_fetch", false, (call) =>
    void handleSessionFetch(client, call),
  );
  const r2 = await client.registerRpcHandler("session_save", false, (call) =>
    void handleSessionSave(client, call),
  );
  const r3 = await client.registerRpcHandler("move_take", false, (call) =>
    void handleMoveTake(client, call),
  );
  const r4 = await client.registerRpcHandler("move_drop", false, (call) =>
    void handleMoveDrop(client, call),
  );
  return async () => {
    for (const r of [r1, r2, r3, r4]) {
      try {
        await r();
      } catch {
        // ignore
      }
    }
  };
}

async function handleSessionFetch(
  client: HandlerClient,
  call: RpcInboundCall,
): Promise<void> {
  const { guid } = (call.payload as { guid?: string }) ?? {};
  if (!guid) {
    await client.respondRpc(call.request_id, null, "missing guid");
    return;
  }
  try {
    const conversation = await invoke<Conversation | null>("load_conversation", {
      guid,
    });
    if (!conversation) {
      await client.respondRpc(
        call.request_id,
        { error: "conversation not found on host" },
        null,
      );
      return;
    }
    await client.respondRpc(call.request_id, { conversation }, null);
  } catch (e) {
    await client.respondRpc(call.request_id, { error: String(e) }, null);
  }
}

async function handleSessionSave(
  client: HandlerClient,
  call: RpcInboundCall,
): Promise<void> {
  const { conversation } = (call.payload as { conversation?: Conversation }) ?? {};
  if (!conversation) {
    await client.respondRpc(call.request_id, null, "missing conversation");
    return;
  }
  try {
    const guid = (conversation as { id?: string } | null)?.id ?? "";
    await invoke("save_conversation", { guid, conversation });
    await client.respondRpc(call.request_id, { ok: true }, null);
  } catch (e) {
    await client.respondRpc(call.request_id, { ok: false, error: String(e) }, null);
  }
}

async function handleMoveTake(
  client: HandlerClient,
  call: RpcInboundCall,
): Promise<void> {
  const { guid, conversation, source_folder } = (call.payload as {
    guid?: string;
    conversation?: Conversation;
    source_folder?: string;
  }) ?? {};
  if (!guid || !conversation) {
    await client.respondRpc(call.request_id, null, "missing guid/conversation");
    return;
  }
  try {
    await invoke("save_conversation", {
      guid,
      conversation,
      folder: source_folder ?? "",
    });
    await client.respondRpc(call.request_id, { ok: true, guid }, null);
  } catch (e) {
    await client.respondRpc(call.request_id, { ok: false, error: String(e) }, null);
  }
}

async function handleMoveDrop(
  client: HandlerClient,
  call: RpcInboundCall,
): Promise<void> {
  const { guid } = (call.payload as { guid?: string }) ?? {};
  if (!guid) {
    await client.respondRpc(call.request_id, null, "missing guid");
    return;
  }
  try {
    await invoke("delete_conversation", { guid });
    await client.respondRpc(call.request_id, { ok: true }, null);
  } catch (e) {
    await client.respondRpc(call.request_id, { ok: false, error: String(e) }, null);
  }
}
