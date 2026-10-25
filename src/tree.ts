import * as path from 'node:path';
import * as vscode from 'vscode';
import { groupByPeriod, type GroupBy } from './periods';
import { ARCHIVE_TAG, oneLine, type ContentMatch, type SessionEntry } from './sessions';

export type Node =
  | { kind: 'project'; key: string; label: string; sessions: SessionEntry[] }
  | { kind: 'period'; projectKey: string; key: string; label: string; sessions: SessionEntry[]; newest: boolean }
  | { kind: 'session'; entry: SessionEntry };

/** When a session started: its first message, or its file's mtime when that is unknown. */
export function startedAt(e: SessionEntry): number {
  return e.createdAt ?? e.lastModified;
}

export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function matchesFilter(e: SessionEntry, filter: string): boolean {
  if (!filter) return true;
  const hay = [e.title, e.firstPrompt, e.cwd, e.projectKey, e.gitBranch, e.id, e.tag].filter(Boolean).join('\n').toLowerCase();
  return filter
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

export class SessionTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  sessions: SessionEntry[] = [];
  filter = '';
  /** A search of transcript text: only sessions with a hit are shown. */
  content?: { query: string; matches: Map<string, ContentMatch> };
  showArchived = false;
  /** All lists each project's sessions directly; the others add a period level by start date. */
  groupBy: GroupBy = 'all';
  error?: string;

  constructor(private readonly archivedIds: () => Set<string>) {}

  isArchived(e: SessionEntry): boolean {
    return e.tag === ARCHIVE_TAG || this.archivedIds().has(e.id);
  }

  visible(): SessionEntry[] {
    return this.sessions.filter(
      (e) => (this.showArchived || !this.isArchived(e)) && matchesFilter(e, this.filter) && (!this.content || this.hits(e) > 0),
    );
  }

  hits(e: SessionEntry): number {
    return this.content?.matches.get(e.id)?.hits ?? 0;
  }

  set(sessions: SessionEntry[]): void {
    this.sessions = sessions;
    this.changed.fire(undefined);
  }

  redraw(): void {
    this.changed.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (node?.kind === 'project') {
      if (this.groupBy === 'all') return node.sessions.map((entry) => ({ kind: 'session', entry }));
      return groupByPeriod(node.sessions, startedAt, this.groupBy).map((p, i) => ({
        kind: 'period',
        projectKey: node.key,
        key: `${this.groupBy}:${p.key}`,
        label: p.label,
        sessions: p.items,
        newest: i === 0,
      }));
    }
    if (node?.kind === 'period') return node.sessions.map((entry) => ({ kind: 'session', entry }));
    if (node) return [];
    const groups = new Map<string, Node & { kind: 'project' }>();
    for (const entry of this.visible()) {
      const key = entry.cwd ?? entry.projectKey;
      let g = groups.get(key);
      if (!g) {
        g = { kind: 'project', key, label: entry.cwd ? path.basename(entry.cwd) : entry.projectKey, sessions: [] };
        groups.set(key, g);
      }
      g.sessions.push(entry);
    }
    // Sessions arrive newest first, so map order is already most recent project first.
    return [...groups.values()];
  }

  /** Lets the view reveal a session: its parent is its project, or its period folder. */
  getParent(node: Node): Node | undefined {
    if (node.kind === 'project') return undefined;
    const projects = this.getChildren();
    if (node.kind === 'period') return projects.find((p) => p.kind === 'project' && p.key === node.projectKey);
    for (const p of projects) {
      if (p.kind !== 'project' || !p.sessions.some((e) => e.id === node.entry.id)) continue;
      if (this.groupBy === 'all') return p;
      return this.getChildren(p).find((c) => c.kind === 'period' && c.sessions.some((e) => e.id === node.entry.id));
    }
    return undefined;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'project') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `project:${node.key}`;
      item.description = `${node.sessions.length}`;
      item.tooltip = node.key;
      item.iconPath = new vscode.ThemeIcon('folder');
      item.contextValue = 'project';
      return item;
    }
    if (node.kind === 'period') {
      // Only the newest period starts open, so a long history stays one screen tall.
      const item = new vscode.TreeItem(node.label, node.newest ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `period:${node.projectKey}:${node.key}`;
      const n = node.sessions.length;
      item.description = `${n} session${n === 1 ? '' : 's'}`;
      item.iconPath = new vscode.ThemeIcon('calendar');
      item.contextValue = 'period';
      return item;
    }
    const e = node.entry;
    const archived = this.isArchived(e);
    const item = new vscode.TreeItem(oneLine(e.title, 90), vscode.TreeItemCollapsibleState.None);
    item.id = `session:${e.id}`;
    const hits = this.content ? this.hits(e) : 0;
    item.description = [hits ? `${hits} match${hits === 1 ? '' : 'es'}` : '', e.gitBranch, relativeTime(e.lastModified)].filter(Boolean).join(' · ');
    item.iconPath = new vscode.ThemeIcon(archived ? 'archive' : 'comment-discussion');
    item.contextValue = archived ? 'session-archived' : 'session';
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${escapeMd(oneLine(e.title, 200))}**\n\n`);
    const snippet = this.content?.matches.get(e.id)?.snippet;
    if (snippet) tip.appendMarkdown(`*Match:* ${escapeMd(snippet)}\n\n`);
    if (e.firstPrompt && e.firstPrompt !== e.title) tip.appendMarkdown(`${escapeMd(oneLine(e.firstPrompt, 300))}\n\n`);
    tip.appendMarkdown(`\`${e.id}\`\n\n`);
    if (e.cwd) tip.appendMarkdown(`${escapeMd(e.cwd)}\n\n`);
    if (e.createdAt) tip.appendMarkdown(`Started ${new Date(e.createdAt).toLocaleString()}  \n`);
    tip.appendMarkdown(`Updated ${new Date(e.lastModified).toLocaleString()}`);
    if (e.fileSize) tip.appendMarkdown(`  \n${(e.fileSize / 1024).toFixed(0)} KB`);
    item.tooltip = tip;
    item.command = { command: 'claudeSessions.open', title: 'Open Transcript', arguments: [node] };
    return item;
  }
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
