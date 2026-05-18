import { readTextFile, writeTextFile, exists, mkdir } from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";
import type {
  Config,
  ApiConfig,
  AutoUpdateConfig,
  AutoCleanupConfig,
  RemoteUiConfig,
  CloudMeshConfig,
  NetworkConfig,
  MicConfig,
} from "./types";

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
// `signaling_servers` list is empty so Trystero falls back to its
// built-in public-relay pool — anyone who wants to point at a
// self-hosted Nostr relay (or a private one for office/LAN use)
// adds entries here from the Cloud Mesh → Addresses tab. STUN
// servers default to Google's public pool, which is the de-facto
// baseline.
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
 *  TURN by default (user supplies their own credentials if they
 *  need one). Applied by `createNetwork` and by the legacy-config
 *  migration so a pre-multi-network install lands with sane
 *  per-network defaults. */
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
 *  (where everything came from the old flat shape). */
function mergeNetwork(raw: Partial<NetworkConfig>): NetworkConfig {
  return {
    id: raw.id || newNetworkInternalId(),
    label: raw.label || raw.network_id || "",
    network_id: raw.network_id || "",
    locked: raw.locked ?? false,
    signaling_servers: cleanSignaling(raw.signaling_servers),
    stun_servers: raw.stun_servers ?? [...DEFAULT_NETWORK_STUN],
    turn_servers: raw.turn_servers ?? [],
    accepting: coerceAccepting(raw.accepting),
  };
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
      label: legacyNetworkId,
      locked: legacy["locked"] === true,
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

/** Append a new saved network and (optionally) set it active. */
export async function addNetwork(
  init: { network_id: string; label?: string },
  options?: { activate?: boolean; locked?: boolean },
): Promise<Config> {
  const cfg = await loadConfig();
  const newNet: NetworkConfig = mergeNetwork({
    network_id: init.network_id,
    label: init.label || init.network_id,
    locked: options?.locked ?? false,
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
