import { readTextFile, writeTextFile, exists, mkdir } from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import type {
  Config,
  ApiConfig,
  AutoUpdateConfig,
  AutoCleanupConfig,
  RemoteUiConfig,
  CloudMeshConfig,
  NetworkConfig,
  MicConfig,
  AgentPermissionsConfig,
  ToolPermission,
  TopologyMode,
  TurnServer,
  Prompt,
  PromptToolId,
} from "./types";
import { PROMPT_ALL_TOOLS } from "./types";

async function configPath(): Promise<string> {
  const home = await homeDir();
  return `${home}/.myownllm/config.json`;
}

/** Default location for persisted chats / artifacts. Lives under the same
 *  `~/.myownllm/` tree as the rest of MyOwnLLM's state so a single directory holds
 *  everything the user might want to back up or wipe. */
async function defaultConversationDir(): Promise<string> {
  const home = await homeDir();
  return `${home}/.myownllm/conversations`;
}

const DEFAULT_API: ApiConfig = {
  enabled: true,
  host: "127.0.0.1",
  port: 1473,
  cors_allow_all: false,
  bearer_token: null,
};

const DEFAULT_AUTO_UPDATE: AutoUpdateConfig = {
  enabled: true,
  channel: "stable",
  auto_apply: "patch",
  check_interval_hours: 6,
};

const DEFAULT_REMOTE_UI: RemoteUiConfig = {
  enabled: false,
  port: 1474,
};

// Signaling is handled by Trystero over Nostr relays. The default
// per-network `signaling_servers` list is empty so the mesh client
// uses Trystero's built-in 52-relay public pool, bumped to
// redundancy 8 at connect time (see `DEFAULT_SIGNALING_REDUNDANCY`
// in mesh-client.svelte.ts). Anyone who wants to point at a
// self-hosted Nostr relay (or a private one for office/LAN use)
// adds entries from the Cloud Mesh → Addresses tab and those
// replace the default pool entirely. STUN servers default to
// Google's public pool, which is the de-facto baseline.
//
// Legacy entries from earlier PeerJS-based commits get stripped
// on load so testers don't end up pointing Trystero at a
// peerjs-server URL it can't speak to.
const LEGACY_PEERJS_SIGNALING_URLS = [
  "wss://0.peerjs.com:443/",
  "wss://0.peerjs.com:443/peerjs",
  "wss://mesh.myownllm.net/signal",
];

/** Defaults for newly-added networks. Empty signaling = Trystero's
 *  public Nostr relays; Google's STUN pool for NAT helpers; empty
 *  per-network TURN by default. Applied by `createNetwork` and by
 *  the legacy-config migration so a pre-multi-network install
 *  lands with sane per-network defaults. */
export const DEFAULT_NETWORK_SIGNALING: string[] = [];
export const DEFAULT_NETWORK_STUN: string[] = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
];

const DEFAULT_CLOUD_MESH: CloudMeshConfig = {
  enabled: false,
  networks: [],
  active_network_id: null,
};

const DEFAULT_AUTO_CLEANUP: AutoCleanupConfig = {
  models: true,
  transcribe_buffer: true,
  legacy: true,
  updates: true,
  conversations: true,
};

const DEFAULT_MIC: MicConfig = {
  device_name: "",
  sample_rate: 16000,
  echo_cancellation: true,
  noise_suppression: true,
  auto_gain_control: true,
};

const DEFAULT_CONFIG: Config = {
  active_provider: "MyOwnLLM Default",
  active_family: "gemma4",
  // Fresh installs land on Transcribe; existing configs keep whatever
  // active_mode they persisted (mergeDefaults overlays raw on top).
  active_mode: "transcribe",
  model_cleanup_days: 1,
  ollama_keep_alive: "30m",
  ollama_throttle: "io",
  // Off by default: the chat model loads lazily on the first message
  // (surfaced inline in the chat as "Loading the model…") rather than being
  // warmed up front behind a startup screen. Opt in to a *background*,
  // non-blocking pre-warm via Settings → Performance.
  warm_on_startup: false,
  cleanup_warning_suppressed_families: [],
  kept_models: [],
  mode_overrides: {},
  family_overrides: {},
  tracked_modes: ["transcribe"],
  // Filled at first load via defaultConversationDir() — needs an async homeDir().
  conversation_dir: "",
  auto_cleanup: { ...DEFAULT_AUTO_CLEANUP },
  api: { ...DEFAULT_API },
  auto_update: { ...DEFAULT_AUTO_UPDATE },
  remote_ui: { ...DEFAULT_REMOTE_UI },
  cloud_mesh: {
    enabled: DEFAULT_CLOUD_MESH.enabled,
    networks: [],
    active_network_id: null,
    diag_quiet: false,
  },
  mic: { ...DEFAULT_MIC },
  providers: [
    {
      name: "MyOwnLLM Default",
      url: "https://raw.githubusercontent.com/mrjeeves/MyOwnLLM/main/manifests/default.json",
    },
  ],
};

let _cached: Config | null = null;

export async function loadConfig(): Promise<Config> {
  if (_cached) return _cached;
  const path = await configPath();
  try {
    if (await exists(path)) {
      const raw = JSON.parse(await readTextFile(path));
      _cached = mergeDefaults(raw);
      if (!_cached.conversation_dir) {
        _cached.conversation_dir = await defaultConversationDir();
      }
      // One-time migration: pre-multi-network permissions lived on
      // the top-level Config. Now they live inside each
      // NetworkConfig so the gossip can stay scoped to "peers on
      // the network where the change was made". Clone the legacy
      // blob onto every saved network so existing always-accept
      // entries carry over wherever the user might be working.
      if (_cached.agent_permissions) {
        const legacy = _cached.agent_permissions;
        _cached.cloud_mesh = {
          ..._cached.cloud_mesh,
          networks: _cached.cloud_mesh.networks.map((n) =>
            n.agent_permissions
              ? n
              : { ...n, agent_permissions: structuredClone(legacy) },
          ),
        };
        delete _cached.agent_permissions;
      }
      // Persist any defaults we filled in so subsequent loads are consistent.
      await saveConfig(_cached);
      return _cached;
    }
  } catch {
    // Corrupt config — reset.
  }
  _cached = structuredClone(DEFAULT_CONFIG);
  _cached.conversation_dir = await defaultConversationDir();
  await saveConfig(_cached);
  return _cached;
}

function mergeDefaults(raw: Record<string, unknown>): Config {
  // One-shot recovery for users hit by the daemon-collision bug
  // (pre-PR #208): the bundled `myownmesh` daemon used to write its
  // own `MeshConfig`-shape `config.json` over the LLM's
  // `~/.myownllm/config.json`, wiping every LLM key. This rebuilds
  // what we can — the daemon kept the user's networks at a
  // top-level `networks` field, so we lift them into
  // `cloud_mesh.networks` (with sensible defaults for the
  // LLM-only fields the daemon doesn't carry), and strip the
  // daemon-shape leftover keys so subsequent saves are clean.
  raw = salvageDaemonShapeLeakage(raw);

  const merged: Config = {
    ...DEFAULT_CONFIG,
    ...(raw as Partial<Config>),
    api: { ...DEFAULT_API, ...((raw as { api?: Partial<ApiConfig> }).api ?? {}) },
    auto_update: {
      ...DEFAULT_AUTO_UPDATE,
      ...((raw as { auto_update?: Partial<AutoUpdateConfig> }).auto_update ?? {}),
    },
    auto_cleanup: {
      ...DEFAULT_AUTO_CLEANUP,
      ...((raw as { auto_cleanup?: Partial<AutoCleanupConfig> }).auto_cleanup ?? {}),
    },
    remote_ui: {
      ...DEFAULT_REMOTE_UI,
      ...((raw as { remote_ui?: Partial<RemoteUiConfig> }).remote_ui ?? {}),
    },
    cloud_mesh: mergeCloudMesh(
      (raw as { cloud_mesh?: Partial<CloudMeshConfig> }).cloud_mesh,
    ),
    // Legacy: pre-multi-network installs stored a global
    // `agent_permissions`. Preserved here only so the migration in
    // loadConfig has something to clone onto each network — after
    // the clone runs the field is deleted. Absent on fresh
    // installs and on already-migrated configs.
    agent_permissions: (raw as { agent_permissions?: Partial<AgentPermissionsConfig> })
      .agent_permissions
      ? mergeAgentPermissions(
          (raw as { agent_permissions?: Partial<AgentPermissionsConfig> }).agent_permissions,
        )
      : undefined,
    mic: {
      ...DEFAULT_MIC,
      ...((raw as { mic?: Partial<MicConfig> & { whisper_model?: string } }).mic ?? {}),
    },
    mode_overrides: (raw as { mode_overrides?: Config["mode_overrides"] }).mode_overrides ?? {},
    family_overrides:
      (raw as { family_overrides?: Config["family_overrides"] }).family_overrides ?? {},
    kept_models: (raw as { kept_models?: string[] }).kept_models ?? [],
    cleanup_warning_suppressed_families:
      (raw as { cleanup_warning_suppressed_families?: string[] })
        .cleanup_warning_suppressed_families ?? [],
    tracked_modes: (raw as { tracked_modes?: Config["tracked_modes"] }).tracked_modes ?? [],
    providers: (raw as { providers?: Config["providers"] }).providers ?? DEFAULT_CONFIG.providers,
  };
  // Strip removed legacy fields so they don't linger in the saved config.
  delete (merged as unknown as { sources?: unknown }).sources;
  // `mic.whisper_model` was the v0.1.19 way to pick a transcribe model; the
  // family/tier resolver now owns that decision (and `mode_overrides.transcribe`
  // is the user-override path). If a legacy value is present, transplant it
  // to `mode_overrides.transcribe` so the user's pick survives the migration.
  const legacyMic = (raw as { mic?: { whisper_model?: string } }).mic;
  if (legacyMic?.whisper_model && !merged.mode_overrides.transcribe) {
    merged.mode_overrides = {
      ...merged.mode_overrides,
      transcribe: legacyMic.whisper_model,
    };
  }
  delete (merged.mic as unknown as { whisper_model?: string }).whisper_model;
  // One-shot upgrade: seed tracked_modes from active_mode for legacy configs.
  if (!merged.tracked_modes || merged.tracked_modes.length === 0) {
    merged.tracked_modes = [merged.active_mode];
  }
  // Older configs predate active_family; default to the schema's gemma4.
  if (!merged.active_family) {
    merged.active_family = DEFAULT_CONFIG.active_family;
  }
  return merged;
}

/** One-shot recovery for the daemon-collision bug fixed in PR #208.
 *
 *  Up through that PR, the bundled `myownmesh serve` daemon was
 *  spawned with `MYOWNMESH_HOME=~/.myownllm`, which put its own
 *  `MeshConfig`-shape `config.json` at the same path as the LLM's
 *  `~/.myownllm/config.json`. Any `NetworkAdd` IPC call triggered
 *  the daemon's `persist_network_add` → `MeshConfig::load() → push
 *  → save`, which silently dropped every LLM-only key from the
 *  loaded config and wrote the daemon shape back over the file.
 *
 *  Users who hit this see, on next launch, a config.json with the
 *  daemon's top-level `{version, identity_path, auto_update,
 *  auto_cleanup, daemon, networks}` shape and none of the LLM's
 *  fields. The new build's Rust-side isolation prevents recurrence,
 *  but the file on disk needs cleanup.
 *
 *  This function:
 *   1. Detects the daemon shape (top-level `networks` array with
 *      `id` + `network_id` fields, AND `cloud_mesh.networks` empty
 *      or absent).
 *   2. Converts each daemon `NetworkConfig` into the LLM's flat
 *      shape and seeds `cloud_mesh.networks` with the result.
 *      LLM-only fields the daemon doesn't carry (`accepting`,
 *      `agent_permissions`, `prompts`, `auto_gossip`) default to
 *      their fresh values via `mergeNetwork`.
 *   3. Strips the daemon-shape leftover top-level keys so the
 *      saved-back file is clean LLM shape going forward.
 *
 *  No-op when nothing matches the detection signature — fresh
 *  installs and uncorrupted configs are untouched. */
function salvageDaemonShapeLeakage(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const daemonNetworks = raw["networks"];
  if (!Array.isArray(daemonNetworks) || daemonNetworks.length === 0) {
    return raw;
  }
  // Detection: each entry has `id` and `network_id`. If even one
  // entry looks malformed, don't touch the file — the user might
  // have hand-edited something we don't want to clobber.
  const allDaemonShape = daemonNetworks.every(
    (n): n is Record<string, unknown> =>
      !!n &&
      typeof n === "object" &&
      typeof (n as Record<string, unknown>).id === "string" &&
      typeof (n as Record<string, unknown>).network_id === "string",
  );
  if (!allDaemonShape) return raw;
  // Only salvage when the LLM-side cloud_mesh.networks isn't
  // already populated — otherwise we'd risk double-adding.
  const existingCloudMesh = raw["cloud_mesh"] as
    | { networks?: unknown }
    | undefined;
  const existingLlmNetworks = Array.isArray(existingCloudMesh?.networks)
    ? (existingCloudMesh!.networks as unknown[])
    : [];
  if (existingLlmNetworks.length > 0) {
    // We have both shapes. Trust the LLM shape; just strip the
    // daemon-shape leftovers so saves stay clean.
    return stripDaemonLeftovers(raw);
  }
  // Convert daemon NetworkConfig → LLM NetworkConfig. Field
  // mapping:
  //   daemon.signaling.servers           → llm.signaling_servers
  //   daemon.stun_servers[].urls flat    → llm.stun_servers
  //   daemon.turn_servers[].urls[0]/auth → llm.turn_servers[]
  //   everything else (label, kind, topology, auto_approve)
  //     passes straight through.
  const recovered: Array<Partial<NetworkConfig>> = daemonNetworks.map((n) => {
    const d = n as Record<string, unknown>;
    const signaling = d["signaling"] as
      | { servers?: unknown }
      | undefined;
    const signaling_servers = Array.isArray(signaling?.servers)
      ? (signaling!.servers as unknown[]).filter(
          (s): s is string => typeof s === "string",
        )
      : [];
    const stunRaw = Array.isArray(d["stun_servers"])
      ? (d["stun_servers"] as unknown[])
      : [];
    const stun_servers: string[] = [];
    for (const entry of stunRaw) {
      if (!entry || typeof entry !== "object") continue;
      const urls = (entry as { urls?: unknown }).urls;
      if (Array.isArray(urls)) {
        for (const u of urls) {
          if (typeof u === "string") stun_servers.push(u);
        }
      }
    }
    const turnRaw = Array.isArray(d["turn_servers"])
      ? (d["turn_servers"] as unknown[])
      : [];
    const turn_servers: NetworkConfig["turn_servers"] = [];
    for (const entry of turnRaw) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const urls = Array.isArray(e["urls"]) ? (e["urls"] as unknown[]) : [];
      const firstUrl = urls.find((u): u is string => typeof u === "string");
      if (!firstUrl) continue;
      turn_servers.push({
        url: firstUrl,
        username:
          typeof e["username"] === "string" ? (e["username"] as string) : undefined,
        credential:
          typeof e["credential"] === "string"
            ? (e["credential"] as string)
            : undefined,
      });
    }
    return {
      id: d["id"] as string,
      network_id: d["network_id"] as string,
      label: typeof d["label"] === "string" ? (d["label"] as string) : undefined,
      kind:
        d["kind"] === "open" || d["kind"] === "closed"
          ? (d["kind"] as NetworkConfig["kind"])
          : undefined,
      topology: d["topology"] as NetworkConfig["topology"] | undefined,
      auto_approve:
        typeof d["auto_approve"] === "boolean"
          ? (d["auto_approve"] as boolean)
          : undefined,
      signaling_servers,
      stun_servers,
      turn_servers,
    };
  });
  const stripped = stripDaemonLeftovers(raw);
  stripped["cloud_mesh"] = {
    ...(stripped["cloud_mesh"] as Record<string, unknown> | undefined),
    networks: recovered,
  };
  return stripped;
}

/** Remove top-level keys the daemon previously wrote into our
 *  config.json so the saved-back file stays clean LLM shape.
 *
 *  `auto_update` and `auto_cleanup` are shared keys (both shapes
 *  define them with compatible fields); the LLM's `mergeDefaults`
 *  merges them with LLM defaults so the user's values — whichever
 *  shape they were last in — are preserved. Only the daemon-only
 *  keys come out. */
function stripDaemonLeftovers(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...raw };
  delete out["version"];
  delete out["identity_path"];
  delete out["daemon"];
  delete out["networks"];
  return out;
}

/** Generate a stable internal id for a saved network. Independent
 *  of `network_id` so renaming the user-facing handle is allowed
 *  without breaking the `active_network_id` pointer. Crockford-ish
 *  base36, prefixed so it doesn't collide with conversation ids. */
export function newNetworkInternalId(): string {
  return "net-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/** Coerce a raw value into a valid AcceptingPolicy with default. */
function coerceAccepting(raw: unknown): NetworkConfig["accepting"] {
  return raw === "available" || raw === "limited" || raw === "busy" ? raw : "available";
}

/** Strip legacy PeerJS signaling URLs that may linger in old
 *  configs from a pre-Trystero branch commit. */
function cleanSignaling(raw: string[] | undefined): string[] {
  return (raw ?? []).filter((s) => !LEGACY_PEERJS_SIGNALING_URLS.includes(s));
}

/** Build a `NetworkConfig` from a partial saved entry, filling
 *  per-network defaults. Used both for normal loads (where most
 *  fields are present) and for the legacy single-network migration
 *  (where everything came from the old flat shape).
 *
 *  Legacy entries that carry a stray `locked` flag (from the
 *  pre-Phase-3 schema, where locking gated mesh start) are
 *  silently dropped — saving is now the commit gesture and the
 *  delete-network modal carries the confirmation guard. */
function mergeNetwork(
  raw: Partial<NetworkConfig> & { locked?: boolean; use_public_turn_fallback?: boolean },
): NetworkConfig {
  // `use_public_turn_fallback` was a brief experiment that shipped a
  // hard-coded Open Relay TURN URL pair as a fallback. Open Relay's
  // free service no longer allocates ("701 TURN allocate request
  // timed out"), so the fallback added latency and noisy errors
  // without ever connecting a peer. The field is silently dropped
  // on load — any existing config retains its `turn_servers` list
  // as-is, and users who need TURN now point at a working server
  // (Cloudflare Calls, self-hosted Coturn) via the UI.
  void raw.use_public_turn_fallback;
  const net: NetworkConfig = {
    id: raw.id || newNetworkInternalId(),
    network_id: raw.network_id || "",
    signaling_servers: cleanSignaling(raw.signaling_servers),
    stun_servers: raw.stun_servers ?? [...DEFAULT_NETWORK_STUN],
    turn_servers: raw.turn_servers ?? [],
    accepting: coerceAccepting(raw.accepting),
    // Default to enabled so existing networks (saved before this
    // field existed) keep their pre-toggle "auto-sync everywhere"
    // behavior. Only an explicit `false` on disk disables gossip.
    auto_gossip: typeof raw.auto_gossip === "boolean" ? raw.auto_gossip : true,
  };
  // Substrate-aligned optional fields. Defaults are chosen so an
  // entry written by MyOwnLLM before this PR still loads identically:
  //   - `label` absent → UI shows `network_id`
  //   - `kind` absent → "open" (the only governance mode MyOwnLLM
  //     has historically supported; no signed transitions required)
  //   - `topology` absent → ring with default n_preferred
  //   - `auto_approve` absent → false (desktop-app default, user
  //     approves each peer)
  if (typeof raw.label === "string" && raw.label.trim()) {
    net.label = raw.label.trim();
  }
  if (raw.kind === "open" || raw.kind === "closed") {
    net.kind = raw.kind;
  }
  const t = coerceTopology(raw.topology);
  if (t) net.topology = t;
  if (typeof raw.auto_approve === "boolean") {
    net.auto_approve = raw.auto_approve;
  }
  if (raw.agent_permissions) {
    net.agent_permissions = mergeAgentPermissions(raw.agent_permissions);
  }
  if (Array.isArray(raw.prompts)) {
    net.prompts = raw.prompts
      .map((p) => coercePrompt(p))
      .filter((p): p is Prompt => p !== null);
  }
  return net;
}

/** Coerce a raw topology blob into a strict `TopologyMode`. Drops
 *  anything we don't recognise so the substrate's serde stays the
 *  shape authority — adding a new variant in `myownmesh-core` is
 *  what teaches this function how to accept it. Returns `undefined`
 *  on a degenerate input so the caller falls back to the implicit
 *  ring default. */
function coerceTopology(raw: unknown): TopologyMode | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  switch (obj.kind) {
    case "ring": {
      const n = obj.n_preferred;
      return {
        kind: "ring",
        ...(typeof n === "number" && Number.isFinite(n) && n > 0
          ? { n_preferred: Math.floor(n) }
          : {}),
      };
    }
    case "star":
      return typeof obj.hub === "string" && obj.hub
        ? { kind: "star", hub: obj.hub }
        : undefined;
    case "full_mesh":
      return { kind: "full_mesh" };
    default:
      return undefined;
  }
}

/** Merge a partial cloud_mesh config from a saved file with
 *  defaults. Two input shapes are supported:
 *
 *   1. New multi-network shape: `{ networks: [...],
 *      active_network_id, diag_quiet, enabled }`.
 *   2. Legacy pre-multi-network shape: `{ network_id, locked,
 *      signaling_servers, stun_servers, turn_servers, accepting,
 *      diag_quiet, enabled }`. Migrated by lifting the flat fields
 *      into a single-element `networks[]` and pointing
 *      `active_network_id` at it. The user's previous network
 *      stays active across the upgrade, and the matching roster
 *      file gets migrated lazily on first Rust-side load.
 *
 *  Empty / unconfigured input yields an empty network list (the
 *  sidebar still renders the Network section with just an "+ Add
 *  Network" button). */
function mergeCloudMesh(raw: Partial<CloudMeshConfig> | undefined): CloudMeshConfig {
  if (!raw) {
    return {
      enabled: DEFAULT_CLOUD_MESH.enabled,
      networks: [],
      active_network_id: null,
      diag_quiet: false,
    };
  }

  const diag_quiet = typeof raw.diag_quiet === "boolean" ? raw.diag_quiet : false;
  const enabled = raw.enabled ?? DEFAULT_CLOUD_MESH.enabled;

  // Detect the legacy flat shape. The marker is presence of any
  // pre-multi-network field — `network_id` (string), `locked`, or
  // the top-level signaling / stun / turn / accepting arrays.
  const legacy = raw as unknown as Record<string, unknown>;
  const looksLegacy =
    typeof legacy["network_id"] === "string" ||
    typeof legacy["locked"] === "boolean" ||
    Array.isArray(legacy["signaling_servers"]) ||
    Array.isArray(legacy["stun_servers"]) ||
    Array.isArray(legacy["turn_servers"]) ||
    typeof legacy["accepting"] === "string";

  if (!Array.isArray(raw.networks) && looksLegacy) {
    const legacyNetworkId = String(legacy["network_id"] ?? "");
    if (legacyNetworkId === "") {
      // Nothing to migrate; just return an empty multi-network config.
      return { enabled, networks: [], active_network_id: null, diag_quiet };
    }
    const migrated = mergeNetwork({
      network_id: legacyNetworkId,
      signaling_servers: (legacy["signaling_servers"] as string[] | undefined) ?? undefined,
      stun_servers: (legacy["stun_servers"] as string[] | undefined) ?? undefined,
      turn_servers: (legacy["turn_servers"] as NetworkConfig["turn_servers"] | undefined) ?? undefined,
      accepting: legacy["accepting"] as NetworkConfig["accepting"] | undefined,
    });
    return {
      enabled,
      networks: [migrated],
      // Keep the previously-active network live across the upgrade.
      active_network_id: migrated.id,
      diag_quiet,
    };
  }

  // New shape (or empty). Coerce each entry through mergeNetwork
  // so any saved-with-an-old-build entries get the same defaults
  // applied as if they were freshly added.
  const networks = (raw.networks ?? []).map((n) => mergeNetwork(n));
  // Defensive: drop `active_network_id` if it points at a network
  // that's no longer in the list (manual config edit, etc.).
  const active =
    raw.active_network_id && networks.some((n) => n.id === raw.active_network_id)
      ? raw.active_network_id
      : null;

  return { enabled, networks, active_network_id: active, diag_quiet };
}

export async function saveConfig(config: Config): Promise<void> {
  _cached = config;
  const path = await configPath();
  const dir = path.substring(0, path.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await writeTextFile(path, JSON.stringify(config, null, 2));
}

export async function updateConfig(patch: Partial<Config>): Promise<Config> {
  const config = await loadConfig();
  const updated = { ...config, ...patch };
  await saveConfig(updated);
  return updated;
}

export function invalidateConfigCache(): void {
  _cached = null;
}

// ---- multi-network helpers ----------------------------------------------
//
// Tiny wrappers around `updateConfig` so callers don't have to
// hand-clone the whole cloud_mesh slice each time they touch a
// single network. Each returns the updated Config so the caller
// can grab the new active network without re-reading.

/** Get the currently-active network, or null if none is active. */
export function activeNetwork(cfg: Config): NetworkConfig | null {
  if (!cfg.cloud_mesh.active_network_id) return null;
  return cfg.cloud_mesh.networks.find((n) => n.id === cfg.cloud_mesh.active_network_id) ?? null;
}

// ---- daemon network bridge -------------------------------------------------
//
// The daemon owns the live mesh (signaling, ICE, channels); the
// frontend owns the user's saved network catalog in
// `~/.myownllm/config.json`. The two stores were left disconnected
// when the migration off Trystero landed — the daemon started with
// `networks=0` regardless of what the user had configured, leaving
// every install stuck pre-join. These helpers wire one side to the
// other so the active frontend network is the daemon's joined
// network.

/** Translate a frontend `NetworkConfig` into the JSON shape the
 *  daemon's `mesh_daemon_network_add` command expects. Mirrors
 *  `myownmesh_core::config::NetworkConfig` field-for-field, lifting
 *  the frontend's flat `signaling_servers: string[]` / `stun_servers:
 *  string[]` into the daemon's structured `SignalingConfig` /
 *  `StunServer { urls }` / `TurnServer { urls }` shapes. Fields the
 *  daemon doesn't carry (accepting, agent_permissions, prompts,
 *  auto_gossip) are LLM-side concerns and don't cross the bridge. */
export function networkConfigToDaemonShape(net: NetworkConfig): Record<string, unknown> {
  const stun = net.stun_servers ?? [];
  const turn = net.turn_servers ?? [];
  return {
    id: net.id,
    network_id: net.network_id,
    label: net.label ?? "",
    kind: net.kind ?? "open",
    topology: net.topology ?? { kind: "ring", n_preferred: null },
    // Partial SignalingConfig — `redundancy` + `denylist` come from
    // the daemon's `#[serde(default)]` Default impl (5 relays,
    // default denylist) when omitted.
    signaling: {
      strategy: "nostr",
      servers: net.signaling_servers ?? [],
    },
    // Daemon's StunServer groups urls into one entry; mirror its
    // own `default_stun_servers()` shape (single entry with the
    // url list) for one-to-one parity.
    stun_servers: stun.length > 0 ? [{ urls: stun }] : [],
    turn_servers: turn.map((t) => {
      const out: Record<string, unknown> = { urls: [t.url] };
      if (t.username) out.username = t.username;
      if (t.credential) out.credential = t.credential;
      return out;
    }),
    auto_approve: net.auto_approve ?? false,
  };
}

/** Push a network to the daemon. Idempotent: a daemon that already
 *  has the same id / network_id (e.g. persisted from a previous
 *  launch) returns an "already in use" error which we treat as
 *  success. */
export async function daemonAddNetwork(net: NetworkConfig): Promise<void> {
  const config = networkConfigToDaemonShape(net);
  try {
    await invoke("mesh_daemon_network_add", { config });
  } catch (e) {
    const msg = String(e);
    if (msg.includes("already in use") || msg.includes("already joined")) {
      return;
    }
    throw e;
  }
}

/** Tell the daemon to leave a network. Accepts either the config id
 *  or the wire-level network_id — the daemon's registry indexes by
 *  both. Idempotent: unknown ids are silently swallowed since the
 *  daemon already reports unknown removes as success-with-warning. */
export async function daemonRemoveNetwork(idOrNetworkId: string): Promise<void> {
  try {
    await invoke("mesh_daemon_network_remove", { network: idOrNetworkId });
  } catch {
    // Best-effort: unknown network / daemon down / racing
    // restart — the next reconcile pass will re-converge.
  }
}

/** Snapshot the daemon's currently-joined `network_id` strings. */
export async function daemonJoinedNetworkIds(): Promise<string[]> {
  try {
    const status = (await invoke("mesh_daemon_status")) as {
      joined_networks?: string[];
    };
    return status.joined_networks ?? [];
  } catch {
    return [];
  }
}

/** Reconcile the daemon's joined-network set with the frontend
 *  config: ensure the active network (if any) is joined and every
 *  other joined network is dropped. The LLM is a single-active-
 *  network UI today; keeping daemon state aligned with that model
 *  avoids the daemon staying joined to a network the user already
 *  switched away from (and wasting signaling bandwidth on it).
 *
 *  Returns the active network the bridge converged on, or null when
 *  no network is active in the frontend config. */
export async function syncActiveNetworkToDaemon(
  cfg: Config,
): Promise<NetworkConfig | null> {
  const active = activeNetwork(cfg);
  const joined = await daemonJoinedNetworkIds();

  // Drop any daemon-joined network that isn't the current active.
  for (const nid of joined) {
    if (!active || nid !== active.network_id) {
      await daemonRemoveNetwork(nid);
    }
  }
  // Add active if not already joined.
  if (active && !joined.includes(active.network_id)) {
    await daemonAddNetwork(active);
  }
  return active;
}

/** Append a new saved network and (optionally) set it active.
 *  Network ID doubles as the display name — there's no separate
 *  label field. Re-saving an existing `network_id` is a no-op
 *  (or a switch when `activate: true`) so the AddNetwork modal
 *  can be re-fired without spawning duplicates. */
export async function addNetwork(
  init: { network_id: string },
  options?: { activate?: boolean },
): Promise<Config> {
  const cfg = await loadConfig();
  const existing = cfg.cloud_mesh.networks.find((n) => n.network_id === init.network_id);
  if (existing) {
    if (options?.activate && cfg.cloud_mesh.active_network_id !== existing.id) {
      return await setActiveNetwork(existing.id);
    }
    return cfg;
  }
  const newNet: NetworkConfig = mergeNetwork({
    network_id: init.network_id,
  });
  const networks = [...cfg.cloud_mesh.networks, newNet];
  const active_network_id = options?.activate ? newNet.id : cfg.cloud_mesh.active_network_id;
  return await updateConfig({
    cloud_mesh: { ...cfg.cloud_mesh, networks, active_network_id },
  });
}

/** Mutate one saved network in place. The patch is shallow-merged
 *  over the existing network. Throws if the id doesn't exist. */
export async function updateNetwork(
  id: string,
  patch: Partial<Omit<NetworkConfig, "id">>,
): Promise<Config> {
  const cfg = await loadConfig();
  const networks = cfg.cloud_mesh.networks.map((n) =>
    n.id === id ? { ...n, ...patch } : n,
  );
  if (!networks.some((n) => n.id === id)) {
    throw new Error(`unknown network id: ${id}`);
  }
  return await updateConfig({ cloud_mesh: { ...cfg.cloud_mesh, networks } });
}

/** Remove a saved network. If it was active, clears the active
 *  pointer so the mesh client stops on the next reconcile. The
 *  on-disk roster file for that network is deleted separately
 *  via `mesh_roster_delete` — keeping the wiring split lets the
 *  Rust side own all FS access. */
export async function removeNetwork(id: string): Promise<Config> {
  const cfg = await loadConfig();
  const networks = cfg.cloud_mesh.networks.filter((n) => n.id !== id);
  const active_network_id =
    cfg.cloud_mesh.active_network_id === id ? null : cfg.cloud_mesh.active_network_id;
  return await updateConfig({
    cloud_mesh: { ...cfg.cloud_mesh, networks, active_network_id },
  });
}

/** Set the active network. Pass null to deactivate (mesh client
 *  stops on next reconcile). Throws if the id isn't in the saved
 *  list. */
export async function setActiveNetwork(id: string | null): Promise<Config> {
  const cfg = await loadConfig();
  if (id !== null && !cfg.cloud_mesh.networks.some((n) => n.id === id)) {
    throw new Error(`unknown network id: ${id}`);
  }
  return await updateConfig({
    cloud_mesh: { ...cfg.cloud_mesh, active_network_id: id },
  });
}

// ---- network settings export / import -----------------------------------
//
// Portable JSON shape for sharing a network's transport config across
// devices or onboarding a new install in one paste. The `kind` field
// is the on-the-wire marker — the AddNetwork modal's paste-detect and
// the LLM's import tool both look for it before treating a blob as
// settings (vs. some unrelated JSON the user happened to paste).
//
// Stable internal `id` is deliberately omitted: a fresh local id gets
// minted on import so the same export can be applied to multiple
// devices without collision. `network_id` IS shared — that's the
// rendezvous handle.

export const NETWORK_SETTINGS_KIND = "myownllm.network-settings";
export const NETWORK_SETTINGS_VERSION = 1;

/** Envelope kinds we recognise on import. Files exported from any
 *  myownmesh-family product (currently MyOwnLLM + MyOwnMesh) carry
 *  one of these markers; the on-the-wire shape is identical so we
 *  accept all of them and re-export only with our own kind. The
 *  substrate's canonical name (`myownmesh.network-settings`) is
 *  what bare-mesh and future products use; legacy `myownllm.*` keeps
 *  working for users sharing files between MyOwnLLM installs that
 *  pre-date this PR. */
const IMPORT_KINDS: readonly string[] = [
  NETWORK_SETTINGS_KIND,
  "myownmesh.network-settings",
];

export interface NetworkSettingsExport {
  kind: typeof NETWORK_SETTINGS_KIND;
  version: number;
  network_id: string;
  /** Optional cosmetic display name. Mirrors
   *  `myownmesh_core::config::NetworkConfig::label`. */
  label?: string;
  /** Substrate-aligned governance kind. Absent → "open" on
   *  import; substrate consumers stamp it explicitly. */
  network_kind?: NetworkConfig["kind"];
  /** Substrate-aligned topology selector. Absent → ring default.
   *  Field name is `topology` in the substrate; we mirror it. */
  topology?: NetworkConfig["topology"];
  /** Headless auto-roster. */
  auto_approve?: boolean;
  signaling_servers: string[];
  stun_servers: string[];
  turn_servers: TurnServer[];
  accepting: NetworkConfig["accepting"];
}

/** Build a shareable JSON envelope from a saved network. The
 *  internal `id` is dropped so the same blob can be applied on
 *  multiple devices without colliding on import. */
export function exportNetworkSettings(net: NetworkConfig): NetworkSettingsExport {
  return {
    kind: NETWORK_SETTINGS_KIND,
    version: NETWORK_SETTINGS_VERSION,
    network_id: net.network_id,
    ...(net.label ? { label: net.label } : {}),
    ...(net.kind ? { network_kind: net.kind } : {}),
    ...(net.topology ? { topology: net.topology } : {}),
    ...(typeof net.auto_approve === "boolean" ? { auto_approve: net.auto_approve } : {}),
    signaling_servers: [...net.signaling_servers],
    stun_servers: [...net.stun_servers],
    turn_servers: net.turn_servers.map((t) => ({
      url: t.url,
      ...(t.username ? { username: t.username } : {}),
      ...(t.credential ? { credential: t.credential } : {}),
    })),
    accepting: net.accepting,
  };
}

/** Recognise a parsed value as a network-settings envelope. Returns
 *  null when the shape doesn't match — callers use this to decide
 *  whether a pasted/uploaded blob should trigger the import flow. */
export function isNetworkSettingsExport(raw: unknown): raw is NetworkSettingsExport {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  return (
    typeof obj.kind === "string" &&
    IMPORT_KINDS.includes(obj.kind) &&
    typeof obj.network_id === "string"
  );
}

/** Try to parse a JSON string as a network-settings envelope.
 *  Returns null when the input isn't JSON, isn't an object, or
 *  doesn't carry the kind marker. */
export function tryParseNetworkSettings(text: string): NetworkSettingsExport | null {
  try {
    const v = JSON.parse(text);
    return isNetworkSettingsExport(v) ? coerceImport(v) : null;
  } catch {
    return null;
  }
}

/** Coerce a (possibly hand-edited) import blob into a strict
 *  NetworkSettingsExport. Drops unknown / malformed fields rather
 *  than throwing — the user expects "import a JSON" to be tolerant
 *  of light edits and stray comments-converted-to-fields. */
function coerceImport(raw: NetworkSettingsExport): NetworkSettingsExport {
  const signaling = Array.isArray(raw.signaling_servers)
    ? raw.signaling_servers.filter((s): s is string => typeof s === "string")
    : [];
  const stun = Array.isArray(raw.stun_servers)
    ? raw.stun_servers.filter((s): s is string => typeof s === "string")
    : [];
  const turn: TurnServer[] = Array.isArray(raw.turn_servers)
    ? raw.turn_servers
        .filter(
          (t): t is TurnServer =>
            !!t && typeof t === "object" && typeof (t as TurnServer).url === "string",
        )
        .map((t) => ({
          url: t.url,
          ...(typeof t.username === "string" && t.username ? { username: t.username } : {}),
          ...(typeof t.credential === "string" && t.credential
            ? { credential: t.credential }
            : {}),
        }))
    : [];
  const network_kind =
    raw.network_kind === "open" || raw.network_kind === "closed"
      ? raw.network_kind
      : undefined;
  const topology = coerceTopology(raw.topology);
  return {
    kind: NETWORK_SETTINGS_KIND,
    version: NETWORK_SETTINGS_VERSION,
    network_id: String(raw.network_id ?? ""),
    ...(typeof raw.label === "string" && raw.label.trim() ? { label: raw.label.trim() } : {}),
    ...(network_kind ? { network_kind } : {}),
    ...(topology ? { topology } : {}),
    ...(typeof raw.auto_approve === "boolean" ? { auto_approve: raw.auto_approve } : {}),
    signaling_servers: cleanSignaling(signaling),
    stun_servers: stun,
    turn_servers: turn,
    accepting: coerceAccepting(raw.accepting),
  };
}

/** Apply a network-settings envelope: create the network if its
 *  `network_id` isn't already saved, or overwrite the transport
 *  fields of the matching existing entry. The `accepting` field is
 *  applied on both paths. `network_id` is assumed already
 *  normalized by the caller — the AddNetwork modal and the LLM
 *  tool both run `normalizeNetworkId` before reaching here.
 *
 *  Returns the resulting NetworkConfig (with its stable internal id),
 *  along with a flag indicating whether a new entry was created. */
export async function importNetworkSettings(
  blob: NetworkSettingsExport,
  options?: { activate?: boolean },
): Promise<{ network: NetworkConfig; created: boolean }> {
  const cfg = await loadConfig();
  const existing = cfg.cloud_mesh.networks.find(
    (n) => n.network_id === blob.network_id,
  );
  // Substrate-aligned overlays applied on both the update and create
  // paths. Each field is only included when the envelope carries it
  // so an old MyOwnLLM export (no `label`/`network_kind`/etc.) doesn't
  // accidentally wipe an existing entry's local customisations.
  const substrate_overlay: Partial<NetworkConfig> = {
    ...(blob.label ? { label: blob.label } : {}),
    ...(blob.network_kind ? { kind: blob.network_kind } : {}),
    ...(blob.topology ? { topology: blob.topology } : {}),
    ...(typeof blob.auto_approve === "boolean"
      ? { auto_approve: blob.auto_approve }
      : {}),
  };
  if (existing) {
    const updated = await updateNetwork(existing.id, {
      signaling_servers: blob.signaling_servers,
      stun_servers: blob.stun_servers,
      turn_servers: blob.turn_servers,
      accepting: blob.accepting,
      ...substrate_overlay,
    });
    if (options?.activate) {
      await setActiveNetwork(existing.id);
    }
    const network =
      updated.cloud_mesh.networks.find((n) => n.id === existing.id) ?? existing;
    return { network, created: false };
  }
  const fresh: NetworkConfig = mergeNetwork({
    network_id: blob.network_id,
    signaling_servers: blob.signaling_servers,
    stun_servers: blob.stun_servers,
    turn_servers: blob.turn_servers,
    accepting: blob.accepting,
    ...substrate_overlay,
  });
  const networks = [...cfg.cloud_mesh.networks, fresh];
  const active_network_id = options?.activate ? fresh.id : cfg.cloud_mesh.active_network_id;
  await updateConfig({
    cloud_mesh: { ...cfg.cloud_mesh, networks, active_network_id },
  });
  return { network: fresh, created: true };
}

// ---- agent permissions ---------------------------------------------------

/** Default policy for a freshly-seen tool: prompt every time, no
 *  allow-list entries. `updated_at: 0` ensures any real change (which
 *  stamps a non-zero timestamp) wins on the next gossip exchange — so
 *  a fresh device picks up the mesh's existing policy as soon as a
 *  peer broadcasts. */
export function freshToolPermission(): ToolPermission {
  return { mode: "ask", always_accept: [], updated_at: 0 };
}

/** Default network-wide permission set. Every gated tool defaults to
 *  "ask" so the user gets a prompt the first time the agent fires
 *  before any policy has been gossiped from elsewhere. */
export function freshAgentPermissions(): AgentPermissionsConfig {
  return {
    shell: freshToolPermission(),
    write_file: freshToolPermission(),
  };
}

function coerceToolPermission(raw: unknown): ToolPermission {
  if (!raw || typeof raw !== "object") return freshToolPermission();
  const obj = raw as Partial<ToolPermission>;
  const mode: ToolPermission["mode"] =
    obj.mode === "accept_all" || obj.mode === "denied" ? obj.mode : "ask";
  const allow = Array.isArray(obj.always_accept)
    ? obj.always_accept.filter((s): s is string => typeof s === "string")
    : [];
  const ts = typeof obj.updated_at === "number" && Number.isFinite(obj.updated_at)
    ? Math.max(0, Math.floor(obj.updated_at))
    : 0;
  return { mode, always_accept: allow, updated_at: ts };
}

function mergeAgentPermissions(
  raw: Partial<AgentPermissionsConfig> | undefined,
): AgentPermissionsConfig {
  if (!raw || typeof raw !== "object") return freshAgentPermissions();
  // Legacy shape carried `by_device: { <id>: { shell, write_file } }`
  // before gossip turned the policy network-wide. Salvage what we can:
  // pick the most recently-touched per-tool record across all devices,
  // dropping the device key entirely. The user's pre-gossip choices
  // therefore migrate forward as the mesh's starting state.
  const legacy = (raw as { by_device?: Record<string, unknown> }).by_device;
  if (legacy && typeof legacy === "object") {
    const out = freshAgentPermissions();
    for (const perDevice of Object.values(legacy)) {
      if (!perDevice || typeof perDevice !== "object") continue;
      const obj = perDevice as Record<string, unknown>;
      for (const tool of ["shell", "write_file"] as const) {
        const merged = coerceToolPermission(obj[tool]);
        // Legacy records have no `updated_at`; coerce gives 0. Use
        // disk mtime indirectly by stamping `now` on migration so
        // the migrated state is treated as the canonical baseline
        // for the mesh until someone explicitly changes it.
        if (merged.mode !== "ask" || merged.always_accept.length > 0) {
          if (merged.updated_at === 0) merged.updated_at = Date.now();
        }
        if (merged.updated_at > out[tool].updated_at) out[tool] = merged;
      }
    }
    return out;
  }
  return {
    shell: coerceToolPermission((raw as { shell?: unknown }).shell),
    write_file: coerceToolPermission((raw as { write_file?: unknown }).write_file),
  };
}

/** Read the active network's permissions. Returns fresh defaults
 *  when no network is active, when the network has no recorded
 *  policy yet, or when the file's missing the field entirely. */
export function getAgentPermissions(cfg: Config): AgentPermissionsConfig {
  const active = activeNetwork(cfg);
  return active?.agent_permissions ?? freshAgentPermissions();
}

/** Mutate the active network's permissions and persist. The patcher
 *  returns the updated record; callers are responsible for bumping
 *  `updated_at` on tools they're actually changing (the gossip layer
 *  decides whose record wins by that timestamp). No-ops (returns the
 *  current config unchanged) when no network is active — there's no
 *  network to scope the permissions to, so the caller's mutation has
 *  nowhere to land.
 *
 *  When the optional `networkId` is passed, mutates that specific
 *  network even if it isn't the active one — used by the inbound
 *  gossip merge path so a `permissions_snapshot` arriving from a
 *  peer on Network B doesn't accidentally overwrite Network A's
 *  policy. */
export async function updateAgentPermissions(
  patcher: (current: AgentPermissionsConfig) => AgentPermissionsConfig,
  networkId?: string,
): Promise<Config> {
  const cfg = await loadConfig();
  const targetId = networkId ?? cfg.cloud_mesh.active_network_id;
  if (!targetId) return cfg;
  const target = cfg.cloud_mesh.networks.find((n) => n.id === targetId);
  if (!target) return cfg;
  const current = target.agent_permissions ?? freshAgentPermissions();
  const next = patcher(current);
  return await updateNetwork(target.id, { agent_permissions: next });
}

// ---- prompts -------------------------------------------------------------

/** Coerce a possibly-hand-edited prompt blob into a strict `Prompt`.
 *  Returns null when the shape is unsalvageable (no id, no name) so
 *  the caller drops it rather than spawning a record with empty
 *  identifying fields. */
function coercePrompt(raw: unknown): Prompt | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Partial<Prompt>;
  const id = typeof obj.id === "string" && obj.id ? obj.id : "";
  if (!id) return null;
  const name = typeof obj.name === "string" ? obj.name : "";
  const system_prompt = typeof obj.system_prompt === "string" ? obj.system_prompt : "";
  const user_prompt = typeof obj.user_prompt === "string" ? obj.user_prompt : "";
  const tools: PromptToolId[] = Array.isArray(obj.tools)
    ? obj.tools.filter((t): t is PromptToolId =>
        typeof t === "string" && (PROMPT_ALL_TOOLS as readonly string[]).includes(t),
      )
    : [...PROMPT_ALL_TOOLS];
  const updated_at =
    typeof obj.updated_at === "number" && Number.isFinite(obj.updated_at)
      ? Math.max(0, Math.floor(obj.updated_at))
      : 0;
  return { id, name, system_prompt, tools, user_prompt, updated_at };
}

/** Mint a fresh `id` for a new prompt. Prefixed so a stray id
 *  doesn't collide with conversation / network identifiers. */
export function newPromptId(): string {
  return "prm-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/** Read the active network's prompts, or an empty list when no
 *  network is active / the network has none yet. */
export function getPrompts(cfg: Config): Prompt[] {
  const active = activeNetwork(cfg);
  return active?.prompts ?? [];
}

/** All prompts known to this device across every saved network.
 *  Used by the TextBar's dropdown so the user can pick any prompt
 *  they've authored regardless of which network is currently
 *  active — picking a foreign prompt later triggers the
 *  propagation step that copies it into the active network on
 *  next use. */
export function getAllPrompts(cfg: Config): Prompt[] {
  const seen = new Map<string, Prompt>();
  for (const net of cfg.cloud_mesh.networks) {
    for (const p of net.prompts ?? []) {
      const prior = seen.get(p.id);
      if (!prior || p.updated_at > prior.updated_at) seen.set(p.id, p);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Replace the active network's prompts list and persist. Used by
 *  both the Prompts settings tab (CRUD) and the inbound-gossip
 *  merge path. The patcher receives the current array and returns
 *  the next one — callers stamp `updated_at` on records they
 *  changed so LWW gossip merges land correctly. */
export async function updatePrompts(
  patcher: (current: Prompt[]) => Prompt[],
  networkId?: string,
): Promise<Config> {
  const cfg = await loadConfig();
  const targetId = networkId ?? cfg.cloud_mesh.active_network_id;
  if (!targetId) return cfg;
  const target = cfg.cloud_mesh.networks.find((n) => n.id === targetId);
  if (!target) return cfg;
  const next = patcher(target.prompts ?? []);
  return await updateNetwork(target.id, { prompts: next });
}
