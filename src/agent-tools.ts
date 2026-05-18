/**
 * Tool registry for the chat agent loop.
 *
 * A `Tool` pairs an Ollama-compatible JSON schema (sent to the model so
 * it knows what arguments to fill in) with a TypeScript handler that
 * actually does the work. The handler returns a string — the model
 * sees that string as the tool's reply on the next turn.
 *
 * Tools execute on THIS device regardless of whether the model is
 * running locally or on a mesh peer. The peer just speaks the model
 * back over the wire; tool side-effects (mutating the saved networks
 * list, joining a Trystero room, approving a pending request) always
 * happen on the caller's machine because that's whose state the user
 * is asking the assistant to manage.
 */

import {
  addNetwork,
  loadConfig,
  removeNetwork,
  setActiveNetwork,
  updateNetwork,
  activeNetwork,
} from "./config";
import { generateNetworkId, getMeshIdentity, normalizeNetworkId } from "./mesh";
import { meshClient } from "./mesh-client.svelte";

/** Ollama / OpenAI-compatible function-tool definition. Sent verbatim
 *  to the model in the `tools` field of `ollama_chat_stream`. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/** A bound tool: the schema the model sees plus a handler that runs
 *  when the model invokes it. Handlers return a string (treated as the
 *  tool's content); throw to surface a tool-level error to the model. */
export interface Tool {
  definition: ToolDefinition;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

// ---------------------------------------------------------------------
// Networks tool
//
// A single tool that exposes the full Networks (Cloud Mesh) management
// surface as a switch on `action`. Folding the operations into one tool
// keeps the prompt cheap (one function the model has to know about) and
// keeps the "what can I do?" surface legible in one place when the model
// is helping a user troubleshoot a connection that isn't working.
// ---------------------------------------------------------------------

type NetworksAction =
  | "status"
  | "list_networks"
  | "add_network"
  | "switch_network"
  | "forget_network"
  | "generate_network_id"
  | "list_peers"
  | "list_pending_requests"
  | "approve_request"
  | "deny_request"
  | "reconnect_peer"
  | "force_rediscovery"
  | "set_accepting"
  | "recent_activity";

const NETWORKS_ACTIONS: NetworksAction[] = [
  "status",
  "list_networks",
  "add_network",
  "switch_network",
  "forget_network",
  "generate_network_id",
  "list_peers",
  "list_pending_requests",
  "approve_request",
  "deny_request",
  "reconnect_peer",
  "force_rediscovery",
  "set_accepting",
  "recent_activity",
];

function asString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`missing or empty required argument: '${key}'`);
  }
  return v.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed ? trimmed : null;
}

function asBool(args: Record<string, unknown>, key: string, dflt: boolean): boolean {
  const v = args[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return dflt;
}

/** Resolve a peer either by `peer_id` (Trystero session id) or by
 *  `pubkey` (the stable identity). The model usually quotes whatever
 *  `list_peers` showed it; both are useful keys depending on which
 *  the user types. */
function findPeer(args: Record<string, unknown>) {
  const peerId = optionalString(args, "peer_id");
  const pubkey = optionalString(args, "pubkey");
  if (!peerId && !pubkey) {
    throw new Error("specify peer_id or pubkey");
  }
  const peer = meshClient.peers.find((p) =>
    peerId ? p.peer_id === peerId : p.device_pubkey === pubkey,
  );
  if (!peer) {
    throw new Error(
      `no peer matches ${peerId ? `peer_id=${peerId}` : `pubkey=${pubkey}`}`,
    );
  }
  return peer;
}

async function runNetworksAction(
  action: NetworksAction,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (action) {
    case "status": {
      const cfg = await loadConfig();
      const active = activeNetwork(cfg);
      const peers = meshClient.peers;
      let identity = null;
      try {
        identity = await getMeshIdentity();
      } catch {
        // Identity isn't critical for diagnosis — fall through with null.
      }
      return {
        identity: identity
          ? { device_id: identity.device_id, label: identity.label }
          : null,
        mesh_enabled: cfg.cloud_mesh.enabled,
        mesh_status: meshClient.status,
        mesh_error: meshClient.error || null,
        accepting: meshClient.accepting,
        active_network: active
          ? {
              id: active.id,
              network_id: active.network_id,
              accepting: active.accepting,
              signaling_servers: active.signaling_servers,
              stun_servers: active.stun_servers,
              turn_servers: active.turn_servers.map((t) => ({ url: t.url })),
            }
          : null,
        saved_network_count: cfg.cloud_mesh.networks.length,
        peer_count: peers.length,
        active_peer_count: peers.filter((p) => p.status === "active").length,
        pending_request_count: peers.filter((p) => p.status === "pending_approval").length,
        offline_peer_count: peers.filter((p) => p.status === "offline").length,
        is_rediscovering: meshClient.is_rediscovering,
      };
    }
    case "list_networks": {
      const cfg = await loadConfig();
      const activeId = cfg.cloud_mesh.active_network_id;
      return cfg.cloud_mesh.networks.map((n) => ({
        id: n.id,
        network_id: n.network_id,
        accepting: n.accepting,
        active: n.id === activeId,
      }));
    }
    case "add_network": {
      const network_id_raw = asString(args, "network_id");
      const normalized = await normalizeNetworkId(network_id_raw);
      const activate = asBool(args, "activate", true);
      await addNetwork({ network_id: normalized }, { activate });
      if (activate) await meshClient.reconcile();
      return {
        added: true,
        network_id: normalized,
        activated: activate,
      };
    }
    case "switch_network": {
      const cfg = await loadConfig();
      const idArg = optionalString(args, "id");
      const networkIdArg = optionalString(args, "network_id");
      let net = null;
      if (idArg) net = cfg.cloud_mesh.networks.find((n) => n.id === idArg) ?? null;
      else if (networkIdArg) {
        const normalized = await normalizeNetworkId(networkIdArg);
        net = cfg.cloud_mesh.networks.find((n) => n.network_id === normalized) ?? null;
      }
      if (!net) {
        throw new Error(
          "no saved network matches the given id / network_id — call list_networks first",
        );
      }
      await setActiveNetwork(net.id);
      await meshClient.reconcile();
      return { switched_to: net.network_id };
    }
    case "forget_network": {
      const cfg = await loadConfig();
      const idArg = optionalString(args, "id");
      const networkIdArg = optionalString(args, "network_id");
      let net = null;
      if (idArg) net = cfg.cloud_mesh.networks.find((n) => n.id === idArg) ?? null;
      else if (networkIdArg) {
        const normalized = await normalizeNetworkId(networkIdArg);
        net = cfg.cloud_mesh.networks.find((n) => n.network_id === normalized) ?? null;
      }
      if (!net) {
        throw new Error(
          "no saved network matches the given id / network_id — call list_networks first",
        );
      }
      const wasActive = cfg.cloud_mesh.active_network_id === net.id;
      await removeNetwork(net.id);
      if (wasActive) await meshClient.reconcile();
      return { forgot: net.network_id, was_active: wasActive };
    }
    case "generate_network_id": {
      const id = await generateNetworkId();
      return { network_id: id };
    }
    case "list_peers": {
      return meshClient.peers.map((p) => ({
        peer_id: p.peer_id,
        device_pubkey: p.device_pubkey,
        device_id_display: p.device_id_display,
        device_suffix: p.device_suffix,
        label: p.label,
        status: p.status,
        authorized: p.authorized,
        accepting: p.capabilities?.accepting ?? null,
        reconnect_attempts: p.reconnect_attempts,
        verification_code: p.verification_code,
      }));
    }
    case "list_pending_requests": {
      return meshClient.peers
        .filter((p) => p.status === "pending_approval")
        .map((p) => ({
          peer_id: p.peer_id,
          device_pubkey: p.device_pubkey,
          device_id_display: p.device_id_display,
          label: p.label,
          verification_code: p.verification_code,
          approver_role: p.approver_role,
        }));
    }
    case "approve_request": {
      const peer = findPeer(args);
      await meshClient.approveRequest(peer.peer_id);
      return { approved: peer.peer_id, label: peer.label };
    }
    case "deny_request": {
      const peer = findPeer(args);
      await meshClient.denyRequest(peer.peer_id);
      return { denied: peer.peer_id, label: peer.label };
    }
    case "reconnect_peer": {
      const peer = findPeer(args);
      await meshClient.reconnectPeer(peer.peer_id);
      return { reconnect_triggered: peer.peer_id, label: peer.label };
    }
    case "force_rediscovery": {
      await meshClient.forceRediscovery();
      return { rediscovery_triggered: true };
    }
    case "set_accepting": {
      const policy = asString(args, "policy");
      if (policy !== "available" && policy !== "limited" && policy !== "busy") {
        throw new Error("policy must be one of: available, limited, busy");
      }
      await meshClient.setAccepting(policy);
      return { accepting: policy };
    }
    case "recent_activity": {
      // Last ~25 diag entries are usually enough for triage; bumping
      // the request size beyond the in-memory cap (80) doesn't buy
      // anything since `diag` is already ring-buffered.
      const wanted = Math.max(1, Math.min(80, Number(args.limit ?? 25) || 25));
      return meshClient.diag.slice(-wanted).map((e) => ({
        timestamp: new Date(e.ts).toISOString(),
        level: e.level,
        message: e.msg,
      }));
    }
  }
}

export const NETWORKS_TOOL: Tool = {
  definition: {
    type: "function",
    function: {
      name: "networks",
      description:
        "Manage and diagnose the user's Cloud Mesh networks. " +
        "Call this whenever the user asks about their network, mesh, " +
        "connection, peers, or devices not showing up. " +
        "Start with action='status' for an overview before taking " +
        "action. Adding or switching networks may briefly disrupt " +
        "any in-flight cross-device work — narrate what you're doing " +
        "before destructive actions and confirm with the user when " +
        "intent is ambiguous.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: NETWORKS_ACTIONS,
            description:
              "Operation to perform. " +
              "'status' returns identity + active network + peer counts (use first for diagnosis). " +
              "'list_networks' lists saved networks. " +
              "'add_network' creates a new saved network (args: network_id, activate). " +
              "'switch_network' activates a saved network (args: id OR network_id). " +
              "'forget_network' removes a saved network (args: id OR network_id). " +
              "'generate_network_id' returns a fresh random 52-char id. " +
              "'list_peers' lists all known peers with status. " +
              "'list_pending_requests' lists peers waiting on the user's approval. " +
              "'approve_request' or 'deny_request' acts on one (args: peer_id OR pubkey). " +
              "'reconnect_peer' nudges a specific peer (args: peer_id OR pubkey). " +
              "'force_rediscovery' leaves and rejoins the mesh room (heavy; use when peers should be visible but aren't). " +
              "'set_accepting' updates this device's accepting policy (args: policy='available'|'limited'|'busy'). " +
              "'recent_activity' returns the last N diagnostic log entries (args: limit, default 25).",
          },
          network_id: {
            type: "string",
            description:
              "Human-readable Network ID (used by add_network, " +
              "switch_network, forget_network). Normalized to canonical form server-side.",
          },
          id: {
            type: "string",
            description:
              "Stable internal id of a saved network (alternative to network_id for switch/forget).",
          },
          peer_id: {
            type: "string",
            description: "Trystero peer_id from list_peers; identifies a peer for approve/deny/reconnect actions.",
          },
          pubkey: {
            type: "string",
            description:
              "device_pubkey from list_peers (alternative to peer_id, stable across reconnects).",
          },
          activate: {
            type: "boolean",
            description: "For add_network: whether to also activate the new network. Defaults true.",
          },
          policy: {
            type: "string",
            enum: ["available", "limited", "busy"],
            description: "For set_accepting: the new accepting policy.",
          },
          limit: {
            type: "integer",
            description: "For recent_activity: max entries to return (1-80). Defaults 25.",
          },
        },
        required: ["action"],
      },
    },
  },
  handler: async (args) => {
    const action = (args.action as NetworksAction | undefined) ?? null;
    if (!action || !NETWORKS_ACTIONS.includes(action)) {
      throw new Error(
        `unknown action '${String(args.action)}' — expected one of: ${NETWORKS_ACTIONS.join(", ")}`,
      );
    }
    const result = await runNetworksAction(action, args);
    return JSON.stringify(result);
  },
};

/** The tool roster the chat agent loop runs with. A single export so
 *  Chat.svelte doesn't have to assemble the list itself; future tools
 *  just get added here. */
export const CHAT_TOOLS: Tool[] = [NETWORKS_TOOL];

/** Map name → tool. Looked up by the agent loop after the model emits
 *  a `tool_call` so the dispatch is O(1) regardless of roster size. */
export const TOOLS_BY_NAME: Record<string, Tool> = Object.fromEntries(
  CHAT_TOOLS.map((t) => [t.definition.function.name, t]),
);

/** System prompt prepended to every tool-enabled chat. Onboards the
 *  model as an IT-style helper that knows what the `networks` tool
 *  exposes and how to use it for diagnosis, so a user who says "I
 *  can't see my other device" gets a triage flow ("let me check the
 *  mesh status…") rather than a generic "have you tried restarting?"
 *  reply. */
export const AGENT_SYSTEM_PROMPT =
  "You are MyOwnLLM's built-in IT support assistant for the user's Cloud Mesh " +
  "(also called \"Networks\"). You can call the `networks` tool to inspect and " +
  "fix the mesh on this device.\n\n" +
  "How the mesh works:\n" +
  "- Devices that share a Network ID find each other through public Nostr relays " +
  "(or a self-hosted one) and connect peer-to-peer over WebRTC.\n" +
  "- Joining still requires explicit approval per device, gated by a 6-char " +
  "verification code that both sides should read out and confirm.\n" +
  "- The user can save multiple networks; exactly one is active at a time.\n" +
  "- Pinned peers that go offline pause the work tied to them (chat / Talking " +
  "Points) rather than silently downgrading — restoring the peer or unpinning " +
  "fixes it.\n\n" +
  "Diagnosing connection problems:\n" +
  "1. Always call `networks` with action='status' first to get the lay of the land.\n" +
  "2. If no network is active, walk the user through adding one (suggest " +
  "`generate_network_id` for a unique handle).\n" +
  "3. If peers should be there but aren't, check `list_peers` + " +
  "`list_pending_requests` before suggesting `force_rediscovery` (the heavy hammer).\n" +
  "4. If a peer is offline-rostered, `reconnect_peer` for that specific peer is " +
  "lighter than rediscovering the whole room.\n" +
  "5. Before changing anything destructive (forgetting a network, denying a " +
  "pending request, switching active network mid-session), confirm with the user.\n\n" +
  "Style:\n" +
  "- Be direct. Quote tool results back to the user in plain English; don't dump JSON.\n" +
  "- When you take an action, say what you did and what the result was.\n" +
  "- If the user just wants information, answer the question and stop — don't " +
  "fire actions speculatively.\n" +
  "- If a tool call fails, surface the error message and suggest the next step.";
