<p align="left">
  <img src="frontend/public/icon.svg" alt="Shipyard" width="120" />
</p>

# Shipyard

A chat-style app for running multiple Claude Code agents in parallel. Hand Shipyard a task — a GitHub issue URL, a Linear ticket, or just plain English — and it creates a branch, spins up a sandbox, and Claude starts working. You watch in the terminal or walk away.

## How it works

- **One sandbox per repo** — created once, persists across restarts. Each branch starts a Claude session inside via `docker sandbox exec`. Trunk runs on the host for interactive use; branch sandboxes use `--dangerously-skip-permissions`.
- **Free-form input** — just describe the task and hit Enter. If the text contains a GitHub/Linear URL it auto-routes through the `/gh-issue` / `/linear` flow; otherwise `claude -p` on the host generates a short kebab-case branch name (falls back to a slug if `claude` isn't on PATH).
- **Slash commands** (type `/` in the new-chat view):
  - `/gh-issue <url>` — Claude implements a GitHub issue (host pre-fetches title, body, comments via `gh`)
  - `/linear <url>` — Claude implements a Linear ticket (requires `LINEAR_API_KEY` to pre-fetch body)
  - `/branch <name> [base]` — open any branch for a blank chat (new or existing, from local or remote)
- **Host-mediated git** — sandbox Claude can't push to origin (no SSH) or safely commit (host/sandbox index format mismatch). It uses the `shipyard:sandbox` CLI installed into every sandbox, which tunnels through the backend:
  - `shipyard:sandbox commit -m "msg"` — `git add -A && git commit` on the host
  - `shipyard:sandbox push [--title "…"]` — `git push` + `gh pr create/edit` on the host, optionally with a title + stdin body for the PR (follows `.github/pull_request_template.md`)
  - `shipyard:sandbox push --dry-run` — verify the flow without touching origin
- **Dry-run mode** — Settings → Dry-run push mode forces all pushes into dry-run globally, so you can hand Claude a real task end-to-end and it never actually hits origin. Orange `DRY-RUN` badge (bottom-right) reminds you it's on.
- **Task files** — `.tasks/<slug>.jsonl` stores per-branch task history. The session seed prompt points Claude there on startup; sandbox-wide rules live in the agent user's `~/.claude/CLAUDE.md` (written at sandbox create time, no worktree pollution).
- **Husky helpers shared** — branch worktrees skip `yarn install` to share trunk's `node_modules`, so `createWorktree` symlinks trunk's `.husky/_/` in so hooks still run without `--no-verify`.
- **Self-healing** — reload restarts Claude (~2s), hard reload rebuilds the sandbox. Auto-reconnect WebSocket. On backend shutdown the branch status stays `running` so rehydrate spins sessions back up, and orphan `claude` processes from crashed runs are reaped on startup to keep the sandbox's RAM clean.

## UI

```
┌──────────────────┬─────────────────────────────────────────┐
│ [≡] Shipyard    │                                         │
│                  │        What would you like to work on? │
│  + New chat  ⌘P │                                         │
│  📊 Dashboard    │  ┌──────────────────────────────────────┐│
│                  │  │ Describe a task, paste an issue URL, ││
│  Chats           │  │ or type / for commands   [ ↗ Send ] ││
│    issue-42      │  └──────────────────────────────────────┘│
│    login-fix     │                                         │
│                  │  [ GitHub issue ] [ Linear ticket ] [ Branch ]
│  ─────────────── │                                         │
│  [ repo ▼ ⚙ ↻ ] │                               [DRY-RUN] │
└──────────────────┴─────────────────────────────────────────┘
```

**Left sidebar** — collapsible, "New chat" (⌘P), Dashboard (trunk), "Chats" with branch tasks, repo switcher at the bottom with inline settings (⚙) and pull-latest (↻) icons.

**Right panel (no task)** — Shipyard wordmark, prompt, command input. Chips hint at the slash commands; hover reveals their descriptions. Non-slash text is treated as a free-form prompt.

**Right panel (task selected)** — terminal header with branch name + Claude/Terminal/Logs tabs, xterm.js terminal, preview + editor actions. Scrollbar is overlay-style (hidden at rest, fades in on hover).

## Getting started

Requires macOS, Node 22+, Docker Desktop with the `docker sandbox` plugin, `claude` CLI (for branch-name generation) and `gh` CLI (for PR creation).

```bash
git clone https://github.com/arthur791004/shipyard
cd shipyard
npm install
npm run dev
```

Open http://localhost:9091 — add your repo folder, then:

- Type a free-form task ("add dark mode toggle to the sidebar") and hit Enter
- Or paste a GitHub / Linear URL
- Or use `/gh-issue <url>` / `/linear <url>` / `/branch <name>` explicitly

Claude works in the sandbox, commits via `shipyard:sandbox commit`, and opens a PR via `shipyard:sandbox push` — all mediated through your host's `gh` + SSH.

## Architecture

```
Browser
  └── localhost:9091          UI (Vite + React + Chakra UI + xterm.js)
  └── localhost:3000          Branch proxy → active branch dashboard
        ↓
Fastify backend (:9090)
  ├── REST API + WebSocket terminals
  ├── .tasks/*.jsonl          Task history per branch
  ├── .config/state.json      Repos, branches, sessions, settings
  └── Single Docker sandbox (per repo)
        ├── Proxy allow-host rule for localhost:9090 so the
        │   sandbox CLI can reach the backend
        ├── /home/agent/.local/bin/shipyard:sandbox   CLI shim
        ├── /home/agent/.claude/CLAUDE.md             sandbox rules
        └── Multiple Claude sessions (docker sandbox exec)
            Each session has its own worktree, shares node_modules with trunk
```

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MAX_SANDBOXES` | `9` | Max concurrent branch sessions |
| `SANDBOX_IDLE_MS` | `1800000` | Auto-stop a session after 30 min idle |
| `LINEAR_API_KEY` | — | Pre-fetch Linear ticket content on `/linear` |
| `DOCKER_IMAGE` | `claude` | Sandbox Docker image |

Branch naming falls back to a heuristic slug when `claude` isn't on the host `PATH` (feature still works, names are just uglier).

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘P` | New chat |
| `↑↓` | Navigate task list |
| `Enter` | Send command / select task |
| `/` | Open command palette |

## Project layout

```
backend/src/
  index.ts         Fastify bootstrap, rehydration, idle sweeper, shutdown flag
  sandbox.ts       v2 sandbox model (one per repo), CLI install, proxy allow,
                   orphan-claude reaper, syncSandboxConfig
  routes.ts        REST API + /api/commands dispatcher (slash + free-form)
  routeHelpers.ts  Pure helpers: slugify, URL regexes, uniqueBranchName
  commands catalogue (frontend mirror: frontend/src/commands.ts)
  llm.ts           `claude -p` wrapper for branch-name generation
  terminal.ts      WebSocket terminal handler
  tasks.ts         .tasks/*.jsonl + seed prompt (commit+push close-the-loop)
  worktree.ts      createWorktree + .husky/_ symlink sharing
  state.ts         Branch/Repo/Settings persistence (Settings.pushDryRun)
  dashboard.ts     Host-side dev server lifecycle
  portforward.ts   TCP tunnel via docker sandbox exec + socat
  shell.ts         run/runOrThrow wrappers

backend/sandbox-bin/
  shipyard:sandbox  bash CLI shipped into every sandbox's ~/.local/bin
                    (commit / push / push --dry-run)

frontend/src/
  App.tsx          Main layout, sidebar, welcome, context menu, DRY-RUN badge
  TerminalModal.tsx  Terminal panel + tabs + disposal-safe xterm wiring
  CommandInput.tsx   Slash menu + chip row + free-form submit
  commands.ts      Shared slash-command catalogue
  RepoSwitcher.tsx   Repo dropdown with inline settings + pull-latest
  SettingsModal.tsx  Per-repo config + Dry-run push mode toggle
  Welcome.tsx        First-run onboarding
  Icons.tsx          SVG icons including ShipyardIcon
  api.ts             API types + fetch wrappers
  styles.css         Global styles incl. terminal scrollbar overrides
```
