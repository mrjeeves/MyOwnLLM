/**
 * Permission gating for the agent's destructive tools.
 *
 * Two tools are gated today: `shell` and `write_file`. Read-only
 * tools (`networks`, `read_file`) bypass this layer because they
 * can't modify the host.
 *
 * The gate is per-device — keyed under `Config.agent_permissions`
 * by the mesh device ID — so a user with multiple machines (laptop,
 * Pi 5, workstation) can grant the agent freer rein where they
 * trust it and keep the prompt on devices they don't. The
 * Permissions tab in Settings is the read/edit surface for the
 * stored policy; this module is the runtime gate the tool handlers
 * call into right before invoking the Rust command.
 *
 * Decision flow (per call):
 *
 *   1. Mode is `denied`           → return refused (no prompt)
 *   2. Mode is `accept_all`       → return allowed (no prompt)
 *   3. Args match `always_accept` → return allowed (no prompt)
 *   4. Otherwise                  → push a pending prompt; resolve
 *                                   when the modal collects the user's
 *                                   choice and persist the side-effect
 *                                   (always_accept entry or
 *                                   mode flip)
 *
 * The pending-prompt queue is a `$state` array so the modal can
 * react to additions and pop the head. Concurrent tool calls
 * (e.g. the model fires shell + write_file in one turn) stack up
 * behind the modal and the user clears them one at a time, which
 * matches how the agent loop runs them sequentially anyway.
 */

import { getMeshIdentity, type MeshIdentity } from "./mesh";
import {
  getDevicePermissions,
  loadConfig,
  updateDevicePermissions,
} from "./config";
import type { DevicePermissions, ToolPermission } from "./types";

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

class AgentPermissionsState {
  /** Pending prompts FIFO. The modal renders `pending[0]`; clearing
   *  it via `resolve(...)` pops it and the next renders. */
  pending = $state<PendingPrompt[]>([]);

  /** Resolved current device's permissions. Cached after first load
   *  and kept in sync via `refresh()` after every mutation so the
   *  Permissions settings tab reflects the latest state without
   *  re-reading config on every render. */
  current = $state<DevicePermissions | null>(null);

  /** Mesh device id this build is bound to, or `""` when identity
   *  hasn't been loaded yet. */
  deviceId = $state("");

  /** Hydrate `deviceId` + `current` from disk. Safe to call
   *  repeatedly; the underlying loaders cache. */
  async ensureLoaded(): Promise<void> {
    if (this.deviceId && this.current) return;
    let id: MeshIdentity;
    try {
      id = await getMeshIdentity();
    } catch {
      // Identity isn't ready (very early startup, or a build without
      // the mesh module wired). Fall back to a synthetic id so the
      // gate still works locally; the user's choices will migrate to
      // the real id on next call once identity is available.
      this.deviceId = "local";
      const cfg = await loadConfig();
      this.current = getDevicePermissions(cfg, this.deviceId);
      return;
    }
    this.deviceId = id.device_id;
    const cfg = await loadConfig();
    this.current = getDevicePermissions(cfg, this.deviceId);
  }

  /** Re-read the device's stored policy. Called after every persist
   *  so the Permissions tab UI tracks the on-disk state. */
  async refresh(): Promise<void> {
    if (!this.deviceId) {
      await this.ensureLoaded();
      return;
    }
    const cfg = await loadConfig();
    this.current = getDevicePermissions(cfg, this.deviceId);
  }

  /** Gate one tool invocation. Returns immediately with `allowed` or
   *  `denied` when the stored policy is conclusive; otherwise enqueues
   *  a prompt and waits for the user's choice. Persists the side
   *  effect (allow-list addition or mode change) before resolving. */
  async request(args: {
    tool: GatedTool;
    literal: string;
    summary: string;
    detail: Record<string, string>;
  }): Promise<PermissionDecision> {
    await this.ensureLoaded();
    const policy = this.current?.[args.tool] ?? {
      mode: "ask" as const,
      always_accept: [],
    };
    if (policy.mode === "denied") {
      return { kind: "denied", reason: "user has denied this tool on this device" };
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

    // Persist the side effect — the modal already removed the prompt
    // from `pending` before invoking the resolver, so we just need to
    // update on-disk state.
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
   *  mutates the persisted policy and refreshes `current`. */
  async setMode(tool: GatedTool, mode: ToolPermission["mode"]): Promise<void> {
    await this.persistPatch(tool, (cur) => ({ ...cur, mode }));
  }

  async removeAlwaysAccept(tool: GatedTool, literal: string): Promise<void> {
    await this.persistPatch(tool, (cur) => ({
      ...cur,
      always_accept: cur.always_accept.filter((s) => s !== literal),
    }));
  }

  async clearAlwaysAccept(tool: GatedTool): Promise<void> {
    await this.persistPatch(tool, (cur) => ({ ...cur, always_accept: [] }));
  }

  /** Helper used by both the modal-driven persist path and the
   *  imperative settings setters. Wraps `updateDevicePermissions` so
   *  every mutation refreshes the cached `current`. */
  private async persistPatch(
    tool: GatedTool,
    patcher: (current: ToolPermission) => ToolPermission,
  ): Promise<void> {
    await this.ensureLoaded();
    await updateDevicePermissions(this.deviceId, (perms) => ({
      ...perms,
      [tool]: patcher(perms[tool]),
    }));
    await this.refresh();
  }
}

export const agentPermissions = new AgentPermissionsState();
