import { readTextFile, writeTextFile, exists, mkdir } from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";
import type {
  Config,
  ApiConfig,
  AutoUpdateConfig,
  AutoCleanupConfig,
  RemoteUiConfig,
  CloudMeshConfig,
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

const DEFAULT_CLOUD_MESH: CloudMeshConfig = {
  enabled: false,
  network_id: "",
  locked: false,
  signaling_servers: [],
  stun_servers: [
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
  ],
  turn_servers: [],
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
    ...DEFAULT_CLOUD_MESH,
    signaling_servers: [...DEFAULT_CLOUD_MESH.signaling_servers],
    stun_servers: [...DEFAULT_CLOUD_MESH.stun_servers],
    turn_servers: [...DEFAULT_CLOUD_MESH.turn_servers],
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

/** Merge a partial cloud_mesh config from a saved file with defaults,
 *  preserving array fields the user has customised. Empty arrays are
 *  legitimate user choices for all of signaling, STUN, and TURN —
 *  empty signaling means "let Trystero use its built-in default
 *  Nostr relays," empty STUN/TURN means "I don't want any of those."
 *  Legacy PeerJS URLs from earlier branch commits get stripped on
 *  load. */
function mergeCloudMesh(raw: Partial<CloudMeshConfig> | undefined): CloudMeshConfig {
  if (!raw) {
    return {
      ...DEFAULT_CLOUD_MESH,
      signaling_servers: [...DEFAULT_CLOUD_MESH.signaling_servers],
      stun_servers: [...DEFAULT_CLOUD_MESH.stun_servers],
      turn_servers: [...DEFAULT_CLOUD_MESH.turn_servers],
    };
  }
  const signaling = (raw.signaling_servers ?? []).filter(
    (s) => !LEGACY_PEERJS_SIGNALING_URLS.includes(s),
  );
  // Phase 2 fields are optional in both the persisted shape and the
  // runtime defaults — older configs that predate them just stay on
  // the implicit defaults (`available` accepting, `diag_quiet` off).
  const accepting =
    raw.accepting === "available" || raw.accepting === "limited" || raw.accepting === "busy"
      ? raw.accepting
      : "available";
  const diag_quiet = typeof raw.diag_quiet === "boolean" ? raw.diag_quiet : false;
  return {
    enabled: raw.enabled ?? DEFAULT_CLOUD_MESH.enabled,
    network_id: raw.network_id ?? DEFAULT_CLOUD_MESH.network_id,
    locked: raw.locked ?? DEFAULT_CLOUD_MESH.locked,
    signaling_servers: signaling,
    stun_servers: raw.stun_servers ?? [...DEFAULT_CLOUD_MESH.stun_servers],
    turn_servers: raw.turn_servers ?? [...DEFAULT_CLOUD_MESH.turn_servers],
    accepting,
    diag_quiet,
  };
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
