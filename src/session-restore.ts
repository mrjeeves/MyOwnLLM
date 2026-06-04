// Persist + restore the bits of UI session state the window-geometry (Rust)
// and config (active mode / family) layers don't already cover, so reopening
// the app lands the user exactly where they left off:
//
//   - which non-mode workspace was open (Speakers / Networks),
//   - the unsent text in the main composer,
//   - any files staged in the composer but not yet sent.
//
// (Window size/position/monitor live in Rust `window_state.rs`; the active
// conversation in the backend's active-conversation pointer; the active
// mode/family in `config.json`.)
//
// Storage lives under the same `~/.myownllm/` tree as the rest of the app's
// state, split across two files on purpose:
//
//   ui-state.json        — { special_view, draft_text }. Small and rewritten
//                          often (every keystroke, debounced).
//   ui-attachments.json  — { attachments }. Potentially large (a staged image
//                          or a multi-MB log) but changes rarely, so it's
//                          written on its own debounce and never dragged into
//                          the per-keystroke text writes.

import { readTextFile, writeTextFile, exists, mkdir } from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";

/** A file staged in the composer but not yet sent. Mirrors the shape Chat's
 *  composer keeps in memory; defined here because this module owns the
 *  serialized form on disk. */
export type PendingAttachment =
  | { kind: "image"; name: string; mime: string; base64: string; size: number }
  | { kind: "text"; name: string; mime: string; content: string; size: number };

/** Which non-mode workspace was open, or `null` for the normal
 *  chat/transcribe surface driven by `config.active_mode`. */
export type SpecialView = "speakers" | "networks" | null;

export interface SessionUiState {
  special_view: SpecialView;
  draft_text: string;
  draft_attachments: PendingAttachment[];
}

const DEFAULT_STATE: SessionUiState = {
  special_view: null,
  draft_text: "",
  draft_attachments: [],
};

/** Above this serialized size we keep staged attachments in memory for the
 *  session but stop mirroring them to disk — restoring a hundred-MB blob on
 *  every launch (and rewriting it on each change) isn't worth it. Generous
 *  enough to cover the "attach a 50 MB log" case the composer explicitly
 *  supports (base64 inflates images ~33%, hence the headroom). */
const MAX_PERSIST_ATTACH_BYTES = 128 * 1024 * 1024;

const STATE_DEBOUNCE_MS = 400;
const ATTACH_DEBOUNCE_MS = 600;

async function dir(): Promise<string> {
  const home = await homeDir();
  return `${home}/.myownllm`;
}

async function statePath(): Promise<string> {
  return `${await dir()}/ui-state.json`;
}

async function attachPath(): Promise<string> {
  return `${await dir()}/ui-attachments.json`;
}

// In-memory mirror of what's on disk. Seeded by `loadSessionState`, mutated
// by the setters, and the source the debounced writers serialize from.
let cache: SessionUiState = { ...DEFAULT_STATE };
let loaded = false;

// Cheap signature of the currently-persisted attachment set (kind+name+size
// per file). Lets `setDraftAttachments` skip a rewrite when the set hasn't
// actually changed — crucially, when the restore effect re-applies the
// just-loaded attachments on mount, which would otherwise re-serialize a
// possibly large payload to disk on every launch. The composer only ever
// adds / removes whole files, so name+size+kind fully captures a real change.
let attachSig = "";

let stateTimer: ReturnType<typeof setTimeout> | null = null;
let attachTimer: ReturnType<typeof setTimeout> | null = null;

function attachmentsSig(atts: PendingAttachment[]): string {
  return atts.map((a) => `${a.kind}:${a.name}:${a.size}`).join("|");
}

/** Load both files and seed the in-memory cache. Returns the merged state so
 *  callers can apply it on mount. Tolerates missing / malformed files by
 *  falling back to defaults — a corrupt session file must never block launch. */
export async function loadSessionState(): Promise<SessionUiState> {
  // Already read this process — hand back the live cache so App (special
  // view) and Chat (composer draft) share a single disk read and Chat
  // remounts (mode switches) pick up the latest draft, not a stale snapshot.
  if (loaded) {
    return { ...cache, draft_attachments: [...cache.draft_attachments] };
  }
  const next: SessionUiState = { ...DEFAULT_STATE };
  try {
    const p = await statePath();
    if (await exists(p)) {
      const raw = JSON.parse(await readTextFile(p)) as Partial<SessionUiState>;
      if (raw.special_view === "speakers" || raw.special_view === "networks") {
        next.special_view = raw.special_view;
      }
      if (typeof raw.draft_text === "string") next.draft_text = raw.draft_text;
    }
  } catch {
    // Ignore — defaults stand.
  }
  try {
    const p = await attachPath();
    if (await exists(p)) {
      const raw = JSON.parse(await readTextFile(p)) as {
        attachments?: unknown;
      };
      if (Array.isArray(raw.attachments)) {
        next.draft_attachments = raw.attachments.filter(isPendingAttachment);
      }
    }
  } catch {
    // Ignore — no attachments restored.
  }
  cache = next;
  attachSig = attachmentsSig(next.draft_attachments);
  loaded = true;
  return { ...next, draft_attachments: [...next.draft_attachments] };
}

/** Narrow an unknown disk value to a `PendingAttachment`, dropping anything
 *  that doesn't match (e.g. a half-written or version-skewed entry). */
function isPendingAttachment(v: unknown): v is PendingAttachment {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  if (typeof a.name !== "string" || typeof a.size !== "number") return false;
  if (a.kind === "image") return typeof a.base64 === "string";
  if (a.kind === "text") return typeof a.content === "string";
  return false;
}

async function writeStateFile(): Promise<void> {
  try {
    const d = await dir();
    if (!(await exists(d))) await mkdir(d, { recursive: true });
    await writeTextFile(
      await statePath(),
      JSON.stringify({
        special_view: cache.special_view,
        draft_text: cache.draft_text,
      }),
    );
  } catch {
    // Best-effort: a failed write only forgets this slice next launch.
  }
}

/** Rough byte size of the staged attachments' payloads — base64 string length
 *  for images, character count for inlined text. Good enough to gate the
 *  "too big to bother persisting" decision without exact encoding math. */
function attachmentsBytes(atts: PendingAttachment[]): number {
  let total = 0;
  for (const a of atts) {
    total += a.kind === "image" ? a.base64.length : a.content.length;
  }
  return total;
}

async function writeAttachFile(): Promise<void> {
  try {
    const d = await dir();
    if (!(await exists(d))) await mkdir(d, { recursive: true });
    const atts =
      attachmentsBytes(cache.draft_attachments) > MAX_PERSIST_ATTACH_BYTES
        ? []
        : cache.draft_attachments;
    if (atts.length === 0 && cache.draft_attachments.length > 0) {
      console.info(
        "[myownllm] staged attachments exceed the persist cap; keeping them " +
          "for this session but not saving them for restore.",
      );
    }
    await writeTextFile(
      await attachPath(),
      JSON.stringify({ attachments: atts }),
    );
  } catch {
    // Best-effort.
  }
}

/** Record which non-mode workspace is open. Folded into the small state file;
 *  view switches are rare so this writes promptly (debounced only to coalesce
 *  a burst). */
export function setSpecialView(view: SpecialView): void {
  if (!loaded) loaded = true;
  if (cache.special_view === view) return;
  cache.special_view = view;
  scheduleStateWrite();
}

/** Record the composer's unsent text. Called on every edit, so the write is
 *  debounced and the file is kept deliberately small. */
export function setDraftText(text: string): void {
  if (!loaded) loaded = true;
  if (cache.draft_text === text) return;
  cache.draft_text = text;
  scheduleStateWrite();
}

/** Record the composer's staged files. Changes only when the user adds /
 *  removes / sends attachments, so its debounce can be lazier and its
 *  (possibly large) payload never rides along with the per-keystroke text
 *  writes. */
export function setDraftAttachments(atts: PendingAttachment[]): void {
  if (!loaded) loaded = true;
  const sig = attachmentsSig(atts);
  // Keep the cache reference fresh either way, but only schedule a (possibly
  // large) disk write when the set genuinely changed.
  cache.draft_attachments = atts;
  if (sig === attachSig) return;
  attachSig = sig;
  scheduleAttachWrite();
}

function scheduleStateWrite(): void {
  if (stateTimer) clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    stateTimer = null;
    void writeStateFile();
  }, STATE_DEBOUNCE_MS);
}

function scheduleAttachWrite(): void {
  if (attachTimer) clearTimeout(attachTimer);
  attachTimer = setTimeout(() => {
    attachTimer = null;
    void writeAttachFile();
  }, ATTACH_DEBOUNCE_MS);
}

/** Flush any pending debounced writes immediately. Wired to page-hide /
 *  unmount so a quick close after an edit still persists. Fire-and-forget;
 *  the debounce remains the real guarantee since fs writes are async. */
export function flushSessionState(): void {
  // A pending timer is the signal that there's an unwritten change; flush
  // only those files so a no-op unmount (e.g. a mode switch with nothing
  // edited) doesn't needlessly rewrite the possibly-large attachment file.
  const stateDirty = stateTimer !== null;
  const attachDirty = attachTimer !== null;
  if (stateTimer) {
    clearTimeout(stateTimer);
    stateTimer = null;
  }
  if (attachTimer) {
    clearTimeout(attachTimer);
    attachTimer = null;
  }
  if (stateDirty) void writeStateFile();
  if (attachDirty) void writeAttachFile();
}
