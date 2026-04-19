# Shipyard

A chat-style app for running multiple Claude Code agents in parallel. Give Shipyard a GitHub issue or Linear ticket — it creates a branch, spins up a sandbox, and Claude starts working. You watch in the terminal or walk away.

## How it works

- **One sandbox per repo** — created once, persists across restarts. Each branch starts a Claude session inside via `docker sandbox exec`.
- **Slash commands** — type `/` in the new chat view to get a command palette:
  - `/gh-issue <url>` — Claude implements a GitHub issue (pre-fetches title, body, comments)
  - `/linear <url>` — Claude implements a Linear ticket
  - `/branch <name> [base]` — blank sandbox on a new branch
- **Dashboard** — trunk branch runs on the host for interactive use with normal permissions. Branch sandboxes use `--dangerously-skip-permissions`.
- **Push & PR** — sandbox Claude commits, you click Push & PR in the terminal header. The host pushes with your SSH keys and creates the PR via `gh`.
- **Task files** — `.tasks/<slug>.jsonl` stores task context (issue body, instructions). CLAUDE.md injection points Claude at the file on startup.
- **Self-healing** — reload restarts Claude (~2s), hard reload rebuilds the sandbox. Auto-reconnect WebSocket.

## UI

```
┌──────────────────┬─────────────────────────────────────────┐
│ [≡]              │  Shipyard                               │
│                  │                                         │
│  + New chat  ⌘P │          What would you like to work on?│
│  📊 Dashboard [t]│                                         │
│                  │  ┌──────────────────────────────────────┐│
│  Chats           │  │ Type / for commands                  ││
│    issue-42      │  │                           [ ↗ Send ] ││
│    issue-38      │  └──────────────────────────────────────┘│
│                  │                                         │
│  ─────────────── │  [ /gh-issue ] [ /linear ] [ /branch ]  │
│  [ repo ▼ ]      │                                         │
└──────────────────┴─────────────────────────────────────────┘
```

**Left sidebar** — collapsible (`[≡]`), "New chat" with ⌘P shortcut, Dashboard (trunk) with branch badge, "Chats" section with branch tasks, repo switcher at bottom.

**Right panel (no task)** — "Shipyard" header, centered prompt, command input with quick-start pills.

**Right panel (task selected)** — terminal header with branch name + Claude/Terminal/Logs tabs, xterm.js terminal, action icons (reload, push, preview, editor).

## Getting started

Requires macOS, Node 22+, Docker Desktop with `docker sandbox` plugin.

```bash
git clone https://github.com/arthur791004/shipyard
cd shipyard
npm install
npm run dev
```

Open http://localhost:9091 — add your repo folder, then use `/gh-issue`, `/linear`, or `/branch` to start a task.

## Architecture

```
Browser
  └── localhost:9091          UI (Vite + React + Chakra UI + xterm.js)
  └── localhost:3000          Branch proxy → active branch dashboard
        ↓
Fastify backend (:9090)
  ├── REST API + WebSocket terminals
  ├── .tasks/*.jsonl          Task history per branch
  ├── .config/state.json      Repos, branches, sessions
  └── Single Docker sandbox (per repo)
        └── Multiple Claude sessions (docker sandbox exec)
            Each session has its own worktree
```

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MAX_SANDBOXES` | `9` | Max concurrent branch sessions |
| `SANDBOX_IDLE_MS` | `1800000` | Auto-stop after 30 min idle |
| `LINEAR_API_KEY` | — | Pre-fetch Linear ticket content |
| `DOCKER_IMAGE` | `claude` | Sandbox Docker image |

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘P` | New chat |
| `↑↓` | Navigate task list |
| `Enter` | Select task / send command |
| `/` | Open command palette |

## Project layout

```
backend/src/
  index.ts        Fastify bootstrap, rehydration, idle sweeper
  sandbox.ts      v2 sandbox model (one per repo, sessions per branch)
  routes.ts       REST API + /api/commands dispatcher
  terminal.ts     WebSocket terminal handler
  tasks.ts        .tasks/*.jsonl + CLAUDE.md injection
  sessions.ts     Session log (append-only JSONL)
  state.ts        Branch/Repo/Settings persistence
  dashboard.ts    Host-side dev server lifecycle
  portforward.ts  TCP tunnel via docker sandbox exec + socat
  shell.ts        run/runOrThrow wrappers

frontend/src/
  App.tsx          Main layout, sidebar, welcome view, context menu
  TerminalModal.tsx  Terminal panel + tabs + action icons
  RepoSwitcher.tsx   Repo dropdown with settings/sync/remove
  SettingsModal.tsx  Per-repo config (install/start/preview)
  Welcome.tsx        First-run onboarding
  api.ts             API types + fetch wrappers
```
