/**
 * Permission gating for the agent's destructive tools.
 *
 * Two tools are gated today: `shell` and `write_file`. Read-only
 * tools (`networks`, `read_file`) bypass this layer because they
 * can't modify the host.
 *
 * The policy is **per-network**: every saved `NetworkConfig`
 * carries its own `agent_permissions` blob, gossiped over the
 * active network's data channel. Switching the active network
 * loads a different policy; changes you make on Network A don't
 * leak to Network B, and the gossip layer only broadcasts to
 * peers in the network where the change was made. Each per-tool
 * record carries an `updated_at` timestamp; on merge, the
 * highest timestamp wins.
 *
 * Mutation path (local user clicks a button in the modal or the
 * Permissions settings tab):
 *
 *   1. Update local record on the active network, stamp
 *      `updated_at = Date.now()`.
 *   2. Persist to config.json.
 *   3. Refresh the in-memory cache.
 *   4. Ask the mesh client to broadcast the new snapshot to peers
 *      on the active network only.
 *
 * Inbound path (gossip arrives from a peer):
 *
 *   1. Mesh client calls `mergeIncoming(snapshot, networkId)`.
 *   2. For each tool, if `incoming.updated_at > local.updated_at`,
 *      adopt; else ignore. The merge writes into the named
 *      network's slot — usually the active one, since gossip
 *      only flows on the active network's channel.
 *   3. Persist + refresh cache when anything changed.
 *
 * Decision flow (per call from the agent loop):
 *
 *   1. Mode is `denied`           → return refused (no prompt)
 *   2. Mode is `accept_all`       → return allowed (no prompt)
 *   3. Args match `always_accept` → return allowed (no prompt)
 *   4. Otherwise                  → push a pending prompt; resolve
 *                                   when the modal collects the user's
 *                                   choice and persist + gossip the
 *                                   side-effect.
 */

import {
  freshAgentPermissions,
  getAgentPermissions,
  loadConfig,
  updateAgentPermissions,
} from "./config";
import type { AgentPermissionsConfig, ToolPermission } from "./types";

export type GatedTool = "shell" | "write_file";

/** Outcome of a permission check. `allowed` lets the tool fire;
 *  `denied` short-circuits with a refusal message routed back to the
 *  model as the tool's "result". */
export type PermissionDecision =
  | { kind: "allowed" }
  | { kind: "denied"; reason: string };

/** Choice the user makes in the prompt modal. Maps 1:1 to the four
 *  buttons. */
export type PromptChoice =
  | "allow_once"
  | "always_accept"
  | "accept_all"
  | "deny";

/** One outstanding prompt for the modal to render. Carries enough
 *  context to render a meaningful summary (command / path) and the
 *  resolver the modal calls when the user clicks a button. */
export interface PendingPrompt {
  id: string;
  tool: GatedTool;
  /** Short identifier (command string for shell, absolute path for
   *  write_file). Persisted to `always_accept` if the user picks
   *  "Always accept this". */
  literal: string;
  /** One-line summary shown above the buttons. Pre-formatted by the
   *  caller because they have the richest context. */
  summary: string;
  /** Optional structured detail. Rendered under the summary as
   *  `<key: value>` lines so the user can audit what the model is
   *  about to do before clicking. */
  detail: Record<string, string>;
  /** Called by the modal once the user clicks a button. */
  resolve: (choice: PromptChoice) => void;
}

/** Callback the mesh client registers so this module can broadcast
 *  the latest snapshot without holding a direct reference (avoids a
 *  circular import — the mesh client itself depends on config which
 *  this module also uses). */
type BroadcastFn = (snapshot: AgentPermissionsConfig) => void;

class AgentPermissionsState {
  /** Pending prompts FIFO. The modal renders `pending[0]`; clearing
   *  it via `resolve(...)` pops it and the next renders. */
  pending = $state<PendingPrompt[]>([]);

  /** Resolved permissions for the currently-active network.
   *  Reactive so the Permissions settings tab reflects gossiped
   *  changes from peers (and active-network switches) without
   *  manual polling. */
  current = $state<AgentPermissionsConfig>(freshAgentPermissions());

  private loaded = false;
  private broadcaster: BroadcastFn | null = null;

  /** Mesh client registers itself once on start so we can fire
   *  `permissions_snapshot` after every local mutation. Safe to call
   *  before / after `ensureLoaded`; the broadcaster is only invoked
   *  when there's a snapshot to send. */
  setBroadcaster(fn: BroadcastFn | null): void {
    this.broadcaster = fn;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const cfg = await loadConfig();
    this.current = getAgentPermissions(cfg);
    this.loaded = true;
  }

  async refresh(): Promise<void> {
    const cfg = await loadConfig();
    this.current = getAgentPermissions(cfg);
    this.loaded = true;
  }

  /** Snapshot for the gossip layer to send on demand (e.g. when a
   *  peer becomes active). Always safe to call — returns the fresh
   *  default if nothing's loaded yet. */
  snapshot(): AgentPermissionsConfig {
    return {
      shell: { ...this.current.shell },
      write_file: { ...this.current.write_file },
    };
  }

  /** Merge an inbound snapshot from a peer. Per-tool LWW by
   *  `updated_at` — the highest wins. The snapshot is applied to the
   *  network identified by `networkId` (the network the gossip came
   *  in on) — usually the active network, but passing it explicitly
   *  keeps the merge robust if the active network switched between
   *  the message arriving on the wire and this handler running.
   *
   *  Persists and refreshes the reactive cache when anything
   *  actually changed; returns whether the local state was mutated
   *  so the mesh client can decide whether to log an entry. */
  async mergeIncoming(
    incoming: Partial<AgentPermissionsConfig>,
    networkId: string,
  ): Promise<boolean> {
    await this.ensureLoaded();
    // Read the target network's current policy directly from
    // config — `this.current` only tracks the active network, and
    // the gossip might arrive scoped to a network that briefly
    // matches active before a switch.
    const cfg = await loadConfig();
    const target = cfg.cloud_mesh.networks.find((n) => n.id === networkId);
    if (!target) return false;
    const local = target.agent_permissions ?? freshAgentPermissions();
    const merged: AgentPermissionsConfig = {
      shell: local.shell,
      write_file: local.write_file,
    };
    let changed = false;
    for (const tool of ["shell", "write_file"] as const) {
      const remote = incoming[tool];
      if (!remote) continue;
      if (remote.updated_at > merged[tool].updated_at) {
        merged[tool] = {
          mode: remote.mode,
          always_accept: [...remote.always_accept],
          updated_at: remote.updated_at,
        };
        changed = true;
      }
    }
    if (!changed) return false;
    await updateAgentPermissions(() => merged, networkId);
    // Refresh the reactive cache if the change landed on the active
    // network. Off-active edits don't show in the UI until the user
    // switches, but they're persisted for that future switch.
    if (cfg.cloud_mesh.active_network_id === networkId) {
      await this.refresh();
    }
    return true;
  }

  /** Gate one tool invocation. Returns immediately with `allowed` or
   *  `denied` when the stored policy is conclusive; otherwise enqueues
   *  a prompt and waits for the user's choice. Persists + gossips the
   *  side effect (allow-list addition or mode change) before resolving. */
  async request(args: {
    tool: GatedTool;
    literal: string;
    summary: string;
    detail: Record<string, string>;
  }): Promise<PermissionDecision> {
    await this.ensureLoaded();
    const policy = this.current[args.tool];
    if (policy.mode === "denied") {
      return { kind: "denied", reason: "user has denied this tool" };
    }
    if (policy.mode === "accept_all") return { kind: "allowed" };
    if (policy.always_accept.includes(args.literal))
      return { kind: "allowed" };

    // Need to prompt. Push and wait for the modal to resolve.
    const choice = await new Promise<PromptChoice>((resolve) => {
      const id = crypto.randomUUID().slice(0, 12);
      this.pending = [
        ...this.pending,
        {
          id,
          tool: args.tool,
          literal: args.literal,
          summary: args.summary,
          detail: args.detail,
          resolve,
        },
      ];
    });

    if (choice === "deny") {
      return { kind: "denied", reason: "user denied this call" };
    }
    if (choice === "allow_once") {
      return { kind: "allowed" };
    }
    if (choice === "always_accept") {
      await this.persistPatch(args.tool, (cur) => ({
        ...cur,
        always_accept: cur.always_accept.includes(args.literal)
          ? cur.always_accept
          : [...cur.always_accept, args.literal],
      }));
      return { kind: "allowed" };
    }
    // accept_all
    await this.persistPatch(args.tool, (cur) => ({ ...cur, mode: "accept_all" }));
    return { kind: "allowed" };
  }

  /** Resolve the head of the prompt queue. Called by the modal's
   *  button handlers. Pops the prompt off `pending` before firing
   *  the resolver so the request() awaiter sees a clean queue when
   *  it resumes. */
  resolveHead(choice: PromptChoice): void {
    const head = this.pending[0];
    if (!head) return;
    this.pending = this.pending.slice(1);
    head.resolve(choice);
  }

  /** Imperative setters used by the Permissions settings tab. Each
   *  stamps `updated_at = Date.now()` on the affected tool and
   *  triggers a gossip broadcast. Settings-tab callers pass
   *  `strict: true` via the persistPatch options so a no-active-
   *  network state surfaces as a visible error rather than being
   *  swallowed. */
  async setMode(tool: GatedTool, mode: ToolPermission["mode"]): Promise<void> {
    await this.persistPatch(tool, (cur) => ({ ...cur, mode }), { strict: true });
  }

  async removeAlwaysAccept(tool: GatedTool, literal: string): Promise<void> {
    await this.persistPatch(
      tool,
      (cur) => ({
        ...cur,
        always_accept: cur.always_accept.filter((s) => s !== literal),
      }),
      { strict: true },
    );
  }

  async clearAlwaysAccept(tool: GatedTool): Promise<void> {
    await this.persistPatch(tool, (cur) => ({ ...cur, always_accept: [] }), {
      strict: true,
    });
  }

  /** Helper used by both the modal-driven persist path and the
   *  imperative settings setters. Stamps `updated_at` on the affected
   *  tool, persists, refreshes the cache, then asks the mesh layer
   *  (if registered) to gossip the new state to peers on the
   *  currently-active network.
   *
   *  With no active network there's nowhere to persist to:
   *    - `strict: true` (settings tab) throws so the UI shows a
   *      useful error.
   *    - `strict: false` (in-loop request path) logs and returns
   *      successfully so the user's immediate click still grants
   *      the call — they'll just see the prompt again next time. */
  private async persistPatch(
    tool: GatedTool,
    patcher: (current: ToolPermission) => ToolPermission,
    opts: { strict?: boolean } = {},
  ): Promise<void> {
    await this.ensureLoaded();
    const cfg = await loadConfig();
    if (!cfg.cloud_mesh.active_network_id) {
      const msg =
        "No active network — permissions are network-scoped. Activate a network in Settings → Networks to configure permissions.";
      if (opts.strict) throw new Error(msg);
      console.warn(`agent-permissions: ${msg}`);
      return;
    }
    await updateAgentPermissions((perms) => {
      const next = patcher(perms[tool]);
      // Always stamp — even a "set to the same mode" click counts
      // because the user has reasserted the choice and we want it to
      // win against an older incoming gossip.
      next.updated_at = Date.now();
      return { ...perms, [tool]: next };
    });
    await this.refresh();
    this.broadcaster?.(this.snapshot());
  }
}

export const agentPermissions = new AgentPermissionsState();
