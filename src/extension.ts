import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  ARCHIVE_TAG,
  deleteSessionFiles,
  loadSessions,
  oneLine,
  projectsRoot,
  searchSessionContent,
  sessionPaths,
  setArchiveTag,
  type ContentMatch,
  type SessionEntry,
} from './sessions';
import { GROUP_LABELS, type GroupBy } from './periods';
import { relativeTime, SessionTree, type Node } from './tree';
import { TranscriptPanels } from './viewer';

const ARCHIVED_KEY = 'claudeSessions.archived';
const GROUP_BY_KEY = 'claudeSessions.groupBy';

export function activate(context: vscode.ExtensionContext): void {
  const cfg = () => vscode.workspace.getConfiguration('claudeSessions');
  const configDir = () => cfg().get<string>('configDir') || undefined;
  const archived = () => new Set(context.globalState.get<string[]>(ARCHIVED_KEY, []));

  const tree = new SessionTree(archived);
  const view = vscode.window.createTreeView('claudeSessions.list', { treeDataProvider: tree, showCollapseAll: true, canSelectMany: true });
  const panels = new TranscriptPanels(() => ({ configDir: configDir(), showThinking: cfg().get<boolean>('showThinking', false) }));
  context.subscriptions.push(view);
  tree.groupBy = context.globalState.get<GroupBy>(GROUP_BY_KEY, 'all');
  // Version in the panel title while versions track PR numbers (0.<PR>); remove once it settles.
  const [major, minor] = String(context.extension.packageJSON.version ?? '').split('.');
  const updateTitle = () => {
    const parts = [minor !== undefined ? `Sessions v${major}.${minor}` : 'Sessions'];
    if (tree.groupBy !== 'all') parts.push(GROUP_LABELS[tree.groupBy]);
    view.title = parts.join(' · ');
  };
  updateTitle();

  // Content search results by file, reused while a transcript's size and mtime are unchanged.
  const searchCache = new Map<string, { query: string; version: string; match: ContentMatch }>();
  const searchContent = async (query: string): Promise<Map<string, ContentMatch>> => {
    const matches = new Map<string, ContentMatch>();
    const queue = [...tree.sessions];
    const worker = async () => {
      for (let e = queue.shift(); e; e = queue.shift()) {
        const version = `${e.lastModified}:${e.fileSize}`;
        const hit = searchCache.get(e.file);
        const match = hit && hit.query === query && hit.version === version ? hit.match : await searchSessionContent(e, query);
        searchCache.set(e.file, { query, version, match });
        matches.set(e.id, match);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    return matches;
  };

  let loading: Promise<void> | undefined;
  let again = false;
  const refresh = (): Promise<void> => {
    if (loading) {
      again = true;
      return loading;
    }
    loading = (async () => {
      do {
        again = false;
        const scope = cfg().get<'all' | 'workspace'>('scope', 'all');
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        try {
          tree.set(
            await loadSessions({
              configDir: configDir(),
              workspaceDir: scope === 'workspace' ? ws : undefined,
              includeProgrammatic: cfg().get<boolean>('includeProgrammatic', false),
            }),
          );
        } catch (err) {
          void vscode.window.showErrorMessage(`Claude Sessions: could not list sessions. ${String(err)}`);
        }
        if (tree.content) {
          const query = tree.content.query;
          const matches = await searchContent(query);
          if (tree.content?.query === query) tree.content = { query, matches };
          tree.redraw();
        }
        updateViewChrome();
      } while (again);
    })().finally(() => (loading = undefined));
    return loading;
  };

  const updateViewChrome = () => {
    const scope = cfg().get<string>('scope', 'all');
    const parts = [scope === 'workspace' ? 'This workspace' : 'All projects'];
    if (tree.filter) parts.push(`filter “${tree.filter}”`);
    if (tree.content) parts.push(`containing “${tree.content.query}”`);
    if (tree.showArchived) parts.push('with archived');
    view.description = parts.join(' · ');
    view.message = tree.sessions.length === 0 ? `No sessions found under ${projectsRoot(configDir())}.` : tree.visible().length === 0 ? 'No sessions match.' : undefined;
    void vscode.commands.executeCommand('setContext', 'claudeSessions.filtered', !!tree.filter || !!tree.content);
  };

  const entryOf = (arg?: Node | SessionEntry): SessionEntry | undefined => {
    if (!arg) {
      const sel = view.selection[0];
      return sel?.kind === 'session' ? sel.entry : undefined;
    }
    return 'kind' in arg ? (arg.kind === 'session' ? arg.entry : undefined) : arg;
  };

  /** The sessions a context-menu command applies to: every selected session when the
   * clicked row is part of a multi-selection, otherwise the clicked one. */
  const entriesOf = (arg?: Node | SessionEntry, all?: Node[]): SessionEntry[] => {
    const nodes = all && all.length > 1 ? all : undefined;
    if (nodes) return nodes.flatMap((n) => (n.kind === 'session' ? [n.entry] : []));
    if (!arg) return view.selection.flatMap((n) => (n.kind === 'session' ? [n.entry] : []));
    const e = entryOf(arg);
    return e ? [e] : [];
  };

  const deleteSessions = async (entries: SessionEntry[]) => {
    if (entries.length === 0) return;
    const one = entries.length === 1;
    const paths = (await Promise.all(entries.map(sessionPaths))).flat();
    const recent = entries.filter((e) => Date.now() - e.lastModified < 2 * 60 * 1000);
    const detail = [
      one ? 'Removes these from disk:' : `Removes ${entries.length} sessions (${paths.length} files and folders) from disk:`,
      ...paths.slice(0, 8),
      ...(paths.length > 8 ? [`…and ${paths.length - 8} more`] : []),
      '',
      'A deleted session can no longer be resumed.',
      ...(recent.length ? ['', `${one ? 'This session was' : `${recent.length} of these sessions were`} updated in the last two minutes and may still be running.`] : []),
    ].join('\n');
    const TRASH = 'Move to Trash';
    const PERMANENT = 'Delete Permanently';
    const choice = await vscode.window.showWarningMessage(
      one ? `Delete “${oneLine(entries[0].title, 80)}”?` : `Delete ${entries.length} sessions?`,
      { modal: true, detail },
      TRASH,
      PERMANENT,
    );
    if (!choice) return;

    const failed: string[] = [];
    for (const e of entries) {
      try {
        if (choice === TRASH) {
          for (const p of await sessionPaths(e)) await vscode.workspace.fs.delete(vscode.Uri.file(p), { recursive: true, useTrash: true });
        } else {
          await deleteSessionFiles(e);
        }
        panels.close(e.id);
      } catch (err) {
        failed.push(`${oneLine(e.title, 60)}: ${String(err)}`);
      }
    }
    const ids = archived();
    const before = ids.size;
    for (const e of entries) ids.delete(e.id);
    if (ids.size !== before) await context.globalState.update(ARCHIVED_KEY, [...ids]);
    await refresh();
    if (failed.length) {
      const hint = choice === TRASH ? ' If the trash is unavailable here, use Delete Permanently.' : '';
      void vscode.window.showErrorMessage(`Could not delete ${failed.length} session${failed.length === 1 ? '' : 's'}. ${failed.join('; ')}${hint}`);
    } else {
      const n = entries.length;
      void vscode.window.setStatusBarMessage(`${n} session${n === 1 ? '' : 's'} ${choice === TRASH ? 'moved to trash' : 'deleted'}`, 3000);
    }
  };

  const setArchived = async (arg: Node | undefined, value: boolean) => {
    const e = entryOf(arg);
    if (!e) return;
    const ids = archived();
    if (value) ids.add(e.id);
    else ids.delete(e.id);
    await context.globalState.update(ARCHIVED_KEY, [...ids]);
    if (cfg().get<boolean>('archiveWritesTag', false) || (!value && e.tag === ARCHIVE_TAG)) {
      try {
        await setArchiveTag(e, value, configDir());
        e.tag = value ? ARCHIVE_TAG : undefined;
      } catch (err) {
        void vscode.window.showWarningMessage(`Archived in VS Code only; the session tag could not be written. ${String(err)}`);
      }
    }
    tree.redraw();
    updateViewChrome();
  };

  const reg = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('claudeSessions.refresh', () => refresh());
  reg('claudeSessions.open', (arg?: Node | SessionEntry) => {
    const e = entryOf(arg);
    // Opened from a content search: search the transcript for the same text.
    if (e) return panels.open(e, tree.content && tree.hits(e) > 0 ? tree.content.query : undefined);
  });
  reg('claudeSessions.quickOpen', async () => {
    if (tree.sessions.length === 0) await refresh();
    const pick = await vscode.window.showQuickPick(
      tree.sessions
        .filter((e) => tree.showArchived || !tree.isArchived(e))
        .map((e) => ({
          label: e.title,
          description: [e.cwd ? path.basename(e.cwd) : e.projectKey, e.gitBranch, relativeTime(e.lastModified)].filter(Boolean).join(' · '),
          detail: e.firstPrompt && e.firstPrompt !== e.title ? e.firstPrompt.replace(/\s+/g, ' ').slice(0, 200) : e.cwd,
          entry: e,
        })),
      { placeHolder: 'Search sessions by title, prompt, project or branch', matchOnDescription: true, matchOnDetail: true },
    );
    if (pick) await panels.open(pick.entry);
  });
  reg('claudeSessions.filter', async () => {
    const value = await vscode.window.showInputBox({ prompt: 'Show sessions containing all of these words', value: tree.filter });
    if (value === undefined) return;
    tree.filter = value.trim();
    tree.redraw();
    updateViewChrome();
  });
  reg('claudeSessions.searchContent', async () => {
    const value = await vscode.window.showInputBox({
      prompt: 'Show sessions whose transcript contains this text (prompts, replies, thinking, tool calls)',
      placeHolder: 'Text to find in every transcript',
      value: tree.content?.query,
    });
    if (value === undefined) return;
    const query = value.trim();
    if (!query) {
      tree.content = undefined;
    } else {
      if (tree.sessions.length === 0) await refresh();
      const matches = await vscode.window.withProgress(
        { location: { viewId: 'claudeSessions.list' }, title: `Searching transcripts for “${query}”` },
        () => searchContent(query),
      );
      tree.content = { query, matches };
    }
    tree.redraw();
    updateViewChrome();
  });
  reg('claudeSessions.clearFilter', () => {
    tree.content = undefined;
    tree.filter = '';
    tree.redraw();
    updateViewChrome();
  });
  reg('claudeSessions.toggleScope', async () => {
    const next = cfg().get<string>('scope', 'all') === 'all' ? 'workspace' : 'all';
    await cfg().update('scope', next, vscode.ConfigurationTarget.Global);
  });
  reg('claudeSessions.groupBy', async () => {
    const hints: Record<GroupBy, string> = {
      all: 'Each worktree lists its sessions, newest first',
      year: 'Folders per calendar year',
      month: 'Folders per month',
      week: 'Folders per week, Saturday 2 PM to Saturday 2 PM',
      day: 'Folders per day',
    };
    const pick = await vscode.window.showQuickPick(
      (Object.keys(GROUP_LABELS) as GroupBy[]).map((g) => ({
        label: `${g === tree.groupBy ? '$(check) ' : ''}${GROUP_LABELS[g][0]} · ${GROUP_LABELS[g]}`,
        description: hints[g],
        value: g,
      })),
      { placeHolder: 'Group each worktree’s sessions by the date they started' },
    );
    if (!pick) return;
    tree.groupBy = pick.value;
    await context.globalState.update(GROUP_BY_KEY, pick.value);
    updateTitle();
    tree.redraw();
  });
  reg('claudeSessions.toggleArchived', () => {
    tree.showArchived = !tree.showArchived;
    tree.redraw();
    updateViewChrome();
  });
  reg('claudeSessions.copyId', async (arg?: Node) => {
    const e = entryOf(arg);
    if (e) await vscode.env.clipboard.writeText(e.id);
  });
  reg('claudeSessions.copyResume', async (arg?: Node) => {
    const e = entryOf(arg);
    if (!e) return;
    const cmd = e.cwd ? `cd ${JSON.stringify(e.cwd)} && claude --resume ${e.id}` : `claude --resume ${e.id}`;
    await vscode.env.clipboard.writeText(cmd);
    void vscode.window.setStatusBarMessage('Resume command copied', 2500);
  });
  reg('claudeSessions.openRaw', async (arg?: Node) => {
    const e = entryOf(arg);
    if (e) await vscode.window.showTextDocument(vscode.Uri.file(e.file), { preview: true });
  });
  reg('claudeSessions.reveal', async (arg?: Node) => {
    const e = entryOf(arg);
    if (e) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(e.file));
  });
  reg('claudeSessions.archive', (arg?: Node) => setArchived(arg, true));
  reg('claudeSessions.unarchive', (arg?: Node) => setArchived(arg, false));
  reg('claudeSessions.delete', (arg?: Node, all?: Node[]) => deleteSessions(entriesOf(arg, all)));

  // Live updates: watch projects/ for transcript changes, debounced.
  let watcher: fs.FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  const changed = new Set<string>();
  const startWatching = () => {
    watcher?.close();
    watcher = undefined;
    if (!cfg().get<boolean>('liveUpdate', true)) return;
    const root = projectsRoot(configDir());
    try {
      watcher = fs.watch(root, { recursive: true }, (_event, file) => {
        if (!file || !String(file).endsWith('.jsonl')) return;
        changed.add(path.join(root, String(file)));
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const files = new Set(changed);
          changed.clear();
          await refresh();
          const subagentChange = [...files].some((f) => f.includes(`${path.sep}subagents${path.sep}`));
          await panels.refresh(subagentChange ? 'all' : files, new Map(tree.sessions.map((s) => [s.id, s])));
        }, 1500);
      });
    } catch {
      // projects/ does not exist yet, or recursive watch is unsupported. Refresh stays manual.
    }
  };
  context.subscriptions.push({ dispose: () => (watcher?.close(), clearTimeout(timer)) });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudeSessions')) return;
      if (e.affectsConfiguration('claudeSessions.liveUpdate') || e.affectsConfiguration('claudeSessions.configDir')) startWatching();
      void refresh();
    }),
  );

  startWatching();
  void refresh();
}

export function deactivate(): void {}
