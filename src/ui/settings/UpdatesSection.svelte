<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import ProvidersSection from "./ProvidersSection.svelte";

  let { onChanged, initialShowProviders = false } = $props<{
    onChanged: () => void;
    /** Open straight into the embedded Providers screen on mount.
     *  Set when a deep-link target asks for the providers panel —
     *  the providers tab itself was retired, the screen now lives
     *  as a sub-page inside Updates. */
    initialShowProviders?: boolean;
  }>();

  // svelte-ignore state_referenced_locally
  let showProviders = $state<boolean>(initialShowProviders);

  interface PendingUpdate {
    version: string;
    staged_at: string;
  }

  interface UpdateStatus {
    current_version: string;
    install_kind: "raw" | "package_manager";
    enabled: boolean;
    channel: string;
    auto_apply: string;
    check_interval_hours: number;
    last_check_unix: number | null;
    pending: PendingUpdate | null;
    release_url: string;
    release_url_overridden: boolean;
  }

  type CheckOutcome =
    | { kind: "disabled" }
    | { kind: "package_manager" }
    | { kind: "up_to_date"; current: string; latest: string }
    | { kind: "staged"; version: string }
    | { kind: "policy_blocked"; current: string; latest: string; policy: string };

  let status = $state<UpdateStatus | null>(null);
  let loading = $state(true);
  let checking = $state(false);
  let togglingEnabled = $state(false);
  let outcome = $state<CheckOutcome | null>(null);
  let error = $state<string>("");

  onMount(refresh);

  async function refresh() {
    loading = true;
    error = "";
    try {
      status = await invoke<UpdateStatus>("update_status");
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  async function checkNow() {
    checking = true;
    outcome = null;
    error = "";
    try {
      outcome = await invoke<CheckOutcome>("update_check_now");
      status = await invoke<UpdateStatus>("update_status");
    } catch (e) {
      error = String(e);
    } finally {
      checking = false;
    }
  }

  async function applyNow() {
    try {
      await invoke("update_apply_now");
    } catch (e) {
      error = String(e);
    }
  }

  async function setEnabled(enabled: boolean) {
    togglingEnabled = true;
    error = "";
    try {
      status = await invoke<UpdateStatus>("update_set_enabled", { enabled });
      // Outcomes from a prior check can become stale once the toggle flips
      // — e.g. an "up-to-date" message shouldn't linger after the user
      // disables updates.
      outcome = null;
    } catch (e) {
      error = String(e);
    } finally {
      togglingEnabled = false;
    }
  }

  function formatTimestamp(unix: number | null): string {
    if (!unix) return "never";
    const ms = Date.now() - unix * 1000;
    const mins = Math.floor(ms / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function formatStagedAt(iso: string): string {
    if (!iso || iso === "?") return "?";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  function installKindLabel(kind: string): string {
    return kind === "package_manager" ? "package manager" : "raw binary";
  }
</script>

<div class="section">
  {#if showProviders}
    <ProvidersSection {onChanged} showBack onBack={() => (showProviders = false)} />
  {:else}
    <div class="content">
      {#if loading}
        <div class="loading">Loading…</div>
      {:else if error && !status}
        <div class="error">{error}</div>
      {:else if status}
      <div class="header-row">
        <div>
          <div class="version">myownllm {status.current_version}</div>
          <div class="meta">
            installed via {installKindLabel(status.install_kind)} ·
            {status.channel} channel
          </div>
        </div>
        <button class="check-btn" onclick={checkNow} disabled={checking || !status.enabled}>
          {checking ? "Checking…" : "Check for updates"}
        </button>
      </div>

      <div class="toggle-row">
        <div class="toggle-text">
          <div class="toggle-label">Automatic updates</div>
          <div class="toggle-sub">
            {status.enabled
              ? "Background checks run every " + status.check_interval_hours + "h."
              : "Background checks are paused. You can still check manually."}
          </div>
        </div>
        <label class="switch" class:on={status.enabled} class:busy={togglingEnabled}>
          <input
            type="checkbox"
            checked={status.enabled}
            disabled={togglingEnabled}
            onchange={(e) => setEnabled((e.currentTarget as HTMLInputElement).checked)}
          />
          <span class="slider"></span>
        </label>
      </div>

      {#if status.install_kind === "package_manager"}
        <div class="notice warn">
          MyOwnLLM was installed via a package manager (Homebrew, apt, rpm, MSI, Chocolatey).
          Use your package manager to upgrade — self-update is intentionally disabled here.
        </div>
      {/if}

      <dl class="info">
        <div>
          <dt>Last checked</dt>
          <dd>{formatTimestamp(status.last_check_unix)}</dd>
        </div>
        <div>
          <dt>Auto-apply policy</dt>
          <dd><code>{status.auto_apply}</code></dd>
        </div>
        <div>
          <dt>Check interval</dt>
          <dd>{status.check_interval_hours}h</dd>
        </div>
      </dl>

      <div class="release-feed">
        <div class="release-feed-label">
          Release feed
          {#if status.release_url_overridden}
            <span class="badge alt">custom</span>
          {/if}
        </div>
        <code class="release-feed-url">{status.release_url}</code>
        <div class="release-feed-hint">
          Override per-machine via <code>auto_update.stable_url</code> /
          <code>auto_update.beta_url</code> in <code>~/.myownllm/config.json</code>, or bake a
          default in at build time with <code>MYOWNLLM_RELEASE_URL_STABLE</code> /
          <code>MYOWNLLM_RELEASE_URL_BETA</code>.
        </div>
      </div>

      {#if status.pending}
        <div class="pending">
          <div class="pending-head">
            <span class="badge">Update staged</span>
            <strong>{status.pending.version}</strong>
          </div>
          <div class="pending-meta">
            staged {formatStagedAt(status.pending.staged_at)} — restart MyOwnLLM to apply.
          </div>
          <button class="apply-btn" onclick={applyNow}>Restart &amp; apply now</button>
        </div>
      {/if}

      {#if outcome}
        <div class="outcome">
          {#if outcome.kind === "disabled"}
            Self-update is disabled.
          {:else if outcome.kind === "package_manager"}
            Package-manager install — self-update deferred to the system updater.
          {:else if outcome.kind === "up_to_date"}
            {#if outcome.current === outcome.latest}
              Already on the latest version ({outcome.latest}).
            {:else}
              You're on <strong>{outcome.current}</strong> — ahead of latest published
              ({outcome.latest}).
            {/if}
          {:else if outcome.kind === "staged"}
            <strong>{outcome.version}</strong> downloaded and staged. Restart to apply.
          {:else if outcome.kind === "policy_blocked"}
            <strong>{outcome.latest}</strong> is available but
            <code>auto_apply = "{outcome.policy}"</code> doesn't permit this jump from
            {outcome.current}. Edit <code>~/.myownllm/config.json</code> to allow it.
          {/if}
        </div>
      {/if}

      {#if error}
        <div class="error">{error}</div>
      {/if}
      {/if}

      <button class="providers-card" onclick={() => (showProviders = true)}>
        <div class="providers-card-main">
          <span class="providers-card-title">Providers</span>
          <span class="providers-card-desc">
            Manage manifest sources — add, switch, or remove the providers
            that publish model families.
          </span>
        </div>
        <span class="providers-card-chevron" aria-hidden="true">›</span>
      </button>
    </div>
  {/if}
</div>

<style>
  .section { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .loading, .error { padding: 2rem; text-align: center; color: #555; font-size: .85rem; }
  .error { color: #d66; }
  .content {
    padding: 1rem 1.1rem;
    overflow-y: auto;
    display: flex; flex-direction: column; gap: 1rem;
  }
  .providers-card {
    width: 100%;
    text-align: left;
    background: #131318;
    border: 1px solid #1e1e1e;
    border-radius: 8px;
    padding: .75rem .9rem;
    color: #ccc;
    cursor: pointer;
    display: flex; align-items: center; gap: .75rem;
  }
  .providers-card:hover { background: #181820; border-color: #2a2a2a; }
  .providers-card-main { flex: 1; display: flex; flex-direction: column; gap: .2rem; min-width: 0; }
  .providers-card-title { font-size: .92rem; font-weight: 600; color: #e8e8e8; }
  .providers-card-desc { font-size: .76rem; color: #888; line-height: 1.45; }
  .providers-card-chevron {
    color: #555; font-size: 1.2rem; line-height: 1; flex-shrink: 0;
  }
  .header-row {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  }
  .version { font-size: 1rem; color: #e8e8e8; font-weight: 600; }
  .meta { font-size: .75rem; color: #666; margin-top: .15rem; }
  .check-btn {
    padding: .45rem .85rem;
    background: #1a1a2a;
    border: 1px solid #2a2a3a;
    color: #e8e8e8;
    border-radius: 6px;
    font-size: .8rem;
    cursor: pointer;
  }
  .check-btn:hover:not(:disabled) { background: #22223a; border-color: #3a3a55; }
  .check-btn:disabled { opacity: .4; cursor: default; }
  .notice {
    padding: .55rem .8rem;
    border-radius: 7px;
    font-size: .78rem;
    line-height: 1.45;
  }
  .notice.warn { background: #2a220e; color: #d6b25a; border: 1px solid #3a2e0e; }
  .info {
    margin: 0;
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: .75rem;
    padding: .75rem;
    background: #131313;
    border: 1px solid #1e1e1e;
    border-radius: 7px;
  }
  .info > div { display: flex; flex-direction: column; gap: .15rem; min-width: 0; }
  dt { font-size: .68rem; color: #666; text-transform: uppercase; letter-spacing: .03em; }
  dd { margin: 0; font-size: .82rem; color: #ccc; }
  dd code { font-family: monospace; font-size: .76rem; color: #9a7; }
  .pending {
    background: #14221a;
    border: 1px solid #1e3325;
    border-radius: 7px;
    padding: .75rem .85rem;
    display: flex; flex-direction: column; gap: .4rem;
  }
  .pending-head { display: flex; align-items: center; gap: .55rem; }
  .pending-head strong { font-family: monospace; color: #6c6; font-size: .9rem; }
  .badge {
    background: #1f3a26; color: #6c6; font-size: .68rem;
    padding: .12rem .45rem; border-radius: 4px;
    text-transform: uppercase; letter-spacing: .04em;
  }
  .pending-meta { font-size: .74rem; color: #788; }
  .apply-btn {
    align-self: flex-start;
    margin-top: .25rem;
    padding: .4rem .85rem;
    background: #1f3a26;
    border: 1px solid #2c5135;
    color: #cfeacf;
    border-radius: 6px;
    font-size: .78rem;
    cursor: pointer;
  }
  .apply-btn:hover { background: #28492f; }
  .outcome {
    padding: .6rem .8rem;
    background: #131820;
    border: 1px solid #1e2530;
    border-radius: 7px;
    font-size: .8rem;
    color: #aac;
    line-height: 1.5;
  }
  .outcome strong { color: #e8e8e8; font-family: monospace; }
  .outcome code { font-family: monospace; font-size: .76rem; color: #d6b25a; }
  .toggle-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 1rem;
    padding: .65rem .85rem;
    background: #131313;
    border: 1px solid #1e1e1e;
    border-radius: 7px;
  }
  .toggle-text { display: flex; flex-direction: column; gap: .15rem; min-width: 0; }
  .toggle-label { font-size: .85rem; color: #e8e8e8; font-weight: 500; }
  .toggle-sub { font-size: .73rem; color: #777; }
  .switch { position: relative; width: 38px; height: 22px; flex-shrink: 0; cursor: pointer; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .switch .slider {
    position: absolute; inset: 0;
    background: #2a2a2a;
    border-radius: 22px;
    transition: background .15s ease;
  }
  .switch .slider::before {
    content: "";
    position: absolute;
    left: 3px; top: 3px;
    width: 16px; height: 16px;
    background: #cfcfcf;
    border-radius: 50%;
    transition: transform .15s ease, background .15s ease;
  }
  .switch.on .slider { background: #2c5135; }
  .switch.on .slider::before { transform: translateX(16px); background: #cfeacf; }
  .switch.busy { opacity: .55; cursor: progress; }
  .release-feed {
    padding: .65rem .85rem;
    background: #131313;
    border: 1px solid #1e1e1e;
    border-radius: 7px;
    display: flex; flex-direction: column; gap: .35rem;
  }
  .release-feed-label {
    font-size: .68rem; color: #666; text-transform: uppercase; letter-spacing: .03em;
    display: flex; align-items: center; gap: .45rem;
  }
  .release-feed-url {
    font-family: monospace; font-size: .76rem; color: #9bbfe0;
    word-break: break-all;
  }
  .release-feed-hint { font-size: .7rem; color: #666; line-height: 1.45; }
  .release-feed-hint code { font-family: monospace; font-size: .68rem; color: #888; }
  .badge.alt {
    background: #2a220e; color: #d6b25a;
    font-size: .62rem;
    padding: .1rem .4rem; border-radius: 4px;
    text-transform: uppercase; letter-spacing: .04em;
  }
</style>
