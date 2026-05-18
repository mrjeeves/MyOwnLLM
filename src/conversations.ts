import {
  readTextFile,
  writeTextFile,
  exists,
  mkdir,
  readDir,
  remove,
  rename,
  stat,
  type DirEntry,
} from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { loadConfig } from "./config";
import type { Mode } from "./types";

/**
 * One turn of a chat. Mirrors the in-memory `Message` shape used by the
 * chat panel; persisted to JSON so reloading a conversation is a verbatim
 * round-trip (including `thinking` blocks from reasoning models).
 */
export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
}

/** One unit of transcribed speech. Mirrors `transcribe::EmittedSegment`
 *  in `src-tauri/src/transcribe.rs`. Speaker IDs are local to the
 *  conversation — they're stable within one session (assigned by the
 *  online clusterer as voices come in) and renameable via
 *  `speaker_labels`, but they don't carry across conversations. */
export interface TranscriptSegment {
  start_ms: number;
  end_ms: number;
  text: string;
  /** Cluster ID from the diarize worker. `undefined` when diarization
   *  is off or when the segment fell outside any reported turn. */
  speaker?: number;
  /** `true` when pyannote reported overlapping speakers in this
   *  segment's timing window — the text is usually garbled and the UI
   *  flags it visually but doesn't try to split. */
  overlap?: boolean;
  /** `true` while the segment's speaker assignment is still
   *  provisional (cold-start cluster warm-up window). */
  provisional?: boolean;
}

/** A whole conversation as it lives on disk (one JSON file per conversation).
 *  The folder it lives in is the source of truth for its grouping — we don't
 *  store a `folder` field, the directory it sits under IS the folder. */
export interface Conversation {
  id: string;
  title: string;
  /** `text` or `transcribe` — the only modes the post-redesign UI exposes. */
  mode: Mode;
  /** Last model used. Stored for display / future reuse, not for routing. */
  model: string;
  /** Family at the time of last write. */
  family: string;
  created_at: string;
  updated_at: string;
  messages: StoredMessage[];
  /** Transcribe-mode artifacts. Empty / absent for text-mode
   *  conversations. Each segment carries timing + optional speaker
   *  ID; the UI renders them grouped by consecutive same-speaker
   *  runs. */
  transcript?: TranscriptSegment[];
  /** User-renamed display names for cluster IDs the diarize worker
   *  emitted. Sparse — only contains IDs the user has explicitly
   *  renamed; the renderer falls back to "Speaker N" otherwise. */
  speaker_labels?: Record<number, string>;
  /** Whether diarization was enabled for this conversation. Persisted
   *  so a re-open resumes with the toggle in the right state. */
  diarize_enabled?: boolean;
  /** Whether the user has requested reasoning / "thinking" tokens
   *  for this conversation. Drives the `think` flag we pass to the
   *  local `ollama_chat_stream` and to the mesh's
   *  `infer_request.think`. Sticky per-conversation so a chat
   *  that's been deliberately set to "reason more carefully" keeps
   *  doing that across reloads. Optional — undefined = off, the
   *  pre-thinking-toggle default. */
  thinking_enabled?: boolean;
  talking_points?: string[];
  /** One-step undo buffer for talking points. Populated when the user
   *  regenerates: the prior `talking_points` array is stashed here so the
   *  Undo button can swap it back. Cleared after undo (single-level
   *  undo — discard, not stack). */
  talking_points_prev?: string[];
}

/** Lightweight projection used by the sidebar list — avoids reading every
 *  message body just to render N rows of titles. */
export interface ConversationMeta {
  id: string;
  title: string;
  mode: Mode;
  updated_at: string;
  /** Folder path from the conversations root (POSIX-style, no leading slash).
   *  Empty string = root. e.g. "Work/Projects". */
  path: string;
}

/** Folder entry, derived from the on-disk directory tree. */
export interface FolderMeta {
  /** Path from the conversations root, POSIX-style. e.g. "Work/Projects". */
  path: string;
}

async function conversationsDir(): Promise<string> {
  const cfg = await loadConfig();
  if (cfg.conversation_dir) return cfg.conversation_dir;
  const home = await homeDir();
  return `${home}/.myownllm/conversations`;
}

async function ensureDir(): Promise<string> {
  const dir = await conversationsDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Crockford-ish base36 id. Time-prefixed so directory listings sort
 *  chronologically without a separate index file. */
export function newConversationId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/** Reject path components that would escape the conversations root or break
 *  the sidebar (`..`, separators, hidden dotfiles). Names are otherwise free
 *  so users can drag in human-readable folder labels. */
export function sanitizeFolderName(name: string): string {
  return name
    .replace(/[/\\\x00-\x1f]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 80);
}

/** Split a POSIX-style path into components, dropping empties and `..`s. */
function splitPath(path: string): string[] {
  return path
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p && p !== "." && p !== "..");
}

function joinPath(parts: string[]): string {
  return parts.join("/");
}

interface WalkEntry {
  /** Absolute filesystem path of the .json file. */
  fullPath: string;
  /** Folder path from root (POSIX-style, "" for root). */
  folderPath: string;
}

/** Depth-first walk of the conversations tree. Skips entries we can't read
 *  rather than throwing — a single malformed subdir shouldn't break listing. */
async function walkTree(root: string): Promise<{
  files: WalkEntry[];
  folders: string[];
}> {
  const files: WalkEntry[] = [];
  const folders: string[] = [];
  async function visit(absDir: string, relPath: string) {
    let entries: DirEntry[];
    try {
      entries = await readDir(absDir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.name) continue;
      // Skip dotfiles / dotdirs so users editing on disk can stash notes
      // (`.DS_Store`, `.git`, etc.) without polluting the sidebar.
      if (e.name.startsWith(".")) continue;
      const childAbs = `${absDir}/${e.name}`;
      const childRel = relPath ? `${relPath}/${e.name}` : e.name;
      if (e.isDirectory) {
        folders.push(childRel);
        await visit(childAbs, childRel);
      } else if (e.isFile && e.name.endsWith(".json")) {
        files.push({ fullPath: childAbs, folderPath: relPath });
      }
    }
  }
  await visit(root, "");
  return { files, folders };
}

/** Sidebar feed. Returns most-recent first across the whole tree. Each row
 *  carries its folder path so the sidebar can render the nested layout
 *  without a second walk. */
export async function listConversations(): Promise<{
  conversations: ConversationMeta[];
  folders: FolderMeta[];
}> {
  let dir: string;
  try {
    dir = await ensureDir();
  } catch {
    return { conversations: [], folders: [] };
  }
  const { files, folders } = await walkTree(dir);
  const conversations: ConversationMeta[] = [];
  for (const f of files) {
    try {
      const raw = await readTextFile(f.fullPath);
      const c = JSON.parse(raw) as Conversation;
      if (!c.id) continue;
      conversations.push({
        id: c.id,
        title: c.title || "Untitled",
        mode: c.mode,
        updated_at: c.updated_at || c.created_at || "",
        path: f.folderPath,
      });
    } catch {
      // Skip unreadable / unparseable files.
    }
  }
  conversations.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  folders.sort();
  return {
    conversations,
    folders: folders.map((path) => ({ path })),
  };
}

/** Find the on-disk path of a conversation by id. We walk because the file
 *  may live in any subfolder; the index is small enough that walking on
 *  every load is cheap, and avoids a stale-cache class of bug. */
async function findConversationPath(id: string): Promise<string | null> {
  let dir: string;
  try {
    dir = await conversationsDir();
  } catch {
    return null;
  }
  const target = `${id}.json`;
  const { files } = await walkTree(dir);
  for (const f of files) {
    if (f.fullPath.endsWith(`/${target}`)) return f.fullPath;
  }
  return null;
}

/** Resolve `{convDir}/{folder}/{id}.json`, creating the folder if needed. */
async function pathFor(folder: string, id: string): Promise<string> {
  const root = await ensureDir();
  const parts = splitPath(folder);
  if (parts.length === 0) return `${root}/${id}.json`;
  const folderAbs = `${root}/${joinPath(parts)}`;
  await mkdir(folderAbs, { recursive: true });
  return `${folderAbs}/${id}.json`;
}

export async function loadConversation(id: string): Promise<Conversation | null> {
  try {
    const path = await findConversationPath(id);
    if (!path) return null;
    const c = JSON.parse(await readTextFile(path)) as Conversation;
    return migrateConversationInPlace(c);
  } catch {
    return null;
  }
}

/** v13 migration: pre-diarize transcripts were stored as a single
 *  `transcript: string`; the new shape is `TranscriptSegment[]`. We
 *  wrap legacy strings as a single zero-timestamped segment on load
 *  so old conversations keep showing their text. The migration is
 *  in-place and lazy: the next `saveConversation` writes the new
 *  shape, but unedited legacy files are never rewritten unnecessarily. */
function migrateConversationInPlace(c: Conversation): Conversation {
  // svelte-check infers `transcript` as `TranscriptSegment[] | undefined`
  // from the interface; the legacy disk form sneaks in as `string` and
  // we explicitly cast to a wider type to detect it.
  const raw = (c as unknown as { transcript?: TranscriptSegment[] | string })
    .transcript;
  if (typeof raw === "string") {
    if (raw.trim().length > 0) {
      c.transcript = [{ start_ms: 0, end_ms: 0, text: raw }];
    } else {
      c.transcript = [];
    }
  }
  return c;
}

/** Sibling-file paths for a conversation's talking-points artifacts. The
 *  `.md` is a human-readable rendering kept in sync with `talking_points`;
 *  the `.prev.md` mirrors the one-step undo buffer (`talking_points_prev`).
 *  Both live in the same folder as the `.json` so a folder move or rename
 *  takes them along for free. */
function tpMdPath(jsonPath: string): string {
  return jsonPath.replace(/\.json$/, ".talking-points.md");
}

function tpPrevMdPath(jsonPath: string): string {
  return jsonPath.replace(/\.json$/, ".talking-points.prev.md");
}

/** Render a bullet list to markdown. Includes the session title and the
 *  generation timestamp at the top so a downloaded file is self-describing
 *  without needing the surrounding session JSON. */
function renderTalkingPointsMd(
  c: Conversation,
  points: string[],
  label: string,
): string {
  const title = c.title || "Untitled session";
  const ts = c.updated_at || new Date().toISOString();
  const body = points.map((p) => `- ${p}`).join("\n");
  return `# ${title}\n\n_${label} · ${ts}_\n\n${body}\n`;
}

/** Write or remove a sidecar `.md` so disk state matches `points`.
 *  Removing on empty keeps the folder tidy — a session that bottoms out
 *  to zero bullets shouldn't leave a stale .md sitting next to the JSON. */
async function syncMdSidecar(
  mdPath: string,
  c: Conversation,
  points: string[] | undefined,
  label: string,
): Promise<void> {
  if (points && points.length > 0) {
    await writeTextFile(mdPath, renderTalkingPointsMd(c, points, label));
    return;
  }
  if (await exists(mdPath)) await remove(mdPath);
}

/** Persist `c` under its current folder, falling back to `targetFolder` (or
 *  the root) if no existing file is found. Existing files keep their folder
 *  unless the caller explicitly moves them via `moveConversation`. */
export async function saveConversation(
  c: Conversation,
  targetFolder = "",
): Promise<void> {
  c.updated_at = new Date().toISOString();
  const existing = await findConversationPath(c.id);
  let path: string;
  if (existing) {
    path = existing;
  } else {
    path = await pathFor(targetFolder, c.id);
  }
  // Pretty-printed: these files are small and users may want to grep them.
  await writeTextFile(path, JSON.stringify(c, null, 2));
  await syncMdSidecar(tpMdPath(path), c, c.talking_points, "Talking points");
  await syncMdSidecar(
    tpPrevMdPath(path),
    c,
    c.talking_points_prev,
    "Talking points (previous)",
  );
}

export async function deleteConversation(id: string): Promise<void> {
  try {
    const path = await findConversationPath(id);
    if (!path) return;
    // Talking-points sidecars travel with the session — clear them out
    // alongside the JSON so a delete doesn't leave orphaned .md files
    // behind in whatever folder the session lived in.
    const md = tpMdPath(path);
    if (await exists(md)) await remove(md);
    const prevMd = tpPrevMdPath(path);
    if (await exists(prevMd)) await remove(prevMd);
    if (await exists(path)) await remove(path);
    // Folders are independent entities — deleting the last chat in a
    // folder leaves the folder in place. Only `deleteFolder` removes them.
  } catch {
    // Silent — caller already removed the row from the sidebar.
  }
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const c = await loadConversation(id);
  if (!c) return;
  c.title = title.trim().slice(0, 80) || "Untitled";
  await saveConversation(c);
}

/** Move a conversation file into the target folder (POSIX path from root,
 *  empty string for root). Creates the folder if needed; no-ops when the
 *  file is already there. The source folder is left in place even if the
 *  move empties it — folders are independent of their contents. */
export async function moveConversation(id: string, targetFolder: string): Promise<void> {
  const current = await findConversationPath(id);
  if (!current) return;
  const targetPath = await pathFor(targetFolder, id);
  if (current === targetPath) return;
  await rename(current, targetPath);
  // Drag the talking-points sidecars along with the JSON. Without this
  // they'd be stranded in the old folder and `findConversationPath` could
  // never reunite them with the moved session.
  for (const sidecar of [tpMdPath, tpPrevMdPath]) {
    const oldMd = sidecar(current);
    const newMd = sidecar(targetPath);
    if (await exists(oldMd)) {
      try {
        await rename(oldMd, newMd);
      } catch {
        // Best-effort: a missing sidecar shouldn't fail the move.
      }
    }
  }
}

/** Create an empty folder at `path` (POSIX, from root). Components are
 *  sanitized to keep filesystem-hostile names out of the tree. */
export async function createFolder(path: string): Promise<void> {
  const root = await ensureDir();
  const parts = splitPath(path).map(sanitizeFolderName).filter(Boolean);
  if (parts.length === 0) return;
  await mkdir(`${root}/${joinPath(parts)}`, { recursive: true });
}

/** Rename / move a folder. Children move along with it because they live
 *  under the directory inode. Any old-parent folders left behind are kept
 *  in place — they're independent entities the user created. */
export async function renameFolder(oldPath: string, newPath: string): Promise<void> {
  const root = await ensureDir();
  const oldParts = splitPath(oldPath);
  const newParts = splitPath(newPath).map(sanitizeFolderName).filter(Boolean);
  if (oldParts.length === 0 || newParts.length === 0) return;
  const oldAbs = `${root}/${joinPath(oldParts)}`;
  const newAbs = `${root}/${joinPath(newParts)}`;
  if (oldAbs === newAbs) return;
  // Make sure the destination's parent exists so we can drop it in.
  if (newParts.length > 1) {
    await mkdir(`${root}/${joinPath(newParts.slice(0, -1))}`, { recursive: true });
  }
  await rename(oldAbs, newAbs);
}

/** Delete a folder and everything under it. Use with caution — there's no
 *  trash; the sidebar gates this behind a confirm dialog. Only the named
 *  folder is removed; parent folders are left alone even if this empties
 *  them, since folders are independent entities. */
export async function deleteFolder(path: string): Promise<void> {
  const root = await ensureDir();
  const parts = splitPath(path);
  if (parts.length === 0) return; // Refuse to delete the root itself.
  const abs = `${root}/${joinPath(parts)}`;
  try {
    await remove(abs, { recursive: true });
  } catch {
    // Best-effort: caller already updated the UI.
  }
}

/** Swap `talking_points` with `talking_points_prev` (single-level undo).
 *  No-op if there's no previous version. Returns the updated conversation
 *  so the caller can refresh its local mirror in one round-trip. */
export async function undoTalkingPoints(id: string): Promise<Conversation | null> {
  const c = await loadConversation(id);
  if (!c) return null;
  const prev = c.talking_points_prev;
  if (!prev || prev.length === 0) return c;
  // Swap rather than discard: this lets the same button toggle back and
  // forth between the two versions until the user is happy, instead of
  // losing whichever side they're not currently looking at.
  const cur = c.talking_points ?? [];
  c.talking_points = prev;
  c.talking_points_prev = cur.length > 0 ? cur : undefined;
  await saveConversation(c);
  return c;
}

/** Persist `nextPoints` as the new current TP set, archiving whatever was
 *  there before into `talking_points_prev` so Undo restores it. Used by
 *  the regenerate flow — the caller already has the new bullets in hand,
 *  this just handles the version bookkeeping + save in one place. */
export async function commitTalkingPointsRegeneration(
  id: string,
  nextPoints: string[],
): Promise<Conversation | null> {
  const c = await loadConversation(id);
  if (!c) return null;
  const cur = c.talking_points ?? [];
  c.talking_points_prev = cur.length > 0 ? cur : undefined;
  c.talking_points = nextPoints;
  await saveConversation(c);
  return c;
}

/** Write the current talking-points .md to `destPath` (a user-chosen
 *  filesystem location from the save dialog). The fs plugin is scoped to
 *  ~/.myownllm/** so the destination lives outside its allowlist — we
 *  route through a Rust command that takes the dialog-confirmed path. */
export async function downloadTalkingPoints(
  id: string,
  destPath: string,
): Promise<void> {
  const path = await findConversationPath(id);
  if (!path) throw new Error("Session not found");
  const mdPath = tpMdPath(path);
  if (!(await exists(mdPath))) {
    throw new Error("No talking points to download yet");
  }
  const md = await readTextFile(mdPath);
  await invoke("write_text_to_path", { path: destPath, contents: md });
}

/** One reclaimable orphan file in the conversation tree. Either a
 *  talking-points sidecar `.md` left behind after its sibling JSON
 *  was removed manually, or a non-conversation file the user dropped
 *  into the folder. The Storage tab's "Clean now" popup lists these
 *  by path + size so the user can see exactly what they're deleting. */
export interface ConversationOrphan {
  /** Absolute path of the orphan file. */
  path: string;
  /** Display path relative to the conversations root, POSIX-style. */
  relPath: string;
  size_bytes: number;
}

/** Match a conversation JSON or its talking-points sidecar. The
 *  `<id>.json` / `<id>.talking-points.md` / `<id>.talking-points.prev.md`
 *  trio is the only shape `saveConversation` writes; anything else
 *  in the tree is fair game for the cleanup pass. */
function classifyConversationFile(name: string): {
  kind: "json" | "tp-md" | "tp-prev-md" | "other";
  id: string | null;
} {
  if (name.endsWith(".talking-points.prev.md")) {
    return { kind: "tp-prev-md", id: name.slice(0, -".talking-points.prev.md".length) };
  }
  if (name.endsWith(".talking-points.md")) {
    return { kind: "tp-md", id: name.slice(0, -".talking-points.md".length) };
  }
  if (name.endsWith(".json")) {
    return { kind: "json", id: name.slice(0, -".json".length) };
  }
  return { kind: "other", id: null };
}

/** Walk the conversations tree and gather files that don't belong to
 *  any live conversation. Two flavors:
 *    1. Talking-points sidecars whose `.json` sibling no longer
 *       exists. Sidecars are supposed to travel with the JSON via
 *       `saveConversation` / `moveConversation` / `deleteConversation`,
 *       so a stray one means the user (or a crashed save) left it
 *       behind.
 *    2. Files the user dropped into the conversation folder by hand
 *       that don't match the conversation schema (PDFs, screenshots,
 *       etc.). Surfaced so the file-manager view stays organized —
 *       per the "folder is the representation" invariant the schema
 *       relies on.
 *  Files inside `.`-prefixed dirs are ignored (matches `walkTree`'s
 *  skip rule for `.DS_Store`, `.git`, …). */
async function readDirRecursive(
  absDir: string,
  relDir: string,
): Promise<Array<{ absPath: string; relPath: string; name: string; isFile: boolean }>> {
  const out: Array<{ absPath: string; relPath: string; name: string; isFile: boolean }> = [];
  let entries: DirEntry[];
  try {
    entries = await readDir(absDir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.name) continue;
    if (e.name.startsWith(".")) continue;
    const abs = `${absDir}/${e.name}`;
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isDirectory) {
      const child = await readDirRecursive(abs, rel);
      out.push(...child);
    } else if (e.isFile) {
      out.push({ absPath: abs, relPath: rel, name: e.name, isFile: true });
    }
  }
  return out;
}

async function fileSizeBytes(absPath: string): Promise<number> {
  try {
    return (await stat(absPath)).size;
  } catch {
    return 0;
  }
}

export async function listConversationOrphans(): Promise<ConversationOrphan[]> {
  let dir: string;
  try {
    dir = await conversationsDir();
  } catch {
    return [];
  }
  if (!(await exists(dir))) return [];

  const files = await readDirRecursive(dir, "");

  // Group files by directory so we can resolve "<id>.json exists in
  // this same folder?" without a cross-tree scan. Sidecars always
  // live alongside their JSON — a moved JSON drags its sidecars
  // with it.
  const jsonIdsByDir = new Map<string, Set<string>>();
  for (const f of files) {
    const cls = classifyConversationFile(f.name);
    if (cls.kind !== "json" || !cls.id) continue;
    const parentRel = f.relPath.includes("/")
      ? f.relPath.slice(0, f.relPath.lastIndexOf("/"))
      : "";
    let bucket = jsonIdsByDir.get(parentRel);
    if (!bucket) {
      bucket = new Set();
      jsonIdsByDir.set(parentRel, bucket);
    }
    bucket.add(cls.id);
  }

  const orphans: ConversationOrphan[] = [];
  for (const f of files) {
    const cls = classifyConversationFile(f.name);
    const parentRel = f.relPath.includes("/")
      ? f.relPath.slice(0, f.relPath.lastIndexOf("/"))
      : "";
    if (cls.kind === "json") continue;
    if (cls.kind === "tp-md" || cls.kind === "tp-prev-md") {
      if (cls.id && jsonIdsByDir.get(parentRel)?.has(cls.id)) continue;
      orphans.push({
        path: f.absPath,
        relPath: f.relPath,
        size_bytes: await fileSizeBytes(f.absPath),
      });
      continue;
    }
    // `other` — any non-conversation file in the tree.
    orphans.push({
      path: f.absPath,
      relPath: f.relPath,
      size_bytes: await fileSizeBytes(f.absPath),
    });
  }
  return orphans;
}

/** Remove every orphan `listConversationOrphans` would surface.
 *  Returns the freed bytes. Errors on individual files are swallowed
 *  so a single permission glitch doesn't abort the whole pass. */
export async function clearConversationOrphans(): Promise<number> {
  const orphans = await listConversationOrphans();
  let freed = 0;
  for (const o of orphans) {
    try {
      await remove(o.path);
      freed += o.size_bytes;
    } catch {
      // Best-effort.
    }
  }
  return freed;
}

/**
 * Read the shared active-conversation pointer from the backend. Mirror of
 * what the LAN remote pings via `GET /api/active-conversation` — both
 * surfaces use the same pointer so the two can hand off seamlessly.
 */
export async function getActiveConversationId(): Promise<string | null> {
  try {
    const id = await invoke<string | null>("get_active_conversation");
    return id ?? null;
  } catch {
    return null;
  }
}

/** Push a new active-conversation id to the backend (or `null` to clear).
 *  Idempotent on the backend — duplicate sets don't refire the change event. */
export async function setActiveConversationId(id: string | null): Promise<void> {
  try {
    await invoke("set_active_conversation", { id });
  } catch {
    // Best-effort: a transient backend hiccup shouldn't block the UI.
  }
}

export function newConversation(mode: Mode, model: string, family: string): Conversation {
  const now = new Date().toISOString();
  return {
    id: newConversationId(),
    title: "New chat",
    mode,
    model,
    family,
    created_at: now,
    updated_at: now,
    messages: [],
  };
}

/**
 * Coax a 3-5 word title out of the active model from the user's first
 * message. Tight `num_predict` ceiling and a low temperature so the daemon
 * doesn't spend visible seconds generating a heading nobody reads — title
 * generation is best-effort and falls back to a truncated message preview.
 */
export async function generateTitle(model: string, firstMessage: string): Promise<string> {
  const seed = firstMessage.trim().slice(0, 240);
  if (!seed) return "New chat";
  try {
    const reply = await invoke<string>("ollama_chat", {
      model,
      messages: [
        {
          role: "user",
          content:
            "Write a 3-5 word title for a chat that opens with the message below. " +
            "Reply with ONLY the title — no quotes, no punctuation, no preamble.\n\n" +
            seed,
        },
      ],
      options: { num_predict: 16, temperature: 0.3 },
    });
    return cleanTitle(reply) || fallbackTitle(seed);
  } catch {
    return fallbackTitle(seed);
  }
}

/** Strip thinking/reasoning leakage and surrounding punctuation, then clamp. */
function cleanTitle(raw: string): string {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // Some models prepend "Title:" or wrap in quotes — peel them off.
  t = t.replace(/^title\s*[:\-]\s*/i, "").trim();
  t = t.replace(/^["'`]+|["'`]+$/g, "").trim();
  // First line only — multi-line titles look broken in the sidebar.
  t = t.split(/\r?\n/, 1)[0]!.trim();
  if (t.length > 60) t = t.slice(0, 60).trimEnd() + "…";
  return t;
}

function fallbackTitle(seed: string): string {
  const flat = seed.replace(/\s+/g, " ").trim();
  return flat.length > 48 ? flat.slice(0, 48).trimEnd() + "…" : flat || "New chat";
}
