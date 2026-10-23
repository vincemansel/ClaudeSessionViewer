import * as vscode from 'vscode';
import { renderTranscript } from './render';
import { loadTranscript, type SessionEntry } from './sessions';

interface Settings {
  configDir?: string;
  showThinking: boolean;
}

/** One webview tab per session. Opening a session that is already open reveals it. */
export class TranscriptPanels {
  private readonly panels = new Map<string, { panel: vscode.WebviewPanel; entry: SessionEntry }>();

  constructor(private readonly settings: () => Settings) {}

  async open(entry: SessionEntry): Promise<void> {
    const existing = this.panels.get(entry.id);
    if (existing) {
      existing.entry = entry;
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('claudeSessions.transcript', shortTitle(entry.title), vscode.ViewColumn.Active, {
      enableScripts: true,
      enableFindWidget: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    });
    panel.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.panels.set(entry.id, { panel, entry });
    panel.onDidDispose(() => this.panels.delete(entry.id));
    panel.webview.html = shell(panel.webview, '<p class="muted">Loading…</p>');
    await this.render(entry.id, false);
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
    else p.panel.webview.html = shell(p.panel.webview, html);
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
export function shell(webview: { cspSource: string }, initial: string): string {
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
</nav>
<div id="root">${initial}</div>
<script nonce="${n}">
const root = document.getElementById('root');
const toggle = (id, cls) => document.getElementById(id).addEventListener('change', e => document.body.classList.toggle(cls, !e.target.checked));
toggle('tools', 'hide-tools');
toggle('thinking', 'hide-thinking');
document.getElementById('expand').onclick = () => root.querySelectorAll('details').forEach(d => d.open = true);
document.getElementById('collapse').onclick = () => root.querySelectorAll('details').forEach(d => d.open = false);
document.getElementById('bottom').onclick = () => window.scrollTo(0, document.body.scrollHeight);
window.addEventListener('message', e => {
  const m = e.data;
  if (m.type !== 'render') return;
  const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
  const y = window.scrollY;
  root.innerHTML = m.html;
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
body.hide-tools details.tool, body.hide-thinking details.thinking { display: none; }
`;
