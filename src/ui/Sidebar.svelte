<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import type { ConversationMeta, FolderMeta } from "../conversations";
  import type { Mode, NetworkConfig } from "../types";
  import { meshClient } from "../mesh-client.svelte";
  import {
    loadConfig,
    removeNetwork,
    setActiveNetwork,
  } from "../config";
  import { settingsRoute } from "./settings-route.svelte";
  import type { CatalogEntry } from "../mesh-protocol";
  import {
    APP_VERSION,
    describePeerMissingFeatures,
    formatPeerCompat,
  } from "../mesh-capabilities";

  /** Peers eligible as Move targets — active and authorized. The
   *  context-menu uses this directly; if the list is empty the
   *  "Move to device…" submenu just shows a hint. */
  let moveTargets = $derived(
    meshClient.peers.filter((p) => p.status === "active" && p.authorized),
  );

  /** Peers we render as expandable sidebar groups, each containing
   *  the conversations that peer hosts (from their broadcast
   *  `catalog_announce`). Sorted by label then pubkey for stable
   *  ordering.
   *
   *  We include:
   *    - active / shelved peers — the data channel is up so we can
   *      both display *and* pull from them
   *    - offline rostered peers that have a cached catalog — the
   *      mesh client preserves the last `catalog_announce` after a
   *      drop, so we render the row dimmed with the previously-seen
   *      conversations. Mirrors the "Claude on the web" feel: an
   *      offline device's content stays visible instead of blinking
   *      out every time the connection cycles. Right-click the
   *      dimmed row → Refresh to attempt reconnect, or Forget to
   *      drop the cache (it'll come back on next sight).
   *
   *  An offline peer with no cached catalog is left out — there's
   *  nothing to show and they'd just be visual noise next to the
   *  live peers. The Settings → Connections tab still lists them. */
  let peerGroups = $derived(
    meshClient.peers
      .filter(
        (p) =>
          ((p.status === "active" || p.status === "shelved") ||
            (p.status === "offline" && p.catalog.length > 0)) &&
          p.authorized &&
          p.device_pubkey,
      )
      .sort((a, b) => {
        const al = (a.label || "").toLowerCase();
        const bl = (b.label || "").toLowerCase();
        if (al && bl && al !== bl) return al < bl ? -1 : 1;
        return a.device_pubkey < b.device_pubkey ? -1 : 1;
      }),
  );

  /** Per-peer-pubkey collapse state. Peers default to expanded so
   *  the user sees what's there on first connect; toggling
   *  persists for the session only. */
  let peerCollapsed = $state<Set<string>>(new Set());

  function togglePeerCollapsed(pubkey: string) {
    peerCollapsed.has(pubkey) ? peerCollapsed.delete(pubkey) : peerCollapsed.add(pubkey);
    peerCollapsed = new Set(peerCollapsed);
  }

  // ---- saved networks --------------------------------------------------
  //
  // The sidebar always renders a "Network" section at the bottom, even
  // when zero networks are saved — that's where the "+ Add network"
  // button lives. Saved networks each render as their own collapsible
  // group: the active one expanded with its peers + catalogs, inactive
  // ones collapsed and clickable to switch.
  //
  // Reload on mount and refresh whenever the mesh-client's status
  // settles — switching networks or completing a reconcile updates the
  // active pointer, and that's the cue to re-pull from disk.

  let savedNetworks = $state<NetworkConfig[]>([]);
  let activeNetworkId = $state<string | null>(null);
  let networksCollapsed = $state<Set<string>>(new Set());
  /** Network the user is about to forget. Confirmation modal mounts
   *  at the bottom of the file. Adding networks is delegated to
   *  Settings → Networks → Status (sidebar gear icon opens it),
   *  so there's no Add modal in the sidebar itself. */
  let forgetModal = $state<NetworkConfig | null>(null);
  /** Sidebar-internal pull-in-flight toast for network-context
   *  actions (Forget). Separate from the conversation-level toasts
   *  above so the wording can be different. */
  let networkActionError = $state<string>("");

  async function reloadNetworks() {
    try {
      const cfg = await loadConfig();
      savedNetworks = cfg.cloud_mesh.networks;
      activeNetworkId = cfg.cloud_mesh.active_network_id;
    } catch {
      // Quiet failure — sidebar still renders, just without networks.
    }
  }

  onMount(() => {
    void reloadNetworks();
  });

  /** Re-pull from disk whenever the mesh-client status changes
   *  (off → starting → online, etc.). This is the cue that a
   *  network switch or first-time join just completed. */
  $effect(() => {
    void meshClient.status;
    void reloadNetworks();
  });

  function toggleNetworkCollapsed(id: string) {
    networksCollapsed.has(id) ? networksCollapsed.delete(id) : networksCollapsed.add(id);
    networksCollapsed = new Set(networksCollapsed);
  }

  async function switchToNetwork(id: string) {
    if (id === activeNetworkId) return;
    try {
      await setActiveNetwork(id);
      meshClient.reconcile().catch(() => {});
      await reloadNetworks();
    } catch (e) {
      networkActionError = String(e);
    }
  }

  async function forgetNetwork(net: NetworkConfig) {
    forgetModal = null;
    try {
      const wasActive = activeNetworkId === net.id;
      await removeNetwork(net.id);
      await invoke("mesh_roster_delete", { networkId: net.network_id }).catch(() => {});
      await reloadNetworks();
      if (wasActive) meshClient.reconcile().catch(() => {});
    } catch (e) {
      networkActionError = String(e);
    }
  }

  function openMeshSettingsForNetwork() {
    closeMenu();
    settingsRoute.open("cloud-mesh", { meshSubTab: "status" });
  }

  /** Sidebar Networks-section gear: route the user to Settings →
   *  Networks → Status. From there they can use the "+ Add network"
   *  button to add, the Switch / Forget controls on each row, or
   *  the wizard to lock the active one. Centralizing all
   *  network-management actions in one place keeps the sidebar
   *  focused on showing networks, not managing them. */
  function openMeshStatusSettings() {
    closeMenu();
    settingsRoute.open("cloud-mesh", { meshSubTab: "status" });
  }

  /** Build a folder tree from a peer's catalog so we render their
   *  conversations under the same folder structure they organize
   *  them on-host. Mirrors the local `tree` derivation —
   *  intermediate folders for "Work/Projects/Q4" materialize
   *  automatically so the user sees the same hierarchy here as
   *  they would on the source device. */
  type RemoteNode = {
    path: string;
    name: string;
    depth: number;
    children: RemoteNode[];
    items: CatalogEntry[];
  };

  function buildRemoteTree(entries: CatalogEntry[]): RemoteNode {
    const root: RemoteNode = { path: "", name: "", depth: 0, children: [], items: [] };
    const byPath = new Map<string, RemoteNode>();
    byPath.set("", root);
    const allPaths = new Set<string>();
    for (const e of entries) if (e.path) allPaths.add(e.path);
    for (const path of [...allPaths].sort()) {
      const parts = path.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) {
        const sub = parts.slice(0, i).join("/");
        if (byPath.has(sub)) continue;
        const parent = byPath.get(parts.slice(0, i - 1).join("/")) ?? root;
        const node: RemoteNode = {
          path: sub,
          name: parts[i - 1],
          depth: i - 1,
          children: [],
          items: [],
        };
        parent.children.push(node);
        byPath.set(sub, node);
      }
    }
    for (const e of entries) {
      (byPath.get(e.path ?? "") ?? root).items.push(e);
    }
    // Most-recent first inside each folder, same ordering rule as
    // the local sidebar.
    const sortItems = (n: RemoteNode) => {
      n.items.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      n.children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const c of n.children) sortItems(c);
    };
    sortItems(root);
    return root;
  }

  /** Map from peer device_pubkey → built tree. Recomputes whenever
   *  a peer's catalog changes (i.e. on every catalog_announce). */
  let remoteTrees = $derived.by(() => {
    const out = new Map<string, RemoteNode>();
    for (const peer of peerGroups) {
      out.set(peer.device_pubkey, buildRemoteTree(peer.catalog));
    }
    return out;
  });

  /** Collapse state for remote folders. Keyed by
   *  `${peer_pubkey}:${folder_path}` so a folder on peer-A doesn't
   *  collapse the same-named folder on peer-B. Default expanded. */
  let remoteFolderCollapsed = $state<Set<string>>(new Set());

  function toggleRemoteFolderCollapsed(key: string) {
    remoteFolderCollapsed.has(key)
      ? remoteFolderCollapsed.delete(key)
      : remoteFolderCollapsed.add(key);
    remoteFolderCollapsed = new Set(remoteFolderCollapsed);
  }

  /** Tracks an in-flight outgoing Move so the context menu can show
   *  a transient "Sending…" instead of letting the user fire and
   *  forget without feedback. Cleared on completion (success or
   *  failure). */
  let moveInFlight = $state<{ guid: string; label: string } | null>(null);
  let moveError = $state<string>("");
  /** Same shape, in the opposite direction: a pull we've kicked off
   *  against a remote peer. Stays until the source ack'd (and the
   *  payload landed) or the source declined. */
  let pullInFlight = $state<{ guid: string; label: string } | null>(null);
  let pullError = $state<string>("");

  async function startMove(guid: string, target_tag: string, target_label: string) {
    moveInFlight = { guid, label: target_label };
    moveError = "";
    closeMenu();
    try {
      await meshClient.moveConversation(guid, target_tag);
    } catch (e) {
      moveError = String(e);
    } finally {
      moveInFlight = null;
    }
  }

  async function startPull(guid: string, source_peer_id: string, source_label: string, title: string) {
    pullInFlight = { guid, label: `${title} from ${source_label}` };
    pullError = "";
    closeMenu();
    try {
      await meshClient.pullConversation(guid, source_peer_id);
    } catch (e) {
      pullError = String(e);
    } finally {
      pullInFlight = null;
    }
  }

  function openMeshConnectionsSettings() {
    closeMenu();
    settingsRoute.open("cloud-mesh", { meshSubTab: "connections" });
  }

  function shortPeerLabel(pubkey: string, label: string): string {
    if (label.trim() !== "") return label;
    return pubkey.slice(0, 8);
  }

  // ---- file send (Phase 2.1) -------------------------------------------
  //
  // Lets the user right-click a connected peer → "Send file…" → pick a
  // file from disk → ship it over the mesh via meshClient.sendFile.
  // The hidden <input type="file"> lives at the bottom of the sidebar
  // and we re-target it per send so the peer-id stays paired with the
  // selected file.

  let fileInput = $state<HTMLInputElement | null>(null);
  let pendingFileTarget = $state<{
    peer_id: string;
    peer_label: string;
  } | null>(null);
  let fileSendError = $state<string>("");

  function startFileSend(peer_id: string, peer_label: string) {
    closeMenu();
    pendingFileTarget = { peer_id, peer_label };
    fileSendError = "";
    // Reset the input value before opening so picking the same file
    // twice in a row still fires `change`. Browsers de-duplicate
    // identical selections otherwise.
    if (fileInput) {
      fileInput.value = "";
      fileInput.click();
    }
  }

  async function onFileChosen(e: Event) {
    const target = pendingFileTarget;
    pendingFileTarget = null;
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files && input.files.length > 0 ? input.files[0] : null;
    input.value = "";
    if (!target || !file) return;
    try {
      const buf = await file.arrayBuffer();
      await meshClient.sendFile({
        target_peer_id: target.peer_id,
        filename: file.name,
        mime_type: file.type || undefined,
        bytes: new Uint8Array(buf),
      });
    } catch (err) {
      fileSendError = `Send "${file.name}" to ${target.peer_label} failed: ${String(err)}`;
    }
  }

  /** Inbound offers from the mesh client. Each one renders as a
   *  toast at the bottom of the sidebar with Save / Decline buttons.
   *  The list is mutated by the mesh client on `file_offer` arrival
   *  and on the user's accept/decline action. */
  let inboundOffers = $derived(meshClient.inbound_offers);

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  let {
    open,
    items,
    folders,
    activeId,
    mode,
    onSelect,
    onNew,
    onRename,
    onDelete,
    onMove,
    onMoveFolder,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    onClose,
  } = $props<{
    open: boolean;
    items: ConversationMeta[];
    folders: FolderMeta[];
    activeId: string | null;
    /** Active mode. Drives whether we say "chat" or "session" in the
     *  sidebar copy — same list, different metaphor. */
    mode: Mode;
    onSelect: (id: string) => void;
    onNew: () => void;
    onRename: (id: string, title: string) => void;
    onDelete: (id: string) => void;
    /** Move a conversation file into the given folder path (POSIX, "" for root). */
    onMove: (id: string, folder: string) => void;
    /** Move/rename a folder into a new parent. `newPath` is the full POSIX
     *  path (parent + "/" + name; just `name` for root). */
    onMoveFolder: (oldPath: string, newPath: string) => void;
    onCreateFolder: (path: string) => void;
    onRenameFolder: (oldPath: string, newPath: string) => void;
    onDeleteFolder: (path: string) => void;
    onClose: () => void;
  }>();

  const newLabel = $derived(mode === "transcribe" ? "New session" : "New chat");
  const emptyLabel = $derived(
    mode === "transcribe" ? "No sessions yet." : "No conversations yet.",
  );
  const itemNoun = $derived(mode === "transcribe" ? "session" : "conversation");

  /** Right-click menu state. Anchored to the viewport (fixed positioning),
   *  so the bounding sidebar's overflow can't clip the menu. */
  type MenuTarget =
    | { kind: "item"; id: string }
    | { kind: "folder"; path: string }
    /** Remote conversation hosted on a peer. The Pull action sends a
     *  `move_request` over the data channel; the source side then
     *  drives the regular Move handshake with us as destination. */
    | {
        kind: "remote-item";
        peer_id: string;
        peer_label: string;
        guid: string;
        title: string;
      }
    /** A peer-group row in the sidebar. Carries device pubkey so
     *  Forget can drop the catalog cache, and a `status` so the
     *  menu can swap actions for offline-rostered peers (no
     *  Send-file, since there's no live channel; gain Forget,
     *  which clears the dimmed cached row). */
    | {
        kind: "peer";
        peer_id: string;
        peer_label: string;
        device_pubkey: string;
        status: "active" | "shelved" | "offline";
      }
    /** A saved-network row in the sidebar's Network section. Menu
     *  exposes switch / forget / settings. */
    | { kind: "saved-network"; network: NetworkConfig };
  let menu = $state<{ target: MenuTarget; x: number; y: number } | null>(null);
  let editingId = $state<string | null>(null);
  let editingFolder = $state<string | null>(null);
  let editValue = $state("");
  /** When non-null, an inline input is rendered as a child of this path
   *  (`""` = root) so the user can name a new folder without a native
   *  dialog. WebKitGTK silently no-ops `window.prompt()`, which made the
   *  old prompt-based flow look broken on Linux. */
  let creatingFolderParent = $state<string | null>(null);
  let newFolderName = $state("");

  function autofocus(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  /** Folder paths the user has collapsed. Folders default to expanded. */
  let collapsed = $state<Set<string>>(new Set());

  /** Non-native delete-confirmation modal. `window.confirm()` used to
   *  drive the delete flows, but Tauri's `dialog:default` capability
   *  set doesn't include the (deprecated) `dialog:allow-confirm`
   *  permission — and we don't want native modals anyway, since the
   *  rest of the app (StorageSection, ModelsSection, the conflict
   *  modal in App) uses inline confirmations consistently. Setting
   *  `deletePrompt` opens the overlay; `proceed` runs after the user
   *  clicks Delete; clicking Cancel just clears it. */
  let deletePrompt = $state<{
    title: string;
    body: string;
    proceed: () => void;
  } | null>(null);

  function openItemMenu(e: MouseEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    const x = Math.min(e.clientX, window.innerWidth - 170);
    const y = Math.min(e.clientY, window.innerHeight - 130);
    menu = { target: { kind: "item", id }, x, y };
  }

  function openFolderMenu(e: MouseEvent, path: string) {
    e.preventDefault();
    e.stopPropagation();
    const x = Math.min(e.clientX, window.innerWidth - 200);
    const y = Math.min(e.clientY, window.innerHeight - 170);
    menu = { target: { kind: "folder", path }, x, y };
  }

  function openRemoteItemMenu(
    e: MouseEvent | KeyboardEvent,
    peer_id: string,
    peer_label: string,
    guid: string,
    title: string,
  ) {
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = menuAnchor(e, 180, 120);
    menu = { target: { kind: "remote-item", peer_id, peer_label, guid, title }, x, y };
  }

  function openPeerMenu(
    e: MouseEvent | KeyboardEvent,
    peer_id: string,
    peer_label: string,
    device_pubkey: string,
    status: "active" | "shelved" | "offline",
  ) {
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = menuAnchor(e, 200, 160);
    menu = { target: { kind: "peer", peer_id, peer_label, device_pubkey, status }, x, y };
  }

  function openSavedNetworkMenu(e: MouseEvent | KeyboardEvent, network: NetworkConfig) {
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = menuAnchor(e, 200, 160);
    menu = { target: { kind: "saved-network", network }, x, y };
  }

  /** Compute a viewport-pinned anchor for the context menu. Mouse
   *  events anchor at the cursor; keyboard events fall back to the
   *  currentTarget's bounding rect so Enter / Space on a focused
   *  row pops the menu next to the row, not at (0,0). */
  function menuAnchor(
    e: MouseEvent | KeyboardEvent,
    widthBudget: number,
    heightBudget: number,
  ): { x: number; y: number } {
    if (e instanceof MouseEvent) {
      return {
        x: Math.min(e.clientX, window.innerWidth - widthBudget),
        y: Math.min(e.clientY, window.innerHeight - heightBudget),
      };
    }
    const target = e.currentTarget as HTMLElement | null;
    if (target) {
      const r = target.getBoundingClientRect();
      return {
        x: Math.min(r.left + 16, window.innerWidth - widthBudget),
        y: Math.min(r.bottom + 4, window.innerHeight - heightBudget),
      };
    }
    return { x: 16, y: 16 };
  }

  function closeMenu() {
    menu = null;
  }

  function startRenameItem(id: string) {
    const item = items.find((c: ConversationMeta) => c.id === id);
    if (!item) return;
    editingId = id;
    editValue = item.title;
    closeMenu();
  }

  function commitRenameItem() {
    if (!editingId) return;
    const t = editValue.trim();
    if (t) onRename(editingId, t);
    editingId = null;
  }

  function startRenameFolder(path: string) {
    editingFolder = path;
    editValue = path.split("/").pop() ?? "";
    closeMenu();
  }

  function commitRenameFolder() {
    if (!editingFolder) return;
    const trimmed = editValue.trim();
    if (trimmed) {
      const parts = editingFolder.split("/");
      parts[parts.length - 1] = trimmed;
      const next = parts.join("/");
      if (next !== editingFolder) onRenameFolder(editingFolder, next);
    }
    editingFolder = null;
  }

  function cancelRename() {
    editingId = null;
    editingFolder = null;
  }

  function onRenameKey(e: KeyboardEvent, kind: "item" | "folder") {
    // The parent row/folder div treats Space as "select/toggle" and calls
    // preventDefault(). Stop the bubble so typing spaces in the rename
    // input works.
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      if (kind === "item") commitRenameItem();
      else commitRenameFolder();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  }

  function deleteItemWithConfirm(id: string) {
    closeMenu();
    const item = items.find((c: ConversationMeta) => c.id === id);
    const label = item?.title ?? `this ${itemNoun}`;
    deletePrompt = {
      title: `Delete "${label}"?`,
      body: "This can't be undone.",
      proceed: () => onDelete(id),
    };
  }

  function deleteFolderWithConfirm(path: string) {
    closeMenu();
    const childCount = items.filter(
      (c: ConversationMeta) => c.path === path || c.path.startsWith(path + "/"),
    ).length;
    const childFolderCount = folders.filter(
      (f: FolderMeta) => f.path !== path && f.path.startsWith(path + "/"),
    ).length;
    const total = childCount + childFolderCount;
    const folderName = path.split("/").pop() ?? path;
    let body = "";
    if (total > 0) {
      body = `This also removes ${childCount} ${itemNoun}${childCount === 1 ? "" : "s"}`;
      if (childFolderCount > 0) {
        body += ` and ${childFolderCount} subfolder${childFolderCount === 1 ? "" : "s"}`;
      }
      body += " inside it. ";
    }
    body += "This can't be undone.";
    deletePrompt = {
      title: `Delete folder "${folderName}"?`,
      body,
      proceed: () => onDeleteFolder(path),
    };
  }

  function startCreateFolder(parent: string) {
    closeMenu();
    // Expand the parent (if any) so the inline input renders into view.
    if (parent && collapsed.has(parent)) {
      const next = new Set(collapsed);
      next.delete(parent);
      collapsed = next;
    }
    newFolderName = "";
    creatingFolderParent = parent;
  }

  function commitCreateFolder() {
    if (creatingFolderParent === null) return;
    const parent = creatingFolderParent;
    const trimmed = newFolderName.trim();
    creatingFolderParent = null;
    newFolderName = "";
    if (!trimmed) return;
    onCreateFolder(parent ? `${parent}/${trimmed}` : trimmed);
  }

  function cancelCreateFolder() {
    creatingFolderParent = null;
    newFolderName = "";
  }

  function onCreateFolderKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitCreateFolder();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelCreateFolder();
    }
  }

  function moveToRoot(id: string) {
    closeMenu();
    onMove(id, "");
  }

  /** Build the visible tree. Each folder appears once with its direct-child
   *  conversations grouped underneath. Walks the sorted folder list in
   *  document order, and uses the conversation `path` field to slot rows
   *  into the right node. */
  type Node = {
    path: string;
    name: string;
    depth: number;
    children: Node[];
    items: ConversationMeta[];
  };

  const tree = $derived.by((): Node => {
    const root: Node = { path: "", name: "", depth: 0, children: [], items: [] };
    const byPath = new Map<string, Node>();
    byPath.set("", root);
    // Build folder skeleton first so empty folders still render.
    const allFolderPaths = new Set<string>();
    for (const f of folders) allFolderPaths.add(f.path);
    // Materialise any folder paths referenced by items but somehow missing
    // from the folders list (defensive — listConversations should already
    // surface them).
    for (const it of items) if (it.path) allFolderPaths.add(it.path);
    const sortedFolders = [...allFolderPaths].sort();
    for (const path of sortedFolders) {
      const parts = path.split("/");
      // Walk ancestors so an entry like "A/B/C" creates A, A/B, A/B/C.
      for (let i = 1; i <= parts.length; i++) {
        const sub = parts.slice(0, i).join("/");
        if (byPath.has(sub)) continue;
        const parent = byPath.get(parts.slice(0, i - 1).join("/")) ?? root;
        const node: Node = {
          path: sub,
          name: parts[i - 1],
          depth: i - 1,
          children: [],
          items: [],
        };
        parent.children.push(node);
        byPath.set(sub, node);
      }
    }
    // Distribute items into their folders.
    for (const it of items) {
      const node = byPath.get(it.path) ?? root;
      node.items.push(it);
    }
    return root;
  });

  /** Group a list into ChatGPT-style time bands. Pure helper, no derived. */
  function groupByBand(rows: ConversationMeta[]) {
    const now = Date.now();
    const day = 86400_000;
    const buckets = [
      { label: "Today", rows: [] as ConversationMeta[] },
      { label: "Yesterday", rows: [] as ConversationMeta[] },
      { label: "Previous 7 days", rows: [] as ConversationMeta[] },
      { label: "Older", rows: [] as ConversationMeta[] },
    ];
    for (const r of rows) {
      const t = r.updated_at ? Date.parse(r.updated_at) : 0;
      const age = now - t;
      if (age < day) buckets[0].rows.push(r);
      else if (age < 2 * day) buckets[1].rows.push(r);
      else if (age < 7 * day) buckets[2].rows.push(r);
      else buckets[3].rows.push(r);
    }
    return buckets.filter((b) => b.rows.length > 0);
  }

  // ---------------------------------------------------------------------
  // Drag-drop. Custom pointer-based implementation: the HTML5 DnD API
  // doesn't fire reliably under WebKitGTK (Tauri's Linux webview), and we
  // want OS-style affordances anyway — a ghost that follows the cursor,
  // drop highlighting on folders, hover-to-expand for collapsed folders,
  // and folder-into-folder dragging. Items resolve the drop target by
  // walking up from `document.elementFromPoint` until we find a node with
  // a `data-drop-path` attribute.
  // ---------------------------------------------------------------------

  type DragSrc =
    | { kind: "item"; id: string; label: string; mode: Mode }
    | { kind: "folder"; path: string; label: string };

  type DragState = {
    src: DragSrc;
    /** Pointer position in viewport coords. */
    x: number;
    y: number;
    /** Cursor offset within the source row, so the ghost lines up with
     *  where the user grabbed it. */
    offsetX: number;
    offsetY: number;
    /** Current drop target path (`""` for root, `null` for "none"). */
    overPath: string | null;
    /** Did we cross the threshold yet? Below the threshold, this is a
     *  click-in-progress and we leave the row alone. */
    active: boolean;
  };

  let drag = $state<DragState | null>(null);

  type PendingDrag = {
    src: DragSrc;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    pointerId: number;
  };
  let pendingDrag: PendingDrag | null = null;

  /** Hover-to-expand: a collapsed folder under the pointer pops open after
   *  this long, mirroring Finder / Explorer / VS Code. */
  const HOVER_EXPAND_MS = 600;
  /** Pointer movement threshold before we treat a press-and-drag as a drag
   *  rather than a click. */
  const DRAG_THRESHOLD = 5;

  let hoverExpandTimer: number | null = null;
  /** Set in pointerup when a drag actually ran, so the synthetic click that
   *  follows on the same element doesn't toggle/select. */
  let suppressNextClick = false;

  /** Visible drop highlight target. Folder rows and the list root key off
   *  this to paint their hover state. */
  const dragOverPath = $derived(drag && drag.active ? drag.overPath : null);

  function srcLabel(src: DragSrc): string {
    return src.label || (src.kind === "folder" ? "Folder" : "Untitled");
  }

  function startItemDrag(e: PointerEvent, c: ConversationMeta) {
    if (!shouldStartDrag(e)) return;
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    pendingDrag = {
      src: { kind: "item", id: c.id, label: c.title, mode: c.mode },
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      pointerId: e.pointerId,
    };
    armDragListeners();
  }

  function startFolderDrag(e: PointerEvent, node: Node) {
    if (!shouldStartDrag(e)) return;
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    pendingDrag = {
      src: { kind: "folder", path: node.path, label: node.name },
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      pointerId: e.pointerId,
    };
    armDragListeners();
  }

  /** Common preflight: only left-button presses on non-input descendants of
   *  the row count as drag starts. Keeps rename inputs and the kebab menu
   *  click-friendly. */
  function shouldStartDrag(e: PointerEvent): boolean {
    if (e.button !== 0) return false;
    if (editingId || editingFolder || creatingFolderParent !== null) return false;
    const target = e.target as HTMLElement | null;
    if (target && target.closest("input, textarea, button")) return false;
    return true;
  }

  function armDragListeners() {
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onDragKey);
  }

  function disarmDragListeners() {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("keydown", onDragKey);
  }

  function onPointerMove(e: PointerEvent) {
    if (!pendingDrag) return;
    if (e.pointerId !== pendingDrag.pointerId) return;
    if (!drag) {
      const dx = e.clientX - pendingDrag.startX;
      const dy = e.clientY - pendingDrag.startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      drag = {
        src: pendingDrag.src,
        x: e.clientX,
        y: e.clientY,
        offsetX: pendingDrag.offsetX,
        offsetY: pendingDrag.offsetY,
        overPath: null,
        active: true,
      };
      // Dismiss any open context menu so it doesn't float over the drag.
      closeMenu();
    }
    drag.x = e.clientX;
    drag.y = e.clientY;
    updateOverPath(pathFromPoint(e.clientX, e.clientY));
  }

  function onPointerUp(e: PointerEvent) {
    if (!pendingDrag) return;
    if (e.pointerId !== pendingDrag.pointerId) return;
    const wasActive = !!(drag && drag.active);
    if (wasActive) {
      finishDrop();
      suppressNextClick = true;
      // Click follows pointerup synchronously; clear on next macrotask in
      // case the platform skips the click (e.g. drop landed off-source).
      setTimeout(() => (suppressNextClick = false), 0);
    }
    pendingDrag = null;
    drag = null;
    clearHoverExpand();
    disarmDragListeners();
  }

  function onPointerCancel(e: PointerEvent) {
    if (!pendingDrag) return;
    if (e.pointerId !== pendingDrag.pointerId) return;
    cancelDrag();
  }

  function onDragKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      cancelDrag();
    }
  }

  function cancelDrag() {
    pendingDrag = null;
    drag = null;
    clearHoverExpand();
    disarmDragListeners();
  }

  /** Walk up from the element under the pointer until we hit a node carrying
   *  a `data-drop-path` attribute. Returns `null` if the pointer isn't over
   *  any sidebar drop zone (e.g. the user dragged outside the sidebar). */
  function pathFromPoint(x: number, y: number): string | null {
    let el = document.elementFromPoint(x, y) as HTMLElement | null;
    while (el) {
      const v = el.dataset?.dropPath;
      if (v !== undefined) return v;
      el = el.parentElement;
    }
    return null;
  }

  function updateOverPath(path: string | null) {
    if (!drag) return;
    if (path !== null && !canDropAt(path)) path = null;
    if (path === drag.overPath) return;
    drag.overPath = path;
    clearHoverExpand();
    if (path && collapsed.has(path)) {
      hoverExpandTimer = window.setTimeout(() => {
        if (drag && drag.overPath === path && collapsed.has(path)) {
          const next = new Set(collapsed);
          next.delete(path);
          collapsed = next;
        }
        hoverExpandTimer = null;
      }, HOVER_EXPAND_MS);
    }
  }

  function canDropAt(path: string): boolean {
    if (!drag) return false;
    if (drag.src.kind === "folder") {
      // Can't drop a folder into itself or any of its descendants.
      if (path === drag.src.path) return false;
      if (drag.src.path && path.startsWith(drag.src.path + "/")) return false;
      // Already directly under this parent? Highlight it anyway as the
      // "same place" target — finishDrop will no-op. Keeps the affordance
      // consistent with file managers, which still show the hover ring.
    }
    return true;
  }

  function clearHoverExpand() {
    if (hoverExpandTimer !== null) {
      window.clearTimeout(hoverExpandTimer);
      hoverExpandTimer = null;
    }
  }

  function finishDrop() {
    if (!drag) return;
    const target = drag.overPath;
    if (target === null) return;
    if (drag.src.kind === "item") {
      const id = drag.src.id;
      const item = items.find((c: ConversationMeta) => c.id === id);
      if (!item) return;
      if (item.path === target) return;
      onMove(id, target);
    } else {
      const fromPath = drag.src.path;
      const folderName = fromPath.split("/").pop() ?? "";
      const newPath = target ? `${target}/${folderName}` : folderName;
      if (newPath === fromPath) return;
      onMoveFolder(fromPath, newPath);
    }
  }

  function toggleCollapsed(path: string) {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    collapsed = next;
  }

  function handleRowClick(id: string) {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    onSelect(id);
  }

  function handleFolderClick(path: string) {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    toggleCollapsed(path);
  }

  function isDragSource(kind: "item" | "folder", key: string): boolean {
    if (!drag || !drag.active) return false;
    if (kind === "item" && drag.src.kind === "item") return drag.src.id === key;
    if (kind === "folder" && drag.src.kind === "folder") return drag.src.path === key;
    return false;
  }
</script>

<aside class="sidebar" class:open aria-hidden={!open}>
  <div class="head">
    <button class="new" onclick={onNew} title={newLabel}>
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 5a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H6a1 1 0 1 1 0-2h5V6a1 1 0 0 1 1-1z"
        />
      </svg>
      <span>{newLabel}</span>
    </button>
    <button
      class="folder-btn"
      onclick={() => startCreateFolder("")}
      title="New folder"
      aria-label="New folder"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path
          fill="currentColor"
          d="M10 4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6zm6 8h-3V9h-2v3H8v2h3v3h2v-3h3v-2z"
        />
      </svg>
    </button>
    <button class="collapse" onclick={onClose} title="Hide sidebar" aria-label="Hide sidebar">
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path fill="currentColor" d="M14.7 6.3a1 1 0 0 1 0 1.4L10.4 12l4.3 4.3a1 1 0 1 1-1.4 1.4l-5-5a1 1 0 0 1 0-1.4l5-5a1 1 0 0 1 1.4 0z" />
      </svg>
    </button>
  </div>

  <div
    class="list"
    class:drop-root={dragOverPath === ""}
    onclick={closeMenu}
    role="presentation"
    data-drop-path=""
  >
    {#if items.length === 0 && folders.length === 0}
      <div class="empty">{emptyLabel}</div>
    {/if}

    {#if tree.items.length > 0}
      {#each groupByBand(tree.items) as group (group.label)}
        <div class="group-label">{group.label}</div>
        {#each group.rows as c (c.id)}
          {@render row(c, 0)}
        {/each}
      {/each}
    {/if}

    {#if creatingFolderParent === ""}
      {@render newFolderInput(0)}
    {/if}

    {#each tree.children as child (child.path)}
      {@render folder(child)}
    {/each}

    <!-- Network section. Always rendered at the bottom of the
         sidebar so the "+ Add network" button is reliably one
         click away regardless of mesh state. Each saved network
         is its own collapsible group:
           - Active network: expanded by default, with its
             connected peers as nested expandable sub-groups
             (each containing the peer's folder tree).
           - Inactive saved networks: collapsed, click the header
             (or right-click → Switch to this network) to switch.
         Right-click on a network header → switch / settings /
         forget menu. -->
    <div class="network-divider" aria-hidden="true"></div>
    <div class="network-section-head">
      <span class="group-label network-label">Networks</span>
      <button
        class="network-settings-btn"
        onclick={openMeshStatusSettings}
        title="Open Networks settings — add, switch, or forget saved networks"
        aria-label="Network settings"
      >
        <!-- 14×14 cog. Rendered at 11×11 to match the surrounding
             sidebar density. -->
        <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
          <path
            fill="currentColor"
            d="M19.4 13a7.7 7.7 0 0 0 0-2l2.1-1.6a.5.5 0 0 0 .1-.6l-2-3.4a.5.5 0 0 0-.6-.2l-2.4 1a7.6 7.6 0 0 0-1.7-1L14.5 2.5a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.4-1a.5.5 0 0 0-.6.2l-2 3.4a.5.5 0 0 0 .1.6L4.6 11a7.7 7.7 0 0 0 0 2l-2.1 1.6a.5.5 0 0 0-.1.6l2 3.4a.5.5 0 0 0 .6.2l2.4-1a7.6 7.6 0 0 0 1.7 1l.4 2.6a.5.5 0 0 0 .5.4h4a.5.5 0 0 0 .5-.4l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.4 1a.5.5 0 0 0 .6-.2l2-3.4a.5.5 0 0 0-.1-.6L19.4 13ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"
          />
        </svg>
      </button>
    </div>
    {#if savedNetworks.length === 0}
      <div class="network-empty">
        No saved networks. <button class="link" onclick={openMeshStatusSettings}>Open settings</button>
        to add one and start sharing conversations and resources
        with another device.
      </div>
    {/if}
    {#each savedNetworks as net (net.id)}
      {@const isActive = net.id === activeNetworkId}
      {@const isCollapsed = networksCollapsed.has(net.id)}
      <div
        class="network-group"
        class:active-network={isActive}
        role="button"
        tabindex="0"
        oncontextmenu={(e) => openSavedNetworkMenu(e, net)}
        onclick={(e) => {
          e.stopPropagation();
          if (isActive) {
            toggleNetworkCollapsed(net.id);
          } else {
            // Inactive networks: clicking the header switches to
            // them. The user almost never wants to "collapse" an
            // inactive network (it's already nothing to look at);
            // they want one click to make it active. Right-click
            // for the full menu.
            void switchToNetwork(net.id);
          }
        }}
        onkeydown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (isActive) toggleNetworkCollapsed(net.id);
            else void switchToNetwork(net.id);
          } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            openSavedNetworkMenu(e, net);
          }
        }}
        title={isActive
          ? `${net.network_id} (active — click to ${isCollapsed ? "expand" : "collapse"})`
          : `${net.network_id} (click to switch)`}
      >
        <span class="folder-caret" aria-hidden="true">
          {#if isActive}{isCollapsed ? "▸" : "▾"}{:else}○{/if}
        </span>
        <span class="net-row-name">{net.network_id}</span>
        {#if isActive}
          <span class="net-row-active">active</span>
        {/if}
        {#if !net.locked}
          <span class="net-row-unlocked" title="Not locked yet — open Settings to commit">unlocked</span>
        {/if}
      </div>
      {#if isActive && !isCollapsed}
        {#if peerGroups.length === 0}
          <div class="network-empty network-empty-active">
            {#if meshClient.status === "online"}
              No peers yet. Share your Network ID with another device.
            {:else if meshClient.status === "starting"}
              Joining mesh…
            {:else if !net.locked}
              Lock this network on the Status tab to bring it online.
            {:else}
              {meshClient.error || "Mesh offline"}
            {/if}
          </div>
        {:else}
          {#each peerGroups as peer (peer.peer_id)}
            {@const isPeerCollapsed = peerCollapsed.has(peer.device_pubkey)}
            <div
              class="peer-group"
              class:standby={peer.status === "shelved"}
              class:offline={peer.status === "offline"}
              role="button"
              tabindex="0"
              oncontextmenu={(e) =>
                openPeerMenu(
                  e,
                  peer.peer_id,
                  peer.label || peer.device_pubkey.slice(0, 8),
                  peer.device_pubkey,
                  peer.status as "active" | "shelved" | "offline",
                )}
              onclick={(e) => {
                e.stopPropagation();
                togglePeerCollapsed(peer.device_pubkey);
              }}
              onkeydown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  togglePeerCollapsed(peer.device_pubkey);
                } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                  openPeerMenu(
                    e,
                    peer.peer_id,
                    peer.label || peer.device_pubkey.slice(0, 8),
                    peer.device_pubkey,
                    peer.status as "active" | "shelved" | "offline",
                  );
                }
              }}
              title={`${peer.label || "Unnamed device"}${peer.device_suffix ? ` -${peer.device_suffix}` : ""}${peer.status === "offline" ? " (offline — cached view)" : ""}`}
            >
              <span class="folder-caret" aria-hidden="true">{isPeerCollapsed ? "▸" : "▾"}</span>
              <span class="peer-dot" data-status={peer.status} aria-hidden="true"></span>
              <span class="peer-group-name">{peer.label || "Unnamed device"}</span>
              {#if peer.device_suffix}
                <span class="peer-group-suffix">-{peer.device_suffix}</span>
              {/if}
              {#if peer.status === "shelved"}
                <span class="peer-standby-pill">standby</span>
              {/if}
              {#if peer.status === "offline"}
                <span class="peer-offline-pill">offline</span>
              {/if}
              {#if peer.capabilities.app_version && peer.capabilities.app_version !== APP_VERSION}
                <!-- Version mismatch surfaced inline so the user
                     sees it without going to settings. The
                     hover-title carries the full missing-feature
                     list so a mismatched-and-incompatible peer
                     reads at a glance. -->
                <span
                  class="peer-version-pill"
                  title={`Peer build v${peer.capabilities.app_version} differs from yours (v${APP_VERSION}). ${describePeerMissingFeatures(peer.capabilities)}`}
                >
                  v{peer.capabilities.app_version}
                </span>
              {/if}
            </div>
            {#if !isPeerCollapsed}
              {@const node = remoteTrees.get(peer.device_pubkey)}
              {#if !node || (node.items.length === 0 && node.children.length === 0)}
                <div class="peer-empty">(no conversations)</div>
              {:else}
                {#each node.items as entry (entry.guid)}
                  {@render remoteRow(entry, peer, 2)}
                {/each}
                {#each node.children as child (child.path)}
                  {@render remoteFolder(child, peer)}
                {/each}
              {/if}
            {/if}
          {/each}
        {/if}
      {/if}
    {/each}
    {#if networkActionError}
      <div class="network-error">
        {networkActionError}
        <button class="dismiss" onclick={() => (networkActionError = "")} aria-label="Dismiss">✕</button>
      </div>
    {/if}
  </div>
</aside>

{#snippet remoteFolder(node: RemoteNode, peer: (typeof peerGroups)[number])}
  {@const key = `${peer.device_pubkey}:${node.path}`}
  {@const isFolderCollapsed = remoteFolderCollapsed.has(key)}
  <div
    class="folder remote-folder"
    style="--depth: {node.depth + 1};"
    role="button"
    tabindex="0"
    onclick={(e) => {
      e.stopPropagation();
      toggleRemoteFolderCollapsed(key);
    }}
    onkeydown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleRemoteFolderCollapsed(key);
      }
    }}
    title={node.path}
  >
    <span class="folder-caret" aria-hidden="true">{isFolderCollapsed ? "▸" : "▾"}</span>
    <svg class="folder-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path
        fill="currentColor"
        d="M10 4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6z"
      />
    </svg>
    <span class="folder-name">{node.name}</span>
  </div>
  {#if !isFolderCollapsed}
    {#each node.items as entry (entry.guid)}
      {@render remoteRow(entry, peer, node.depth + 2)}
    {/each}
    {#each node.children as child (child.path)}
      {@render remoteFolder(child, peer)}
    {/each}
  {/if}
{/snippet}

{#snippet remoteRow(entry: CatalogEntry, peer: (typeof peerGroups)[number], depth: number)}
  <div
    class="row remote"
    class:pending-move={entry.pending_move}
    style="--depth: {depth};"
    role="button"
    tabindex="0"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => {
      // Keyboard equivalent of right-click: Enter / Space opens
      // the Pull menu so the action is reachable without a mouse.
      if (e.key === "Enter" || e.key === " ") {
        openRemoteItemMenu(
          e,
          peer.peer_id,
          peer.label || peer.device_pubkey.slice(0, 8),
          entry.guid,
          entry.title,
        );
      }
    }}
    oncontextmenu={(e) =>
      openRemoteItemMenu(
        e,
        peer.peer_id,
        peer.label || peer.device_pubkey.slice(0, 8),
        entry.guid,
        entry.title,
      )}
    title="{entry.title} (hosted on {peer.label || 'this peer'})"
  >
    {#if entry.mode === "transcribe" || entry.mode === "diarize"}
      <svg
        class="mode-icon"
        viewBox="0 0 24 24"
        width="11"
        height="11"
        aria-hidden="true"
      >
        <path
          fill="currentColor"
          d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"
        />
      </svg>
    {/if}
    <span class="title">{entry.title}</span>
    {#if entry.pending_move}
      <span class="moving-pill">moving…</span>
    {/if}
  </div>
{/snippet}

{#snippet folder(node: Node)}
  {@const isCollapsed = collapsed.has(node.path)}
  <div
    class="folder"
    class:drop-target={dragOverPath === node.path}
    class:dragging={isDragSource("folder", node.path)}
    style="--depth: {node.depth};"
    role="button"
    tabindex="0"
    title={node.path}
    data-drop-path={node.path}
    oncontextmenu={(e) => openFolderMenu(e, node.path)}
    onpointerdown={(e) => startFolderDrag(e, node)}
    onclick={(e) => {
      e.stopPropagation();
      handleFolderClick(node.path);
    }}
    onkeydown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleCollapsed(node.path);
      }
    }}
  >
    <span class="folder-caret" aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
    <svg class="folder-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path
        fill="currentColor"
        d="M10 4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6z"
      />
    </svg>
    {#if editingFolder === node.path}
      <input
        class="rename"
        bind:value={editValue}
        onblur={commitRenameFolder}
        onkeydown={(e) => onRenameKey(e, "folder")}
        onclick={(e) => e.stopPropagation()}
        use:autofocus
      />
    {:else}
      <span class="folder-name">{node.name}</span>
    {/if}
  </div>
  {#if !isCollapsed}
    {#if creatingFolderParent === node.path}
      {@render newFolderInput(node.depth + 1)}
    {/if}
    {#each node.items as c (c.id)}
      {@render row(c, node.depth + 1)}
    {/each}
    {#each node.children as child (child.path)}
      {@render folder(child)}
    {/each}
  {/if}
{/snippet}

{#snippet newFolderInput(depth: number)}
  <div class="folder ghost" style="--depth: {depth};">
    <span class="folder-caret" aria-hidden="true">▾</span>
    <svg class="folder-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path
        fill="currentColor"
        d="M10 4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6z"
      />
    </svg>
    <input
      class="rename"
      placeholder="Folder name"
      bind:value={newFolderName}
      onblur={commitCreateFolder}
      onkeydown={onCreateFolderKey}
      onclick={(e) => e.stopPropagation()}
      use:autofocus
    />
  </div>
{/snippet}

{#snippet row(c: ConversationMeta, depth: number)}
  <div
    class="row"
    class:active={c.id === activeId}
    class:dragging={isDragSource("item", c.id)}
    style="--depth: {depth};"
    role="button"
    tabindex="0"
    data-drop-path={c.path}
    onclick={() => handleRowClick(c.id)}
    onkeydown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(c.id);
      }
    }}
    oncontextmenu={(e) => openItemMenu(e, c.id)}
    onpointerdown={(e) => startItemDrag(e, c)}
    title={c.title}
  >
    {#if c.mode === "transcribe"}
      <svg
        class="mode-icon"
        viewBox="0 0 24 24"
        width="11"
        height="11"
        aria-label="Transcription session"
      >
        <path
          fill="currentColor"
          d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"
        />
      </svg>
    {/if}
    {#if editingId === c.id}
      <input
        class="rename"
        bind:value={editValue}
        onblur={commitRenameItem}
        onkeydown={(e) => onRenameKey(e, "item")}
        onclick={(e) => e.stopPropagation()}
        use:autofocus
      />
    {:else}
      <span class="title">{c.title}</span>
    {/if}
  </div>
{/snippet}

{#if menu}
  <!-- Click-outside catcher: click anywhere to dismiss the context menu. -->
  <button
    class="menu-scrim"
    aria-label="Close menu"
    onclick={closeMenu}
    oncontextmenu={(e) => {
      e.preventDefault();
      closeMenu();
    }}
  ></button>
  <div class="menu" style="left: {menu.x}px; top: {menu.y}px;">
    {#if menu.target.kind === "item"}
      {@const targetId = menu.target.id}
      <button onclick={() => startRenameItem(targetId)}>Rename</button>
      {@const item = items.find((c: ConversationMeta) => c.id === targetId)}
      {#if item && item.path}
        <button onclick={() => moveToRoot(targetId)}>Move to root</button>
      {/if}
      {#if moveTargets.length > 0}
        <div class="menu-divider"></div>
        <div class="menu-section-label">Push to device</div>
        {#each moveTargets as peer (peer.peer_id)}
          <button
            onclick={() => startMove(targetId, peer.peer_id, shortPeerLabel(peer.device_pubkey, peer.label))}
            title="Transfer this conversation to {peer.label || peer.device_pubkey.slice(0, 12)}"
          >
            → {shortPeerLabel(peer.device_pubkey, peer.label)}
          </button>
        {/each}
      {/if}
      <div class="menu-divider"></div>
      <button class="danger" onclick={() => deleteItemWithConfirm(targetId)}>Delete</button>
    {:else if menu.target.kind === "folder"}
      {@const targetPath = menu.target.path}
      <button onclick={() => startCreateFolder(targetPath)}>New subfolder</button>
      <button onclick={() => startRenameFolder(targetPath)}>Rename</button>
      <button class="danger" onclick={() => deleteFolderWithConfirm(targetPath)}>Delete</button>
    {:else if menu.target.kind === "remote-item"}
      {@const target = menu.target}
      <div class="menu-section-label">{target.title}</div>
      <button
        onclick={() => startPull(target.guid, target.peer_id, target.peer_label, target.title)}
        title="Move this conversation from {target.peer_label} onto this device"
      >
        ← Pull from {target.peer_label}
      </button>
    {:else if menu.target.kind === "peer"}
      {@const target = menu.target}
      <div class="menu-section-label">
        {target.peer_label}
        {#if target.status === "offline"}<span class="menu-section-tag">offline</span>{/if}
      </div>
      <button
        onclick={() => {
          closeMenu();
          void meshClient.reconnectPeer(target.peer_id);
        }}
        title={target.status === "offline"
          ? "Attempt to restore the connection by rejoining the mesh room"
          : "Re-send hello to this peer right now (bypasses the re-handshake backoff)"}
      >
        Refresh
      </button>
      {#if target.status !== "offline"}
        <button
          onclick={() => startFileSend(target.peer_id, target.peer_label)}
          title="Pick a file from your computer to ship to this peer over the mesh"
        >
          Send file…
        </button>
      {/if}
      <div class="menu-divider"></div>
      <button onclick={openMeshConnectionsSettings} title="Open Networks → Connections">
        Settings
      </button>
      {#if target.status === "offline"}
        <div class="menu-divider"></div>
        <button
          class="danger"
          onclick={() => {
            closeMenu();
            meshClient.forgetPeerCache(target.device_pubkey);
          }}
          title="Hide this offline peer's cached conversations until you see them again. Their actual data lives on their device — the cache rebuilds on next sight."
        >
          Forget cached view
        </button>
      {/if}
    {:else}
      {@const target = menu.target}
      {@const isActive = target.network.id === activeNetworkId}
      <div class="menu-section-label">{target.network.network_id}</div>
      {#if !isActive}
        <button onclick={() => switchToNetwork(target.network.id)} title="Stop the current mesh and join this one">
          Switch to this network
        </button>
      {/if}
      <button onclick={openMeshSettingsForNetwork} title="Open Networks → Status">
        Settings
      </button>
      <div class="menu-divider"></div>
      <button
        class="danger"
        onclick={() => {
          closeMenu();
          forgetModal = target.network;
        }}
        title="Remove from saved list and delete this network's roster"
      >
        Forget
      </button>
    {/if}
  </div>
{/if}

{#if moveInFlight}
  <!-- Transient toast while a Move is in flight. Source-side: the
       conversation is read, shipped over the data channel, and the
       local copy deleted on receiver-ack. Disappears when the
       promise settles. -->
  <div class="move-toast" role="status" aria-live="polite">
    Moving to {moveInFlight.label}…
  </div>
{/if}
{#if moveError}
  <div class="move-toast error" role="alert">
    Move failed: {moveError}
    <button onclick={() => (moveError = "")} class="dismiss">✕</button>
  </div>
{/if}

{#if pullInFlight}
  <!-- Pull-in-flight toast. The promise resolves once the payload
       has landed locally (handlePullByGuid in mesh-client) — until
       then, the conversation appears under the remote peer in the
       sidebar with a "moving…" pill. -->
  <div class="move-toast" role="status" aria-live="polite">
    Pulling {pullInFlight.label}…
  </div>
{/if}
{#if pullError}
  <div class="move-toast error" role="alert">
    Pull failed: {pullError}
    <button onclick={() => (pullError = "")} class="dismiss">✕</button>
  </div>
{/if}

<!-- Hidden file picker — opened by the per-peer "Send file…" menu
     item. Routed through a single shared input so we don't render
     N invisible inputs (one per connected peer). The target peer
     is stashed in `pendingFileTarget` before `.click()` so the
     change handler knows where to ship the bytes. -->
<input
  bind:this={fileInput}
  type="file"
  style="display:none"
  onchange={onFileChosen}
/>

{#if fileSendError}
  <div class="move-toast error" role="alert">
    {fileSendError}
    <button onclick={() => (fileSendError = "")} class="dismiss">✕</button>
  </div>
{/if}

<!-- Outgoing file transfers from meshClient.files.outbound. Each
     row shows the live byte count + progress bar so the user
     knows how far along the transfer is. Cleared automatically
     when the receiver acks `file_complete` or aborts. -->
{#if meshClient.files.outbound.length > 0}
  <div class="file-stack file-stack-out" role="status" aria-live="polite">
    {#each meshClient.files.outbound as f (f.id)}
      {@const pct = f.bytes_total > 0 ? Math.round((f.bytes_sent / f.bytes_total) * 100) : 0}
      <div class="file-toast file-toast-out">
        <div class="file-toast-head">
          <span class="file-toast-arrow">→</span>
          <span class="file-toast-name" title={f.filename}>{f.filename}</span>
          <span class="file-toast-meta">{f.peer_label} · {formatBytes(f.bytes_sent)} / {formatBytes(f.bytes_total)}</span>
        </div>
        <div class="file-toast-bar"><div class="file-toast-fill" style="width:{pct}%"></div></div>
        <div class="file-toast-status">{f.status === "offered" ? "awaiting accept…" : `${pct}%`}</div>
      </div>
    {/each}
  </div>
{/if}

<!-- Incoming offers: a sender has shipped us a `file_offer`. Each
     row mounts Save / Decline buttons; Save opens the OS save
     dialog and then accepts the offer, Decline drops it. -->
{#if inboundOffers.length > 0}
  <div class="file-stack file-stack-in" role="status" aria-live="polite">
    {#each inboundOffers as offer (offer.id)}
      <div class="file-toast file-toast-offer">
        <div class="file-toast-head">
          <span class="file-toast-arrow in">←</span>
          <span class="file-toast-name" title={offer.filename}>{offer.filename}</span>
          <span class="file-toast-meta">from {offer.peer_label} · {formatBytes(offer.size_bytes)}</span>
        </div>
        <div class="file-toast-actions">
          <button
            class="file-toast-btn primary"
            onclick={() => meshClient.acceptInboundFile(offer.id)}
            title="Open save dialog and accept the transfer"
          >
            Save as…
          </button>
          <button
            class="file-toast-btn ghost"
            onclick={() => meshClient.declineInboundFile(offer.id)}
            title="Tell the sender we're not accepting this file"
          >
            Decline
          </button>
        </div>
      </div>
    {/each}
  </div>
{/if}

<!-- Inbound transfers currently streaming. Pure progress display;
     declining or accepting happens via the inboundOffers stack
     above. -->
{#if meshClient.files.inbound.length > 0}
  <div class="file-stack file-stack-in" role="status" aria-live="polite">
    {#each meshClient.files.inbound as f (f.id)}
      {@const pct = f.bytes_total > 0 ? Math.round((f.bytes_received / f.bytes_total) * 100) : 0}
      <div class="file-toast file-toast-in">
        <div class="file-toast-head">
          <span class="file-toast-arrow in">←</span>
          <span class="file-toast-name" title={f.filename}>{f.filename}</span>
          <span class="file-toast-meta">{f.peer_label} · {formatBytes(f.bytes_received)} / {formatBytes(f.bytes_total)}</span>
        </div>
        <div class="file-toast-bar"><div class="file-toast-fill" style="width:{pct}%"></div></div>
        <div class="file-toast-status">{pct}%</div>
      </div>
    {/each}
  </div>
{/if}

{#if forgetModal}
  {@const target = forgetModal}
  <div class="forget-overlay" onclick={() => (forgetModal = null)} role="presentation"></div>
  <div class="forget-modal" role="dialog" aria-label="Forget network">
    <h3>Forget "{target.network_id}"?</h3>
    <p>
      Removes this network from your saved list and deletes its
      roster file. Re-adding the same Network ID later starts fresh
      — no auto-allow for previously-approved peers.
    </p>
    {#if target.id === activeNetworkId}
      <p class="soft">
        This is the currently active network. Forgetting it will
        stop the mesh client.
      </p>
    {/if}
    <div class="forget-actions">
      <button class="cancel" onclick={() => (forgetModal = null)}>Cancel</button>
      <button class="delete" onclick={() => forgetNetwork(target)}>Forget</button>
    </div>
  </div>
{/if}

{#if deletePrompt}
  <!-- Non-native delete confirmation. Modelled on the existing
       inline modals in StorageSection / ModelsSection / App's conflict
       modal — no Tauri native dialog, so it works on every platform
       without needing `dialog:allow-confirm` in capabilities. -->
  <button
    class="delete-prompt-scrim"
    aria-label="Cancel delete"
    onclick={() => (deletePrompt = null)}
  ></button>
  <div class="delete-prompt" role="dialog" aria-label={deletePrompt.title}>
    <h3>{deletePrompt.title}</h3>
    <p>{deletePrompt.body}</p>
    <div class="delete-prompt-actions">
      <button class="cancel" onclick={() => (deletePrompt = null)}>Cancel</button>
      <button
        class="delete"
        onclick={() => {
          const p = deletePrompt;
          deletePrompt = null;
          p?.proceed();
        }}
      >
        Delete
      </button>
    </div>
  </div>
{/if}

{#if drag && drag.active}
  <div
    class="drag-ghost"
    style="left: {drag.x - drag.offsetX}px; top: {drag.y - drag.offsetY}px;"
    aria-hidden="true"
  >
    {#if drag.src.kind === "folder"}
      <svg viewBox="0 0 24 24" width="13" height="13">
        <path
          fill="currentColor"
          d="M10 4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6z"
        />
      </svg>
    {:else if drag.src.mode === "transcribe"}
      <svg viewBox="0 0 24 24" width="11" height="11">
        <path
          fill="currentColor"
          d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"
        />
      </svg>
    {/if}
    <span class="drag-ghost-label">{srcLabel(drag.src)}</span>
  </div>
{/if}

<style>
  .sidebar {
    width: 260px;
    flex-shrink: 0;
    background: #0b0b0b;
    border-right: 1px solid #1a1a1a;
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    transition: margin-left .18s ease, width .18s ease;
    /* Sidebar text isn't user content — clicks and right-clicks should
     * never start a selection. Inputs below opt back in. */
    user-select: none;
    -webkit-user-select: none;
  }
  .sidebar:not(.open) {
    margin-left: -260px;
    width: 260px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: .35rem;
    padding: .45rem .5rem;
    border-bottom: 1px solid #161616;
  }
  .new {
    flex: 1;
    display: flex;
    align-items: center;
    gap: .4rem;
    background: none;
    border: 1px solid #2a2a2a;
    color: #ccc;
    padding: .35rem .55rem;
    border-radius: 7px;
    font-size: .8rem;
    cursor: pointer;
    transition: border-color .12s, color .12s, background .12s;
  }
  .new:hover { border-color: #3a3a55; color: #fff; background: #131320; }
  .folder-btn,
  .collapse {
    background: none;
    border: none;
    color: #666;
    cursor: pointer;
    padding: .25rem .35rem;
    border-radius: 5px;
    display: flex;
    align-items: center;
  }
  .folder-btn:hover,
  .collapse:hover { background: #1a1a1a; color: #ccc; }
  .list {
    flex: 1;
    overflow-y: auto;
    padding: .35rem .25rem .5rem .25rem;
  }
  .list.drop-root {
    background: rgba(110, 110, 247, .04);
    box-shadow: inset 0 0 0 1px rgba(110, 110, 247, .35);
    border-radius: 8px;
  }
  .empty {
    color: #555;
    font-size: .78rem;
    padding: .75rem;
    text-align: center;
  }
  .group-label {
    font-size: .68rem;
    text-transform: uppercase;
    letter-spacing: .04em;
    color: #555;
    padding: .55rem .65rem .25rem .65rem;
  }

  /* Network section — peer groups below the local conversation
     tree. Each peer is a row that toggles a collapsed flag,
     wrapping a list of remote conversations rendered as .row.remote
     children. */
  .network-divider {
    margin: .55rem .45rem .15rem .45rem;
    height: 1px;
    background: #181818;
  }
  /* Network-section header: label on the left, "+ Add" button on
     the right. Always visible — even with zero saved networks the
     button is present so the empty-state guidance has somewhere
     to point. */
  .network-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-right: .55rem;
  }
  .group-label.network-label {
    color: #6a7a99;
    letter-spacing: .06em;
  }
  .network-settings-btn {
    background: none;
    border: none;
    color: #666;
    border-radius: 4px;
    padding: .2rem .35rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    line-height: 0;
    transition: background .12s, color .12s;
  }
  .network-settings-btn:hover { background: #1a1a1a; color: #ccc; }

  .network-empty {
    padding: .35rem .65rem .35rem .65rem;
    font-size: .72rem;
    color: #666;
    line-height: 1.5;
  }
  .network-empty .link {
    background: none;
    border: none;
    color: #b9c9ee;
    padding: 0;
    font-size: inherit;
    cursor: pointer;
    text-decoration: underline;
  }
  .network-empty.network-empty-active {
    padding-left: 1.35rem;
    font-style: italic;
  }
  .network-error {
    margin: .35rem .55rem;
    padding: .35rem .55rem;
    background: #2a1818;
    border: 1px solid #4a2424;
    color: #f88;
    border-radius: 5px;
    font-size: .72rem;
    display: flex;
    align-items: center;
    gap: .35rem;
  }
  .network-error .dismiss {
    margin-left: auto;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0 .25rem;
    opacity: .75;
  }
  .network-error .dismiss:hover { opacity: 1; }

  /* Network-row (one per saved network). Active gets a green left
     border + brighter text; inactive is muted with a hover hint so
     it reads as "click to switch." */
  .network-group {
    display: flex;
    align-items: center;
    gap: .35rem;
    padding: .35rem .45rem;
    margin: 1px 0;
    border-radius: 6px;
    color: #aaa;
    font-size: .8rem;
    cursor: pointer;
    transition: background .1s;
  }
  .network-group:hover { background: #161616; color: #ccc; }
  .network-group.active-network {
    color: #e8e8e8;
    border-left: 2px solid #2c8e4e;
    padding-left: calc(.45rem - 2px);
  }
  .net-row-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .net-row-active {
    font-size: .58rem;
    text-transform: uppercase;
    letter-spacing: .06em;
    background: #122212;
    color: #6c6;
    padding: .05rem .35rem;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .net-row-unlocked {
    font-size: .58rem;
    text-transform: uppercase;
    letter-spacing: .06em;
    background: #2a220e;
    color: #d6b25a;
    padding: .05rem .35rem;
    border-radius: 3px;
    flex-shrink: 0;
  }

  /* Forget-network modal — local to the sidebar so it sits above
     the sidebar without prop-drilling through App. Mirrors the
     delete-prompt modal styling already used by deleteFolderWithConfirm. */
  .forget-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    z-index: 50;
  }
  .forget-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(420px, 90vw);
    background: #161616;
    border: 1px solid #2a2a2a;
    border-radius: 10px;
    padding: 1.1rem 1.2rem;
    z-index: 51;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
  }
  .forget-modal h3 {
    font-size: 0.95rem;
    font-weight: 600;
    margin: 0 0 0.6rem 0;
    color: #fff;
  }
  .forget-modal p {
    font-size: 0.82rem;
    color: #ccc;
    line-height: 1.55;
    margin: 0 0 0.5rem 0;
  }
  .forget-modal p.soft { color: #888; font-size: 0.78rem; }
  .forget-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.85rem;
  }
  .forget-actions button {
    padding: 0.4rem 0.9rem;
    border-radius: 6px;
    font-size: 0.8rem;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .forget-actions .cancel { background: #1e1e1e; color: #ccc; border-color: #2a2a2a; }
  .forget-actions .cancel:hover { background: #252525; }
  .forget-actions .delete { background: #5a2424; color: #fee; border-color: #6a3030; }
  .forget-actions .delete:hover { background: #6a2c2c; }

  .peer-group {
    display: flex;
    align-items: center;
    gap: .35rem;
    padding: .35rem .45rem;
    margin: 1px 0;
    border-radius: 6px;
    color: #ccc;
    font-size: .8rem;
    cursor: pointer;
    transition: background .1s;
  }
  .peer-group:hover { background: #161616; }
  .peer-group.standby { opacity: .75; }
  /* Offline rostered peers render with a cached catalog snapshot so
     the user keeps seeing the device's conversations across a
     disconnect cycle. Dim hard enough that the row reads as
     "this is stale" — distinguishes from active and shelved at a
     glance without needing to look at the dot color. */
  .peer-group.offline { opacity: .5; }
  .peer-group.offline:hover { opacity: .7; }
  .peer-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #6c6;
    flex-shrink: 0;
    box-shadow: 0 0 5px rgba(102, 204, 102, 0.5);
  }
  .peer-dot[data-status="shelved"] {
    background: #b9c9ee;
    box-shadow: 0 0 5px rgba(185, 201, 238, 0.5);
  }
  .peer-dot[data-status="offline"] {
    background: #555;
    box-shadow: none;
  }
  .peer-group-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .peer-group-suffix {
    font-family: monospace;
    font-size: .68rem;
    font-weight: 700;
    color: #b9c9ee;
    letter-spacing: .04em;
    flex-shrink: 0;
  }
  .peer-standby-pill {
    font-size: .55rem;
    text-transform: uppercase;
    letter-spacing: .06em;
    background: #1a1e2a;
    color: #b9c9ee;
    border-radius: 3px;
    padding: .05rem .3rem;
    flex-shrink: 0;
  }
  .peer-offline-pill {
    font-size: .55rem;
    text-transform: uppercase;
    letter-spacing: .06em;
    background: #1e1e1e;
    color: #888;
    border-radius: 3px;
    padding: .05rem .3rem;
    flex-shrink: 0;
  }
  .peer-version-pill {
    font-size: .55rem;
    background: #221218;
    color: #d6a09c;
    border-radius: 3px;
    padding: .05rem .3rem;
    flex-shrink: 0;
    cursor: help;
    letter-spacing: .02em;
  }
  .peer-empty {
    font-size: .72rem;
    color: #555;
    font-style: italic;
    padding: .25rem .65rem .35rem 1.45rem;
  }
  /* Remote rows inherit the same depth-based padding-left math as
     local .row entries (via --depth). The peer's "root" items get
     --depth: 1 so they sit under the peer-group header; items
     inside the peer's folders get --depth: folder_depth + 2, the
     same nesting feel as the local sidebar. */
  .row.remote { color: #ccc; }
  .row.remote:hover { background: #131820; }
  .row.remote.pending-move { opacity: .65; }
  /* Remote folders match the local folder styling so the peer's
     tree visually reads as "their version of the same sidebar." */
  .folder.remote-folder { color: #ccc; }
  .folder.remote-folder:hover { background: #131820; }
  .moving-pill {
    font-size: .58rem;
    text-transform: uppercase;
    letter-spacing: .06em;
    color: #d6b25a;
    background: #2a220e;
    border-radius: 3px;
    padding: .05rem .3rem;
    margin-left: auto;
    flex-shrink: 0;
  }
  .folder {
    display: flex;
    align-items: center;
    gap: .35rem;
    padding: .35rem .45rem .35rem calc(.45rem + var(--depth, 0) * .9rem);
    margin: 1px 0;
    border-radius: 6px;
    color: #ccc;
    font-size: .8rem;
    cursor: pointer;
    transition: background .1s;
  }
  .folder:hover { background: #161616; }
  .folder.drop-target {
    background: rgba(110, 110, 247, .1);
    box-shadow: inset 0 0 0 1px #6e6ef7;
  }
  .folder.dragging,
  .row.dragging {
    opacity: .4;
  }
  .folder-caret {
    width: 10px;
    color: #666;
    font-size: .7rem;
    text-align: center;
    flex-shrink: 0;
  }
  .folder-icon {
    color: #d4a64a;
    flex-shrink: 0;
  }
  .folder-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .row {
    display: flex;
    align-items: center;
    gap: .35rem;
    padding: .4rem .55rem .4rem calc(.55rem + var(--depth, 0) * .9rem + .85rem);
    margin: 1px 0;
    border-radius: 6px;
    color: #bbb;
    font-size: .82rem;
    cursor: pointer;
    overflow: hidden;
    transition: background .1s, color .1s;
  }
  .row:hover { background: #161616; color: #e8e8e8; }
  .row.active { background: #1c1c2e; color: #fff; }
  .mode-icon {
    color: #6e6ef7;
    flex-shrink: 0;
  }
  .row .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .rename {
    flex: 1;
    background: #1a1a1a;
    border: 1px solid #3a3a55;
    color: #fff;
    padding: .25rem .4rem;
    border-radius: 5px;
    font-size: .82rem;
    font-family: inherit;
    user-select: text;
    -webkit-user-select: text;
  }
  .rename:focus { outline: none; border-color: #6e6ef7; }

  .menu-scrim {
    position: fixed;
    inset: 0;
    background: transparent;
    border: none;
    z-index: 50;
    cursor: default;
  }
  .menu {
    position: fixed;
    z-index: 51;
    background: #131320;
    border: 1px solid #2a2a3a;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    padding: .25rem;
    display: flex;
    flex-direction: column;
    min-width: 160px;
  }
  .menu button {
    text-align: left;
    background: none;
    border: none;
    color: #e8e8e8;
    font: inherit;
    font-size: .82rem;
    padding: .4rem .6rem;
    border-radius: 5px;
    cursor: pointer;
  }
  .menu button:hover { background: #1f1f33; }
  .menu button.danger { color: #ff8b8b; }
  .menu button.danger:hover { background: #2a1818; }
  .menu-divider {
    height: 1px;
    background: #2a2a3a;
    margin: 0.25rem 0;
  }
  .menu-section-label {
    font-size: 0.66rem;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0.3rem 0.6rem 0.15rem;
  }
  .menu-section-tag {
    margin-left: 0.35rem;
    font-size: 0.55rem;
    background: #222;
    color: #888;
    border-radius: 3px;
    padding: 0.05rem 0.3rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .move-toast {
    position: fixed;
    bottom: 1rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 60;
    background: #1a1a2a;
    border: 1px solid #2a2a3a;
    color: #b9b9ee;
    padding: 0.5rem 0.85rem;
    border-radius: 7px;
    font-size: 0.82rem;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .move-toast.error {
    background: #2a1a1a;
    border-color: #5a2a2a;
    color: #f88;
  }
  .move-toast .dismiss {
    background: none;
    border: none;
    color: inherit;
    font-size: 0.9rem;
    cursor: pointer;
    opacity: 0.7;
    padding: 0 0.25rem;
  }
  .move-toast .dismiss:hover { opacity: 1; }

  /* File transfer toasts — stacked at the bottom-right so they
     don't collide with the move/pull toast at bottom-center. Each
     file gets its own row so a multi-transfer batch reads
     vertically. */
  .file-stack {
    position: fixed;
    right: 1rem;
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: .35rem;
    max-width: 320px;
  }
  .file-stack-out { bottom: 1rem; }
  .file-stack-in { bottom: 1rem; right: auto; left: 1rem; }
  .file-toast {
    background: #15151f;
    border: 1px solid #2a2a3a;
    color: #d6d6ef;
    padding: .55rem .7rem;
    border-radius: 8px;
    font-size: .78rem;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.55);
    display: flex;
    flex-direction: column;
    gap: .35rem;
  }
  .file-toast-offer { border-color: #4a4a3a; background: #232a1f; }
  .file-toast-in { border-color: #2a4a4a; background: #1a2a2a; color: #c8e8e8; }
  .file-toast-out { border-color: #2a3a4a; background: #1a2030; color: #c8d6ee; }
  .file-toast-head {
    display: flex;
    align-items: center;
    gap: .35rem;
    flex-wrap: wrap;
  }
  .file-toast-arrow { font-weight: bold; color: #b9c9ee; }
  .file-toast-arrow.in { color: #b9eec9; }
  .file-toast-name { font-weight: 600; word-break: break-all; flex: 1; min-width: 0; }
  .file-toast-meta { color: #888; font-size: .72rem; }
  .file-toast-status { color: #888; font-size: .72rem; text-align: right; }
  .file-toast-bar {
    height: 4px;
    background: #2a2a3a;
    border-radius: 3px;
    overflow: hidden;
  }
  .file-toast-fill {
    height: 100%;
    background: linear-gradient(90deg, #6e6ef7, #b96eef);
    transition: width .14s linear;
  }
  .file-toast-actions {
    display: flex;
    gap: .35rem;
    justify-content: flex-end;
  }
  .file-toast-btn {
    background: none;
    border: 1px solid #3a3a55;
    color: #ccc;
    padding: .25rem .55rem;
    border-radius: 5px;
    font-size: .76rem;
    cursor: pointer;
    transition: background .12s, border-color .12s;
  }
  .file-toast-btn:hover { background: #1a1a2a; border-color: #5a5a7a; color: #fff; }
  .file-toast-btn.primary { background: #2a2a5a; border-color: #4a4a7a; color: #d8d8ff; }
  .file-toast-btn.primary:hover { background: #3a3a7a; }
  .file-toast-btn.ghost { color: #aaa; }

  /* Pointer-following ghost while dragging. Position is updated from the
   * pointermove handler; pointer-events:none keeps it from blocking
   * elementFromPoint hit-testing. The double box-shadow gives the
   * "stack of cards" feel without needing extra DOM nodes. */
  .drag-ghost {
    position: fixed;
    z-index: 60;
    pointer-events: none;
    display: flex;
    align-items: center;
    gap: .35rem;
    padding: .35rem .55rem;
    background: #1c1c2e;
    color: #fff;
    border: 1px solid #3a3a55;
    border-radius: 6px;
    font-size: .82rem;
    max-width: 240px;
    box-shadow:
      0 6px 14px rgba(0, 0, 0, 0.5),
      4px 4px 0 -1px #131320,
      4px 4px 0 0 #2a2a3a;
    opacity: .96;
  }
  .drag-ghost-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .delete-prompt-scrim {
    position: fixed; inset: 0; background: rgba(0, 0, 0, .65); z-index: 40;
    border: none; padding: 0; cursor: default;
  }
  .delete-prompt {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(380px, 90vw);
    background: #161616; border: 1px solid #2a2a2a; border-radius: 10px;
    padding: 1rem 1.1rem; z-index: 41;
    box-shadow: 0 12px 40px rgba(0, 0, 0, .6);
  }
  .delete-prompt h3 {
    font-size: .9rem; font-weight: 600; margin-bottom: .5rem;
    overflow: hidden; text-overflow: ellipsis;
  }
  .delete-prompt p { font-size: .82rem; color: #c4c4c4; margin-bottom: .75rem; }
  .delete-prompt-actions {
    display: flex; gap: .5rem; justify-content: flex-end;
  }
  .delete-prompt-actions button {
    padding: .4rem .8rem; border-radius: 5px; border: 1px solid #2a2a2a;
    background: #1d1d1d; color: #e8e8e8; cursor: pointer; font-size: .82rem;
  }
  .delete-prompt-actions .cancel:hover { background: #232323; }
  .delete-prompt-actions .delete {
    background: #3a1818; border-color: #5a2c2c; color: #ff8b8b;
  }
  .delete-prompt-actions .delete:hover { background: #4a2020; }
</style>
