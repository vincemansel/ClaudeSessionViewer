// Turns transcript messages into the webview's HTML body. Pure functions, no vscode
// import, so the tests can run them under plain node.
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionEntry, Transcript } from './sessions';

export interface RenderOptions {
  showThinking: boolean;
  /** Cap on characters shown for one tool input or result. */
  maxBlockChars?: number;
}

const DEFAULT_MAX = 20_000;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return escapeHtml(s);
  return escapeHtml(s.slice(0, max)) + `<span class="trunc">… ${(s.length - max).toLocaleString()} more characters. Open the raw JSONL for the rest.</span>`;
}

/** Plain text with ``` fences as code blocks; everything else keeps its line breaks. */
function renderText(text: string): string {
  const parts = text.split(/```/);
  return parts
    .map((part, i) => {
      if (i % 2 === 0) return part.trim() ? `<div class="text">${escapeHtml(part.replace(/^\n+|\n+$/g, ''))}</div>` : '';
      const nl = part.indexOf('\n');
      const lang = nl > 0 ? part.slice(0, nl).trim() : '';
      const code = nl >= 0 ? part.slice(nl + 1) : part;
      return `<pre class="code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`;
    })
    .join('');
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : JSON.stringify(b)))
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content, null, 2);
}

function toolSummary(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const pick =
    input.description ?? input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.prompt;
  return typeof pick === 'string' ? pick.replace(/\s+/g, ' ').slice(0, 120) : '';
}

function contentBlocks(msg: SessionMessage): any[] {
  const content = (msg.message as any)?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function isToolResultOnly(msg: SessionMessage): boolean {
  const blocks = contentBlocks(msg);
  return blocks.length > 0 && blocks.every((b) => b?.type === 'tool_result');
}

function renderMessages(messages: SessionMessage[], opts: RenderOptions): string {
  const max = opts.maxBlockChars ?? DEFAULT_MAX;
  const results = new Map<string, { content: unknown; isError: boolean }>();
  for (const m of messages) {
    for (const b of contentBlocks(m)) {
      if (b?.type === 'tool_result') results.set(b.tool_use_id, { content: b.content, isError: !!b.is_error });
    }
  }

  const out: string[] = [];
  let open: string | null = null; // role of the turn currently open
  const openTurn = (role: string, label: string) => {
    if (open === role) return;
    if (open) out.push('</section>');
    out.push(`<section class="turn ${role}"><header>${label}</header>`);
    open = role;
  };

  for (const m of messages) {
    if (m.type === 'system') {
      const text = resultText((m.message as any)?.content ?? m.message);
      if (open) out.push('</section>');
      open = null;
      out.push(`<div class="system">${truncate(text, 400)}</div>`);
      continue;
    }
    if (m.type === 'user' && isToolResultOnly(m)) continue; // shown under its tool call

    const role = m.type;
    openTurn(role, role === 'user' ? 'You' : 'Claude');
    for (const b of contentBlocks(m)) {
      switch (b?.type) {
        case 'text':
          if (typeof b.text === 'string' && b.text.trim()) out.push(renderText(b.text));
          break;
        case 'thinking':
          if (typeof b.thinking === 'string' && b.thinking.trim()) {
            out.push(`<details class="thinking"${opts.showThinking ? ' open' : ''}><summary>Thinking</summary><div class="text">${truncate(b.thinking, max)}</div></details>`);
          }
          break;
        case 'redacted_thinking':
          out.push('<div class="muted">Thinking (redacted)</div>');
          break;
        case 'tool_use': {
          const res = results.get(b.id);
          const summary = toolSummary(b.name, b.input);
          const input = JSON.stringify(b.input, null, 2) ?? '';
          const cls = res?.isError ? 'tool error' : 'tool';
          out.push(
            `<details class="${cls}"><summary><span class="tool-name">${escapeHtml(String(b.name))}</span>` +
              (summary ? ` <span class="tool-sum">${escapeHtml(summary)}</span>` : '') +
              (res ? '' : ' <span class="muted">(no result)</span>') +
              `</summary><div class="label">Input</div><pre><code>${truncate(input, max)}</code></pre>` +
              (res ? `<div class="label">${res.isError ? 'Error' : 'Result'}</div><pre><code>${truncate(resultText(res.content), max)}</code></pre>` : '') +
              `</details>`,
          );
          break;
        }
        case 'tool_result':
          break;
        case 'image':
          out.push('<div class="muted">[image]</div>');
          break;
        default:
          if (b) out.push(`<pre class="muted"><code>${truncate(JSON.stringify(b, null, 2), 2000)}</code></pre>`);
      }
    }
  }
  if (open) out.push('</section>');
  return out.join('\n');
}

export function renderTranscript(entry: SessionEntry, t: Transcript, opts: RenderOptions): string {
  const meta = [
    entry.cwd ?? entry.projectKey,
    entry.gitBranch ? `branch ${entry.gitBranch}` : '',
    entry.createdAt ? `started ${new Date(entry.createdAt).toLocaleString()}` : '',
    `updated ${new Date(entry.lastModified).toLocaleString()}`,
    entry.tag ? `tag ${entry.tag}` : '',
  ]
    .filter(Boolean)
    .map(escapeHtml)
    .join(' · ');

  const body = t.messages.length ? renderMessages(t.messages, opts) : '<p class="muted">No messages in this transcript yet.</p>';
  const subs = t.subagents
    .filter((s) => s.messages.length)
    .map(
      (s) =>
        `<details class="subagent"><summary>Subagent ${escapeHtml(s.id)} · ${s.messages.length} messages</summary>${renderMessages(s.messages, opts)}</details>`,
    )
    .join('\n');

  return (
    `<header class="session"><h1>${escapeHtml(entry.title)}</h1><div class="meta">${meta}</div>` +
    `<div class="meta mono">${escapeHtml(entry.id)} · ${t.messages.length} messages</div></header>` +
    `<main>${body}</main>` +
    (subs ? `<h2>Subagents</h2>${subs}` : '')
  );
}
