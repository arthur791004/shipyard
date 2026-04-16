# TODO

## Shipped this session

### Task file via `.tasks/` folder ✅
- Backend writes `.tasks/<slug>.jsonl` with structured task entries (command, source URL, pre-fetched body, port, instructions)
- `/gh-issue` pre-fetches issue title, body, and comments via `gh issue view` on the host
- `/linear` pre-fetches via GraphQL API when `LINEAR_API_KEY` is set
- CLAUDE.md in each worktree gets an injected task section pointing at the file
- Seed prompt ("Read CLAUDE.md and start working on the task.") sent via PTY quiescence
- `.tasks/` mounted into every sandbox

### Clone instead of symlink ✅
- `git clone --local --branch <default>` replaces symlink for trunk
- Eliminates git index corruption from host/sandbox concurrent access
- Each worktree has its own `.git` — no shared state with the user's original checkout
- `yarn install` runs on the host (fast, cached) during repo and branch creation

### Trunk runs in sandbox ✅
- Trunk gets a `sandboxName` and Docker sandbox like every other branch
- Consistent lifecycle: reload, hard reload, terminal tabs all work the same
- Dashboard still runs on the host (see parked item below)

### Push & PR from host ✅
- `POST /api/branches/:id/push` — runs `git push -u origin HEAD && gh pr create --fill` on the host
- Sandbox has no SSH keys or gh auth (security boundary)
- Push icon button in terminal header + right-click menu item

### Self-healing sandbox refresh ✅
- Reload: kills Claude, execs fresh session (~2-3s)
- Hard Reload: rm + recreate + start (fixes zombie VMs, broken sockets)
- Reload button in terminal header (right-click for Hard Reload)
- Also in task right-click menu

### Other
- `--dangerously-skip-permissions` for sandbox Claude
- Sandbox config independent from host (mount-first, auth-only from host)
- Auto-reconnect WebSocket (2s retry)
- Non-blocking task select (terminal opens immediately)
- Arrow key navigation, Cmd+P to focus command input
- Resizable left column (persisted to localStorage)
- Clone uses `--branch <defaultBranch>` to always clone trunk regardless of host HEAD

---

## Known issues to resolve

### Sandbox Claude may not auto-start on task
- CLAUDE.md injection + seed prompt works but Claude sometimes ignores it (asks "what do you want to work on?" instead of reading the file)
- `--dangerously-skip-permissions` helps but doesn't guarantee Claude reads CLAUDE.md
- May need to pass the task as CLI argument: `claude "Read CLAUDE.md and start"` instead of PTY injection

### Git hooks fail in sandbox (`yarn: not found`)
- Sandbox has Node 20, no yarn. Hooks (husky) call `yarn lint-staged` which fails.
- Current workaround: task instructions say commit normally (no `--no-verify`), but hooks may fail
- Proper fix: either install yarn+Node 22 in sandbox (slow, see parked #2) or tell Claude to use `--no-verify`

### Stale worktrees after failed creates
- If `createBranchFlow` fails mid-way, the worktree directory can remain on disk
- `git worktree add` then fails with "already exists" on retry
- Manual cleanup: `git worktree remove --force <path> && git worktree prune`
- Should add automatic cleanup in the error path

### Sessions accumulate in JSONL
- `sessions.jsonl` is append-only with last-write-wins dedup on load
- Over time, many duplicate rows for the same session (each update appends)
- Not a problem yet but will slow down if sessions reach thousands
- Fix: periodic compaction or swap to SQLite (TODO #5)

---

## 2. Web server inside sandbox + port forwarding (PARKED)

### What we tried

Moved the per-branch dev server from the host into the Docker sandbox:

1. **Port forwarding via socat** — Node.js TCP proxy on host spawns `docker sandbox exec -i <name> socat - TCP:localhost:<port>` per connection. Works. Code in `backend/src/portforward.ts` (still on disk, unused).

2. **Auto-start dashboard** — `autoStartDashboardInSandbox` execs `yarn install && PORT=<port> yarn start-dashboard` inside sandbox via shared PTY.

3. **Logs tab** — connects to same shared PTY for dev server output.

### What we encountered

| Issue | Detail | Attempted fix |
|-------|--------|---------------|
| Sandbox proxy blocks Yarn Berry | MITM proxy at `host.docker.internal:3128`. Yarn 4 ignores `HTTP_PROXY` env vars. | `yarn config set httpProxy/httpsProxy/httpsCaFilePath` |
| No yarn in sandbox | Fresh sandboxes have no global yarn | `npm install -g yarn` (~5s) |
| Node 20 vs Node 22 | Sandbox image ships Node 20; wp-calypso needs 22 | `npx n 22` to user dir (~15s) |
| yarn install slow in sandbox | Proxy overhead + no cache | Run install on host, only start cmd in sandbox |
| Start command needs yarn+Node 22 | Even `yarn start-dashboard` needs them in sandbox | Full Node 22 + yarn global install |
| Cascading startup time | Each fix adds seconds: n(15s) + yarn(5s) + install(varies) | Unacceptable for fast iteration |

### Decision

Rolled back. Dev server runs on host. Sandbox focuses on Claude + code. Revisit when Docker sandbox ships Node 22 image or native port forwarding.

## 3. Right-click → Generate Summary

Right-click a task → **Generate Summary**. Backend asks Claude to summarize progress, appends to `.tasks/<branch>.jsonl`.

- New endpoint: `POST /api/branches/:id/snapshot`
- Types prompt into sandbox PTY: "Summarize what you've done so far and write to .tasks/..."
- Polls for new `summary` entry (3s interval, 2 min timeout)
- On success, `updateSession(id, { summary })` → UI shows subtitle

## 4. Generate summary via sub-agent file watcher

Non-interrupting alternative to #3: sub-agent inside sandbox watches `.tasks/<branch>.jsonl` for `snapshot-request` entries.

- Backend appends `{"type":"snapshot-request","ts":...}` to trigger
- Sub-agent notifies main Claude → summary appended back
- No PTY interruption, no timing guesswork

## 5. Chat mode vs Terminal mode

Switch between PTY terminal and structured JSON chat per sandbox.

**Terminal mode** (current): raw xterm.js, interact by typing
**Chat mode**: `--input-format stream-json --output-format stream-json`, chat bubble UI, summary via `send_message()` call

Store mode in `state.json` per branch. Global default in settings.

## 6. Single sandbox, multiple Claude sessions

Replace the current one-sandbox-per-branch model with one sandbox per repo, running multiple Claude processes inside via `docker sandbox exec`.

### Current

One docker sandbox per branch → slow create/start, high resource usage.

### New

- One docker sandbox per repo, created once on first use
- Each branch starts a Claude process via `docker sandbox exec --workdir /worktrees/<branch>`
- Isolation is handled by git worktrees, not sandbox boundaries

### Lifecycle

| Action | Command |
|--------|---------|
| Repo added | `docker sandbox run <repo-name>` once (slow, but only once) |
| Branch start | `docker sandbox exec --interactive <repo-name> bash -c "cd /worktrees/<branch> && claude --dangerously-skip-permissions"` |
| Branch stop | Kill the exec process only, sandbox keeps running |
| Branch restart | Re-run exec, reads `.tasks/<branch>.jsonl` for context |
| Repo removed | `docker sandbox rm <repo-name>` |

### Port forwarding

- Each branch web server binds to a different port inside the sandbox (4001, 4002, 4003...)
- Backend calls `docker sandbox ports <repo-name> --publish <host-port>:<container-port>` per branch after Claude starts
- Caddy wildcard routes `issue-42.mac.ts.net` → `localhost:4001`
- On branch stop, `docker sandbox ports <repo-name> --unpublish <host-port>:<container-port>`

### Benefits

- Start/stop is just a process, not a VM — much faster
- One sandbox per repo instead of N sandboxes per repo
- Port forwarding still works, just multiple ports on the same sandbox
- Node/yarn only installed once per sandbox, shared across all branches
- Solves the "sandbox web server" problem (TODO #2) since all branches share the same runtime

### Considerations

- All branches share the same sandbox filesystem — one bad install can affect others
- Need to mount all worktrees into the sandbox (or mount the entire `.config/repo/<name>/` dir)
- `restartSandboxClaude` already uses `docker sandbox exec`, so the exec pattern is proven
- Trunk could also run inside this single sandbox (same as other branches)

## 7. Swap JSONL → SQLite

Only if `sessions.jsonl` becomes a problem (thousands of rows, slow load). Single-file swap of `backend/src/sessions.ts`.
