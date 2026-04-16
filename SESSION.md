# Session notes

Ongoing notes for Claude across sessions. Update when picking work back up or leaving a thread dangling.

## Last shipped

**Commit:** `025aae8` — *Agent-first redesign: slash commands, sessions, new layout*

Everything from the original `改造計畫` that could be done autonomously is shipped. See `README.md` for the user-facing description and `TODO.md` for what's left.

## Mental model of the app today

**One window, three zones.**

- **Left column (440px desktop, full width mobile)**
  - Header: title + `RepoSwitcher` (trigger button `maxW=140`) + gear icon for Settings
  - Task list (sorted alphabetically; trunk pinned first)
    - `TaskRow` is a semantic `<button>` for Tab/Enter keyboard access
    - Right-click opens a grouped context menu: **Copy name** / **Open issue** / **Open in Linear** / **Preview** / **Open in editor** / **Delete**
    - Clicking auto-starts the sandbox if it's `stopped`/`error`, then opens the terminal
    - Archived rows (branch gone) are filtered out entirely
    - Deleting state: opacity drop + inline spinner, non-clickable
  - `n/cap running` footer (bottom-right, turns orange at cap)
  - Slash-command composer (disabled at cap)
    - `/branch <name> [base]`, `/gh-issue <url>`, `/linear <url>`
    - `/` opens a popover menu with keyboard navigation (↑/↓/Tab/Enter); palette gated on input focus

- **Right column (flex-1 desktop, full-screen mobile)**
  - Always-mounted `TerminalModal`
  - Header: back-arrow (mobile) + branch name + `Claude / Terminal / Logs` tabs + icon buttons (Preview, Editor, Full screen, Close) with tooltips
  - Non-running status bar (creating / starting / stopped / error) — suppressed for trunk, which always has working Claude/shell ptys via `sharedPty`
  - Terminal WebSocket gated on `branch.status === "running"` (except trunk, which always connects)

## Data model cheat sheet

```
Session (sessions.jsonl, append-only)
  id, repo, branch, issueUrl?, linearUrl?, summary?, createdAt, completedAt?

Branch (state.json)
  id, name, repoId, isTrunk?, worktreePath, sandboxName?, port, status, createdAt, error?
  status ∈ "creating" | "stopped" | "starting" | "running" | "error"
  (note: "starting" is in the union but no code path actually sets it)

Task (frontend-only, derived)
  { session?, branch? }
  — trunk has only branch
  — active sandbox task has both
  — archived (no branch) filtered out before render
```

## Lifecycle guarantees

- **Concurrency cap** (`MAX_SANDBOXES`, default 9, +1 for trunk in UI): enforced in `startSandbox`, surfaced in the composer as disabled + orange badge.
- **Idle auto-stop** (`SANDBOX_IDLE_MS`, default 30m): sweeper stops pty'd sandboxes whose `lastActivity` is older than the cutoff.
- **Stuck-create detection**: branches in `creating` status > 5m are flipped to `error: "startup stalled"` by the same sweeper tick. Catches backend-crash-mid-create orphans.
- **External kill**: `term.onExit` checks branch state; if still `running`, flips to `stopped`. Covers `docker sandbox stop` from a shell, Docker Desktop restart, etc.
- **Dashboard auto-start on Logs tab**: backend `terminal.ts` calls `ensureDashboardRunning` before attaching if the shared pty is missing.
- **Backend restart**: `index.ts` rehydrates running branches via `startSandbox` and backfills sessions via `ensureSession` for every non-trunk branch.

## Seed-prompt mechanism

`/gh-issue` and `/linear` type a prompt into the fresh sandbox PTY after:
- 1.5s of no output from the entrypoint (quiescence) — or
- 30s hard cap, whichever comes first

No image changes. Works against whatever Claude's default entrypoint renders. Lives in `backend/src/docker.ts::scheduleSeedPrompt`.

## Rough edges I'm aware of

- **Mobile right-click:** no long-press fallback, so context menu is unreachable on touch. Tracked in TODO #3.
- **`starting` status in the union but unused:** benign; if anything, it's a placeholder for a future "waiting for claude to boot" state we don't actually need right now.
- **`prUrl` in old sessions.jsonl rows:** field was removed from the type when `/pr` was dropped. Old rows still parse fine; the extra property is ignored.
- **Non-trunk Logs tab:** if a dashboard exits and the branch is still running, the user has to reopen the Logs tab to respawn it (auto-restart only on reconnect, not on watchdog).
- **`RepoSwitcher` trigger** has hardcoded `maxW=140px` — fits two repos of common names but will clip long ones. Intentional tradeoff for the tight header.

## Where to start next session

The first two items in `TODO.md` are the ones that would actually get used:

1. **Manual snapshot via Claude** (TODO #1) — highest visible payoff. Right-click → Snapshot, backend types a prompt, Claude writes `.calypso-summary.md`, backend polls for the file, displays summary as subtitle. Well-scoped, all the machinery exists (seed-prompt write path, session update path, frontend context menu).
2. **Tailscale + Caddy** (TODO #2) — can't be done in-editor; needs the user at the Mac. Unblocks remote access from the phone.

If the user wants polish instead:
- **Touch-device long-press** (TODO #3) — small, self-contained.
- **Arrow-key nav in task list** (TODO #4) — small, complements the Tab+Enter flow.

## Key files

- `backend/src/routes.ts` — `/api/commands` dispatcher, REST API
- `backend/src/docker.ts` — sandbox lifecycle, seed prompts, pty bookkeeping
- `backend/src/index.ts` — bootstrap, idle sweeper, rehydrate, branch proxy
- `backend/src/sessions.ts` — JSONL log
- `backend/src/terminal.ts` — WS per `kind=claude|shell|dashboard`
- `frontend/src/App.tsx` — layout, task list, composer, context menu
- `frontend/src/TerminalModal.tsx` — terminal panel + icon buttons + status bar
- `frontend/src/Welcome.tsx` — first-run onboarding

## Don't re-derive these decisions

- **JSONL over SQLite** for sessions — decided because schema is flat and writes are rare. Revisit only if sessions cross a few thousand rows.
- **Seed prompt via PTY typing** instead of image changes or MCP — chosen because it works against any Claude entrypoint without extra config.
- **Right-click as the action surface** — cards stay visually clean; Preview/Editor are also in the terminal header once a task is open.
- **Trunk runs on the host** — gives direct access to the real Claude config and avoids a pointless sandbox wrapper for the default branch.
- **`/pr` removed** — was redundant with `/branch` once sessions got `prUrl` via `create-pr`. Then `create-pr` itself was removed because the user pushes PRs manually.
