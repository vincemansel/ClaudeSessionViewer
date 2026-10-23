// Runs the vscode-free modules against a throwaway CLAUDE_CONFIG_DIR.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadSessions, loadTranscript, sessionPaths, deleteSessionFiles } = require('../dist/test-lib/sessions.js');
const { renderTranscript } = require('../dist/test-lib/render.js');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
let dir;

function line(o) {
  return JSON.stringify(o) + '\n';
}

function transcript(id, cwd, prompt, extra = []) {
  const base = { sessionId: id, cwd, gitBranch: 'main', version: '2.1.0', entrypoint: 'cli', userType: 'external', isSidechain: false };
  const u1 = 'aaaaaaaa-0000-4000-8000-00000000000' + id[0];
  const a1 = 'bbbbbbbb-0000-4000-8000-00000000000' + id[0];
  const r1 = 'cccccccc-0000-4000-8000-00000000000' + id[0];
  const a2 = 'dddddddd-0000-4000-8000-00000000000' + id[0];
  return [
    line({ ...base, type: 'user', uuid: u1, parentUuid: null, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: prompt } }),
    line({ ...base, type: 'assistant', uuid: a1, parentUuid: u1, timestamp: '2026-10-20T10:00:05.000Z', message: { id: 'msg_1', role: 'assistant', model: 'm', type: 'message', content: [
      { type: 'thinking', thinking: 'Let me look <carefully>.', signature: 's' },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls', description: 'List files' } },
    ] } }),
    line({ ...base, type: 'user', uuid: r1, parentUuid: a1, timestamp: '2026-10-20T10:00:06.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'README.md\n<script>alert(1)</script>' }] } }),
    line({ ...base, type: 'assistant', uuid: a2, parentUuid: r1, timestamp: '2026-10-20T10:00:09.000Z', message: { id: 'msg_2', role: 'assistant', model: 'm', type: 'message', content: [{ type: 'text', text: 'Done.\n```swift\nlet x = 1\n```' }] } }),
    ...extra,
  ].join('');
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-test-'));
  const p1 = path.join(dir, 'projects', '-work-alpha');
  const p2 = path.join(dir, 'projects', '-work-alpha-worktree');
  fs.mkdirSync(path.join(p1, 'memory'), { recursive: true });
  fs.mkdirSync(p2, { recursive: true });
  fs.writeFileSync(path.join(p1, 'memory', 'notes.md'), '# memory, not a transcript');
  fs.writeFileSync(path.join(p1, `${A}.jsonl`), transcript(A, '/work/alpha', 'Fix the parser'));
  fs.writeFileSync(path.join(p2, `${B}.jsonl`), transcript(B, '/work/alpha-worktree', 'Second worktree task'));
  process.env.CLAUDE_CONFIG_DIR = dir;
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('lists sessions from every project folder and skips memory', async () => {
  const all = await loadSessions({ includeProgrammatic: false });
  assert.deepEqual(all.map((s) => s.id).sort(), [A, B]);
  const a = all.find((s) => s.id === A);
  assert.equal(a.cwd, '/work/alpha');
  assert.equal(a.gitBranch, 'main');
  assert.match(a.title, /Fix the parser/);
  assert.ok(a.file.endsWith(`${A}.jsonl`));
});

test('reads messages and pairs tool results with their calls', async () => {
  const [a] = (await loadSessions({ includeProgrammatic: true })).filter((s) => s.id === A);
  const t = await loadTranscript(a);
  assert.ok(t.messages.length >= 3, `got ${t.messages.length} messages`);
  const html = renderTranscript(a, t, { showThinking: false });
  assert.match(html, /Fix the parser/);
  assert.match(html, /<span class="tool-name">Bash<\/span> <span class="tool-sum">List files<\/span>/);
  assert.match(html, /README\.md/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;carefully&gt;/);
  assert.match(html, /<pre class="code" data-lang="swift"><code>let x = 1<\/code><\/pre>/);
  // The tool-result-only user message is not shown as its own turn.
  assert.equal((html.match(/class="turn user"/g) || []).length, 1);
});

test('truncates very large blocks', async () => {
  const [a] = await loadSessions({ includeProgrammatic: true });
  const t = await loadTranscript(a);
  const html = renderTranscript(a, t, { showThinking: true, maxBlockChars: 5 });
  assert.match(html, /more characters/);
});

test('deletes a session transcript and its subagent folder, nothing else', async () => {
  const p = path.join(dir, 'projects', '-work-gamma');
  fs.mkdirSync(path.join(p, C, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(p, `${C}.jsonl`), transcript(C, '/work/gamma', 'Throwaway session'));
  fs.writeFileSync(path.join(p, C, 'subagents', 'agent-x.jsonl'), line({ type: 'user', message: { role: 'user', content: 'hi' } }));
  fs.writeFileSync(path.join(p, 'keep.md'), 'not part of the session');

  const c = (await loadSessions({ includeProgrammatic: true })).find((s) => s.id === C);
  assert.ok(c);
  assert.deepEqual(await sessionPaths(c), [path.join(p, `${C}.jsonl`), path.join(p, C)]);

  await deleteSessionFiles(c);
  assert.ok(!fs.existsSync(path.join(p, `${C}.jsonl`)));
  assert.ok(!fs.existsSync(path.join(p, C)));
  assert.ok(fs.existsSync(path.join(p, 'keep.md')));
  const ids = (await loadSessions({ includeProgrammatic: true })).map((s) => s.id).sort();
  assert.deepEqual(ids, [A, B]);
});

test('a session without a subagent folder is just its transcript', async () => {
  const [a] = (await loadSessions({ includeProgrammatic: true })).filter((s) => s.id === A);
  assert.deepEqual(await sessionPaths(a), [a.file]);
});
