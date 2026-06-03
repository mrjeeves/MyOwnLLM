/**
 * Named prompts the user can apply on the next chat send.
 *
 * Prompts are per-network: each `NetworkConfig.prompts` owns the
 * list visible while that network is active. The TextBar's "System
 * prompt" dropdown shows the union across every saved network so
 * the user can pick a prompt regardless of where it lives — picking
 * a foreign prompt later triggers a propagation step that copies
 * the prompt onto the active network the moment it's USED on a
 * send, after which it gossips like any other prompt on the new
 * network.
 *
 * Wire layout: a `prompts_snapshot` message ships the full list to
 * peers on the active network. Receivers merge by id, last-write-
 * wins on `updated_at`. New entries (different `id`) are added; an
 * `id` deleted on the sender is signalled with a tombstone — see
 * `mesh-protocol.ts` for the wire shape and `mesh-client.svelte.ts`
 * for the broadcast/inbound wiring.
 */

import {
  freshAgentPermissions,
  getPrompts,
  getAllPrompts,
  loadConfig,
  newPromptId,
  updatePrompts,
} from "./config";
import { DEFAULT_SYSTEM_PROMPT_BASE } from "./agent-tools";
import { PROMPT_ALL_TOOLS, type Prompt, type PromptToolId } from "./types";

void freshAgentPermissions; // imported only to keep barrel-style co-locations easy

/** Construct a new Prompt with sane defaults: built-in system
 *  prompt body, all tools selected, empty user prompt. Used by the
 *  Settings Prompts editor's "Add new" button. */
export function freshPrompt(name = "Untitled persona"): Prompt {
  return {
    id: newPromptId(),
    name,
    system_prompt: DEFAULT_SYSTEM_PROMPT_BASE,
    tools: [...PROMPT_ALL_TOOLS],
    user_prompt: "",
    updated_at: Date.now(),
  };
}

/** Callback the mesh client registers so this module can broadcast
 *  the latest prompts snapshot without holding a direct reference
 *  to the mesh layer. */
type BroadcastFn = (prompts: Prompt[]) => void;

class AgentPromptsState {
  /** Prompts visible on the currently-active network. Drives the
   *  Prompts settings tab's sidebar list. */
  current = $state<Prompt[]>([]);

  /** Union of every prompt known across every saved network.
   *  Drives the TextBar dropdown so the user can pick a prompt
   *  authored on another network — selecting + sending propagates
   *  it onto the active network. */
  all = $state<Prompt[]>([]);

  private loaded = false;
  private broadcaster: BroadcastFn | null = null;

  setBroadcaster(fn: BroadcastFn | null): void {
    this.broadcaster = fn;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.refresh();
    this.loaded = true;
  }

  async refresh(): Promise<void> {
    const cfg = await loadConfig();
    this.current = getPrompts(cfg);
    this.all = getAllPrompts(cfg);
  }

  /** Resolve a prompt id to the most-recent version known
   *  anywhere on this device. Returns null when the id doesn't
   *  resolve — e.g. the prompt was deleted everywhere or never
   *  existed. */
  resolve(id: string): Prompt | null {
    return this.all.find((p) => p.id === id) ?? null;
  }

  /** Snapshot for the gossip layer to send on demand. Always safe
   *  to call — returns an empty list if nothing's loaded. */
  snapshot(): Prompt[] {
    return this.current.map((p) => ({ ...p, tools: [...p.tools] }));
  }

  /** Merge an inbound prompts snapshot from a peer. Each entry is
   *  compared by `id`; the higher `updated_at` wins. Returns whether
   *  the local state was mutated so the mesh client can decide
   *  whether to log an entry. Scoped to a network id like the
   *  permissions merge — usually the active network. */
  async mergeIncoming(incoming: Prompt[], networkId: string): Promise<boolean> {
    await this.ensureLoaded();
    const cfg = await loadConfig();
    const target = cfg.cloud_mesh.networks.find((n) => n.id === networkId);
    if (!target) return false;
    const local = target.prompts ?? [];
    const merged = new Map<string, Prompt>();
    for (const p of local) merged.set(p.id, p);
    let changed = false;
    for (const remote of incoming) {
      if (!remote.id) continue;
      const existing = merged.get(remote.id);
      if (!existing || remote.updated_at > existing.updated_at) {
        merged.set(remote.id, {
          id: remote.id,
          name: remote.name,
          system_prompt: remote.system_prompt,
          tools: [...remote.tools],
          user_prompt: remote.user_prompt,
          updated_at: remote.updated_at,
        });
        changed = true;
      }
    }
    if (!changed) return false;
    const next = Array.from(merged.values());
    await updatePrompts(() => next, networkId);
    if (cfg.cloud_mesh.active_network_id === networkId) {
      await this.refresh();
    } else {
      // Off-active edits still need `all` to reflect the new
      // version so the dropdown's union view stays current.
      const fresh = await loadConfig();
      this.all = getAllPrompts(fresh);
    }
    return true;
  }

  /** Add a brand-new prompt to the active network and persist.
   *  Stamps `updated_at = now` so the inbound peer's LWW merge
   *  treats it as authoritative. Returns the inserted prompt so the
   *  editor can select it. Throws when no network is active —
   *  prompts live inside networks. */
  async create(prompt?: Partial<Prompt>): Promise<Prompt> {
    const next: Prompt = {
      ...freshPrompt(prompt?.name ?? "Untitled persona"),
      ...(prompt ?? {}),
      updated_at: Date.now(),
    };
    await this.persistList((cur) => [...cur, next]);
    return next;
  }

  /** Update a prompt by id and persist. Patcher receives the current
   *  prompt; it must return the updated record. `updated_at` is
   *  always re-stamped so peers see the change as newer than their
   *  local copy. */
  async update(id: string, patcher: (cur: Prompt) => Prompt): Promise<void> {
    await this.persistList((cur) =>
      cur.map((p) => (p.id === id ? { ...patcher(p), id, updated_at: Date.now() } : p)),
    );
  }

  /** Delete a prompt from the active network. Doesn't touch other
   *  networks' copies — those remain visible in the dropdown's
   *  union list and continue to gossip on their own networks. */
  async remove(id: string): Promise<void> {
    await this.persistList((cur) => cur.filter((p) => p.id !== id));
  }

  /** Propagate a foreign prompt onto the active network. Called by
   *  the chat-send path when the active prompt isn't yet present on
   *  the active network — the spec requires that "using" a prompt
   *  on a foreign network makes it act as though it had been
   *  created there from then on. After this call the prompt is in
   *  the active network's list and the next broadcast will ship it
   *  out. No-op when the prompt already exists locally or when
   *  there's no active network to land it on. */
  async propagateToActive(promptId: string): Promise<void> {
    await this.ensureLoaded();
    const cfg = await loadConfig();
    if (!cfg.cloud_mesh.active_network_id) return;
    const active = cfg.cloud_mesh.networks.find(
      (n) => n.id === cfg.cloud_mesh.active_network_id,
    );
    if (!active) return;
    if ((active.prompts ?? []).some((p) => p.id === promptId)) return;
    const source = this.all.find((p) => p.id === promptId);
    if (!source) return;
    const clone: Prompt = {
      id: source.id,
      name: source.name,
      system_prompt: source.system_prompt,
      tools: [...source.tools],
      user_prompt: source.user_prompt,
      // Stamp fresh so peers on the new network treat this as the
      // authoritative copy.
      updated_at: Date.now(),
    };
    await this.persistList((cur) => [...cur, clone]);
  }

  /** Internal: apply a patcher to the active network's prompts,
   *  persist, refresh caches, then ask the mesh layer to broadcast.
   *  Throws when no network is active so the UI can show a useful
   *  message rather than silently dropping the click. */
  private async persistList(patcher: (cur: Prompt[]) => Prompt[]): Promise<void> {
    const cfg = await loadConfig();
    if (!cfg.cloud_mesh.active_network_id) {
      throw new Error(
        "No active network — prompts are network-scoped. Activate a network in Settings → Networks to author prompts.",
      );
    }
    await updatePrompts(patcher);
    await this.refresh();
    this.broadcaster?.(this.snapshot());
  }
}

export const agentPrompts = new AgentPromptsState();

// Re-export the toolset for callers that don't want to pull from
// types.ts directly.
export { PROMPT_ALL_TOOLS };
export type { Prompt, PromptToolId };
