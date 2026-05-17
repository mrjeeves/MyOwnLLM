export type GpuType = "nvidia" | "amd" | "apple" | "none";

export interface HardwareProfile {
  vram_gb: number | null;
  ram_gb: number;
  disk_free_gb: number;
  gpu_type: GpuType;
  /** CPU architecture the binary was built for, e.g. "x86_64", "aarch64". */
  arch?: string;
  /** Friendly board / SoC label when known, e.g. "Raspberry Pi 5 Model B". */
  soc?: string | null;
}

export type Mode = "text" | "vision" | "code" | "transcribe" | "diarize";

/** Runtimes the resolver knows how to dispatch to.
 *
 *  - `ollama`            — the LLM stack (text/vision/code).
 *  - `moonshine`         — Moonshine ASR via ONNX runtime. Streaming, edge-class.
 *                          English-only at the Small variant we ship today.
 *  - `parakeet`          — NVIDIA Parakeet TDT 0.6B v3 ASR via ONNX runtime.
 *                          25-language, mid-/high-tier CPU + GPU.
 *  - `pyannote-diarize`  — pyannote-segmentation-3.0 + speaker embedder +
 *                          online agglomerative clustering, all wrapped as
 *                          one logical runtime. Used on every tier today.
 *  - `sortformer`        — reserved for a future NVIDIA Streaming-Sortformer
 *                          tier on capable GPUs. Schema accepts the value
 *                          but no model ships yet (upstream ONNX export
 *                          has a known issue in late 2025).
 */
export type ModelRuntime =
  | "ollama"
  | "moonshine"
  | "parakeet"
  | "pyannote-diarize"
  | "sortformer";

export interface ManifestTier {
  /** Discrete-GPU path: matches when `vram_gb >= min_vram_gb`. Includes
   *  KV-cache / activation overhead and any VRAM the paired transcribe
   *  runtime would also claim, so the resolver and the displayed
   *  "Needs ~X GB VRAM" hint can use the same number. Meaningless on
   *  unified-memory hosts (Apple, no-GPU SBCs); use `min_unified_ram_gb`
   *  there. */
  min_vram_gb: number;
  /** Discrete-GPU CPU-fallback path: only consulted when the VRAM walk
   *  produced no hit at all (e.g. a 2 GB GPU staring at a ladder whose
   *  bottom rung wants 4 GB). Matches when system RAM is at least this
   *  big *after* the manifest's per-GPU-class `headroom_gb` is
   *  subtracted. Last-resort path — every shipped family ends in a
   *  min_vram_gb=0 rung so the VRAM walk almost always matches first. */
  min_ram_gb?: number;
  /** Unified-memory path (Apple Silicon, integrated GPUs, CPU-only SBCs):
   *  the raw total RAM the host must have for this tier to fit alongside
   *  the OS, ollama, the WebView, and the paired transcribe model. When
   *  absent the resolver synthesises `min_ram_gb + headroom_gb[gpu_type]`
   *  so legacy tiers keep working. */
  min_unified_ram_gb?: number;
  /** Approximate on-disk size of the model file(s) in MB. Surfaced in the
   *  Settings → Family tier ladder so users can see what each rung costs
   *  before committing. Optional: tiers without it just hide the column. */
  disk_mb?: number;
  /** Optional per-tier runtime override. When set, this rung uses the
   *  named runtime regardless of the mode-level default — so a single
   *  `transcribe` ladder can promote capable hardware to `parakeet`
   *  while the bottom rung stays on `moonshine`. Falls through to
   *  `ManifestMode.runtime`, then `defaultRuntimeFor(mode)`. */
  runtime?: ModelRuntime;
  model: string;
  fallback: string;
}

export interface ManifestMode {
  label: string;
  input?: "audio";
  /** Default runtime for tiers that don't declare their own. Most modes
   *  leave this blank and let the resolver derive it from the mode
   *  (`text` → `ollama`, `transcribe` → `moonshine`, `diarize` →
   *  `pyannote-diarize`). Per-tier `runtime` always wins. */
  runtime?: ModelRuntime;
  tiers: ManifestTier[];
}

/**
 * A model family — e.g. "gemma4", "qwen3". Owns its own per-mode tier table:
 * a family is the unit of "what models do I run, sized to my hardware". Users
 * pick an active family inside an active provider; the resolver walks
 * `families[active_family].modes[mode].tiers` against the local hardware.
 */
export interface ManifestFamily {
  /** Human-readable name shown in the UI ("Gemma 4"). */
  label: string;
  /** One-line blurb shown in the family picker. Optional. */
  description?: string;
  /** Mode picked when the user hasn't chosen one. */
  default_mode: Mode;
  modes: Record<string, ManifestMode>;
}

/** Per-GPU-class RAM (in GB) the resolver reserves for OS / WebView /
 *  ollama / paired transcribe overhead before crediting the rest toward
 *  tier thresholds. Apple unified memory shares the LLM pool with the
 *  whole desktop, so its headroom is the largest; discrete-GPU hosts
 *  reserve only enough system RAM for the host process. Used both as the
 *  `min_ram_gb` budget offset on discrete CPU-fallback and as the
 *  synthesised default for tiers that don't declare an explicit
 *  `min_unified_ram_gb`. */
export type HeadroomMap = Partial<Record<GpuType, number>>;

export interface Manifest {
  name: string;
  version: string;
  ttl_minutes?: number;
  /** Family picked when the user hasn't chosen one. */
  default_family: string;
  /** URLs of other manifests whose families are merged into this one. */
  imports?: string[];
  /** Per-GPU-class headroom budget. Missing keys fall back to the
   *  resolver's compiled-in defaults (apple: 8, none: 4, nvidia/amd: 2)
   *  so older cached manifests automatically inherit sensible numbers. */
  headroom_gb?: HeadroomMap;
  /**
   * Mode blocks every family inherits unless it declares its own.
   * Used today for the canonical whisper transcribe ladder so we don't
   * have to copy-paste the same six tiers into every family — and so a
   * family can override (e.g. a coding-focused family that wants
   * `large-v3` everywhere) without forking the schema. The family's own
   * `modes[k]` always wins on collision.
   */
  shared_modes?: Record<string, ManifestMode>;
  families: Record<string, ManifestFamily>;
}

export interface Provider {
  name: string;
  url: string;
}

export interface ApiConfig {
  enabled: boolean;
  host: string;
  port: number;
  cors_allow_all: boolean;
  bearer_token: string | null;
}

export type AutoUpdateChannel = "stable" | "beta";
export type AutoApplyPolicy = "patch" | "minor" | "all" | "none";

export interface AutoUpdateConfig {
  enabled: boolean;
  channel: AutoUpdateChannel;
  auto_apply: AutoApplyPolicy;
  check_interval_hours: number;
}

/** Optional in-process server that exposes a minimal browser shell over the
 *  LAN so phones / other machines can chat with this MyOwnLLM instance. Off by
 *  default — turning it on binds 0.0.0.0:port. Single-user: the local Tauri
 *  UI is curtained off while a remote session is active. */
export interface RemoteUiConfig {
  enabled: boolean;
  port: number;
}

/** TURN relay server. URL plus optional credentials — TURN servers
 *  typically require auth because they consume bandwidth. */
export interface TurnServer {
  url: string;
  username?: string;
  credential?: string;
}

/** Cloud Mesh — peer-to-peer substrate that lets multiple MyOwnLLM instances
 *  share identities, conversations, and (later) sensors / compute. Off by
 *  default. The Device ID is derived from the ed25519 keypair stored under
 *  `~/.myownllm/.secrets/identity.json` and lives outside this config — only
 *  the network membership and address configuration lives here. */
export interface CloudMeshConfig {
  enabled: boolean;
  /** Shared rendezvous handle for the mesh. Empty string when no
   *  network is configured. Persisted in canonical base32-lowercase
   *  form (256-bit, 52 chars). */
  network_id: string;
  /** True when the user has committed the current `network_id`. The
   *  Cloud Mesh settings tab uses this to gate edits behind a lock
   *  icon and warning popup so a misclick can't silently swap mesh
   *  membership. */
  locked: boolean;
  /** WebSocket URLs of Nostr signaling relays Trystero should use.
   *  Empty array = use Trystero's built-in public-relay pool (the
   *  default). Populated = override with the user's own relays
   *  (typically self-hosted strfry / nostr-rs-relay). MyOwnLLM
   *  operates none of these — the public defaults are
   *  community-run Nostr relays. */
  signaling_servers: string[];
  /** STUN server URLs for NAT traversal. Defaults cover Google's
   *  public stun pool; replace or extend per deployment. */
  stun_servers: string[];
  /** TURN relay servers — optional fallback when STUN can't punch
   *  through. Empty by default; users add their own credentials. */
  turn_servers: TurnServer[];
}

/** Microphone capture settings used by transcribe mode. Audio capture
 *  runs through cpal on the Rust side; `device_name` is matched against
 *  `cpal::Device::name()`. Empty string = system default. The ASR
 *  model itself is picked by the active family's tier resolver — set
 *  `mode_overrides.transcribe` to override. */
export interface MicConfig {
  device_name: string;
  /** Target capture rate in Hz. 16000 is what every ASR backend we ship
   *  expects; the cpal capture path resamples to 16k regardless, so this
   *  is just a hint to any future browser-side fallback. */
  sample_rate: number;
  /** WebRTC echo cancellation — only applies if a future build uses the
   *  WebView mic path; cpal doesn't expose an equivalent. */
  echo_cancellation: boolean;
  /** WebRTC noise suppression — same caveat as above. */
  noise_suppression: boolean;
  /** WebRTC auto gain control — same caveat as above. */
  auto_gain_control: boolean;
}

/** Per-section auto-cleanup toggles. Each flag gates a startup
 *  cleanup pass for that storage area; the Storage tab pairs the
 *  toggle with a "Clean now" button so the user can run the same
 *  pass on demand. All flags default to `true` to preserve the
 *  pre-centralisation behavior (models + updates were cleaned
 *  silently; legacy / transcribe / conversations were exposed as
 *  per-item reclaims or background drains). */
export interface AutoCleanupConfig {
  models: boolean;
  transcribe_buffer: boolean;
  legacy: boolean;
  updates: boolean;
  conversations: boolean;
}

export interface Config {
  active_provider: string;
  active_family: string;
  active_mode: Mode;
  model_cleanup_days: number;
  /** Family names for which the user has dismissed the
   *  "switching with auto-cleanup on" confirmation in the family
   *  detail view's per-tier picker. Per-family rather than per-tier
   *  because the user's intent is "I know how I use this family —
   *  stop asking." Sticky; the user can clear individual entries
   *  if/when we surface a control for it. */
  cleanup_warning_suppressed_families: string[];
  kept_models: string[];
  mode_overrides: Partial<Record<Mode, string | null>>;
  /** Per-family-per-mode user override of the hardware-picked tier.
   *  Outer key is family name, inner key is mode, value is the
   *  selected model tag. Set by the family detail view's "Switch to"
   *  action on a non-recommended tier; cleared by "Un-switch", which
   *  reverts that (family, mode) pair to the hardware tier walk. Wins
   *  over `mode_overrides` (which is the older flat, global per-mode
   *  override) so a per-family choice always beats a global one. */
  family_overrides: Record<string, Partial<Record<Mode, string | null>>>;
  tracked_modes: Mode[];
  /** Where MyOwnLLM persists conversations and generated artifacts. Defaults to
   *  `~/.myownllm/conversations/`. Stored as an absolute path so exported
   *  configs are readable, though new machines re-default on first load. */
  conversation_dir: string;
  auto_cleanup: AutoCleanupConfig;
  api: ApiConfig;
  auto_update: AutoUpdateConfig;
  remote_ui: RemoteUiConfig;
  cloud_mesh: CloudMeshConfig;
  mic: MicConfig;
  providers: Provider[];
}

export interface ModelStatus {
  recommended_by: string[];
  last_recommended: string;
}

export interface ModelStatusCache {
  [modelTag: string]: ModelStatus;
}

export interface OllamaModel {
  name: string;
  size: number;
}
