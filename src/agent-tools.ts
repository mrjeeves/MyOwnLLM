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
  loadConfig,
  removeNetwork,
  setActiveNetwork,
  updateNetwork,
  activeNetwork,
} from "./config";
import { generateNetworkId, getMeshIdentity, normalizeNetworkId } from "./mesh";
import { meshClient } from "./mesh-client.svelte";
import { agentPermissions } from "./agent-permissions.svelte";

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

/** Build the system prompt for one chat send. Injects the live host
 *  info (OS + arch + which shell `shell` will invoke + path separator)
 *  so the model picks platform-appropriate idioms on the first try
 *  rather than guessing or having to call `shell` once just to learn
 *  what's on the other side. */
export function buildAgentSystemPrompt(host: AgentHostInfo): string {
  const hostLine =
    `Host environment for tool calls on this device: ${host.os} (${host.arch}). ` +
    `The \`shell\` tool runs \`${host.shell}\` so use ${
      host.family === "windows" ? "Windows cmd" : "POSIX sh"
    } syntax. ` +
    `Filesystem path separator is \`${host.path_separator}\`, though both \`/\` and \`\\\` work in paths passed to read_file / write_file on either family.`;
  return (
    "You are MyOwnLLM's built-in IT support assistant. You have hands-on " +
    "tools for managing the user's Cloud Mesh (\"Networks\") and acting on " +
    "the host filesystem and shell.\n\n" +
    hostLine +
    "\n\n" +
    "Tools available:\n" +
    "- `networks` — inspect / mutate Cloud Mesh state (status, peers, saved " +
    "networks, accepting policy, diagnostic log).\n" +
    "- `read_file` — read a text file (non-destructive, no prompt).\n" +
    "- `write_file` — write or append text to a file (prompts the user).\n" +
    "- `shell` — run a shell command (prompts the user).\n\n" +
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
    "pending request, switching active network mid-session, writing a file, " +
    "running a shell command), confirm with the user. They'll see a permission " +
    "prompt for shell / write_file, but a quick \"I'm about to run X — okay?\" " +
    "in chat first is better UX than a surprise modal.\n\n" +
    "Style:\n" +
    "- Be direct. Quote tool results back to the user in plain English; don't dump JSON.\n" +
    "- When you take an action, say what you did and what the result was.\n" +
    "- If the user just wants information, answer the question and stop — don't " +
    "fire actions speculatively.\n" +
    "- If a tool call fails (including permission denials), surface the error " +
    "message and suggest the next step."
  );
}
