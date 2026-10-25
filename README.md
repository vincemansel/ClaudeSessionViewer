# Claude Session Viewer

## Why I made this

Claude Code saves every session, but once a session ends it's hard to get back to.
`claude --resume` only shows sessions for the folder you're in, so work from another
worktree or an old checkout is effectively hidden. The raw JSONL is hard to read, and
reopening a session just to look something up risks starting a new turn which costs tokens. I wanted one place
in VS Code to see all my sessions across every project: search them, read them like a
conversation, copy a resume command when I want to pick one up again, and delete the ones
I'm done with. It never calls the model, so browsing your history costs nothing. If you use
Claude Code across several repos or worktrees, it works as is.

## At a glance

- Every session from every project and worktree, in one sidebar
- Search inside all transcripts to find the sessions that mention something
- Search within one open transcript, with matches highlighted
- Readable transcripts with Markdown replies and collapsible tool calls
- Live updates while a session is running
- Copy a ready-to-paste resume command
- Archive or delete sessions you're done with
- Never calls the model, so browsing costs nothing

## Get started

You need [Node.js](https://nodejs.org) 20 or newer, `git`, and VS Code with the `code`
command on your PATH. On macOS, run **Shell Command: Install 'code' command in PATH** from
the VS Code command palette if `code` isn't found.

```bash
git clone https://github.com/vincemansel/ClaudeSessionViewer.git
cd ClaudeSessionViewer
npm install
npm run install-vsix                                 # builds this version and installs it
```

`install-vsix` removes any old `.vsix` builds, packages the current version, and installs it
over whatever version VS Code has, so there's nothing to uninstall first. Then, in VS Code, open the command palette (`Cmd+Shift+P` or `Ctrl+Shift+P`) and run
**Developer: Reload Window**. Click the **Claude Sessions** icon in the activity bar to see
your sessions. They're read from `~/.claude/projects/`. If yours are somewhere else, set
`claudeSessions.configDir`.

To update later:

```bash
git pull
npm install
npm run install-vsix
```

Then reload the window. The panel title shows the version you're running, for example
`Sessions v0.7`. If `code` isn't on your PATH, `install-vsix` still builds the `.vsix` and
tells you its name, so you can install it from the Extensions view (**…** › **Install from
VSIX…**).

## Overview

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
- **Search Transcripts…** (fuzzy search icon): finds text anywhere inside every session,
  including prompts, replies, thinking, tool calls and their output, and subagent transcripts.
  The list narrows to the sessions that contain it, each showing its number of matches, with
  the first match in the tooltip. *Clear Filter* brings everything back.
- **Search this transcript**: the box in a transcript's toolbar (or `Cmd+F` / `Ctrl+F`)
  highlights matches in that session only. `Enter` and `Shift+Enter` step through them,
  opening collapsed tool calls and thinking as needed; `Esc` clears. A session opened from
  *Search Transcripts…* starts with the same text searched and jumps to its first match.
- **Transcript tab**: your prompts and Claude's replies, with tool calls collapsed under their
  name and a one-line summary, each tool's result nested under its call, thinking collapsed,
  and subagent transcripts at the end. Claude's replies and thinking render as Markdown
  (tables, headings, lists, quotes, links, inline code and code blocks); your prompts and tool
  output stay as typed. Raw HTML in a transcript is always shown as text. Toggle tool calls and
  thinking, expand or collapse everything, and search the transcript (below).
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

## Build and install manually

```bash
npm install
npm run package                     # builds claude-session-viewer-<version>.vsix
code --install-extension claude-session-viewer-<version>.vsix --force
```

`npm run install-vsix` does both steps and removes old builds first.

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

## Release notes

See [RELEASE_NOTES.md](RELEASE_NOTES.md) for what changed in each version. From 0.6 on, the
version number matches the pull request that shipped it.
