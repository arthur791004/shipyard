# TODO

## 1. Manual snapshot / summary capture via Claude

Right-click a task → **Snapshot**. Backend types a short prompt into the sandbox PTY asking Claude to write `.calypso-summary.md` in the project root, then polls the worktree for the file (3s interval, 2 min timeout). When it appears, read it, call `updateSession(id, { summary })`, delete the file. Frontend's session poll picks it up and renders the summary as a subtitle under the branch name.

- New endpoint: `POST /api/branches/:id/snapshot`
- Uses the existing seed-prompt PTY write mechanism (`entry.term.write`)
- Polls `fs.stat` rather than `fs.watch` (macOS fs.watch is flaky)
- Surface a "timed out" toast if Claude doesn't comply within 2 min
- Prompt ends with "then continue what you were doing" so Claude doesn't stop mid-task

## 2. Tailscale + Caddy host setup

Out of scope for in-editor work — needs the user at the Mac.

- Install Tailscale, sign Mac + phone into the same tailnet, enable MagicDNS
- Caddyfile with wildcard `*.mac.ts.net` → backend
- Sandbox lifecycle registers/unregisters a per-branch subdomain (e.g. `issue-42.mac.ts.net` → `127.0.0.1:<branch.port>`)
- Backend already listens on `0.0.0.0`, so LAN access works today; this is only about pretty hostnames and remote access via Tailscale

## 3. Touch-device context menu

Right-click doesn't exist on tablets/phones, so Delete, Copy name, Open issue, etc. are unreachable on touch. The responsive layout otherwise works fine on mobile.

- Long-press (say 500ms) on a `TaskRow` opens the same context menu
- `onTouchStart` starts a timer; `onTouchEnd` / `onTouchMove` cancels it
- Position the menu relative to the touch point, not page coords — mobile viewports scroll

## 4. Arrow-key navigation in task list

Tab navigation works, but cycling through many tasks with Tab is slow. Arrow keys would let the user walk the list with ↑/↓ and activate with Enter.

- Track a focused-task index at the App level
- ↑/↓ updates index, wraps at ends
- Enter on the focused row triggers `onSelectTask`
- Tab still works (browser default), this is additive

## 5. Swap JSONL → SQLite

Only if `sessions.jsonl` becomes a problem:

- Rows > a few thousand and read-all-on-load gets slow
- Want to filter/join on the frontend (e.g. "show all `/linear` tasks from last week")
- Otherwise JSONL is fine

Migration would be a single-file swap of `backend/src/sessions.ts`. Schema is already flat.
