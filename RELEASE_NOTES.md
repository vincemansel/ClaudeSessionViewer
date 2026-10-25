# Release notes

From 0.6 on, each version matches the number of the pull request that ships it:
version `0.<PR number>`, so 0.6 is [PR #6](https://github.com/vincemansel/ClaudeSessionViewer/pull/6).
Newest first. The version also shows next to the **Sessions** panel title while this
numbering is in use.

## 0.10

- **Fix:** Session Viewer's right-click items now appear only in its own Sessions sidebar.
  Before, they also showed on Claude Token Reporter's session rows, which use the same
  `session` row type, so picking one there gave an error. Token Reporter makes the
  matching fix for its own items.

## 0.9

- **Cross-link with Claude Token Reporter 0.15:** right-click a session › *Open in Token
  Reporter* opens its token report. The item shows only when Token Reporter is installed.
- New command `claudeSessions.openSession` (`{ sessionId, cwd? }`) opens a session's
  transcript and selects it in the sidebar. Token Reporter's *Open in Session Viewer* uses it.

## 0.8

- **Group by date started:** a calendar button in the Sessions title bar picks All, Year,
  Month, Week or Day. Year to Day add period folders under each worktree, grouped by the
  date each session started, with a session count on each folder. Weeks run Saturday 2 PM
  to Saturday 2 PM. The title shows the grouping (`Sessions v0.8 · Month`).

## 0.7

- `npm run install-vsix` builds the current version and installs it over any installed
  version. It removes old `.vsix` builds first, so `code --install-extension` never picks up
  a stale one, and nothing needs uninstalling by hand. The README's install and update steps
  use it.

## 0.6

- Versions now follow PR numbers, starting here.
- The **Sessions** panel title shows the installed version (`Sessions v0.6`).
- Added these release notes, linked from the README.

## Before 0.6

Everything up to here shipped as 0.1.0. These are the pull requests that built it.

- **[#5](https://github.com/vincemansel/ClaudeSessionViewer/pull/5) Search.** *Search
  Transcripts…* narrows the list to the sessions whose text contains a phrase, with a match
  count for each. Each transcript tab got its own search box that highlights matches in that
  session only. The README got its *At a glance* list.
- **[#4](https://github.com/vincemansel/ClaudeSessionViewer/pull/4) README.** Why the tool
  exists and step-by-step install at the top.
- **[#3](https://github.com/vincemansel/ClaudeSessionViewer/pull/3) Markdown.** Claude's
  replies and thinking render as Markdown: tables, headings, lists, quotes and code.
- **[#2](https://github.com/vincemansel/ClaudeSessionViewer/pull/2) Delete.** Delete
  sessions from the panel, to the trash or permanently, after a confirmation that lists the
  files.
- **[#1](https://github.com/vincemansel/ClaudeSessionViewer/pull/1) First version.** A
  read-only panel listing every session across projects and worktrees, with readable
  transcripts, live updates, filter, Find Session, archive, and copy resume command.
