/**
 * Cloud Mesh runtime client (Trystero transport).
 *
 * Trystero handles peer discovery and WebRTC connection setup via
 * existing decentralized infrastructure (BitTorrent trackers, Nostr
 * relays, etc., with auto-fallback). No MyOwnLLM-operated signaling
 * server, no broker key to register, no single point of failure.
 *
 * Identity, the auth handshake, the roster, Move, and the
 * Connections / Network Requests UI are unchanged from the previous
 * peerjs-backed client — the protocol rides on top of Trystero's
 * `makeAction` data channel and is transport-agnostic by design.
 *
 * Lifecycle:
 *   - `start()` joins a Trystero room keyed by the network handle.
 *     Trystero takes care of discovery + WebRTC; we get
 *     `onPeerJoin` / `onPeerLeave` callbacks and a typed action
 *     channel for our protocol messages.
 *   - On every `onPeerJoin`, both sides start the bidirectional
 *     auth handshake. The lex-lesser pubkey side acts as the
 *     "approver" (auto-allows if peer is in roster, prompts the
 *     user otherwise); the other side waits for the approver's
 *     `approve` message and flips to ACTIVE on receipt. This
 *     preserves the asymmetric one-prompt UX the prior code had
 *     without needing an initiator/receiver distinction in the
 *     transport layer.
 *   - `stop()` leaves the room and tears down all connections.
 */

import { joinRoom, type Room } from "trystero";
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
  pubkeyPart,
  pubkeySuffix,
  signMessage,
  verifySignature,
  PROTOCOL_VERSION,
  type MeshMessage,
} from "./mesh-protocol";

/** Watchdog for the cryptographic handshake only. If a peer doesn't
 *  send a valid `auth_response` within this window we assume the
 *  channel is broken and drop. Once `peer_authenticated` flips true
 *  we clear the timer — the subsequent waits (for the local user to
 *  click Approve, or for the remote side's `approve`) have no
 *  timeout, because verifying a code with a peer out-of-band can
 *  easily take more than 30s. */
const HANDSHAKE_TIMEOUT_MS = 30_000;
const DIAG_MAX = 80;
/** Globally-unique app identifier passed to Trystero so MyOwnLLM
 *  peers don't accidentally match peers from unrelated apps that
 *  happen to use the same `roomId`. Bump the suffix if we ever
 *  ship a wire-incompatible protocol change. */
const TRYSTERO_APP_ID = "myownllm-cloud-mesh-v1";

export type DiagLevel = "info" | "warn" | "error";
export interface DiagEntry {
  ts: number;
  level: DiagLevel;
  msg: string;
}

export type PeerStatus =
  | "handshaking" // hello sent / received; awaiting auth_response or verifying
  | "pending_approval" // local user needs to act (approve or confirm, see approver_role)
  | "pending_remote" // we've acted, OR we're waiting for the host's first move
  | "active" // both sides have approved and exchanged approve messages
  | "denied" // user denied; close imminent
  | "failed"; // protocol error; close imminent

export interface PeerEntry {
  /** Trystero-assigned peer id — unique per session, used as the
   *  callback handle for action methods (approve/deny/remove). */
  peer_id: string;
  /** Full pubkey once handshake has completed; empty string during
   *  early handshake. */
  device_pubkey: string;
  /** 5-char uppercase-hex display suffix derived from the peer's
   *  pubkey, matching what they show in their own Identity tab. */
  device_suffix: string;
  device_id_display: string;
  label: string;
  status: PeerStatus;
  /** True when this peer is in our local roster (we'd auto-allow on
   *  reconnect). */
  authorized: boolean;
  /** True when our side is the "host" (lex-lesser pubkey) — we
   *  prompt first ("X wants to connect"). False = "guest" (we
   *  prompt second, "X authorized you. Confirm?"). */
  approver_role: boolean;
  /** True after we've sent our own `approve`. UI uses this to
   *  pick "awaiting peer approval" (false) vs "awaiting peer
   *  confirmation" (true) labels. */
  local_approved: boolean;
  /** True after we've received `approve` from the peer. */
  remote_approved: boolean;
  /** Six-char verification code the user reads to confirm the
   *  request is the one they expect. */
  verification_code: string;
}

interface ConnectionState {
  peer_id: string;
  device_pubkey: string;
  device_suffix: string;
  label: string;
  our_nonce: string;
  their_nonce: string | null;
  our_verification_code: string;
  their_verification_code: string;
  peer_authenticated: boolean;
  /** Set after we've received `approve` from the peer. */
  remote_approved: boolean;
  /** Set when we've decided to allow this peer (auto-allowed or
   *  user clicked Approve). */
  local_approved: boolean;
  /** True when WE are the lex-lesser side — we're the one who
   *  prompts the user / auto-approves and sends `approve`. */
  approver_role: boolean;
  handshake_timer: number | null;
}

class MeshClient {
  // ---- reactive state ---------------------------------------------------

  status = $state<"off" | "starting" | "online" | "error">("off");
  error = $state("");
  /** Mostly informational — Trystero peer ids are short hex strings,
   *  surfaced for the Activity panel. */
  my_peer_id = $state("");
  peers = $state<PeerEntry[]>([]);
  diag = $state<DiagEntry[]>([]);

  private logDiag(level: DiagLevel, msg: string): void {
    const entry: DiagEntry = { ts: Date.now(), level, msg };
    this.diag = [...this.diag, entry].slice(-DIAG_MAX);
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
    fn(`[mesh] ${msg}`);
  }

  // ---- internal --------------------------------------------------------

  private room: Room | null = null;
  private sendMesh: ((data: unknown, target?: string | string[] | null) => Promise<unknown>) | null = null;
  private identity: MeshIdentity | null = null;
  private network_id = "";
  private network_handle = "";
  private connections = new Map<string, ConnectionState>();
  private roster_pubkeys = new Set<string>();
  private stopping = false;
  private pending_moves_out = new Map<
    string,
    { target_peer_id: string; conversation: Conversation; on_complete?: (ok: boolean, err?: string) => void }
  >();

  // ---- lifecycle -------------------------------------------------------

  async reconcile(): Promise<void> {
    let cfg;
    let identity: MeshIdentity;
    try {
      cfg = await loadConfig();
      identity = await invoke<MeshIdentity>("mesh_identity_get");
    } catch (e) {
      this.logDiag("warn", `reconcile preflight failed: ${String(e)}`);
      return;
    }

    const should_run = cfg.cloud_mesh.locked && cfg.cloud_mesh.network_id !== "";
    if (!should_run) {
      if (this.room) {
        this.logDiag("info", "reconcile: should_run=false → stopping");
        await this.stop();
      }
      return;
    }

    // Already running on the right network with the right identity?
    // No-op.
    if (
      this.room &&
      this.network_id === cfg.cloud_mesh.network_id &&
      this.identity?.device_id === identity.device_id
    ) {
      return;
    }

    if (this.room) {
      this.logDiag("info", "reconcile: config changed → restarting");
      await this.stop();
    }
    this.logDiag("info", `reconcile: joining mesh for "${cfg.cloud_mesh.network_id}"`);
    await this.start({
      identity,
      networkId: cfg.cloud_mesh.network_id,
      relayUrls: cfg.cloud_mesh.signaling_servers,
      stunServers: cfg.cloud_mesh.stun_servers,
      turnServers: cfg.cloud_mesh.turn_servers,
    });
  }

  async start(opts: {
    identity: MeshIdentity;
    networkId: string;
    relayUrls: string[];
    stunServers: string[];
    turnServers: TurnServer[];
  }): Promise<void> {
    if (this.room) return;

    this.stopping = false;
    this.status = "starting";
    this.error = "";
    this.identity = opts.identity;
    this.network_id = opts.networkId;
    this.peers = [];
    this.connections.clear();

    try {
      this.network_handle = await deriveNetworkHandle(opts.networkId);
    } catch (e) {
      this.status = "error";
      this.error = `network-handle derivation: ${String(e)}`;
      this.logDiag("error", `handle derivation failed: ${String(e)}`);
      return;
    }

    await this.refreshRoster();

    const ice_servers = buildIceServers(opts.stunServers, opts.turnServers);
    const room_id = this.network_handle;
    const custom_relays = opts.relayUrls.filter((r) => r.trim() !== "");

    this.logDiag(
      "info",
      `joining mesh room ${room_id.slice(0, 12)}… (trystero, app=${TRYSTERO_APP_ID}` +
        (custom_relays.length > 0
          ? `, ${custom_relays.length} custom relay${custom_relays.length === 1 ? "" : "s"})`
          : `, default relays)`),
    );

    try {
      const room_config: Parameters<typeof joinRoom>[0] = {
        appId: TRYSTERO_APP_ID,
        rtcConfig: { iceServers: ice_servers },
      };
      if (custom_relays.length > 0) {
        // Trystero accepts a `relayUrls` override for the current
        // strategy. When set, only these relays are used; when not,
        // the strategy's built-in defaults apply.
        (room_config as Record<string, unknown>).relayUrls = custom_relays;
      }
      this.room = joinRoom(room_config, room_id);
    } catch (e) {
      this.status = "error";
      this.error = `trystero init: ${String(e)}`;
      this.logDiag("error", `trystero init failed: ${String(e)}`);
      return;
    }

    // Trystero exposes a single typed `action` channel per name.
    // We carry our entire MeshMessage envelope through one action;
    // discriminating on `kind` keeps the existing handlers as-is.
    const [send, recv] = this.room.makeAction("mesh");
    this.sendMesh = send as typeof this.sendMesh extends infer T
      ? T extends null
        ? never
        : T
      : never;

    recv((data, peerId) => {
      // Trystero's typed payload covers binary too; we only send
      // JSON objects via `send`, so the cast through `unknown` is
      // safe and matches what arrives at runtime.
      void this.handleMessage(peerId, data as unknown as MeshMessage);
    });

    this.room.onPeerJoin((peerId) => {
      this.handlePeerJoin(peerId);
    });

    this.room.onPeerLeave((peerId) => {
      this.handlePeerLeave(peerId);
    });

    // Trystero joins the room synchronously — discovery happens in
    // the background and `onPeerJoin` fires as peers turn up. No
    // open/connect handshake to wait for like with peerjs.
    this.status = "online";
    this.my_peer_id = `trystero/${room_id.slice(0, 8)}`;
    this.logDiag("info", `online — listening for peers in room ${room_id.slice(0, 12)}…`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const c of this.connections.values()) {
      if (c.handshake_timer !== null) clearTimeout(c.handshake_timer);
    }
    this.connections.clear();
    if (this.room) {
      try {
        this.room.leave();
      } catch {}
      this.room = null;
    }
    this.sendMesh = null;
    this.peers = [];
    this.my_peer_id = "";
    this.status = "off";
    this.error = "";
    settingsAttention.set("cloud-mesh", null);
    this.logDiag("info", "stopped");
  }

  // ---- action callbacks (UI) -------------------------------------------

  /** User clicked Approve (host first prompt) or Confirm (guest
   *  second prompt). Both flows route here — what the button reads
   *  is purely a UI decision based on `approver_role`. */
  async approveRequest(peer_id: string): Promise<void> {
    const c = this.connections.get(peer_id);
    if (!c || !c.device_pubkey) return;
    await this.acceptPeer(c);
    this.republishPeers();
  }

  /** Common path for "this side has approved this peer." Sets
   *  local_approved, adds the peer to the roster (so the next
   *  reconnect is silent on our side), and sends the `approve`
   *  message so the other side can flip to active. */
  private async acceptPeer(conn: ConnectionState): Promise<void> {
    conn.local_approved = true;
    try {
      await invoke("mesh_roster_add", {
        networkId: this.network_id,
        deviceId: conn.device_pubkey,
        label: conn.label,
      });
      this.roster_pubkeys.add(conn.device_pubkey);
    } catch (e) {
      this.logDiag("warn", `roster add failed: ${String(e)}`);
    }
    this.sendApprove(conn);
    this.maybePromoteToActive(conn);
  }

  async denyRequest(peer_id: string): Promise<void> {
    const c = this.connections.get(peer_id);
    if (!c) return;
    this.sendDeny(c, "user denied");
    this.dropConnection(peer_id);
  }

  async removePeer(peer_id: string): Promise<void> {
    const c = this.connections.get(peer_id);
    if (c?.device_pubkey) {
      try {
        await invoke("mesh_roster_remove", {
          networkId: this.network_id,
          deviceId: c.device_pubkey,
        });
        this.roster_pubkeys.delete(c.device_pubkey);
      } catch (e) {
        this.logDiag("warn", `roster remove failed: ${String(e)}`);
      }
    }
    if (c) this.dropConnection(peer_id);
    else this.republishPeers();
  }

  async moveConversation(guid: string, target_peer_id: string): Promise<void> {
    const conn = this.connections.get(target_peer_id);
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
        target_peer_id,
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

  // ---- peer lifecycle --------------------------------------------------

  private handlePeerJoin(peer_id: string): void {
    if (this.connections.has(peer_id)) return;
    this.logDiag("info", `peer joined: ${peer_id.slice(0, 8)}…`);
    const conn = this.createConnState(peer_id);
    this.connections.set(peer_id, conn);
    this.sendHello(conn);
    conn.handshake_timer = window.setTimeout(() => {
      // Only fire if we never made it past the cryptographic
      // handshake. Once `peer_authenticated` is set the watchdog
      // is cleared explicitly in handleAuthResponse, so this
      // callback firing means the peer genuinely never replied.
      if (conn.peer_authenticated) return;
      this.logDiag(
        "warn",
        `handshake timeout for ${peer_id.slice(0, 8)}… — peer never sent auth_response`,
      );
      this.dropConnection(peer_id);
    }, HANDSHAKE_TIMEOUT_MS);
    this.republishPeers();
  }

  private handlePeerLeave(peer_id: string): void {
    this.logDiag("info", `peer left: ${peer_id.slice(0, 8)}…`);
    this.dropConnection(peer_id);
  }

  private createConnState(peer_id: string): ConnectionState {
    return {
      peer_id,
      device_pubkey: "",
      device_suffix: "",
      label: "",
      our_nonce: generateNonce(),
      their_nonce: null,
      our_verification_code: generateVerificationCode(),
      their_verification_code: "",
      peer_authenticated: false,
      remote_approved: false,
      local_approved: false,
      approver_role: false, // set in handleHello once we know both pubkeys
      handshake_timer: null,
    };
  }

  // ---- protocol --------------------------------------------------------

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
    if (!this.sendMesh) return;
    try {
      void this.sendMesh(msg, conn.peer_id);
    } catch (e) {
      this.logDiag("warn", `send failed: ${String(e)}`);
    }
  }

  private async handleMessage(peer_id: string, msg: MeshMessage): Promise<void> {
    const conn = this.connections.get(peer_id);
    if (!conn) {
      // Message from a peer we don't have state for — possible if
      // trystero delivers a message before onPeerJoin fires, or
      // after we've dropped the connection. Spin up state on
      // demand for the former case.
      if (msg.kind === "hello") {
        this.handlePeerJoin(peer_id);
        const fresh = this.connections.get(peer_id);
        if (fresh) await this.handleMessageOn(fresh, msg);
      }
      return;
    }
    await this.handleMessageOn(conn, msg);
  }

  private async handleMessageOn(conn: ConnectionState, msg: MeshMessage): Promise<void> {
    switch (msg.kind) {
      case "hello":
        await this.handleHello(conn, msg);
        break;
      case "auth_response":
        await this.handleAuthResponse(conn, msg);
        break;
      case "approve":
        await this.handleApproveMessage(conn);
        break;
      case "deny":
        this.logDiag("warn", `peer denied: ${msg.reason ?? "(no reason)"}`);
        this.dropConnection(conn.peer_id);
        break;
      case "ping":
        this.send(conn, { kind: "pong", t: msg.t });
        break;
      case "pong":
        break;
      case "catalog_announce":
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

  private async handleHello(
    conn: ConnectionState,
    msg: MeshMessage & { kind: "hello" },
  ): Promise<void> {
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.sendDeny(conn, "protocol mismatch");
      this.dropConnection(conn.peer_id);
      return;
    }
    conn.device_pubkey = msg.device_id;
    conn.their_nonce = msg.nonce;
    conn.label = msg.label || "";
    conn.their_verification_code = (msg.verification_code || "").slice(0, 16);
    try {
      conn.device_suffix = await pubkeySuffix(msg.device_id);
    } catch {
      conn.device_suffix = "";
    }
    // Decide approver role: the lex-lesser pubkey side prompts /
    // auto-allows. Symmetric tie-break means both sides agree on
    // who's in charge without needing extra coordination.
    const my_pubkey = pubkeyPart(this.identity!.device_id);
    conn.approver_role = my_pubkey < msg.device_id;
    this.republishPeers();

    // Sign the payload they expect to verify against us.
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
      this.dropConnection(conn.peer_id);
    }
  }

  private async handleAuthResponse(
    conn: ConnectionState,
    msg: MeshMessage & { kind: "auth_response" },
  ): Promise<void> {
    if (!conn.our_nonce || !conn.device_pubkey) {
      this.sendDeny(conn, "auth_response before hello");
      this.dropConnection(conn.peer_id);
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
      this.dropConnection(conn.peer_id);
      return;
    }
    conn.peer_authenticated = true;
    // Cryptographic handshake is complete — kill the watchdog. The
    // peer is now genuinely waiting on user approval (locally or
    // remotely) and that can take as long as it takes.
    if (conn.handshake_timer !== null) {
      clearTimeout(conn.handshake_timer);
      conn.handshake_timer = null;
    }
    this.logDiag(
      "info",
      `auth ok with ${conn.device_pubkey.slice(0, 8)}… (approver=${conn.approver_role})`,
    );

    if (conn.approver_role) {
      // Host side: prompt the local user first (or auto-allow
      // from roster, in which case `acceptPeer` sends our
      // `approve` immediately).
      const authorized = this.roster_pubkeys.has(conn.device_pubkey);
      if (authorized) {
        await this.acceptPeer(conn);
      } else {
        settingsAttention.set("cloud-mesh", {
          reason: `${shortLabel(conn.label, conn.device_pubkey)} wants to connect`,
        });
      }
    }
    // Guest side: just wait. The host either auto-allows us (in
    // which case their `approve` will arrive almost immediately
    // and the guest path in `handleApprove` runs) or prompts
    // their user. Until then we sit in `pending_remote` with
    // "awaiting peer approval" in the UI.
    this.republishPeers();
  }

  private async handleApproveMessage(conn: ConnectionState): Promise<void> {
    conn.remote_approved = true;
    if (conn.approver_role) {
      // Host side: receiving guest's `approve` is the final step.
      // We sent our own already; both sides now have both flags
      // set and the connection flips to ACTIVE.
      this.maybePromoteToActive(conn);
    } else {
      // Guest side: this is the host's authorization arriving.
      // Either auto-confirm (peer already in our roster from a
      // previous session) or surface a confirm prompt to the
      // user — same UI surface as the host's first prompt, but
      // the label reads "X authorized you. Confirm?".
      if (!conn.local_approved) {
        const authorized = this.roster_pubkeys.has(conn.device_pubkey);
        if (authorized) {
          await this.acceptPeer(conn);
        } else {
          settingsAttention.set("cloud-mesh", {
            reason: `${shortLabel(conn.label, conn.device_pubkey)} authorized you`,
          });
        }
      } else {
        this.maybePromoteToActive(conn);
      }
    }
    this.republishPeers();
  }

  // ---- move ------------------------------------------------------------

  private async handleMoveOffer(
    conn: ConnectionState,
    msg: MeshMessage & { kind: "move_offer" },
  ): Promise<void> {
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
    if (!pending || pending.target_peer_id !== conn.peer_id) return;
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
      this.send(conn, { kind: "move_decline", guid: msg.guid, reason: "malformed payload" });
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
    if (!pending || pending.target_peer_id !== conn.peer_id) return;
    try {
      await deleteConversation(msg.guid);
    } catch (e) {
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

  // ---- helpers ---------------------------------------------------------

  private maybePromoteToActive(conn: ConnectionState): void {
    if (
      conn.peer_authenticated &&
      conn.local_approved &&
      conn.remote_approved
    ) {
      // Defensive: watchdog should already be cleared at this
      // point (cleared on `peer_authenticated`). Re-clear just
      // in case some future code path leaves it dangling.
      if (conn.handshake_timer !== null) {
        clearTimeout(conn.handshake_timer);
        conn.handshake_timer = null;
      }
      this.logDiag("info", `peer active: ${conn.device_pubkey.slice(0, 8)}…`);
    }
    if (this.computePeers().every((p) => p.status !== "pending_approval")) {
      settingsAttention.set("cloud-mesh", null);
    }
  }

  private dropConnection(peer_id: string): void {
    const c = this.connections.get(peer_id);
    if (!c) return;
    if (c.handshake_timer !== null) clearTimeout(c.handshake_timer);
    this.connections.delete(peer_id);
    for (const [guid, pending] of this.pending_moves_out) {
      if (pending.target_peer_id === peer_id) {
        this.pending_moves_out.delete(guid);
        pending.on_complete?.(false, "peer disconnected mid-move");
      }
    }
    this.republishPeers();
    if (this.computePeers().every((p) => p.status !== "pending_approval")) {
      settingsAttention.set("cloud-mesh", null);
    }
  }

  private peerStatus(conn: ConnectionState): PeerStatus {
    if (!conn.peer_authenticated) return "handshaking";
    if (conn.local_approved && conn.remote_approved) return "active";
    // Needs local user action when:
    //   - We're the host AND haven't approved yet (first prompt)
    //   - We're the guest AND the host has already approved
    //     (second prompt: "Confirm?")
    if (!conn.local_approved && (conn.approver_role || conn.remote_approved)) {
      return "pending_approval";
    }
    // Otherwise we're waiting on the peer — either guest waiting
    // for host's first approve, or either side having already
    // sent approve and waiting for the reciprocal.
    return "pending_remote";
  }

  private computePeers(): PeerEntry[] {
    return Array.from(this.connections.values()).map((c) => ({
      peer_id: c.peer_id,
      device_pubkey: c.device_pubkey,
      device_suffix: c.device_suffix,
      device_id_display: c.device_suffix && c.device_pubkey
        ? `${c.device_pubkey}-${c.device_suffix}`
        : c.device_pubkey || c.peer_id,
      label: c.label,
      status: this.peerStatus(c),
      authorized: c.device_pubkey ? this.roster_pubkeys.has(c.device_pubkey) : false,
      approver_role: c.approver_role,
      local_approved: c.local_approved,
      remote_approved: c.remote_approved,
      verification_code: c.approver_role ? c.their_verification_code : c.our_verification_code,
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
      this.logDiag("warn", `roster load failed: ${String(e)}`);
      this.roster_pubkeys = new Set();
    }
  }
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
