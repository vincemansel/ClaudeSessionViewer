# Claude Session Viewer

A VS Code side panel for browsing Claude Code session transcripts. It lists every
session under `~/.claude/projects/`, across all project directories, so history from other
worktrees and old checkouts is one click away, and opens any of them as a readable transcript.

Viewing never starts a model turn. The extension reads transcripts with the Agent SDK's
`listSessions()`, `getSessionMessages()`, `listSubagents()` and `getSubagentMessages()`, and
never calls `query()`, so browsing costs nothing.

## Features

- **Sessions panel** in the activity bar, grouped by project (working directory), newest first.
  Each row shows the title (your `/rename` title, the summary, or the first prompt), git branch
  and age; the tooltip has the full first prompt, session ID, path, dates and size.
- **Find Session…** (search icon, or `Claude Sessions: Find Session…` in the command palette):
  a quick pick over every session, matching title, project, branch and first prompt.
- **Filter** the tree by words; every word must match.
- **Transcript tab**: your prompts and Claude's replies, with tool calls collapsed under their
  name and a one-line summary, each tool's result nested under its call, thinking collapsed,
  code fences as code blocks, and subagent transcripts at the end. Toggle tool calls and
  thinking, expand or collapse everything, and use `Cmd+F` to search.
- **Live**: the list and open transcripts update as sessions are written, so a running
  session can be followed from another window.
- **Right-click a session** to open the raw JSONL, reveal it in Finder, copy the session ID,
  or copy a ready-to-paste `cd … && claude --resume <id>` command.
- **Archive** hides a session from the list (toggle *Show or Hide Archived* to see it again).
- **Delete** removes a session from disk: right-click → *Delete…*, or select one or more rows
  and press `Delete` (`Cmd+Backspace` on macOS). A confirmation lists the files first: the
  `<id>.jsonl` transcript and its `<id>/` folder of subagent transcripts and tool results.
  Choose *Move to Trash* (recoverable) or *Delete Permanently*. It warns when a session was
  written in the last two minutes, since it may still be running. Nothing outside those paths
  is touched, and nothing is ever deleted without that confirmation.
- **Scope**: all projects (default) or only this workspace and its git worktrees.

The `memory/` folders next to transcripts are Claude's auto-memory, not sessions, and are not
listed.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `claudeSessions.scope` | `all` | `all` projects, or `workspace` (this folder and its worktrees). |
| `claudeSessions.includeProgrammatic` | `false` | Also list headless sessions (Agent SDK, `claude -p`). |
| `claudeSessions.archiveWritesTag` | `false` | Archiving also writes a `frozen` tag into the transcript via `tagSession()`, so other tools see it. Off keeps the extension strictly read-only; the archive list lives in VS Code's state. |
| `claudeSessions.showThinking` | `false` | Expand thinking blocks by default. |
| `claudeSessions.liveUpdate` | `true` | Watch the projects folder and refresh on change. |
| `claudeSessions.configDir` | empty | Claude config directory; empty uses `$CLAUDE_CONFIG_DIR`, then `~/.claude`. |

## Install

```bash
npm install
npm run package                     # builds claude-session-viewer-<version>.vsix
code --install-extension claude-session-viewer-*.vsix
```

## Develop

```bash
npm install
npm run typecheck
npm test        # builds, then runs node:test against a throwaway CLAUDE_CONFIG_DIR
npm run watch   # rebuild on save; press F5 in VS Code to launch an Extension Development Host
```

`esbuild.mjs` bundles the extension and the SDK's session readers into one CommonJS file,
`dist/extension.js`, so the `.vsix` carries no `node_modules` and none of the SDK's
platform binaries (only `query()` needs those).

Layout: `src/sessions.ts` reads sessions (SDK plus a fallback scan of `*.jsonl` for sessions
the SDK skips), `src/render.ts` turns messages into HTML (no `vscode` import, so it is
testable), `src/tree.ts` is the sidebar, `src/viewer.ts` the transcript tab, and
`src/extension.ts` wires commands, settings and the file watcher.
