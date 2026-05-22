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

import { invoke } from "@tauri-apps/api/core";
import {
  addNetwork,
  exportNetworkSettings,
  importNetworkSettings,
  isNetworkSettingsExport,
  loadConfig,
  removeNetwork,
  setActiveNetwork,
  tryParseNetworkSettings,
  updateNetwork,
  activeNetwork,
  type NetworkSettingsExport,
} from "./config";
import { generateNetworkId, getMeshIdentity, normalizeNetworkId } from "./mesh";
import { meshClient } from "./mesh-client.svelte";
import { agentPermissions } from "./agent-permissions.svelte";
import type { TurnServer } from "./types";

/** Mirror of `agent_io::AgentHostInfo` in the Rust side. Fetched
 *  once per chat send so the system prompt + the shell tool's
 *  description always reflect the host the tools will actually
 *  execute against — the model needs to know whether to write
 *  `sh` or `cmd` syntax before it calls `shell`. */
export interface AgentHostInfo {
  /** "linux" / "macos" / "windows" / etc. */
  os: string;
  /** "x86_64" / "aarch64" / etc. */
  arch: string;
  /** "unix" or "windows" — which shell family applies. */
  family: "unix" | "windows" | string;
  /** "sh" on Unix, "cmd" on Windows — the executable the
   *  `shell` tool will invoke. */
  shell: string;
  /** "/" on Unix, "\\" on Windows. */
  path_separator: string;
}

/** Fetch the host info from the Rust side. Cheap (constant-time
 *  read of compiled-in env consts) so callers don't need to cache. */
export async function getAgentHostInfo(): Promise<AgentHostInfo> {
  return await invoke<AgentHostInfo>("agent_host_info");
}

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
  | "recent_activity"
  | "export_settings"
  | "import_settings"
  | "set_signaling_servers"
  | "set_stun_servers"
  | "set_turn_servers";

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
  "export_settings",
  "import_settings",
  "set_signaling_servers",
  "set_stun_servers",
  "set_turn_servers",
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

/** Read a string[] argument, accepting either a JSON-array string or a
 *  native array. Tolerant of stray empty entries — those are stripped
 *  before returning. Throws on the wrong shape so the model surfaces
 *  the error rather than silently dropping its input. */
function asStringArray(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (Array.isArray(v)) {
    return v.filter((s): s is string => typeof s === "string" && s.trim() !== "")
      .map((s) => s.trim());
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed
            .filter((s): s is string => typeof s === "string" && s.trim() !== "")
            .map((s) => s.trim());
        }
      } catch {
        // Fall through to single-string handling.
      }
    }
    if (trimmed === "") return [];
    return [trimmed];
  }
  throw new Error(`expected an array of strings for '${key}'`);
}

/** Coerce a value into a TurnServer[]. Accepts arrays of objects or a
 *  JSON-string version of the same. Each entry needs at least a `url`;
 *  empty entries get dropped. */
function asTurnArray(args: Record<string, unknown>, key: string): TurnServer[] {
  let raw: unknown = args[key];
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new Error(`'${key}' must be a JSON array of {url, username?, credential?}`);
    }
  }
  if (!Array.isArray(raw)) {
    throw new Error(`'${key}' must be an array`);
  }
  return raw
    .filter(
      (t): t is { url: string; username?: string; credential?: string } =>
        !!t && typeof t === "object" && typeof (t as { url?: unknown }).url === "string",
    )
    .map((t) => ({
      url: t.url,
      ...(typeof t.username === "string" && t.username ? { username: t.username } : {}),
      ...(typeof t.credential === "string" && t.credential
        ? { credential: t.credential }
        : {}),
    }));
}

/** Resolve a target network for the multi-network mutating actions.
 *  Accepts `id` (stable internal id), `network_id` (user-facing
 *  handle), or neither (defaults to the currently-active network).
 *  Throws when nothing matches so the model can recover. */
async function resolveNetwork(args: Record<string, unknown>) {
  const cfg = await loadConfig();
  const idArg = optionalString(args, "id");
  const networkIdArg = optionalString(args, "network_id");
  if (idArg) {
    const net = cfg.cloud_mesh.networks.find((n) => n.id === idArg);
    if (!net) throw new Error(`no saved network with id='${idArg}' — call list_networks`);
    return net;
  }
  if (networkIdArg) {
    const normalized = await normalizeNetworkId(networkIdArg);
    const net = cfg.cloud_mesh.networks.find((n) => n.network_id === normalized);
    if (!net) {
      throw new Error(`no saved network with network_id='${networkIdArg}' — call list_networks`);
    }
    return net;
  }
  const active = activeNetwork(cfg);
  if (!active) {
    throw new Error(
      "no target network given and no active network — pass 'id' or 'network_id' explicitly, or add+switch first",
    );
  }
  return active;
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
    case "export_settings": {
      // Return the same envelope shape the UI's Copy / Save .json
      // actions produce — including the kind/version markers so the
      // model can hand the blob back to import_settings on another
      // device verbatim.
      const net = await resolveNetwork(args);
      return exportNetworkSettings(net);
    }
    case "import_settings": {
      // Accepts either a parsed `settings` object or a `json` string
      // (the user may have pasted raw JSON into chat for the model
      // to apply). The model is encouraged to use the parsed form,
      // but the string fallback keeps a "copy this blob and ask
      // your AI to set it up" flow working without a tool-call
      // schema round-trip.
      let blob: NetworkSettingsExport | null = null;
      const direct = args.settings;
      if (direct && typeof direct === "object" && isNetworkSettingsExport(direct)) {
        blob = direct;
      } else if (typeof args.json === "string") {
        blob = tryParseNetworkSettings(args.json);
      } else if (typeof direct === "string") {
        // Some models stringify their object args; try parsing
        // before giving up.
        blob = tryParseNetworkSettings(direct);
      }
      if (!blob) {
        throw new Error(
          "couldn't read network settings — pass either a parsed object as 'settings' " +
            "or a JSON string as 'json', containing 'kind: \"myownllm.network-settings\"'",
        );
      }
      // The model can request a different network_id than what's in
      // the blob (useful when adopting someone else's blob onto a
      // fresh handle). Override only when explicitly given.
      const override = optionalString(args, "network_id");
      if (override) {
        blob = { ...blob, network_id: await normalizeNetworkId(override) };
      } else {
        blob = { ...blob, network_id: await normalizeNetworkId(blob.network_id) };
      }
      const activate = asBool(args, "activate", false);
      const result = await importNetworkSettings(blob, { activate });
      if (activate) await meshClient.reconcile();
      return {
        imported: true,
        created: result.created,
        activated: activate,
        network_id: result.network.network_id,
        id: result.network.id,
      };
    }
    case "set_signaling_servers": {
      const net = await resolveNetwork(args);
      const list = asStringArray(args, "servers");
      const cfg = await updateNetwork(net.id, { signaling_servers: list });
      if (cfg.cloud_mesh.active_network_id === net.id) {
        await meshClient.reconcile();
      }
      return {
        network_id: net.network_id,
        signaling_servers: list,
      };
    }
    case "set_stun_servers": {
      const net = await resolveNetwork(args);
      const list = asStringArray(args, "servers");
      const cfg = await updateNetwork(net.id, { stun_servers: list });
      if (cfg.cloud_mesh.active_network_id === net.id) {
        await meshClient.reconcile();
      }
      return {
        network_id: net.network_id,
        stun_servers: list,
      };
    }
    case "set_turn_servers": {
      const net = await resolveNetwork(args);
      const list = asTurnArray(args, "servers");
      const cfg = await updateNetwork(net.id, { turn_servers: list });
      if (cfg.cloud_mesh.active_network_id === net.id) {
        await meshClient.reconcile();
      }
      return {
        network_id: net.network_id,
        turn_servers: list.map((t) => ({
          url: t.url,
          ...(t.username ? { username: t.username } : {}),
        })),
      };
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
              "'recent_activity' returns the last N diagnostic log entries (args: limit, default 25). " +
              "'export_settings' returns this network's portable JSON envelope for sharing (args: id OR network_id; defaults to active). " +
              "'import_settings' applies a portable JSON envelope, creating or updating the matching network (args: settings=parsed object OR json=string; optional activate, network_id override). " +
              "'set_signaling_servers' / 'set_stun_servers' / 'set_turn_servers' replace the respective list on a network (args: id OR network_id, servers=array). For TURN, each entry is {url, username?, credential?}.",
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
          settings: {
            type: "object",
            description:
              "For import_settings: parsed network-settings envelope. Must carry " +
              "'kind: \"myownllm.network-settings\"'. Alternative to passing 'json'.",
          },
          json: {
            type: "string",
            description:
              "For import_settings: raw JSON string of the network-settings envelope " +
              "(useful when the user pasted JSON into chat). The handler parses and validates.",
          },
          servers: {
            type: "array",
            description:
              "For set_signaling_servers / set_stun_servers: array of URL strings. " +
              "For set_turn_servers: array of {url, username?, credential?} objects. " +
              "Empty array clears the list (Trystero / Google defaults will be used).",
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

// ---------------------------------------------------------------------
// Shell / file tools
//
// `shell` and `write_file` mutate the host, so they route through
// `agentPermissions.request()` before invoking the Rust command —
// every call either matches a stored allow-list entry, runs under an
// `accept_all` policy, or surfaces the prompt modal for the user to
// approve. `read_file` is non-destructive and bypasses the gate.
// ---------------------------------------------------------------------

interface ShellOutcome {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  timed_out: boolean;
}

interface ReadFileOutcome {
  content: string;
  bytes_returned: number;
  truncated: boolean;
  total_bytes: number | null;
}

interface WriteFileOutcome {
  path: string;
  bytes_written: number;
  created_dirs: boolean;
}

/** Build the shell tool with a description tailored to the live host.
 *  Including the actual platform + shell name in the description (not
 *  just "Unix or Windows") means the model sees a single concrete
 *  instruction rather than a "pick the right one" choice — it tends
 *  to produce platform-appropriate one-liners on the first try. */
export function buildShellTool(host: AgentHostInfo): Tool {
  const shellHint =
    host.family === "windows"
      ? `Windows cmd.exe via \`cmd /C\` — use cmd syntax: \`&\` chains commands, \`1>&2\` redirects stderr, \`exit N\` sets the exit code. \`timeout.exe\` refuses redirected stdin so prefer \`ping 127.0.0.1 -n N > NUL\` for sleeps.`
      : `POSIX sh via \`sh -c\` — pipes, redirects, \`&&\`, \`;\`, \`1>&2\` all work as written.`;
  return {
    definition: {
      type: "function",
      function: {
        name: "shell",
        description:
          `Run a shell command on this device (${host.os} ${host.arch}) and ` +
          `return stdout / stderr / exit code.\n\n` +
          `Shell: ${shellHint}\n\n` +
          `Each call prompts the user for permission unless they've previously granted ` +
          `blanket or per-command trust. Output is capped at 256 KiB per stream and ` +
          `times out after 60 s by default.`,
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: `Shell-syntax command for the host's ${host.shell}.`,
            },
            cwd: {
              type: "string",
              description:
                "Working directory for the command. Optional; defaults to the process CWD.",
            },
            timeout_ms: {
              type: "integer",
              description:
                "Per-call timeout in milliseconds. Defaults 60000, capped at 600000.",
            },
          },
          required: ["command"],
        },
      },
    },
    handler: shellToolHandler,
  };
}

async function shellToolHandler(args: Record<string, unknown>): Promise<string> {
  const command = asString(args, "command");
  const cwd = optionalString(args, "cwd");
  const timeout = typeof args.timeout_ms === "number" ? args.timeout_ms : undefined;
  const decision = await agentPermissions.request({
    tool: "shell",
    literal: command,
    summary: `Run: ${command}`,
    detail: cwd ? { command, cwd } : { command },
  });
  if (decision.kind === "denied") {
    return JSON.stringify({ error: `permission denied: ${decision.reason}` });
  }
  const outcome = await invoke<ShellOutcome>("agent_shell", {
    command,
    cwd: cwd ?? null,
    timeoutMs: timeout ?? null,
  });
  return JSON.stringify(outcome);
}

// Static export retained for callers that don't have a host info yet
// (e.g. tests, future code paths). Defaults to the cross-platform
// "either shell" description; live chat replaces this via
// `buildChatTools(host)` below.
export const SHELL_TOOL: Tool = {
  definition: {
    type: "function",
    function: {
      name: "shell",
      description:
        "Run a shell command on this device and return stdout / stderr / " +
        "exit code. Uses `sh -c` on Unix and `cmd /C` on Windows so " +
        "pipes, redirects, and `&&` work as written. Each call prompts " +
        "the user for permission unless they've previously granted blanket " +
        "or per-command trust on this device. Output is capped at 256 KiB " +
        "per stream and timed-out after 60 s by default.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell-syntax command to run.",
          },
          cwd: {
            type: "string",
            description:
              "Working directory for the command. Optional; defaults to the process CWD.",
          },
          timeout_ms: {
            type: "integer",
            description:
              "Per-call timeout in milliseconds. Defaults 60000, capped at 600000.",
          },
        },
        required: ["command"],
      },
    },
  },
  handler: shellToolHandler,
};

export const READ_FILE_TOOL: Tool = {
  definition: {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a text file on this device and return its contents. Capped " +
        "at 1 MiB by default (16 MiB hard ceiling). Non-destructive — " +
        "doesn't prompt the user. Binary content is returned as UTF-8 " +
        "lossy approximation; use `shell` with `file`/`xxd` for true " +
        "binary inspection.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative filesystem path.",
          },
          max_bytes: {
            type: "integer",
            description:
              "Cap on bytes returned. Defaults 1048576 (1 MiB), capped at 16777216 (16 MiB).",
          },
        },
        required: ["path"],
      },
    },
  },
  handler: async (args) => {
    const path = asString(args, "path");
    const max_bytes = typeof args.max_bytes === "number" ? args.max_bytes : undefined;
    const outcome = await invoke<ReadFileOutcome>("agent_read_file", {
      path,
      maxBytes: max_bytes ?? null,
    });
    return JSON.stringify(outcome);
  },
};

export const WRITE_FILE_TOOL: Tool = {
  definition: {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write text content to a file on this device. Creates parent " +
        "directories by default. Each call prompts the user for permission " +
        "unless they've previously granted blanket or per-path trust on " +
        "this device. Use `append: true` to append rather than overwrite.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative filesystem path to write.",
          },
          content: {
            type: "string",
            description: "Text payload to write. Newlines are preserved.",
          },
          create_dirs: {
            type: "boolean",
            description:
              "If true (default), create missing parent directories before writing.",
          },
          append: {
            type: "boolean",
            description:
              "If true, append to the file instead of overwriting. Defaults false.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  handler: async (args) => {
    const path = asString(args, "path");
    const content = typeof args.content === "string" ? args.content : "";
    const append = asBool(args, "append", false);
    const create_dirs = asBool(args, "create_dirs", true);
    const decision = await agentPermissions.request({
      tool: "write_file",
      literal: path,
      summary: `${append ? "Append to" : "Write"}: ${path}`,
      detail: {
        path,
        bytes: String(content.length),
        mode: append ? "append" : "overwrite",
      },
    });
    if (decision.kind === "denied") {
      return JSON.stringify({ error: `permission denied: ${decision.reason}` });
    }
    const outcome = await invoke<WriteFileOutcome>("agent_write_file", {
      path,
      content,
      createDirs: create_dirs,
      append,
    });
    return JSON.stringify(outcome);
  },
};

/** The tool roster the chat agent loop runs with. Built fresh per
 *  chat send so the shell tool's description reflects the live host
 *  (which shell will run, which path separator to use). Order matters
 *  for system-prompt readability — destructive tools surface later
 *  than the safe `read_file`. */
export function buildChatTools(host: AgentHostInfo): Tool[] {
  return [NETWORKS_TOOL, READ_FILE_TOOL, WRITE_FILE_TOOL, buildShellTool(host)];
}

/** Map name → tool. Used by the agent loop's dispatcher (which only
 *  cares about the handler, not the description), so the static
 *  shell tool here is fine — the description differences live in
 *  what the MODEL sees, not in the handler the loop dispatches to. */
export const TOOLS_BY_NAME: Record<string, Tool> = Object.fromEntries(
  [NETWORKS_TOOL, READ_FILE_TOOL, WRITE_FILE_TOOL, SHELL_TOOL].map((t) => [
    t.definition.function.name,
    t,
  ]),
);

/** Base system prompt — the framing the model sees regardless of
 *  which tools are enabled for the current send. Includes role +
 *  general style guidance. Per-tool documentation is appended at
 *  send time via `toolSystemPromptSnippet` so deselecting a tool in
 *  the prompt editor drops both the tool from the model's tool array
 *  AND its documentation from the prompt body. */
export const DEFAULT_SYSTEM_PROMPT_BASE: string =
  "You are MyOwnLLM's built-in IT support assistant. You have hands-on " +
  "tools for managing the user's Cloud Mesh (\"Networks\") and acting on " +
  "the host filesystem and shell.\n\n" +
  "Style:\n" +
  "- Be direct. Quote tool results back to the user in plain English; don't dump JSON.\n" +
  "- When you take an action, say what you did and what the result was.\n" +
  "- If the user just wants information, answer the question and stop — don't " +
  "fire actions speculatively.\n" +
  "- If a tool call fails (including permission denials), surface the error " +
  "message and suggest the next step.\n" +
  "- Before changing anything destructive (forgetting a network, denying a " +
  "pending request, switching active network mid-session, writing a file, " +
  "running a shell command), confirm with the user. They'll see a permission " +
  "prompt for shell / write_file, but a quick \"I'm about to run X — okay?\" " +
  "in chat first is better UX than a surprise modal.";

/** Host environment line. Injected verbatim into the system prompt
 *  at send time so the model knows which shell + path separator it's
 *  targeting before its first tool call. Lives outside the per-tool
 *  snippets because it's always relevant whenever any tool is
 *  enabled (the model needs to know what host it's on). */
export function hostInfoSnippet(host: AgentHostInfo): string {
  return (
    `Host environment for tool calls on this device: ${host.os} (${host.arch}). ` +
    `The \`shell\` tool runs \`${host.shell}\` so use ${
      host.family === "windows" ? "Windows cmd" : "POSIX sh"
    } syntax. ` +
    `Filesystem path separator is \`${host.path_separator}\`, though both \`/\` and \`\\\` work in paths passed to read_file / write_file on either family.`
  );
}

/** Per-tool prompt snippets. Each block describes what the tool
 *  does, when to use it, and any specific guidance the model needs.
 *  Concatenated onto the base system prompt at send time based on
 *  the selected `tools` list of the active Prompt. New tools added
 *  later get a new entry here. */
const NETWORKS_TOOL_SNIPPET: string =
  "## `networks` tool — Cloud Mesh management\n\n" +
  "Use this tool to inspect or mutate the user's Cloud Mesh state " +
  "(status, peers, saved networks, accepting policy, diagnostic log, " +
  "signaling/STUN/TURN servers, import/export of portable settings).\n\n" +
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
  "lighter than rediscovering the whole room.\n\n" +
  "Network settings & imports:\n" +
  "- Network settings travel as a portable JSON envelope carrying " +
  "`kind: \"myownllm.network-settings\"`. The user can paste one into chat or " +
  "attach a .json file — when you see this shape, offer to import it via " +
  "`action='import_settings'` (pass the parsed object as `settings`, or the " +
  "raw string as `json`). Confirm the network_id with the user before applying.\n" +
  "- `action='export_settings'` returns the same envelope for the active (or " +
  "named) network, ready to share to another device.\n" +
  "- `action='set_signaling_servers' / 'set_stun_servers' / 'set_turn_servers'` " +
  "replace the respective list on a network. Empty array restores defaults " +
  "(Trystero public Nostr relays / Google STUN / no TURN).";

const READ_FILE_TOOL_SNIPPET: string =
  "## `read_file` tool — read a file from disk\n\n" +
  "Reads a text file on the user's device and returns its contents. " +
  "Non-destructive — runs without prompting the user. Use it to inspect " +
  "logs, config files, or any text artifact before deciding what to do " +
  "next. Pass an absolute path when possible; relative paths resolve " +
  "against the agent's working directory which may not match what the " +
  "user expects.";

const WRITE_FILE_TOOL_SNIPPET: string =
  "## `write_file` tool — create or modify a file\n\n" +
  "Writes (or appends) text to a file on the user's device. The user is " +
  "prompted for permission on every call unless they've previously " +
  "granted blanket trust for the exact path. State your intent in chat " +
  "before calling — a surprise permission modal is worse UX than a " +
  "heads-up sentence describing what you're about to write and where.";

const SHELL_TOOL_SNIPPET: string =
  "## `shell` tool — run a shell command\n\n" +
  "Runs a shell command on the user's device. The user is prompted for " +
  "permission on every call unless they've granted blanket trust for the " +
  "exact command string. Use the shell family indicated in the host line " +
  "above (POSIX sh on Unix, Windows cmd on Windows). State your intent " +
  "in chat before invoking destructive commands — confirmation first " +
  "beats a surprise modal.";

/** Lookup of the per-tool prompt snippet by tool id. Exposed so the
 *  Prompts settings UI can preview the snippet next to each tool's
 *  checkbox — the user sees exactly what gets added when they select
 *  a tool. */
export const TOOL_PROMPT_SNIPPETS: Record<string, string> = {
  networks: NETWORKS_TOOL_SNIPPET,
  read_file: READ_FILE_TOOL_SNIPPET,
  write_file: WRITE_FILE_TOOL_SNIPPET,
  shell: SHELL_TOOL_SNIPPET,
};

/** Compose the actual system prompt body sent to the model. Glues
 *  the user-editable `systemPromptBody` (defaults to
 *  `DEFAULT_SYSTEM_PROMPT_BASE` for new Prompts) together with the
 *  host info line, the snippets for each selected tool, and an
 *  optional trailing user-prompt addition. Layout:
 *
 *      <system body>
 *
 *      <host info>
 *
 *      <tool 1 snippet>
 *      <tool 2 snippet>
 *      …
 *
 *      <user prompt addition>
 *
 *  The user-prompt sits after the tools because it's the user's
 *  task-shaped framing — the model reads role + capabilities first,
 *  then "and here's what I'm trying to accomplish in this chat". */
export function composeSystemPrompt(args: {
  systemPromptBody: string;
  host: AgentHostInfo;
  enabledTools: string[];
  /** Optional trailing addition from the active Prompt's
   *  `user_prompt` field. Appended after the tool snippets so the
   *  user's task framing comes last. Empty / whitespace = skipped. */
  userPromptAddition?: string;
}): string {
  const parts: string[] = [];
  const body = args.systemPromptBody.trim();
  if (body) parts.push(body);
  if (args.enabledTools.length > 0) {
    parts.push(hostInfoSnippet(args.host));
    for (const t of args.enabledTools) {
      const snippet = TOOL_PROMPT_SNIPPETS[t];
      if (snippet) parts.push(snippet);
    }
  }
  const addition = args.userPromptAddition?.trim();
  if (addition) parts.push(addition);
  return parts.join("\n\n");
}

/** Back-compat wrapper for callers that haven't migrated to the
 *  Prompt-aware composition path. Reproduces the historical default
 *  system prompt (all tools enabled, default base) for a host. New
 *  call sites should use `composeSystemPrompt` so per-Prompt
 *  selections take effect. */
export function buildAgentSystemPrompt(host: AgentHostInfo): string {
  return composeSystemPrompt({
    systemPromptBody: DEFAULT_SYSTEM_PROMPT_BASE,
    host,
    enabledTools: ["networks", "read_file", "write_file", "shell"],
  });
}
