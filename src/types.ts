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

/** Live resource snapshot — mirrors the `LiveSnapshot` struct in
 *  src-tauri/src/usage.rs, returned by the `usage_live_snapshot`
 *  Tauri command. Every counter is optional on the Rust side so the
 *  UI renders "—" when a platform doesn't expose it. Shared between
 *  the Usage settings tab and the chat model-loading dialog so both
 *  read the same system lookups. */
export interface LiveSnapshot {
  cpu_app_pct: number | null;
  cpu_total_pct: number | null;
  ram_app_bytes: number | null;
  ram_total_bytes: number | null;
  ram_used_bytes: number | null;
  gpu_pct: number | null;
  vram_app_bytes: number | null;
  vram_used_bytes: number | null;
  vram_total_bytes: number | null;
  process_uptime_seconds: number;
  cpu_brand: string | null;
  cpu_count: number | null;
}

export type Mode = "text" | "vision" | "code" | "transcribe" | "diarize" | "embed";

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
 *  - `silero-vad`        — Silero VAD v5, the neural endpointer on the live
 *                          ASR path. The generic resolver never dispatches
 *                          it (transcribe.rs loads the file directly); the
 *                          manifest lists it under the `vad` shared mode so
 *                          it's tracked / recommended / locked like any
 *                          other model. The non-`ollama` value is what keeps
 *                          it off the Ollama pull + cleanup machinery.
 */
export type ModelRuntime =
  | "ollama"
  | "moonshine"
  | "parakeet"
  | "pyannote-diarize"
  | "sortformer"
  | "silero-vad";

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
  /** Whether a provider can swap this capability's model by editing its
   *  manifest. Absent ⇒ swappable: the embedding / transcribe / diarize /
   *  speak ladders are all provider-level defaults — MyOwnLLM's own provider
   *  ships `embeddinggemma` for every family, a Deepseek/white-label provider
   *  can ship its own. `false` marks a capability whose runtime is wired to
   *  one specific model (Silero VAD) — tracked in the manifest, but built
   *  into the app and not a swap target. */
  swappable?: boolean;
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
  /** Fraction (0, 1] of the VRAM / unified-RAM pool a recommendation may use
   *  for a family's own LLM modes — the resolver walks the tiers against this
   *  share of the pool so the resident chat model leaves the rest free (the
   *  shared ASR/TTS/embed ladders always use the full pool). Absent ⇒ 1.0. */
  max_utilization?: number;
  /**
   * Mode blocks every family inherits unless it declares its own.
   * Used today for the canonical whisper transcribe ladder so we don't
   * have to copy-paste the same six tiers into every family — and so a
   * family can override (e.g. a coding-focused family that wants
   * `large-v3` everywhere) without forking the schema. The family's own
   * `modes[k]` always wins on collision.
   */
  shared_modes?: Record<string, ManifestMode>;
  /** Deprecation map: a retired model tag → the current model it maps to.
   *  Providers author this so cleanup is *provider-controlled*: auto-cleanup
   *  removes a pulled model only when a provider has listed it here (i.e.
   *  explicitly superseded it), never just because it dropped off the current
   *  tier list. It also lets a stored/offline reference to a retired tag be
   *  forwarded to its replacement. Matching is canonical (`:latest`-
   *  insensitive). Absent ⇒ no deprecations. */
  backmap?: Record<string, string>;
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

/** One saved network in the user's mesh catalog. The user can save
 *  several (home-mesh, office-mesh, …); only one is active at a
 *  time (single Trystero room joined per process), but the others
 *  retain their roster + per-network settings so switching back is
 *  one click and reuses the prior approvals.
 *
 *  The Network ID IS the display name — it's a short
 *  user-readable handle like `home-mesh`, NOT a secret. Anyone
 *  who knows the ID can knock (you'll see their request), but
 *  joining still requires explicit approval. If you find yourself
 *  fielding requests from strangers who guessed your ID, pick a
 *  more unique one. */
export interface NetworkConfig {
  /** Stable internal id, generated when the network is first
   *  saved. Independent of `network_id` so renaming the
   *  user-facing handle is allowed without breaking the
   *  `active_network_id` pointer. */
  id: string;
  /** Canonical base32-lowercase form of the user-typed Network
   *  ID — and the only thing the user ever reads. Doubles as the
   *  per-network roster filename. */
  network_id: string;
  /** Cosmetic display name. Optional — when absent the UI falls
   *  back to `network_id`. Mirrors `myownmesh_core::config::NetworkConfig::label`
   *  so a network record round-trips between MyOwnLLM and any
   *  other myownmesh consumer without losing its friendly name. */
  label?: string;
  /** Governance kind. `"open"` (default) means every peer can
   *  edit the roster; `"closed"` enables the proposal /
   *  threshold-signature flow from `myownmesh_core::network_state`.
   *  Matches the substrate's `NetworkKind` serde encoding so the
   *  daemon-side governance state agrees on the wire. */
  kind?: NetworkKind;
  /** Topology selector for the runtime mesh. `"ring"` is the only
   *  shape MyOwnLLM's JS mesh client currently implements; the
   *  field is persisted so a future substrate-driven runtime
   *  (Star, FullMesh) can pick it up without a schema migration.
   *  Mirrors `myownmesh_core::config::TopologyMode`. */
  topology?: TopologyMode;
  /** Headless auto-roster: when true, incoming hellos are
   *  approved without the user-facing prompt. Off by default
   *  because MyOwnLLM is a desktop app where the user is
   *  expected to be present; mirrors the substrate's
   *  `auto_approve` field so a NetworkConfig blob ported from a
   *  daemon-only setup keeps the same semantics. */
  auto_approve?: boolean;
  /** Per-network signaling / NAT settings. Each network can point
   *  at a different relay pool — home / office / public mesh all
   *  configurable independently. Empty signaling = Trystero's
   *  built-in Nostr default pool at redundancy 8; empty stun = no
   *  NAT helpers; empty turn = no relay fallback. */
  signaling_servers: string[];
  stun_servers: string[];
  turn_servers: TurnServer[];
  /** Self-reported willingness to take jobs from this network's
   *  peers. Per-network so you can be "available" at home and
   *  "busy" on a shared office mesh simultaneously. */
  accepting: "available" | "limited" | "busy";
  /** Per-network agent-tool permission policy. Each network owns
   *  its own gated-tool policy: changes you make while joined to
   *  the office mesh don't bleed onto the home mesh, and only
   *  peers on the network where the change was made hear the
   *  gossiped update. Optional for backwards compat — absent =
   *  fresh `ask` everywhere. */
  agent_permissions?: AgentPermissionsConfig;
  /** Prompts authored or imported on this network. Like
   *  permissions, prompts gossip only to peers on the network
   *  where they live. Empty / absent = no per-network prompts.
   *
   *  Propagation rule: when the user selects a prompt that
   *  doesn't exist on the currently-active network and sends a
   *  message with it, the prompt is copied into this list (with
   *  a fresh `updated_at`) so it begins to gossip on the new
   *  network too. */
  prompts?: Prompt[];
  /** Whether agent permissions and prompts auto-propagate
   *  ("gossip") between devices on this network. When true
   *  (default), local edits broadcast to peers and inbound
   *  snapshots are merged via LWW — the legacy behavior. When
   *  false, this device stays isolated on this network: outbound
   *  permission/prompt snapshots are suppressed (both the
   *  on-peer-active push and the on-local-edit broadcast) and
   *  inbound snapshots are dropped without merging. Other
   *  network features (catalogs, conversations, inference,
   *  transfers) are unaffected — only the settings-level gossip
   *  is gated. Per-network so a noisy office mesh can be
   *  isolated while the home mesh keeps auto-syncing. Optional
   *  for backwards compat — absent = enabled. */
  auto_gossip?: boolean;
}

/** Governance kind for a network. Mirrors
 *  `myownmesh_core::network_state::NetworkKind`.
 *
 *  - `"open"` — every roster entry can add or remove peers; no
 *    threshold required. Default. The only kind MyOwnLLM has
 *    historically shipped.
 *  - `"closed"` — roster edits become signed transitions through
 *    the governance proposal flow. Requires at least one Owner
 *    on the network to bootstrap. */
export type NetworkKind = "open" | "closed";

/** Authority tier within a closed network. Mirrors
 *  `myownmesh_core::network_state::Role`. Cosmetic on open
 *  networks (every peer is effectively Owner-equivalent there). */
export type Role = "member" | "controller" | "owner";

/** Topology selector. Mirrors `myownmesh_core::config::TopologyMode`
 *  with serde `tag = "kind"`, `rename_all = "snake_case"`. The
 *  shape on disk matches what the substrate's `serde_json` emits,
 *  so a NetworkConfig blob written by either side parses on the
 *  other. */
export type TopologyMode =
  | { kind: "ring"; n_preferred?: number | null }
  | { kind: "star"; hub: string }
  | { kind: "full_mesh" };

/** Cloud Mesh — peer-to-peer substrate that lets multiple MyOwnLLM
 *  instances share identities, conversations, and (later) sensors /
 *  compute. Off by default.
 *
 *  The shape is multi-network: the user can save several `networks`
 *  (each with its own settings + roster on disk) and switch which
 *  one is active. Only one network is joined at a time — the active
 *  network drives the live Trystero room, capability advertisements,
 *  and the Status / Connections tabs. Switching back to a
 *  previously-active network reuses its roster so peers don't have
 *  to re-authenticate.
 *
 *  The Device ID is derived from the ed25519 keypair stored under
 *  `~/.myownllm/.secrets/identity.json` and lives outside this
 *  config — only the network catalog lives here. */
export interface CloudMeshConfig {
  enabled: boolean;
  /** Saved networks. Empty when the user hasn't joined any yet —
   *  the sidebar still surfaces the empty Network section with an
   *  "+ Add Network" button. */
  networks: NetworkConfig[];
  /** `id` field of the currently-active network, or null when no
   *  network is active. The mesh client joins this network's room
   *  (or stays offline when null). */
  active_network_id: string | null;
  /** When true, the mesh client suppresses informational messages
   *  in the Activity log (warnings + errors still land). Stays
   *  global because it's a UI preference, not a per-network
   *  policy. Set via the "Quiet logs" toggle on the Status tab. */
  diag_quiet?: boolean;
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

/** Per-tool permission policy. `ask` (the default for any tool/device
 *  pair the user hasn't acted on yet) shows a prompt on every call;
 *  `accept_all` skips the prompt and approves every invocation;
 *  `denied` skips the prompt and refuses every invocation. The
 *  `always_accept` list is an allow-list of exact command strings (for
 *  shell) or absolute paths (for write_file) that bypass the prompt
 *  regardless of mode — populated from the modal's "Always accept this"
 *  button.
 *
 *  `updated_at` is the unix-ms timestamp of when this record was last
 *  mutated on any device in the mesh. The gossip layer broadcasts the
 *  full record on every change; receivers adopt the incoming version
 *  when its timestamp is strictly newer than their local one. No CRDT
 *  machinery — three discrete modes plus a small allow-list means
 *  last-write-wins converges cleanly. */
export interface ToolPermission {
  mode: "ask" | "accept_all" | "denied";
  always_accept: string[];
  updated_at: number;
}

/** Agent-tool permissions for the whole mesh. Today gates only the two
 *  destructive tools (`shell` and `write_file`); read-only operations
 *  (`networks`, `read_file`) intentionally aren't gated because they
 *  can't modify the host.
 *
 *  Stored network-wide rather than per-device: the user shouldn't have
 *  to re-grant "always accept `ls /tmp`" on every machine on their
 *  mesh. Devices broadcast this blob when they change anything and
 *  when a peer becomes active; the highest `updated_at` per tool
 *  wins on merge. Missing tools default to fresh (`mode: "ask"`).
 *
 *  Lives inside each `NetworkConfig` so the policy is per-network:
 *  permissions configured on Network A don't apply to Network B,
 *  and gossiped updates only reach peers on the network where the
 *  change was made. */
export interface AgentPermissionsConfig {
  shell: ToolPermission;
  write_file: ToolPermission;
}

/** Tool ids selectable on a Prompt. The names match the tool
 *  registry in `agent-tools.ts` — turning one off in the Prompt
 *  drops it from the model's `tools` array for that send, hiding
 *  the function entirely so the model can't call it. */
export type PromptToolId =
  | "networks"
  | "web_search"
  | "read_file"
  | "write_file"
  | "shell";

/** One row in the tool catalog: the metadata the settings UI renders
 *  for a tool, independent of any one screen. Keeps the Tools list
 *  (Settings → Tools), the Permissions sub-tab, and the Personas
 *  editor agreeing on names + descriptions rather than each hard-coding
 *  its own copy. */
export interface ToolCatalogEntry {
  id: PromptToolId;
  /** Human-readable name shown in every tool list. */
  label: string;
  /** One-line description of what the tool does. */
  description: string;
  /** True for host-mutating tools (`write_file`, `shell`) that route
   *  through the agent-permission gate — so the UI can show a
   *  "permission-gated" affordance and point at the Permissions tab.
   *  False for read-only / informational tools that bypass the gate. */
  gated: boolean;
}

/** Canonical catalog of every agent tool, in the safe-first order the
 *  system prompt advertises them in (read-only / informational tools
 *  lead; host-mutating ones trail). Single source of truth for tool
 *  metadata across the settings screens. */
export const TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    id: "networks",
    label: "Networks",
    description:
      "Inspect and manage your Cloud Mesh — peers, saved networks, the accepting policy, and signaling / STUN / TURN servers.",
    gated: false,
  },
  {
    id: "web_search",
    label: "Web search",
    description: "Search the web for current facts and sources. Keyless and read-only.",
    gated: false,
  },
  {
    id: "read_file",
    label: "Read file",
    description: "Read a text file from this device. Read-only, so it never modifies anything.",
    gated: false,
  },
  {
    id: "write_file",
    label: "Write file",
    description: "Create or modify files on this device.",
    gated: true,
  },
  {
    id: "shell",
    label: "Shell",
    description: "Run shell commands on this device.",
    gated: true,
  },
];

/** Every available tool, surfaced as a fixed list so the Personas
 *  editor can render check-marks in a stable order without round-
 *  tripping the agent-tools registry. Derived from `TOOL_CATALOG` so
 *  the order + membership stay in lockstep with the catalog. */
export const PROMPT_ALL_TOOLS: PromptToolId[] = TOOL_CATALOG.map((t) => t.id);

/** Program-level (global, per-installation) tool enablement — the
 *  OUTER layer of tool control, edited in Settings → Tools. Each
 *  tool the chat agent can call has a master on/off switch here. A
 *  tool switched off is removed from every chat send on this device
 *  (it drops from the model's tool array AND from the system-prompt
 *  tool snippets), regardless of whether a persona has it selected.
 *  Per-persona tool selection (the `Prompt.tools` list) is the INNER
 *  layer: it can only narrow what a globally-enabled tool exposes,
 *  never re-enable a globally-disabled one.
 *
 *  Unlike agent permissions and personas (which are per-network and
 *  gossip to peers), this is a local program preference: not
 *  network-scoped and not shared with peers. */
export interface ToolsConfig {
  /** Per-tool master enable, keyed by tool id. `false` removes the
   *  tool from every chat send on this device. A MISSING key means
   *  enabled (the default) so a tool added in a later version is on
   *  until the user turns it off. */
  enabled: Partial<Record<PromptToolId, boolean>>;
}

/** One named prompt the user has authored. The TextBar's "System
 *  prompt" dropdown picks one of these to apply on the next send.
 *  Sent with the model's chat completion as:
 *    - `system_prompt` is the system message body. New prompts
 *      pre-fill it with the built-in default so the user starts
 *      from a working baseline.
 *    - `tools` filters the model's tool array down to the selected
 *      ids; each selected tool's documentation snippet is appended
 *      to the system prompt at send time so the model knows about
 *      the tools it can call.
 *    - `user_prompt` (if non-empty) is appended to the system
 *      message body AFTER the tool snippets — i.e. it acts as the
 *      user's personal system-level instructions, seen by the
 *      model once at the start of the conversation rather than
 *      prepended to every typed message.
 *
 *  Prompts gossip on the network they live on, last-write-wins by
 *  `updated_at`. Stable `id` lets receivers merge edits across
 *  devices without duplicating entries. */
export interface Prompt {
  /** Stable id minted at create time. Travels with the prompt
   *  across networks so propagation onto a foreign network
   *  doesn't spawn a fork. */
  id: string;
  /** Display name shown in the TextBar dropdown + the Prompts
   *  settings sidebar. Defaults to "Untitled prompt" so an empty
   *  field doesn't render blank. */
  name: string;
  /** The system prompt body sent to the model. Pre-filled with
   *  the built-in default on create; the user can edit it but is
   *  discouraged from doing so — the recommended path is to leave
   *  the system prompt alone and customize via `user_prompt`. */
  system_prompt: string;
  /** Tools the model is allowed to call while this prompt is
   *  active. New prompts start with every tool selected; deselect
   *  to hide a tool from the model for that prompt. The selected
   *  tools' documentation snippets are concatenated onto
   *  `system_prompt` at send time so the model knows how to use
   *  them. */
  tools: PromptToolId[];
  /** The user's personal system-level instructions. Appended to
   *  the system message after the tool snippets at send time, so
   *  the model reads role → host → tools → user-task-framing
   *  once at the start of the conversation. Recommended over
   *  editing `system_prompt` because it doesn't risk breaking the
   *  agent's tool / shell conventions baked into the default
   *  system prompt. */
  user_prompt: string;
  /** Unix-ms timestamp of the last local edit. LWW merge key. */
  updated_at: number;
}

/** How the `web_search` tool reaches the web. Keyless by default
 *  (DuckDuckGo's HTML endpoint) so search works out of the box with no
 *  signup; point it at a self-hosted SearXNG instance for a JSON-clean
 *  alternative. Mirrors Myo's `WebSearchConfig`. */
export interface WebSearchConfig {
  /** "ddg" = DuckDuckGo's keyless HTML endpoint (default, works
   *  anywhere). "searxng" = a SearXNG instance's JSON search API at
   *  `searxng_url`. */
  backend: "ddg" | "searxng";
  /** Base URL of the SearXNG instance (e.g. "http://127.0.0.1:8080").
   *  Required when `backend` is "searxng"; ignored otherwise. */
  searxng_url?: string;
}

export interface Config {
  active_provider: string;
  active_family: string;
  active_mode: Mode;
  model_cleanup_days: number;
  /** Ollama `keep_alive` for chat requests — how long the model stays
   *  resident in RAM/VRAM after a turn before Ollama unloads it.
   *  Native Ollama duration format: "30m", "1h", "0" (unload right
   *  away, frees memory for transcription), "-1" (keep until evicted).
   *  Longer values avoid cold-start reloads between messages; shorter
   *  values suit memory-tight machines. Default "30m". */
  ollama_keep_alive: string;
  /** How hard to throttle the Ollama server we spawn while it loads a
   *  model, so the disk thrash doesn't freeze the machine. "off" = no
   *  throttle; "io" = disk-IO priority only (keeps inference full speed,
   *  the default); "aggressive" = also demote CPU/QoS (most responsive
   *  desktop, slower inference). Only applies when MyOwnLLM spawns Ollama
   *  itself — not when it's a system/tray service. */
  ollama_throttle: "off" | "io" | "aggressive";
  /** Warm (preload) the active chat model in the background at startup so
   *  the first message doesn't pay the cold-load wait. On by default; the
   *  load runs under the configured throttle so it doesn't lock up the
   *  machine. Can be turned off in Settings → Performance. */
  warm_on_startup: boolean;
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
  /** Backend the agent's `web_search` tool uses. Defaults to keyless
   *  DuckDuckGo so search works with no setup. */
  web_search: WebSearchConfig;
  /** Program-level (global) per-tool enablement, managed in
   *  Settings → Tools. The outer on/off layer for every agent tool;
   *  a tool disabled here is unavailable to every persona and chat
   *  send on this device. Optional for backwards compat — absent /
   *  missing tools default to enabled. */
  tools?: ToolsConfig;
  providers: Provider[];
  /** Legacy field: pre-multi-network installs stored a single
   *  `agent_permissions` blob shared across every (then-singular)
   *  network. The loader migrates this onto each saved
   *  `NetworkConfig.agent_permissions` on first read and clears
   *  the field. Left in the schema as optional so the
   *  migration's `delete` operation type-checks; new code should
   *  read permissions off the active network. */
  agent_permissions?: AgentPermissionsConfig;
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
