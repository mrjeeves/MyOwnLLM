/**
 * Program-level (global) agent-tool enablement.
 *
 * This is the OUTER layer of tool control, edited in
 * Settings → Tools. Each tool the chat agent can call has a master
 * on/off switch here. A tool switched off is removed from every chat
 * send on this device — it drops from the model's tool array AND from
 * the system-prompt tool snippets — regardless of whether a persona
 * has it selected. Per-persona tool selection (Settings → Personas)
 * is the INNER layer: it can only narrow what a globally-enabled tool
 * exposes, never re-enable a globally-disabled one.
 *
 * Unlike agent permissions and personas (which are per-network and
 * gossip to peers), this is a local program preference: not
 * network-scoped and not shared with peers. Missing entries default
 * to enabled so a tool added in a later version is on until the user
 * turns it off.
 *
 * Reactive singleton so the Tools settings screen, the Personas
 * editor (which flags a persona tool that's globally off), and the
 * chat-send path all read one live snapshot without prop-drilling or
 * polling.
 */

import { getToolsConfig, loadConfig, updateToolsConfig } from "./config";
import { PROMPT_ALL_TOOLS, type PromptToolId, type ToolsConfig } from "./types";

class AgentToolsConfigState {
  /** Resolved program-level enablement. Mutated by `setEnabled` and
   *  reloaded by `refresh`; templates / `$derived` that read through
   *  `isEnabled` repaint when it changes. */
  current = $state<ToolsConfig>({ enabled: {} });

  private loaded = false;

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.refresh();
    this.loaded = true;
  }

  async refresh(): Promise<void> {
    const cfg = await loadConfig();
    this.current = getToolsConfig(cfg);
  }

  /** Whether a tool is enabled at the program level. A missing entry
   *  reads as enabled (the default). */
  isEnabled(tool: PromptToolId): boolean {
    return this.current.enabled[tool] ?? true;
  }

  /** The globally-enabled tools, in canonical catalog order. */
  enabledList(): PromptToolId[] {
    return PROMPT_ALL_TOOLS.filter((t) => this.isEnabled(t));
  }

  /** Flip a tool's program-level switch and persist. Re-reads the
   *  config afterwards so `current` reflects what landed on disk. */
  async setEnabled(tool: PromptToolId, enabled: boolean): Promise<void> {
    await this.ensureLoaded();
    await updateToolsConfig((cur) => ({
      ...cur,
      enabled: { ...cur.enabled, [tool]: enabled },
    }));
    await this.refresh();
  }
}

export const agentToolsConfig = new AgentToolsConfigState();
