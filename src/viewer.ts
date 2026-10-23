import * as vscode from 'vscode';
import { escapeHtml, renderTranscript } from './render';
import { loadTranscript, type SessionEntry } from './sessions';

interface Settings {
  configDir?: string;
  showThinking: boolean;
}

/** One webview tab per session. Opening a session that is already open reveals it. */
export class TranscriptPanels {
  private readonly panels = new Map<string, { panel: vscode.WebviewPanel; entry: SessionEntry; search?: string }>();

  constructor(private readonly settings: () => Settings) {}

  /** Opens a session's tab. With `search`, the tab's search box starts with that text and
   * jumps to its first hit in this transcript. */
  async open(entry: SessionEntry, search?: string): Promise<void> {
    const existing = this.panels.get(entry.id);
    if (existing) {
      existing.entry = entry;
      existing.panel.reveal();
      if (search) void existing.panel.webview.postMessage({ type: 'search', query: search });
      return;
    }
    const panel = vscode.window.createWebviewPanel('claudeSessions.transcript', shortTitle(entry.title), vscode.ViewColumn.Active, {
      enableScripts: true,
      // The page has its own search box, which also takes Cmd/Ctrl+F.
      enableFindWidget: false,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    });
    panel.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.panels.set(entry.id, { panel, entry, search });
    panel.onDidDispose(() => this.panels.delete(entry.id));
    panel.webview.html = shell(panel.webview, '<p class="muted">Loading…</p>');
    await this.render(entry.id, false);
  }

  /** Closes the tab for a session, if open. */
  close(id: string): void {
    this.panels.get(id)?.panel.dispose();
  }

  /** Re-render open transcripts whose file changed. */
  async refresh(changedFiles: Set<string> | 'all', latest: Map<string, SessionEntry>): Promise<void> {
    for (const [id, p] of this.panels) {
      const next = latest.get(id);
      if (next) p.entry = next;
      if (changedFiles === 'all' || changedFiles.has(p.entry.file)) await this.render(id, true);
    }
  }

  private async render(id: string, isUpdate: boolean): Promise<void> {
    const p = this.panels.get(id);
    if (!p) return;
    const s = this.settings();
    let html: string;
    try {
      const t = await loadTranscript(p.entry, s.configDir);
      html = renderTranscript(p.entry, t, { showThinking: s.showThinking });
    } catch (err) {
      html = `<p class="error">Could not read this session: ${String(err)}</p>`;
    }
    if (!this.panels.has(id)) return; // closed while loading
    p.panel.title = shortTitle(p.entry.title);
    // The first render replaces the page; later ones post to it so scroll survives.
    if (isUpdate) void p.panel.webview.postMessage({ type: 'render', html, isUpdate });
    else p.panel.webview.html = shell(p.panel.webview, html, p.search);
  }
}

function shortTitle(title: string): string {
  const flat = title.replace(/\s+/g, ' ').trim();
  return flat.length > 40 ? flat.slice(0, 39) + '…' : flat;
}

function nonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** The page frame. Live updates arrive by postMessage so they keep the scroll position. */
export function shell(webview: { cspSource: string }, initial: string, search = ''): string {
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${CSS}</style>
</head>
<body>
<nav class="toolbar">
  <label><input type="checkbox" id="tools" checked> Tool calls</label>
  <label><input type="checkbox" id="thinking" checked> Thinking</label>
  <button id="expand">Expand all</button>
  <button id="collapse">Collapse all</button>
  <button id="bottom">Jump to end</button>
  <span class="search">
    <input id="q" type="search" placeholder="Search this transcript" value="${escapeHtml(search)}" spellcheck="false">
    <span id="count" class="muted"></span>
    <button id="prev" title="Previous match (Shift+Enter)">↑</button>
    <button id="next" title="Next match (Enter)">↓</button>
  </span>
</nav>
<div id="root">${initial}</div>
<script nonce="${n}">
const root = document.getElementById('root');
const toggle = (id, cls) => document.getElementById(id).addEventListener('change', e => document.body.classList.toggle(cls, !e.target.checked));
toggle('tools', 'hide-tools');
toggle('thinking', 'hide-thinking');

// Search within this transcript only: wrap each hit in <mark>, skip hits hidden by the
// toolbar toggles, and open the collapsed sections around the current one.
const q = document.getElementById('q');
const count = document.getElementById('count');
let marks = [];
let cur = -1;
const hidden = m =>
  (document.body.classList.contains('hide-tools') && m.closest('details.tool')) ||
  (document.body.classList.contains('hide-thinking') && m.closest('details.thinking'));
function clearMarks() {
  for (const m of root.querySelectorAll('mark.hit')) {
    const parent = m.parentNode;
    parent.replaceChild(document.createTextNode(m.textContent), m);
    parent.normalize();
  }
  marks = [];
  cur = -1;
}
function search(keep) {
  const prev = cur;
  clearMarks();
  const term = q.value.toLowerCase();
  if (term) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      let i = lower.indexOf(term);
      if (i < 0 || lower.length !== text.length) continue;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (; i >= 0; i = lower.indexOf(term, last)) {
        frag.append(text.slice(last, i));
        const m = document.createElement('mark');
        m.className = 'hit';
        m.textContent = text.slice(i, i + term.length);
        frag.append(m);
        last = i + term.length;
      }
      frag.append(text.slice(last));
      node.parentNode.replaceChild(frag, node);
    }
    marks = [...root.querySelectorAll('mark.hit')].filter(m => !hidden(m));
  }
  if (marks.length) go(keep && prev >= 0 ? Math.min(prev, marks.length - 1) : 0, !keep);
  else count.textContent = term ? 'No matches' : '';
}
function go(i, scroll = true) {
  if (!marks.length) return;
  marks[cur]?.classList.remove('current');
  cur = (i + marks.length) % marks.length;
  const m = marks[cur];
  m.classList.add('current');
  count.textContent = (cur + 1) + ' of ' + marks.length;
  if (!scroll) return;
  // Open every collapsed section around the hit; a hit in a summary needs only its parents.
  let d = m.closest('details');
  if (d && m.closest('summary')?.parentElement === d) d = d.parentElement.closest('details');
  for (; d; d = d.parentElement.closest('details')) d.open = true;
  m.scrollIntoView({ block: 'center' });
}
let typing;
q.addEventListener('input', () => {
  clearTimeout(typing);
  typing = setTimeout(() => search(false), 150);
});
q.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(typing);
    if (!marks.length || !marks[0].isConnected) search(false);
    else go(cur + (e.shiftKey ? -1 : 1));
  } else if (e.key === 'Escape') {
    q.value = '';
    search(false);
  }
});
document.getElementById('next').onclick = () => go(cur + 1);
document.getElementById('prev').onclick = () => go(cur - 1);
for (const id of ['tools', 'thinking']) document.getElementById(id).addEventListener('change', () => search(true));
window.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    q.focus();
    q.select();
  }
});
if (q.value) search(false);
document.getElementById('expand').onclick = () => root.querySelectorAll('details').forEach(d => d.open = true);
document.getElementById('collapse').onclick = () => root.querySelectorAll('details').forEach(d => d.open = false);
document.getElementById('bottom').onclick = () => window.scrollTo(0, document.body.scrollHeight);
window.addEventListener('message', e => {
  const m = e.data;
  if (m.type === 'search') {
    q.value = m.query;
    search(false);
    return;
  }
  if (m.type !== 'render') return;
  const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
  const y = window.scrollY;
  root.innerHTML = m.html;
  if (q.value) search(true);
  if (m.isUpdate) window.scrollTo(0, atBottom ? document.body.scrollHeight : y);
});
</script>
</body>
</html>`;
}

const CSS = `
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0 20px 40px; max-width: 980px; margin: 0 auto; line-height: 1.5; }
.toolbar { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 8px 0; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
.toolbar button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 10px; border-radius: 2px; cursor: pointer; }
.toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
header.session h1 { font-size: 1.4em; margin: 16px 0 4px; font-weight: 600; }
.meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; overflow-wrap: anywhere; }
.mono, code, pre { font-family: var(--vscode-editor-font-family); }
main { margin-top: 16px; }
.turn { margin: 14px 0; padding: 8px 12px; border-left: 3px solid var(--vscode-panel-border); }
.turn.user { border-left-color: var(--vscode-textLink-foreground); background: var(--vscode-textBlockQuote-background); }
.turn.assistant { border-left-color: var(--vscode-charts-purple, #b180d7); }
.turn > header { font-weight: 600; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 4px 0; }
pre { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 3px; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.9em; margin: 4px 0; }
details { margin: 4px 0; }
details > summary { cursor: pointer; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
details.tool > summary .tool-name { font-family: var(--vscode-editor-font-family); color: var(--vscode-symbolIcon-functionForeground, var(--vscode-foreground)); }
details.tool.error > summary .tool-name { color: var(--vscode-errorForeground); }
details.thinking .text, details.thinking .md { color: var(--vscode-descriptionForeground); font-style: italic; }
details.subagent { border: 1px solid var(--vscode-panel-border); padding: 6px 10px; border-radius: 3px; }
.label { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-top: 6px; }
.system { color: var(--vscode-descriptionForeground); font-size: 0.85em; text-align: center; margin: 10px 0; border-top: 1px dashed var(--vscode-panel-border); padding-top: 6px; }
.muted, .trunc { color: var(--vscode-descriptionForeground); }
.trunc { display: block; font-style: italic; }
.error { color: var(--vscode-errorForeground); }
.md { overflow-wrap: anywhere; margin: 4px 0; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p, .md ul, .md ol, .md blockquote, .md .table-wrap { margin: 6px 0; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: 14px 0 6px; line-height: 1.25; font-weight: 600; }
.md h1 { font-size: 1.35em; } .md h2 { font-size: 1.2em; } .md h3 { font-size: 1.08em; } .md h4, .md h5, .md h6 { font-size: 1em; }
.md ul, .md ol { padding-left: 1.6em; }
.md li { margin: 2px 0; }
.md li > p { margin: 2px 0; }
.md :not(pre) > code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; font-size: 0.92em; }
.md blockquote { border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border)); padding: 2px 10px; color: var(--vscode-descriptionForeground); }
.md hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 12px 0; }
.md a { color: var(--vscode-textLink-foreground); }
.md .table-wrap { overflow-x: auto; }
.md table { border-collapse: collapse; font-size: 0.95em; }
.md th, .md td { border: 1px solid var(--vscode-panel-border); padding: 4px 10px; text-align: left; vertical-align: top; overflow-wrap: normal; }
.md th { background: var(--vscode-textCodeBlock-background); font-weight: 600; }
.toolbar .search { margin-left: auto; display: flex; gap: 4px; align-items: center; }
.toolbar input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; border-radius: 2px; width: 200px; font: inherit; }
.toolbar input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
#count { font-size: 0.9em; min-width: 5em; text-align: right; }
mark.hit { background: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33)); color: inherit; border-radius: 2px; }
mark.hit.current { background: var(--vscode-editor-findMatchBackground, rgba(255, 150, 50, 0.6)); outline: 1px solid var(--vscode-editor-findMatchBorder, transparent); }
body.hide-tools details.tool, body.hide-thinking details.thinking { display: none; }
`;
