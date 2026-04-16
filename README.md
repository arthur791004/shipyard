# Calypso Multi-Agent

A local dev tool for running multiple Claude Code agents in parallel against different branches of [wp-calypso](https://github.com/Automattic/wp-calypso) — or any other git repo. Drive the whole thing from a single composer with slash commands: give Claude a GitHub issue or a Linear ticket and it spins up an isolated sandbox and starts working. The UI stays out of the way — a list of tasks on the left, a live terminal on the right.

## What it does

- **Slash-command composer** — one input box at the bottom of the task list. Type `/` to get a command palette:
  - `/branch <name> [base]` — start a blank sandbox on a new or existing branch.
  - `/gh-issue <url>` — derive a branch name from the issue number, create it, and seed Claude with a prompt to implement the issue.
  - `/linear <url>` — derive the branch name from the Linear ticket identifier and seed Claude with a prompt to implement it.
- **Unified task list** — every row is a "task" (session). Trunk is always the first row with a `Dashboard` badge. Click any row to open its terminal in the right panel; if the sandbox is stopped, clicking auto-starts it. Right-click for Copy name / Open issue / Open in Linear / Preview / Open in editor / Hard restart / Delete.
- **Task file (`.tasks/<slug>.jsonl`)** — each `/gh-issue` and `/linear` command writes a structured task entry (with pre-fetched issue title, body, and comments for GitHub; Linear content when `LINEAR_API_KEY` is set). Claude reads this file for context on startup. The task section is also injected into the worktree's `CLAUDE.md` so Claude picks it up automatically.
- **Pre-fetched issue content** — `/gh-issue` calls `gh issue view` on the host to fetch the issue title, body, and comments before the sandbox starts. Claude gets everything without needing `gh` CLI access inside the sandbox. `/linear` fetches via the GraphQL API when `LINEAR_API_KEY` is set.
- **Session log** — each task created via `/branch`, `/gh-issue`, or `/linear` is recorded in `sessions.jsonl` with its repo, branch, the source URL, and a completion timestamp.
- **Per-branch sandboxes** — each non-trunk task runs in its own `docker sandbox` container with Claude Code inside (`--dangerously-skip-permissions` since the sandbox is the security boundary). Credentials from `~/.claude-sandbox/` are synced in/out so one login covers all of them. Config is shared across sandboxes via a mount file — the first sandbox configures permissions interactively, subsequent ones inherit.
- **Seed prompt** — after sandbox Claude starts, a short nudge ("Read CLAUDE.md and start working on the task.") is typed into the PTY once output settles (1.5s quiescence, 30s hard cap). The actual task context lives in CLAUDE.md and the task file, not the prompt itself.
- **Self-healing restart** — the refresh button (or right-click → Hard restart) handles all failure modes: fast exec restart for running VMs (~2-3s), full stop+start for stopped VMs, and rm+recreate+start for zombie VMs with broken sockets. The terminal auto-reconnects via WebSocket with a 2s retry loop.
- **Concurrency cap + idle auto-stop** — default 9 live sandboxes (+ trunk). Sandboxes with no PTY activity for 30 minutes are automatically stopped; status shown at the bottom-right of the task list.
- **Customizable preview URL** — each repo stores its own dashboard URL in Settings (defaults to `http://my.localhost:3000`). The Preview action opens whatever URL the active repo is configured for.
- **Dashboard reverse proxy** — `http://my.localhost:3000` always routes to whichever branch is currently marked active, so Calypso's hostname handling (cookies, CORS) keeps working across branches.

## Architecture

```
┌──────────────────────────────────────────────┐
│           Frontend (Vite, :9091)             │
│   React + Chakra UI v3 + xterm.js terminal   │
│   Tasks (left)  ·  Terminal (right)          │
│   Slash-command composer at bottom-left      │
└───────┬──────────────────────────────────────┘
        │ /api/*, /api/branches/:id/terminal (ws)
┌───────▼──────────────────────────────────────┐
│        Backend (Fastify, :9090)              │
│                                               │
│  ┌─────────────┐  ┌──────────────────────┐   │
│  │ REST + WS   │  │ Branch proxy (:3000) │   │
│  │ /api/*      │  │ my.localhost →       │   │
│  │ /api/       │  │   active branch port │   │
│  │   commands  │  │                      │   │
│  └──────┬──────┘  └──────────┬───────────┘   │
│         │                    │               │
│  ┌──────▼──────┬─────────────▼─────┬─────┐   │
│  │ state.json  │ sessions.jsonl    │ pty │   │
│  │ (.config/)  │ (.config/)        │ pool│   │
│  │             │ append-only log   │     │   │
│  └─────────────┴───────────────────┴─────┘   │
│         │                                     │
│  ┌──────▼───────────────────────────────┐    │
│  │ idle sweeper (60s tick, 30min stop)  │    │
│  └──────────────────────────────────────┘    │
└───────┬──────────────────────────────────────┘
        │
   ┌────┴──────────────────────┐
   │                           │
┌──▼────────────────┐  ┌───────▼─────────────┐
│ Docker sandboxes  │  │ Host yarn processes │
│ (one per branch)  │  │ (yarn start-dashboard│
│ - claude pty      │  │  per branch, on     │
│ - seed prompt     │  │  shared pty)        │
│ - worktree bind   │  │                     │
│ - ~/.claude-      │  │                     │
│   sandbox bind    │  │                     │
└───────────────────┘  └─────────────────────┘
```

### Ports

| Port          | Service                                                     |
| ------------- | ----------------------------------------------------------- |
| `9090`        | Backend REST + WebSocket API                                |
| `9091`        | Vite frontend                                               |
| `3000`        | Branch proxy — `my.localhost:3000` → active branch dashboard|
| `4001–4999`   | Per-branch Calypso dashboard dev servers                    |

### Env overrides

| Variable                    | Default  | Purpose                                       |
| --------------------------- | -------- | --------------------------------------------- |
| `MAX_SANDBOXES`             | `9`      | Concurrency cap for docker sandboxes          |
| `SANDBOX_IDLE_MS`           | `1800000`| Idle timeout before auto-stop (30 min)        |
| `SANDBOX_IDLE_CHECK_MS`     | `60000`  | Sweeper tick interval                         |
| `DATA_DIR`                  | `.config`| Where `state.json` and `sessions.jsonl` live  |
| `DOCKER_IMAGE`              | `claude` | Docker image used for sandboxes               |
| `LINEAR_API_KEY`            | —        | Linear personal API key for `/linear` pre-fetch|

### Directories (under the project root's `.config/`)

| Path                              | Purpose                                            |
| --------------------------------- | -------------------------------------------------- |
| `.config/state.json`              | Persisted repos, branches, active branch, settings |
| `.config/sessions.jsonl`          | Append-only session log (one JSON row per task)    |
| `.tasks/<slug>.jsonl`             | Per-branch task history (mounted into sandboxes)   |
| `.config/repo/<repo>/<default>`   | Symlink to your local checkout (default branch)    |
| `.config/repo/<repo>/<branch>`    | Per-branch git worktrees                           |
| `~/.claude-sandbox/`              | Shared OAuth credentials injected into each sandbox|

## Getting started

Requires macOS (the folder picker uses `osascript`) with:

- Node 22+
- Docker Desktop with the `docker sandbox` plugin
- VS Code's `code` command on PATH (for Open in editor)
- A local repo checkout

```bash
npm install
npm run dev
```

Launches both the backend (`:9090`) and frontend (`:9091`) via `npm-run-all`. Open <http://localhost:9091> — on first run the Welcome screen asks you to pick a repo folder. It gets symlinked to `.config/repo/<name>/<default>` (no clone), and its trunk starts automatically.

Once running:
- Click any task row to open its terminal. Keyboard works too — Tab into the task list, then Enter.
- Right-click a task for Copy name, Open issue, Open in Linear, Preview, Open in editor, and Delete.
- Type `/` in the composer to get the command palette; Tab or Enter picks an item.
- The bottom-right of the task list shows `n/cap running`; it turns orange when full.
- On narrow viewports (phones, stacked windows) the layout collapses to one column — the task list is full-width until you tap a task, which swaps to a full-screen terminal with a back button.

### Per-repo settings (gear icon → Settings)

Each repo can override:
- **Install command** — runs in each worktree before the dev server. Default `yarn install`.
- **Start command** — dev server launcher. Default `yarn start-dashboard`. Invoked as `PORT=<port> <cmd>`.
- **Preview URL** — opened in a new tab when you click Preview. Default `http://my.localhost:3000`.

### Run as a desktop app (Electron)

```bash
npm run electron:dev
```

Compiles the Electron main process and opens a native window pointing at the frontend. If `npm run dev` is already running on `:9090`/`:9091`, Electron attaches to those servers instead of spawning duplicates; otherwise it launches backend + vite as child processes and shuts them down on quit. Dev skeleton — no packaged `.app`/`.dmg` yet.

## Project layout

```
backend/
  src/
    index.ts        # Fastify bootstrap, branch proxy, trunk/sandbox rehydrate, idle sweeper
    config.ts       # Paths, ports, env overrides
    routes.ts       # REST API + /api/commands dispatcher (/branch, /gh-issue, /linear)
    terminal.ts     # /api/branches/:id/terminal WebSocket
    state.ts        # state.json, repos, branches
    sessions.ts     # sessions.jsonl append-only log
    tasks.ts        # .tasks/<slug>.jsonl per-branch task history + CLAUDE.md injection
    docker.ts       # docker sandbox lifecycle, claude ptys, seed-prompt injection
    dashboard.ts    # yarn start-dashboard lifecycle per worktree
    sharedPty.ts    # keyed pty pool for trunk claude/bash and dashboards
    worktree.ts     # git worktree add/remove, list local branches
    shell.ts        # run / runOrThrow wrappers

frontend/
  src/
    App.tsx           # Task list, slash composer, context menu, layout
    RepoSwitcher.tsx  # Header dropdown: activate / add / remove repos
    TerminalModal.tsx # xterm panel + Claude/Terminal/Logs tabs, status bar
    SettingsModal.tsx # Per-repo install/start cmds and preview URL
    Welcome.tsx       # First-run folder picker
    Toaster.tsx       # Chakra v3 toaster host
    api.ts            # API types + fetch wrappers (includes Session type)
    main.tsx          # ChakraProvider + next-themes dark mode

electron/
  src/
    main.ts           # BrowserWindow + spawns/attaches to backend & vite
```

## Notable design decisions

- **Trunk runs on the host, not in a sandbox.** Gives immediate access to your real Claude config and avoids one extra layer for the main branch. The idle sweeper and concurrency cap both skip trunk.
- **Dashboards run on the host, on a shared pty.** `docker sandbox` has no port publishing, so `yarn start-dashboard` runs on the host with `PORT=<branch.port>` set.
- **Task context via file, not prompt.** Task details (issue body, comments, instructions) are written to `.tasks/<slug>.jsonl` and injected into CLAUDE.md before the sandbox starts. The PTY seed prompt is just a short nudge ("Read CLAUDE.md and start working"). This makes quiescence detection reliable (short fixed string) and gives Claude a re-readable file for context.
- **Sandbox Claude runs with `--dangerously-skip-permissions`.** The sandbox VM is the security boundary; permission prompts inside it just slow down autonomous work. The `restartSandboxClaude` exec path passes the flag; the initial `docker sandbox run` uses the image's default entrypoint.
- **Sandbox config is independent from the host.** The shared mount file (`~/.claude-sandbox/.claude.json`) carries MCP approvals and tool permissions across sandbox sessions. Only auth identity fields (`oauthAccount`, `userID`) come from the host `~/.claude.json`. This lets sandboxes have different permissions from the host Claude.
- **Sessions are append-only JSONL, not SQLite.** Schema is flat, writes are rare, reads are full-scan — SQLite would buy nothing. Swapping to `better-sqlite3` later would be a single-file migration if the shape stops fitting.
- **Unified task list instead of "branches" vs "sessions" tabs.** A task = `{session?, branch?}`. Trunk has only a branch; active sandboxes have both; archived tasks (branch deleted) are filtered out.
- **Right-click is the action surface.** Cards are clean (branch name + optional Dashboard badge), with all non-primary actions behind the context menu. Preview and Editor are also in the terminal header (as icon buttons) so they're reachable once a task is open.
- **Responsive single-column layout on narrow viewports.** Below the `md` breakpoint the left task column goes full-width and the terminal pane hides until you open a task (which then takes the whole screen with a back button). No bottom nav bar; the task list itself is the "home" view.
- **Idle sweeper also flags stuck creates.** Any non-trunk branch stuck in status `creating` for more than 5 minutes (e.g. orphaned by a mid-create backend crash) is marked `error` with "startup stalled". External kills (e.g. `docker sandbox stop` from a shell) are caught in `term.onExit` and flip the branch to `stopped` so the UI stays honest.
- **No clone.** Adding a repo symlinks your existing checkout instead of cloning, so you reuse your local `node_modules`, existing branches, and yarn caches.

## Out of scope / not yet implemented

See [`TODO.md`](./TODO.md) for the full list with implementation notes. Highlights:

- **Manual snapshot / summary capture.** Right-click → Snapshot would ask Claude to write a one-line summary to a file in the worktree, which the backend picks up and displays.
- **Tailscale + Caddy wildcard proxy** for remote access from phone/laptop. The UI binds to `0.0.0.0` so it's reachable over LAN; the Tailscale/Caddy layer is host-level setup.
- **Touch-device context menu.** Right-click doesn't exist on tablets; long-press fallback not wired. Mobile layout works otherwise.
