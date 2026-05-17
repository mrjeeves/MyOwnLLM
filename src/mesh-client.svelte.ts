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
  authPayload,
  generateNonce,
  parsePeerJsId,
  peerJsId,
  pubkeyPart,
  signMessage,
  verifySignature,
  PROTOCOL_VERSION,
  type MeshMessage,
} from "./mesh-protocol";

const DISCOVERY_INTERVAL_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;

export type PeerStatus =
  | "connecting" // DC opening, no hello exchanged yet
  | "handshaking" // hello sent / received; awaiting auth_response or verifying
  | "pending_approval" // receiver: waiting on the local user to approve
  | "pending_remote_approval" // initiator: waiting on the remote user to approve
  | "active" // both sides cleared; channel usable
  | "denied" // user denied; close imminent
  | "failed"; // protocol error; close imminent

export interface PeerEntry {
  device_pubkey: string;
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
}

interface ConnectionState {
  dc: DataConnection;
  device_pubkey: string;
  label: string;
  initiated_by_us: boolean;
  our_nonce: string;
  /** Their nonce — populated after we receive their `hello`. */
  their_nonce: string | null;
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

  // ---- internal --------------------------------------------------------

  private peer_js: Peer | null = null;
  private identity: MeshIdentity | null = null;
  private network_id = "";
  private connections = new Map<string, ConnectionState>();
  private roster_pubkeys = new Set<string>();
  private discovery_timer: number | null = null;
  private stopping = false;

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

    // Hydrate the roster so auto-allow works on the very first
    // incoming connection of this session.
    await this.refreshRoster();

    const pubkey = pubkeyPart(opts.identity.device_id);
    const id = peerJsId(opts.networkId, pubkey);
    this.my_peer_id = id;

    const parsed = parseSignalingUrl(opts.signalingUrl);
    const ice_servers = buildIceServers(opts.stunServers, opts.turnServers);

    try {
      this.peer_js = new Peer(id, {
        host: parsed.host,
        port: parsed.port,
        path: parsed.path,
        secure: parsed.secure,
        config: { iceServers: ice_servers },
        // Quieter logs in production; bump for debugging.
        debug: 1,
      });
    } catch (e) {
      this.status = "error";
      this.error = `peerjs init: ${String(e)}`;
      return;
    }

    this.peer_js.on("open", () => {
      this.status = "online";
      this.kickDiscovery();
    });
    this.peer_js.on("error", (err) => {
      // PeerJS surfaces both fatal and recoverable errors here. We
      // log them all but only flip status on fatal categories.
      // "peer-unavailable" happens routinely when listAllPeers
      // races a peer leaving, for example.
      const type = (err as { type?: string }).type ?? "unknown";
      if (type === "network" || type === "server-error" || type === "socket-error") {
        this.status = "error";
        this.error = `${type}: ${String((err as Error).message ?? err)}`;
      }
      // eslint-disable-next-line no-console
      console.warn("[mesh] peerjs error", type, err);
    });
    this.peer_js.on("disconnected", () => {
      // Broker connection dropped; PeerJS auto-reconnects by default.
      // Surface this so the UI can show a transient state without us
      // tearing down the whole client.
      if (!this.stopping) this.status = "starting";
    });
    this.peer_js.on("connection", (dc) => {
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
      if (this.peer_js) await this.stop();
      return;
    }

    const signaling = cfg.cloud_mesh.signaling_servers[0];
    if (!signaling || signaling.trim() === "") return;

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

    if (this.peer_js) await this.stop();
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
   *  message so the other side flips to ACTIVE. */
  async approveRequest(device_pubkey: string): Promise<void> {
    const c = this.connections.get(device_pubkey);
    if (!c) return;
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
      // eslint-disable-next-line no-console
      console.warn("[mesh] roster add failed", e);
    }
    this.sendApprove(c);
    this.maybePromoteToActive(c);
    this.republishPeers();
  }

  /** Deny a pending peer. Closes the data channel and removes them
   *  from the peers list. Does not blacklist — they can try again,
   *  and they may succeed if circumstances change (e.g. roster
   *  populated by a different peer). */
  async denyRequest(device_pubkey: string): Promise<void> {
    const c = this.connections.get(device_pubkey);
    if (!c) return;
    this.sendDeny(c, "user denied");
    this.dropConnection(device_pubkey);
  }

  /** Remove an already-active peer from the roster and close the
   *  current connection. The peer can reconnect, but will require
   *  fresh approval. */
  async removePeer(device_pubkey: string): Promise<void> {
    const c = this.connections.get(device_pubkey);
    try {
      await invoke("mesh_roster_remove", {
        networkId: this.network_id,
        deviceId: device_pubkey,
      });
      this.roster_pubkeys.delete(device_pubkey);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[mesh] roster remove failed", e);
    }
    if (c) this.dropConnection(device_pubkey);
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
      // eslint-disable-next-line no-console
      console.warn("[mesh] discovery unavailable", e);
      if (this.discovery_timer !== null) {
        clearInterval(this.discovery_timer);
        this.discovery_timer = null;
      }
      return;
    }
    for (const id of all) {
      const parsed = parsePeerJsId(id);
      if (!parsed) continue;
      if (parsed.network_id !== this.network_id) continue;
      if (parsed.device_pubkey === my_pubkey) continue;
      if (this.connections.has(parsed.device_pubkey)) continue;
      // Tie-break who initiates so we don't double-connect: the
      // lexically-lesser pubkey is the initiator. Without this both
      // sides would try simultaneously and we'd get two redundant
      // channels.
      if (my_pubkey > parsed.device_pubkey) continue;
      this.initiateConnection(id, parsed.device_pubkey);
    }
  }

  private initiateConnection(peer_id: string, device_pubkey: string): void {
    if (!this.peer_js) return;
    const dc = this.peer_js.connect(peer_id, { reliable: true });
    const conn = this.createConnState(dc, device_pubkey, /* initiator */ true);
    this.connections.set(device_pubkey, conn);
    this.wireDataChannel(conn);
    this.republishPeers();
  }

  private handleInboundConnection(dc: DataConnection): void {
    const parsed = parsePeerJsId(dc.peer);
    if (!parsed || parsed.network_id !== this.network_id) {
      // Foreign peer (different network or non-MyOwnLLM client).
      try { dc.close(); } catch {}
      return;
    }
    // If a connection in either direction is already in flight,
    // prefer the one we initiated and drop this inbound one.
    if (this.connections.has(parsed.device_pubkey)) {
      try { dc.close(); } catch {}
      return;
    }
    const conn = this.createConnState(dc, parsed.device_pubkey, /* initiator */ false);
    this.connections.set(parsed.device_pubkey, conn);
    this.wireDataChannel(conn);
    this.republishPeers();
  }

  private createConnState(
    dc: DataConnection,
    device_pubkey: string,
    initiator: boolean,
  ): ConnectionState {
    return {
      dc,
      device_pubkey,
      label: "",
      initiated_by_us: initiator,
      our_nonce: generateNonce(),
      their_nonce: null,
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
        this.dropConnection(conn.device_pubkey);
      }, HANDSHAKE_TIMEOUT_MS);
    });
    conn.dc.on("data", (raw) => {
      this.handleMessage(conn, raw);
    });
    conn.dc.on("close", () => {
      this.dropConnection(conn.device_pubkey);
    });
    conn.dc.on("error", () => {
      this.dropConnection(conn.device_pubkey);
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
    }
  }

  private async handleHello(
    conn: ConnectionState,
    msg: MeshMessage & { kind: "hello" },
  ): Promise<void> {
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.sendDeny(conn, "protocol mismatch");
      this.dropConnection(conn.device_pubkey);
      return;
    }
    // Bind the peer to the pubkey embedded in their PeerJS ID, not
    // the one they claim in `hello`. Anything else lets a peer
    // impersonate by lying about device_id, since the auth signature
    // is over the claimed value.
    if (msg.device_id !== conn.device_pubkey) {
      this.sendDeny(conn, "device_id / peerjs_id mismatch");
      this.dropConnection(conn.device_pubkey);
      return;
    }
    conn.their_nonce = msg.nonce;
    conn.label = msg.label || "";
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
      // eslint-disable-next-line no-console
      console.warn("[mesh] signing failed", e);
      this.dropConnection(conn.device_pubkey);
    }
  }

  private async handleAuthResponse(
    conn: ConnectionState,
    msg: MeshMessage & { kind: "auth_response" },
  ): Promise<void> {
    if (!conn.our_nonce) return;
    const payload = authPayload({
      nonce: conn.our_nonce,
      my_device_id: conn.device_pubkey,
      their_device_id: pubkeyPart(this.identity!.device_id),
    });
    let ok: boolean;
    try {
      ok = await verifySignature(conn.device_pubkey, payload, msg.signature);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[mesh] verify failed", e);
      ok = false;
    }
    if (!ok) {
      this.sendDeny(conn, "signature invalid");
      this.dropConnection(conn.device_pubkey);
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

  private dropConnection(device_pubkey: string): void {
    const c = this.connections.get(device_pubkey);
    if (!c) return;
    if (c.handshake_timer !== null) clearTimeout(c.handshake_timer);
    try { c.dc.close(); } catch {}
    this.connections.delete(device_pubkey);
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
      device_pubkey: c.device_pubkey,
      device_id_display: c.device_pubkey, // suffix is appended by the UI layer
      label: c.label,
      status: this.peerStatus(c),
      authorized: this.roster_pubkeys.has(c.device_pubkey),
      initiated_by_us: c.initiated_by_us,
      connected_at: 0, // set on first transition to handshaking; v1 is fine without
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
