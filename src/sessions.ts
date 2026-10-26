// Reads Claude Code session transcripts. Read-only: this module never calls query(),
// so browsing sessions starts no model turn and costs nothing. The write paths are
// setArchiveTag, opt-in through the claudeSessions.archiveWritesTag setting, and
// deleteSessionFiles, which runs only after the user confirms a delete.
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getSessionMessages,
  getSubagentMessages,
  listSessions,
  listSubagents,
  tagSession,
  type SDKSessionInfo,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';

export const ARCHIVE_TAG = 'frozen';

export interface SessionEntry {
  id: string;
  title: string;
  firstPrompt?: string;
  cwd?: string;
  /** Encoded folder name under projects/, the fallback when cwd is unknown. */
  projectKey: string;
  gitBranch?: string;
  tag?: string;
  lastModified: number;
  createdAt?: number;
  fileSize?: number;
  file: string;
}

export interface LoadOptions {
  configDir?: string;
  /** Limit to this directory and its git worktrees. */
  workspaceDir?: string;
  includeProgrammatic: boolean;
  /** Leave out the one-message sessions Claude Token Reporter runs to read plan usage. */
  hideTokenReporterPings?: boolean;
}

/** Claude Token Reporter 0.21+ runs its plan-usage readings as `claude` sessions in this folder. */
export function tokenReporterPingDir(): string {
  return path.join(os.homedir(), '.claude-tokens-ping');
}

export function isTokenReporterPing(e: Pick<SessionEntry, 'cwd' | 'projectKey'>): boolean {
  if (e.cwd) {
    const cwd = e.cwd.startsWith('~') ? path.join(os.homedir(), e.cwd.slice(1)) : e.cwd;
    return path.resolve(cwd) === tokenReporterPingDir();
  }
  // No cwd recorded: fall back to the projects/ folder name Claude Code derives from it.
  return e.projectKey.endsWith('-claude-tokens-ping');
}

export function projectsRoot(configDir?: string): string {
  const base = configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/** Lists every session transcript. Combines the SDK's metadata with a scan of
 * projects/<key>/*.jsonl, so a session the SDK skips (no summary yet, still being
 * written) still shows up. Subfolders such as memory/ and subagents/ are not
 * transcripts and are never listed. */
export async function loadSessions(opts: LoadOptions): Promise<SessionEntry[]> {
  const root = projectsRoot(opts.configDir);
  const files = await scanTranscriptFiles(root);

  let infos: SDKSessionInfo[] = [];
  try {
    infos = await withConfigDir(opts.configDir, () =>
      listSessions({
        dir: opts.workspaceDir,
        includeProgrammatic: opts.includeProgrammatic,
      }),
    );
  } catch {
    // Fall back to the scan alone.
  }

  const byId = new Map<string, SessionEntry>();
  for (const info of infos) {
    const file = files.get(info.sessionId);
    if (!file) continue;
    byId.set(info.sessionId, {
      id: info.sessionId,
      title: info.customTitle || info.summary || info.firstPrompt || info.sessionId,
      firstPrompt: info.firstPrompt,
      cwd: info.cwd,
      projectKey: path.basename(path.dirname(file.path)),
      gitBranch: info.gitBranch,
      tag: info.tag,
      lastModified: info.lastModified,
      createdAt: info.createdAt,
      fileSize: info.fileSize ?? file.size,
      file: file.path,
    });
  }

  // The SDK filters programmatic sessions and, with workspaceDir, other projects.
  // Only add scan-only files when neither filter could have removed them.
  if (!opts.workspaceDir && opts.includeProgrammatic) {
    for (const [id, file] of files) {
      if (byId.has(id)) continue;
      byId.set(id, await peekSession(id, file));
    }
  } else if (!opts.workspaceDir) {
    // Without includeProgrammatic, add a scanned file only if it looks interactive.
    for (const [id, file] of files) {
      if (byId.has(id)) continue;
      const entry = await peekSession(id, file);
      if (!entry.programmatic) byId.set(id, entry);
    }
  }

  let out = [...byId.values()];
  if (opts.hideTokenReporterPings) out = out.filter((e) => !isTokenReporterPing(e));
  return out.sort((a, b) => b.lastModified - a.lastModified);
}

interface TranscriptFile {
  path: string;
  size: number;
  mtime: number;
}

async function scanTranscriptFiles(root: string): Promise<Map<string, TranscriptFile>> {
  const out = new Map<string, TranscriptFile>();
  let dirs: string[];
  try {
    dirs = await fs.readdir(root);
  } catch {
    return out;
  }
  await Promise.all(
    dirs.map(async (dir) => {
      const full = path.join(root, dir);
      let names: string[];
      try {
        names = await fs.readdir(full);
      } catch {
        return;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const p = path.join(full, name);
        try {
          const st = await fs.stat(p);
          if (!st.isFile()) continue;
          out.set(name.slice(0, -'.jsonl'.length), { path: p, size: st.size, mtime: st.mtimeMs });
        } catch {
          // Vanished between readdir and stat.
        }
      }
    }),
  );
  return out;
}

const PEEK_BYTES = 256 * 1024;

/** Builds an entry from the head of a transcript the SDK did not list. */
async function peekSession(id: string, file: TranscriptFile): Promise<SessionEntry & { programmatic: boolean }> {
  const entry: SessionEntry & { programmatic: boolean } = {
    id,
    title: id,
    projectKey: path.basename(path.dirname(file.path)),
    lastModified: Math.round(file.mtime),
    fileSize: file.size,
    file: file.path,
    programmatic: false,
  };
  let head = '';
  try {
    const fh = await fs.open(file.path, 'r');
    try {
      const buf = Buffer.alloc(Math.min(PEEK_BYTES, file.size));
      await fh.read(buf, 0, buf.length, 0);
      head = buf.toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return entry;
  }
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // Last line may be cut by the peek.
    }
    if (!entry.cwd && typeof obj.cwd === 'string') entry.cwd = obj.cwd;
    if (!entry.gitBranch && typeof obj.gitBranch === 'string') entry.gitBranch = obj.gitBranch;
    if (!entry.createdAt && typeof obj.timestamp === 'string') entry.createdAt = Date.parse(obj.timestamp) || undefined;
    if (typeof obj.entrypoint === 'string' && /^sdk-/.test(obj.entrypoint)) entry.programmatic = true;
    if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') entry.title = obj.customTitle;
    if (obj.type === 'tag' && typeof obj.tag === 'string') entry.tag = obj.tag || undefined;
    if (!entry.firstPrompt && obj.type === 'user' && !obj.isMeta) {
      const text = firstText(obj.message?.content);
      if (text) entry.firstPrompt = text;
    }
  }
  if (entry.title === id && entry.firstPrompt) entry.title = entry.firstPrompt;
  entry.title = oneLine(entry.title);
  return entry;
}

function firstText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) return block.text.trim();
    }
  }
  return undefined;
}

export function oneLine(s: string, max = 200): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

export interface Transcript {
  messages: SessionMessage[];
  subagents: { id: string; messages: SessionMessage[] }[];
}

export async function loadTranscript(entry: SessionEntry, configDir?: string): Promise<Transcript> {
  return withConfigDir(configDir, async () => {
    let messages: SessionMessage[] = [];
    try {
      messages = await getSessionMessages(entry.id, { dir: entry.cwd, includeSystemMessages: true });
      if (messages.length === 0 && entry.cwd) {
        messages = await getSessionMessages(entry.id, { includeSystemMessages: true });
      }
    } catch {
      messages = [];
    }
    if (messages.length === 0) messages = await readRawMessages(entry);

    const subagents: Transcript['subagents'] = [];
    try {
      const ids = await listSubagents(entry.id, { dir: entry.cwd });
      for (const id of ids) {
        subagents.push({ id, messages: await getSubagentMessages(entry.id, id, { dir: entry.cwd }) });
      }
    } catch {
      // A session with no subagents folder.
    }
    return { messages, subagents };
  });
}

/** Last resort when the SDK returns nothing (an unreadable chain): every
 * user/assistant line in file order. */
async function readRawMessages(entry: SessionEntry): Promise<SessionMessage[]> {
  let text: string;
  try {
    text = await fs.readFile(entry.file, 'utf8');
  } catch {
    return [];
  }
  const out: SessionMessage[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if ((obj.type === 'user' || obj.type === 'assistant') && obj.message) {
        out.push({
          type: obj.type,
          uuid: obj.uuid ?? '',
          session_id: entry.id,
          message: obj.message,
          parent_tool_use_id: null,
          parent_agent_id: null,
        });
      }
    } catch {
      // Skip a partial line.
    }
  }
  return out;
}

export interface ContentMatch {
  /** Case-insensitive occurrences of the query in what the transcript shows. */
  hits: number;
  /** A line of text around the first hit. */
  snippet?: string;
}

// Keys whose values are ids, encodings or binary data, never text a reader sees.
const NOT_TEXT = new Set(['type', 'id', 'tool_use_id', 'signature', 'source', 'data', 'media_type']);

/** Searches the text a transcript shows (prompts, replies, thinking, tool inputs and
 * results) in the session and its subagent transcripts. Reads the JSONL directly, so it
 * is as free as viewing. */
export async function searchSessionContent(entry: SessionEntry, query: string): Promise<ContentMatch> {
  const q = query.toLowerCase();
  const out: ContentMatch = { hits: 0 };
  if (!q) return out;
  // A query with characters JSON escapes can't be pre-checked against the raw line.
  const rawCheck = !/["\\\u0000-\u001f]/.test(q);
  const files = [entry.file];
  const subDir = path.join(path.dirname(entry.file), entry.id, 'subagents');
  try {
    for (const name of await fs.readdir(subDir)) if (name.endsWith('.jsonl')) files.push(path.join(subDir, name));
  } catch {
    // No subagents.
  }
  for (const file of files) {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim() || (rawCheck && !line.toLowerCase().includes(q))) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if ((obj.type !== 'user' && obj.type !== 'assistant') || !obj.message) continue;
      const strings: string[] = [];
      collectText(obj.message.content, strings);
      for (const s of strings) {
        const lower = s.toLowerCase();
        for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) {
          if (out.hits++ === 0) out.snippet = snippetAt(s, i, q.length);
        }
      }
    }
  }
  return out;
}

function collectText(v: unknown, out: string[]): void {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectText(x, out);
  else if (v && typeof v === 'object') {
    // Only content blocks (objects with a type) carry ids and encodings; tool inputs keep every key.
    const isBlock = typeof (v as any).type === 'string';
    for (const [k, x] of Object.entries(v)) if (!(isBlock && NOT_TEXT.has(k))) collectText(x, out);
  }
}

function snippetAt(s: string, i: number, len: number): string {
  const start = Math.max(0, i - 40);
  const end = Math.min(s.length, i + len + 60);
  return (start > 0 ? '…' : '') + s.slice(start, end).replace(/\s+/g, ' ').trim() + (end < s.length ? '…' : '');
}

export async function setArchiveTag(entry: SessionEntry, archived: boolean, configDir?: string): Promise<void> {
  await withConfigDir(configDir, () => tagSession(entry.id, archived ? ARCHIVE_TAG : null, { dir: entry.cwd }));
}

/** The files that make up a session on disk: the transcript and, when present, the
 * sibling <id>/ folder holding subagent transcripts and tool results. The same set the
 * SDK's deleteSession() removes, resolved from the known path instead of by cwd, so
 * sessions found only by the scan can be deleted too. */
export async function sessionPaths(entry: SessionEntry): Promise<string[]> {
  const out = [entry.file];
  const folder = path.join(path.dirname(entry.file), entry.id);
  try {
    if ((await fs.stat(folder)).isDirectory()) out.push(folder);
  } catch {
    // No subagents or tool results.
  }
  return out;
}

/** Permanently removes a session's files. Returns the paths removed. */
export async function deleteSessionFiles(entry: SessionEntry): Promise<string[]> {
  const paths = await sessionPaths(entry);
  for (const p of paths) await fs.rm(p, { recursive: true, force: true });
  return paths;
}

/** The SDK reads CLAUDE_CONFIG_DIR. Point it at the configured folder for one call. */
async function withConfigDir<T>(configDir: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!configDir) return fn();
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
}
