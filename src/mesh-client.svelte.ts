/**
 * Cloud Mesh runtime client.
 *
 * Manages the lifetime of the PeerJS connection, peer discovery, the
 * mutual auth handshake, and the in-memory state the Cloud Mesh
 * settings tab renders against. Persistence lives in Rust (identity,
 * roster); this class is the live, reactive view of what's happening
 * right now.
 *
 * Lifecycle:
 *   - `start()` is called when the user has a locked Network ID. It
 *     connects to the PeerJS broker, registers under a deterministic
 *     Peer ID (`mol-<networkId>-<devicePubkey>`), and listens for
 *     incoming connections.
 *   - On a periodic tick the client polls the broker's peer list,
 *     filters to peers on the same Network ID, and initiates
 *     connections to ones it isn't already talking to.
 *   - Inbound and outbound connections both run the same mutual-auth
 *     handshake. The receiver side either auto-allows (peer in
 *     roster) or queues for user approval. Once the receiver sends
 *     `approve`, both sides flip to ACTIVE.
 *   - `stop()` tears everything down. Re-runnable.
 *
 * What's intentionally not here yet (slots reserved in the protocol
 * for future commits): catalog gossip, Move RPC, capability
 * advertisement, mic / file routing.
 */

import Peer, { type DataConnection } from "peerjs";
import { invoke } from "@tauri-apps/api/core";
import type { MeshIdentity } from "./mesh";
import type { TurnServer } from "./types";
import { loadConfig } from "./config";
import { settingsAttention } from "./settings-attention.svelte";
import {
  loadConversation,
  saveConversation,
  deleteConversation,
  type Conversation,
} from "./conversations";
import {
  authPayload,
  deriveNetworkHandle,
  generateNonce,
  generateVerificationCode,
  networkTag,
  parsePeerJsId,
  peerJsId,
  pubkeyPart,
  pubkeySuffix,
  pubkeyTag,
  signMessage,
  verifySignature,
  PROTOCOL_VERSION,
  type MeshMessage,
} from "./mesh-protocol";

const DISCOVERY_INTERVAL_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;
/** If the broker's `open` event doesn't arrive within this window
 *  we flip to error rather than sit on "Connecting…" indefinitely.
 *  Surfaces the most common failure modes (broker down, URL path
 *  wrong, network blocked) with an actionable message instead of
 *  hanging silently. */
const BROKER_OPEN_TIMEOUT_MS = 15_000;
/** Cap on in-UI diagnostic log entries. Old entries fall off so the
 *  log doesn't grow unbounded during long sessions. */
const DIAG_MAX = 80;

export type DiagLevel = "info" | "warn" | "error";
export interface DiagEntry {
  ts: number;
  level: DiagLevel;
  msg: string;
}

export type PeerStatus =
  | "connecting" // DC opening, no hello exchanged yet
  | "handshaking" // hello sent / received; awaiting auth_response or verifying
  | "pending_approval" // receiver: waiting on the local user to approve
  | "pending_remote_approval" // initiator: waiting on the remote user to approve
  | "active" // both sides cleared; channel usable
  | "denied" // user denied; close imminent
  | "failed"; // protocol error; close imminent

export interface PeerEntry {
  /** Full pubkey when handshake has completed; pubkey-tag during
   *  early handshake. The UI uses this for display only — for
   *  action callbacks pass `device_pubkey_tag` instead, since it's
   *  always defined. */
  device_pubkey: string;
  /** 8-char tag — the always-defined handle used as the
   *  connections-map key. Pass this back into approve/deny/remove
   *  callbacks. */
  device_pubkey_tag: string;
  /** 5-char uppercase-hex display suffix derived from the peer's
   *  pubkey, matching what they show in their own Identity tab.
   *  Empty string until handshake completes. */
  device_suffix: string;
  /** Display form including the 5-char suffix. Derived from the
   *  pubkey using the same algorithm Rust uses, so the suffix
   *  matches what the peer themselves would show. */
  device_id_display: string;
  label: string;
  status: PeerStatus;
  /** True when this peer is in our local roster (we'd auto-allow on
   *  reconnect). */
  authorized: boolean;
  /** True when we were the side that initiated this connection. */
  initiated_by_us: boolean;
  connected_at: number;
  /** Six-char verification code the user reads to confirm the
   *  request is the one they expect. On the initiator side this is
   *  the code we sent (so the local user can read it to the
   *  remote); on the receiver side this is the code we received
   *  from the peer (so the local user can confirm it matches what
   *  the remote person quoted them). Both sides see the same
   *  string. */
  verification_code: string;
}

interface ConnectionState {
  dc: DataConnection;
  /** 8-char tag derived from the peer's full pubkey. Stable for
   *  the lifetime of the connection — known immediately from the
   *  Peer ID, used as the connections-map key. */
  device_pubkey_tag: string;
  /** Full 52-char pubkey. Empty string until `hello` arrives and
   *  we've verified `pubkeyTag(device_pubkey) === device_pubkey_tag`.
   *  Used for roster lookups, signature verification, and anything
   *  cryptographic. */
  device_pubkey: string;
  /** 5-char uppercase-hex display suffix. Computed once when the
   *  full pubkey arrives in `hello`; the same algorithm Rust uses
   *  so a peer's suffix here matches what they show in their own
   *  Identity tab. */
  device_suffix: string;
  label: string;
  initiated_by_us: boolean;
  our_nonce: string;
  /** Their nonce — populated after we receive their `hello`. */
  their_nonce: string | null;
  /** Verification code WE generated and sent in our `hello`. The
   *  initiator's UI shows this — the local user reads it to the
   *  remote to confirm. */
  our_verification_code: string;
  /** Verification code we RECEIVED from the peer's `hello`. The
   *  receiver's UI shows this in Network Requests — the local user
   *  confirms it matches what the remote person quoted. */
  their_verification_code: string;
  /** True after we've verified the auth_response signature. */
  peer_authenticated: boolean;
  /** True after they've sent us `approve`. Always true on the
   *  initiator side once `approve` arrives, and on the receiver
   *  side when we auto-allow (in roster) without sending anything. */
  remote_approved: boolean;
  /** True after we've decided to allow this peer (auto-allowed or
   *  user clicked Approve). */
  local_approved: boolean;
  handshake_timer: number | null;
}

class MeshClient {
  // ---- reactive state, observed by the Cloud Mesh tab -----------------

  status = $state<"off" | "starting" | "online" | "error">("off");
  error = $state("");
  /** Our own Peer-JS-side identifier on the broker, for debugging. */
  my_peer_id = $state("");
  peers = $state<PeerEntry[]>([]);

  /** Ring-buffered diagnostic log surfaced inside the Cloud Mesh
   *  tab. Same content the dev console gets, but reachable without
   *  opening DevTools — important on Tauri where the WebView's
   *  console is platform-dependent and often hidden in shipped
   *  builds. */
  diag = $state<DiagEntry[]>([]);
  private logDiag(level: DiagLevel, msg: string): void {
    const entry: DiagEntry = { ts: Date.now(), level, msg };
    this.diag = [...this.diag, entry].slice(-DIAG_MAX);
    // Mirror to the dev console so a reproduction transcript exists
    // in both places.
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
    fn(`[mesh] ${msg}`);
  }

  // ---- internal --------------------------------------------------------

  private peer_js: Peer | null = null;
  private identity: MeshIdentity | null = null;
  /** Human-readable Network ID — what the user sees and shares. */
  private network_id = "";
  /** sha256 of `network_id` framed under our domain tag. Used as
   *  the broker discovery handle in `peerJsId()` / filtering. */
  private network_handle = "";
  private connections = new Map<string, ConnectionState>();
  private roster_pubkeys = new Set<string>();
  private discovery_timer: number | null = null;
  private broker_open_timer: number | null = null;
  private stopping = false;
  /** Outgoing Move state. Keyed by conversation GUID — only one
   *  in-flight Move per conversation is allowed. Holds the full
   *  payload so move_accept can immediately ship it without
   *  re-reading from disk. */
  private pending_moves_out = new Map<
    string,
    { target_tag: string; conversation: Conversation; on_complete?: (ok: boolean, err?: string) => void }
  >();

  async start(opts: {
    identity: MeshIdentity;
    networkId: string;
    signalingUrl: string;
    stunServers: string[];
    turnServers: TurnServer[];
  }): Promise<void> {
    // Defensive idempotency — calling start while already running
    // is a no-op rather than a double-init.
    if (this.peer_js) return;

    this.stopping = false;
    this.status = "starting";
    this.error = "";
    this.identity = opts.identity;
    this.network_id = opts.networkId;
    this.peers = [];
    this.connections.clear();

    // Derive the broker-side handle once per session. Hashing the
    // human Network ID gives us a fixed-length, parseable identifier
    // for the PeerJS ID without leaking the user's chosen name to
    // anyone scraping the broker. The act of joining the right
    // handle on the broker is itself proof-of-knowledge of the
    // Network ID, which is one half of the bidirectional auth model
    // — the other half is the per-peer signature handshake below.
    try {
      this.network_handle = await deriveNetworkHandle(opts.networkId);
    } catch (e) {
      this.status = "error";
      this.error = `network-handle derivation: ${String(e)}`;
      return;
    }

    // Hydrate the roster so auto-allow works on the very first
    // incoming connection of this session.
    await this.refreshRoster();

    const pubkey = pubkeyPart(opts.identity.device_id);
    const id = peerJsId(this.network_handle, pubkey);
    this.my_peer_id = id;

    const parsed = parseSignalingUrl(opts.signalingUrl);
    const ice_servers = buildIceServers(opts.stunServers, opts.turnServers);

    this.logDiag(
      "info",
      `connecting → ${parsed.secure ? "wss" : "ws"}://${parsed.host}:${parsed.port}${parsed.path}`,
    );
    this.logDiag("info", `my peer id: ${id}`);
    this.logDiag("info", `network handle: ${this.network_handle.slice(0, 12)}…`);

    try {
      this.peer_js = new Peer(id, {
        host: parsed.host,
        port: parsed.port,
        path: parsed.path,
        secure: parsed.secure,
        config: { iceServers: ice_servers },
        // Verbose during early Cloud Mesh rollout — the dev console
        // is the cheapest place to debug broker connectivity. Tighten
        // to 1 (errors only) once the failure modes stabilise.
        debug: 2,
      });
    } catch (e) {
      this.status = "error";
      this.error = `peerjs init: ${String(e)}`;
      this.logDiag("error", `peerjs init failed: ${String(e)}`);
      return;
    }

    // Bail out of "Connecting…" if the broker never responds with
    // `open`. The most common cause is a wrong path component in
    // the signaling URL (e.g. `…/peerjs` instead of `…/`) where
    // PeerJS dutifully tries to talk to a 404 endpoint and never
    // surfaces an error. 15s is generous for a healthy broker over
    // any reasonable network.
    this.broker_open_timer = window.setTimeout(() => {
      if (this.status === "starting") {
        const detail = `${parsed.secure ? "wss" : "ws"}://${parsed.host}:${parsed.port}${parsed.path}`;
        const msg =
          `signaling broker did not respond within ${BROKER_OPEN_TIMEOUT_MS / 1000}s ` +
          `(${detail}). Check that the URL is reachable and the path is the ` +
          `peerjs-server mount point — for the public broker that's just '/' ` +
          `(PeerJS adds '/peerjs' itself).`;
        this.status = "error";
        this.error = msg;
        this.logDiag("error", `broker open timeout — ${detail}`);
      }
    }, BROKER_OPEN_TIMEOUT_MS);

    this.peer_js.on("open", () => {
      if (this.broker_open_timer !== null) {
        clearTimeout(this.broker_open_timer);
        this.broker_open_timer = null;
      }
      this.status = "online";
      this.logDiag("info", `broker open — listening as ${this.my_peer_id}`);
      this.kickDiscovery();
    });
    this.peer_js.on("error", (err) => {
      // PeerJS surfaces both fatal and recoverable errors here.
      // "peer-unavailable" happens routinely when listAllPeers races
      // a peer leaving — log but ignore. Everything else flips the
      // visible status so the user gets feedback rather than a
      // silent hang.
      const type = (err as { type?: string }).type ?? "unknown";
      const message = String((err as Error).message ?? err);
      if (type === "peer-unavailable") {
        this.logDiag("warn", `${type}: ${message}`);
        return;
      }
      this.logDiag("error", `${type}: ${message}`);
      this.status = "error";
      this.error = `${type}: ${message}`;
      if (this.broker_open_timer !== null) {
        clearTimeout(this.broker_open_timer);
        this.broker_open_timer = null;
      }
    });
    this.peer_js.on("disconnected", () => {
      this.logDiag("warn", "broker disconnected — peerjs will retry");
      if (!this.stopping) this.status = "starting";
    });
    this.peer_js.on("close", () => {
      this.logDiag("info", "broker connection closed");
    });
    this.peer_js.on("connection", (dc) => {
      this.logDiag("info", `inbound connection from ${dc.peer.slice(0, 20)}…`);
      this.handleInboundConnection(dc);
    });
  }

  /** Read current config + identity and reconcile the client state
   *  with what the user asked for. Idempotent: called at app start
   *  and again after any setting that affects the mesh (locking the
   *  Network ID, changing signaling addresses, etc.). Restarts the
   *  client only when the config has actually changed; otherwise
   *  it's a cheap no-op. */
  async reconcile(): Promise<void> {
    let cfg;
    let identity: MeshIdentity;
    try {
      cfg = await loadConfig();
      identity = await invoke<MeshIdentity>("mesh_identity_get");
    } catch (e) {
      // No identity yet (anchor failed to generate?) — leave the
      // mesh in whatever state it's in. The user will see the
      // problem when they open the Cloud Mesh tab.
      // eslint-disable-next-line no-console
      console.warn("[mesh] reconcile preflight failed", e);
      return;
    }

    const should_run = cfg.cloud_mesh.locked && cfg.cloud_mesh.network_id !== "";
    if (!should_run) {
      if (this.peer_js) {
        this.logDiag("info", "reconcile: should_run=false → stopping");
        await this.stop();
      }
      return;
    }

    const signaling = cfg.cloud_mesh.signaling_servers[0];
    if (!signaling || signaling.trim() === "") {
      this.logDiag("error", "reconcile: no signaling URL configured");
      return;
    }

    // If we're already running on the right network with the right
    // identity, leave it alone. Detecting STUN/TURN drift here is
    // overkill for v1 — the user can stop and re-lock the Network
    // ID to force a restart.
    if (
      this.peer_js &&
      this.network_id === cfg.cloud_mesh.network_id &&
      this.identity?.device_id === identity.device_id
    ) {
      return;
    }

    if (this.peer_js) {
      this.logDiag("info", "reconcile: config changed → restarting");
      await this.stop();
    }
    this.logDiag("info", `reconcile: starting mesh for network "${cfg.cloud_mesh.network_id}"`);
    await this.start({
      identity,
      networkId: cfg.cloud_mesh.network_id,
      signalingUrl: signaling,
      stunServers: cfg.cloud_mesh.stun_servers,
      turnServers: cfg.cloud_mesh.turn_servers,
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.discovery_timer !== null) {
      clearInterval(this.discovery_timer);
      this.discovery_timer = null;
    }
    if (this.broker_open_timer !== null) {
      clearTimeout(this.broker_open_timer);
      this.broker_open_timer = null;
    }
    for (const c of this.connections.values()) {
      if (c.handshake_timer !== null) clearTimeout(c.handshake_timer);
      try {
        c.dc.close();
      } catch {}
    }
    this.connections.clear();
    if (this.peer_js) {
      try {
        this.peer_js.destroy();
      } catch {}
      this.peer_js = null;
    }
    this.peers = [];
    this.my_peer_id = "";
    this.status = "off";
    this.error = "";
    settingsAttention.set("cloud-mesh", null);
  }

  /** Approve a peer waiting in the pending_approval state. Adds them
   *  to the roster (so reconnects auto-allow) and sends an `approve`
   *  message so the other side flips to ACTIVE. Takes the peer's
   *  pubkey tag (PeerEntry.device_pubkey_tag) since that's the
   *  always-defined handle the UI knows about. */
  async approveRequest(device_pubkey_tag: string): Promise<void> {
    const c = this.connections.get(device_pubkey_tag);
    if (!c || !c.device_pubkey) return;
    c.local_approved = true;
    try {
      await invoke("mesh_roster_add", {
        networkId: this.network_id,
        deviceId: c.device_pubkey,
        label: c.label,
      });
      this.roster_pubkeys.add(c.device_pubkey);
    } catch (e) {
      // Persistence failure shouldn't block the active connection
      // — the peer is still authenticated, the user has approved
      // them — but it does mean they won't auto-allow on
      // reconnect. Log and continue.
      this.logDiag("warn", `roster add failed: ${String(e)}`);
    }
    this.sendApprove(c);
    this.maybePromoteToActive(c);
    this.republishPeers();
  }

  /** Deny a pending peer. Closes the data channel and removes them
   *  from the peers list. Does not blacklist — they can try again,
   *  and they may succeed if circumstances change (e.g. roster
   *  populated by a different peer). */
  async denyRequest(device_pubkey_tag: string): Promise<void> {
    const c = this.connections.get(device_pubkey_tag);
    if (!c) return;
    this.sendDeny(c, "user denied");
    this.dropConnection(device_pubkey_tag);
  }

  /** Initiate a Move of conversation `guid` to peer `target_tag`.
   *  The target must be in the active peer list. Resolves when the
   *  receiver has acknowledged write completion (and we've deleted
   *  the local copy); rejects on protocol error, peer-decline, or
   *  disconnect mid-flight. */
  async moveConversation(guid: string, target_tag: string): Promise<void> {
    const conn = this.connections.get(target_tag);
    if (!conn || this.peerStatus(conn) !== "active") {
      throw new Error("target peer is not active");
    }
    if (this.pending_moves_out.has(guid)) {
      throw new Error("a move for this conversation is already in flight");
    }
    const conversation = await loadConversation(guid);
    if (!conversation) {
      throw new Error("conversation not found locally");
    }
    return await new Promise<void>((resolve, reject) => {
      this.pending_moves_out.set(guid, {
        target_tag,
        conversation,
        on_complete: (ok, err) => {
          if (ok) resolve();
          else reject(new Error(err ?? "move failed"));
        },
      });
      this.send(conn, {
        kind: "move_offer",
        guid,
        title: conversation.title,
      });
    });
  }

  /** Remove an already-active peer from the roster and close the
   *  current connection. The peer can reconnect, but will require
   *  fresh approval. */
  async removePeer(device_pubkey_tag: string): Promise<void> {
    const c = this.connections.get(device_pubkey_tag);
    const full_pubkey = c?.device_pubkey;
    if (full_pubkey) {
      try {
        await invoke("mesh_roster_remove", {
          networkId: this.network_id,
          deviceId: full_pubkey,
        });
        this.roster_pubkeys.delete(full_pubkey);
      } catch (e) {
        this.logDiag("warn", `roster remove failed: ${String(e)}`);
      }
    }
    if (c) this.dropConnection(device_pubkey_tag);
    else this.republishPeers();
  }

  // ---- discovery ------------------------------------------------------

  private kickDiscovery(): void {
    void this.runDiscoveryTick();
    this.discovery_timer = window.setInterval(() => {
      void this.runDiscoveryTick();
    }, DISCOVERY_INTERVAL_MS);
  }

  private async runDiscoveryTick(): Promise<void> {
    if (!this.peer_js || !this.identity) return;
    const my_pubkey = pubkeyPart(this.identity.device_id);
    // Wrap listAllPeers in a promise — PeerJS's signature is
    // callback-based even though it logically returns a list.
    let all: string[];
    try {
      all = await new Promise<string[]>((resolve, reject) => {
        this.peer_js!.listAllPeers((ids) => resolve(ids));
        // Belt-and-braces timeout in case the broker doesn't respond.
        setTimeout(() => reject(new Error("listAllPeers timed out")), 10_000);
      });
    } catch (e) {
      // Some peerjs-server deployments disable discovery. We surface
      // this once and stop polling — the user can still connect by
      // having a peer initiate to us, just not the reverse.
      this.logDiag("warn", `discovery unavailable: ${String(e)}`);
      if (this.discovery_timer !== null) {
        clearInterval(this.discovery_timer);
        this.discovery_timer = null;
      }
      return;
    }
    const our_network_tag = networkTag(this.network_handle);
    const our_pubkey_tag = pubkeyTag(my_pubkey);
    const matches = all.filter((id) => {
      const p = parsePeerJsId(id);
      return p && p.network_tag === our_network_tag && p.pubkey_tag !== our_pubkey_tag;
    });
    this.logDiag(
      "info",
      `discovery: ${all.length} peers on broker, ${matches.length} on our network`,
    );
    for (const id of all) {
      const parsed = parsePeerJsId(id);
      if (!parsed) continue;
      if (parsed.network_tag !== our_network_tag) continue;
      if (parsed.pubkey_tag === our_pubkey_tag) continue;
      if (this.connections.has(parsed.pubkey_tag)) continue;
      // Tie-break who initiates so we don't double-connect: the
      // lexically-lesser pubkey-tag is the initiator. Without this
      // both sides would try simultaneously and we'd get two
      // redundant channels.
      if (our_pubkey_tag > parsed.pubkey_tag) continue;
      this.logDiag("info", `initiating connection to ${parsed.pubkey_tag}…`);
      this.initiateConnection(id, parsed.pubkey_tag);
    }
  }

  private initiateConnection(peer_id: string, device_pubkey_tag: string): void {
    if (!this.peer_js) return;
    const dc = this.peer_js.connect(peer_id, { reliable: true });
    const conn = this.createConnState(dc, device_pubkey_tag, /* initiator */ true);
    this.connections.set(device_pubkey_tag, conn);
    this.wireDataChannel(conn);
    this.republishPeers();
  }

  private handleInboundConnection(dc: DataConnection): void {
    const parsed = parsePeerJsId(dc.peer);
    if (!parsed || parsed.network_tag !== networkTag(this.network_handle)) {
      // Foreign peer (different network or non-MyOwnLLM client).
      try { dc.close(); } catch {}
      return;
    }
    // If a connection in either direction is already in flight,
    // prefer the one we initiated and drop this inbound one.
    if (this.connections.has(parsed.pubkey_tag)) {
      try { dc.close(); } catch {}
      return;
    }
    const conn = this.createConnState(dc, parsed.pubkey_tag, /* initiator */ false);
    this.connections.set(parsed.pubkey_tag, conn);
    this.wireDataChannel(conn);
    this.republishPeers();
  }

  private createConnState(
    dc: DataConnection,
    device_pubkey_tag: string,
    initiator: boolean,
  ): ConnectionState {
    return {
      dc,
      device_pubkey_tag,
      device_pubkey: "",
      device_suffix: "",
      label: "",
      initiated_by_us: initiator,
      our_nonce: generateNonce(),
      their_nonce: null,
      our_verification_code: generateVerificationCode(),
      their_verification_code: "",
      peer_authenticated: false,
      remote_approved: false,
      local_approved: false,
      handshake_timer: null,
    };
  }

  private wireDataChannel(conn: ConnectionState): void {
    conn.dc.on("open", () => {
      // Send our hello as soon as the data channel opens.
      this.sendHello(conn);
      conn.handshake_timer = window.setTimeout(() => {
        if (this.peerStatus(conn) === "active") return;
        this.dropConnection(conn.device_pubkey_tag);
      }, HANDSHAKE_TIMEOUT_MS);
    });
    conn.dc.on("data", (raw) => {
      this.handleMessage(conn, raw);
    });
    conn.dc.on("close", () => {
      this.dropConnection(conn.device_pubkey_tag);
    });
    conn.dc.on("error", () => {
      this.dropConnection(conn.device_pubkey_tag);
    });
  }

  private sendHello(conn: ConnectionState): void {
    if (!this.identity) return;
    const msg: MeshMessage = {
      kind: "hello",
      protocol: PROTOCOL_VERSION,
      device_id: pubkeyPart(this.identity.device_id),
      label: this.identity.label,
      nonce: conn.our_nonce,
      verification_code: conn.our_verification_code,
    };
    this.send(conn, msg);
  }

  private sendApprove(conn: ConnectionState): void {
    this.send(conn, { kind: "approve" });
  }

  private sendDeny(conn: ConnectionState, reason: string): void {
    this.send(conn, { kind: "deny", reason });
  }

  private send(conn: ConnectionState, msg: MeshMessage): void {
    try {
      conn.dc.send(JSON.stringify(msg));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[mesh] send failed", e);
    }
  }

  private async handleMessage(conn: ConnectionState, raw: unknown): Promise<void> {
    let msg: MeshMessage;
    try {
      msg = typeof raw === "string" ? JSON.parse(raw) : (raw as MeshMessage);
    } catch {
      return;
    }
    switch (msg.kind) {
      case "hello":
        await this.handleHello(conn, msg);
        break;
      case "auth_response":
        await this.handleAuthResponse(conn, msg);
        break;
      case "approve":
        conn.remote_approved = true;
        this.maybePromoteToActive(conn);
        this.republishPeers();
        break;
      case "deny":
        this.dropConnection(conn.device_pubkey);
        break;
      case "ping":
        this.send(conn, { kind: "pong", t: msg.t });
        break;
      case "pong":
        // No-op for v1 — latency tracking will land with capability
        // advertisement.
        break;
      case "catalog_announce":
        // No-op for v1. Catalog state is held by the source of
        // each conversation; this message just isn't actioned yet.
        // The "Network" view that consumes it will land in a
        // follow-up commit.
        break;
      case "move_offer":
        await this.handleMoveOffer(conn, msg);
        break;
      case "move_accept":
        await this.handleMoveAccept(conn, msg);
        break;
      case "move_decline":
        this.resolveMoveOut(msg.guid, false, msg.reason);
        break;
      case "move_payload":
        await this.handleMovePayload(conn, msg);
        break;
      case "move_complete":
        await this.handleMoveComplete(conn, msg);
        break;
    }
  }

  private async handleMoveOffer(
    conn: ConnectionState,
    msg: MeshMessage & { kind: "move_offer" },
  ): Promise<void> {
    // Defensively refuse offers from un-approved peers — the auth
    // gates should already block this but cheap to be sure.
    if (this.peerStatus(conn) !== "active") {
      this.send(conn, { kind: "move_decline", guid: msg.guid, reason: "channel not active" });
      return;
    }
    let existing: Conversation | null = null;
    try {
      existing = await loadConversation(msg.guid);
    } catch {
      existing = null;
    }
    if (existing) {
      this.send(conn, {
        kind: "move_decline",
        guid: msg.guid,
        reason: "already have this conversation",
      });
      return;
    }
    this.send(conn, { kind: "move_accept", guid: msg.guid });
  }

  private async handleMoveAccept(
    conn: ConnectionState,
    msg: MeshMessage & { kind: "move_accept" },
  ): Promise<void> {
    const pending = this.pending_moves_out.get(msg.guid);
    if (!pending || pending.target_tag !== conn.device_pubkey_tag) return;
    this.send(conn, {
      kind: "move_payload",
      guid: msg.guid,
      conversation: pending.conversation,
    });
  }

  private async handleMovePayload(
    conn: ConnectionState,
    msg: MeshMessage & { kind: "move_payload" },
  ): Promise<void> {
    const incoming = msg.conversation as Conversation | undefined;
    if (!incoming || typeof incoming !== "object" || incoming.id !== msg.guid) {
      // Malformed payload — decline rather than write garbage.
      this.send(conn, {
        kind: "move_decline",
        guid: msg.guid,
        reason: "malformed payload",
      });
      return;
    }
    try {
      await saveConversation(incoming);
      this.send(conn, { kind: "move_complete", guid: msg.guid });
    } catch (e) {
      this.send(conn, {
        kind: "move_decline",
        guid: msg.guid,
        reason: `write failed: ${String(e)}`,
      });
    }
  }

  private async handleMoveComplete(
    conn: ConnectionState,
    msg: MeshMessage & { kind: "move_complete" },
  ): Promise<void> {
    const pending = this.pending_moves_out.get(msg.guid);
    if (!pending || pending.target_tag !== conn.device_pubkey_tag) return;
    try {
      await deleteConversation(msg.guid);
    } catch (e) {
      // The receiver successfully wrote and we couldn't delete our
      // local — the user now has the conversation on both devices.
      // Inconvenient but not destructive. Surface to the caller.
      this.resolveMoveOut(msg.guid, false, `local delete failed: ${String(e)}`);
      return;
    }
    this.resolveMoveOut(msg.guid, true);
  }

  private resolveMoveOut(guid: string, ok: boolean, err?: string): void {
    const pending = this.pending_moves_out.get(guid);
    if (!pending) return;
    this.pending_moves_out.delete(guid);
    pending.on_complete?.(ok, err);
  }

  private async handleHello(
    conn: ConnectionState,
    msg: MeshMessage & { kind: "hello" },
  ): Promise<void> {
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.sendDeny(conn, "protocol mismatch");
      this.dropConnection(conn.device_pubkey_tag);
      return;
    }
    // The peer's Peer ID embeds only an 8-char prefix (tag) of their
    // pubkey — `hello` carries the full pubkey, and we verify it
    // matches the tag we know from the broker. Without this, a peer
    // could register under one tag and claim a totally different
    // identity in `hello`, then sign with whichever key matches the
    // claim. Anchoring the claim to the registered tag closes that
    // gap.
    if (pubkeyTag(msg.device_id) !== conn.device_pubkey_tag) {
      this.sendDeny(conn, "device_id / peerjs_id tag mismatch");
      this.dropConnection(conn.device_pubkey_tag);
      return;
    }
    conn.device_pubkey = msg.device_id;
    conn.their_nonce = msg.nonce;
    conn.label = msg.label || "";
    // Stash the peer's verification code so the receiver UI can
    // surface it for confirmation. Length-clamp defensively — the
    // sender controls this field and we don't want a runaway string
    // breaking the layout.
    conn.their_verification_code = (msg.verification_code || "").slice(0, 16);
    // Compute the peer's display suffix locally from their pubkey —
    // never trust a suffix the peer sends, but they don't send one
    // either: the suffix is purely derived. Mirrors the algorithm
    // Rust uses for our own device.
    try {
      conn.device_suffix = await pubkeySuffix(msg.device_id);
    } catch {
      conn.device_suffix = "";
    }
    this.republishPeers();

    // Sign the payload they expect to verify against us.
    const my_pubkey = pubkeyPart(this.identity!.device_id);
    const payload = authPayload({
      nonce: msg.nonce,
      my_device_id: my_pubkey,
      their_device_id: conn.device_pubkey,
    });
    try {
      const signature = await signMessage(payload);
      this.send(conn, { kind: "auth_response", signature });
    } catch (e) {
      this.logDiag("error", `signing failed: ${String(e)}`);
      this.dropConnection(conn.device_pubkey_tag);
    }
  }

  private async handleAuthResponse(
    conn: ConnectionState,
    msg: MeshMessage & { kind: "auth_response" },
  ): Promise<void> {
    if (!conn.our_nonce) return;
    if (!conn.device_pubkey) {
      // Peer sent auth_response before hello — protocol error.
      this.sendDeny(conn, "auth_response before hello");
      this.dropConnection(conn.device_pubkey_tag);
      return;
    }
    const payload = authPayload({
      nonce: conn.our_nonce,
      my_device_id: conn.device_pubkey,
      their_device_id: pubkeyPart(this.identity!.device_id),
    });
    let ok: boolean;
    try {
      ok = await verifySignature(conn.device_pubkey, payload, msg.signature);
    } catch (e) {
      this.logDiag("error", `verify failed: ${String(e)}`);
      ok = false;
    }
    if (!ok) {
      this.sendDeny(conn, "signature invalid");
      this.dropConnection(conn.device_pubkey_tag);
      return;
    }
    conn.peer_authenticated = true;

    // Authentication clear. Decide local-approval policy.
    const authorized = this.roster_pubkeys.has(conn.device_pubkey);
    if (authorized) {
      conn.local_approved = true;
      this.sendApprove(conn);
    } else {
      // The initiator's identity is the user that just locked a
      // Network ID — they've already consented to joining. Treat the
      // initiator side as auto-approving so the user only sees one
      // approval prompt (on the receiver). Roster gets populated on
      // both sides as soon as the approve flows complete.
      if (conn.initiated_by_us) {
        conn.local_approved = true;
        try {
          await invoke("mesh_roster_add", {
            networkId: this.network_id,
            deviceId: conn.device_pubkey,
            label: conn.label,
          });
          this.roster_pubkeys.add(conn.device_pubkey);
        } catch {}
        this.sendApprove(conn);
      } else {
        // Receiver side: surface for user approval. Settings tab
        // dot lights up so the user knows there's something
        // waiting even if they're elsewhere in the app.
        settingsAttention.set("cloud-mesh", {
          reason: `${shortLabel(conn.label, conn.device_pubkey)} wants to connect`,
        });
      }
    }
    this.maybePromoteToActive(conn);
    this.republishPeers();
  }

  private maybePromoteToActive(conn: ConnectionState): void {
    if (
      conn.peer_authenticated &&
      conn.local_approved &&
      conn.remote_approved &&
      conn.handshake_timer !== null
    ) {
      clearTimeout(conn.handshake_timer);
      conn.handshake_timer = null;
    }
    // If we just transitioned to active and there are no more
    // pending requests, clear the attention dot. Otherwise leave it.
    if (this.computePeers().every((p) => p.status !== "pending_approval")) {
      settingsAttention.set("cloud-mesh", null);
    }
  }

  private dropConnection(device_pubkey_tag: string): void {
    const c = this.connections.get(device_pubkey_tag);
    if (!c) return;
    if (c.handshake_timer !== null) clearTimeout(c.handshake_timer);
    try { c.dc.close(); } catch {}
    this.connections.delete(device_pubkey_tag);
    // Reject any in-flight outgoing moves to this peer so the
    // caller's promise settles rather than hanging forever.
    for (const [guid, pending] of this.pending_moves_out) {
      if (pending.target_tag === device_pubkey_tag) {
        this.pending_moves_out.delete(guid);
        pending.on_complete?.(false, "peer disconnected mid-move");
      }
    }
    this.republishPeers();
    if (this.computePeers().every((p) => p.status !== "pending_approval")) {
      settingsAttention.set("cloud-mesh", null);
    }
  }

  // ---- derived views --------------------------------------------------

  private peerStatus(conn: ConnectionState): PeerStatus {
    if (!conn.peer_authenticated) {
      if (conn.their_nonce === null) return "connecting";
      return "handshaking";
    }
    if (conn.local_approved && conn.remote_approved) return "active";
    if (!conn.local_approved) return "pending_approval";
    return "pending_remote_approval";
  }

  private computePeers(): PeerEntry[] {
    return Array.from(this.connections.values()).map((c) => ({
      device_pubkey: c.device_pubkey || c.device_pubkey_tag,
      device_pubkey_tag: c.device_pubkey_tag,
      device_suffix: c.device_suffix,
      device_id_display: c.device_suffix
        ? `${c.device_pubkey}-${c.device_suffix}`
        : c.device_pubkey || c.device_pubkey_tag,
      label: c.label,
      status: this.peerStatus(c),
      authorized: c.device_pubkey ? this.roster_pubkeys.has(c.device_pubkey) : false,
      initiated_by_us: c.initiated_by_us,
      connected_at: 0,
      verification_code: c.initiated_by_us
        ? c.our_verification_code
        : c.their_verification_code,
    }));
  }

  private republishPeers(): void {
    this.peers = this.computePeers();
  }

  private async refreshRoster(): Promise<void> {
    try {
      const r = await invoke<{
        network_id: string;
        authorized_devices: Array<{ device_id: string; label: string; approved_at: number }>;
      }>("mesh_roster_get", { networkId: this.network_id });
      this.roster_pubkeys = new Set(r.authorized_devices.map((d) => d.device_id));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[mesh] roster load failed", e);
      this.roster_pubkeys = new Set();
    }
  }
}

function parseSignalingUrl(url: string): {
  host: string;
  port: number;
  path: string;
  secure: boolean;
} {
  const u = new URL(url);
  const secure = u.protocol === "wss:" || u.protocol === "https:";
  const port = u.port ? parseInt(u.port, 10) : secure ? 443 : 80;
  const path = u.pathname || "/";
  return { host: u.hostname, port, path, secure };
}

function buildIceServers(
  stun: string[],
  turn: TurnServer[],
): Array<RTCIceServer> {
  return [
    ...stun.filter((s) => s.trim() !== "").map((urls) => ({ urls })),
    ...turn
      .filter((t) => t.url.trim() !== "")
      .map((t) => ({
        urls: t.url,
        username: t.username,
        credential: t.credential,
      })),
  ];
}

function shortLabel(label: string, pubkey: string): string {
  if (label.trim() !== "") return label;
  return pubkey.slice(0, 8);
}

export const meshClient = new MeshClient();
