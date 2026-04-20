# Shipyard — Project Plan

## Vision

A Chats-style app where you talk to Claude naturally. Claude decides when to create branches, manages its own worktrees, and runs a live preview server — all inside a single sandboxed environment. You just chat.

---

## Architecture

```
Browser (Tailscale)
  ├── app.mac.ts.net          → Chat UI (this app)
  └── <chat-id>.mac.ts.net   → Per-chat web server preview
            ↓
      Caddy wildcard proxy
            ↓
      Fastify backend
            ↓
      Single Docker sandbox (per repo)
            ↓
      Multiple Claude sessions (docker sandbox exec)
      Each session has its own worktree + port
```

---

## Core Concepts

### One sandbox per repo
- Created once when a repo is added
- Persists across app restarts
- Torn down only when repo is removed

### One chat per Claude session
- Each chat = `docker sandbox exec --workdir <worktree> claude`
- Each chat has a unique port for its web server
- Chats are independent — stopping one doesn't affect others

### Trunk chat (always present)
- Runs on the trunk branch, read-only
- Claude can read files, answer questions, discuss code
- Cannot make changes directly — must create a new branch first

### Branch chats
- Created when Claude decides changes are needed
- Claude creates the git worktree and branch itself
- Has its own web server port for live preview

---

## UI

```
┌─────────────────┬──────────────────────────────────────[⛶]┐
│  Tasks       [+]│  [ Claude ] [ Logs ]                     │
│  ─────────────  │  ────────────────────────────────────    │
│  > trunk        │                                          │
│    issue-42     │   xterm.js / log viewer                  │
│    issue-38     │                                          │
│                 │                                          │
│                 │                                          │
│                 │                                          │
│                 │   [ Preview ↗ ] [ Editor ]               │
│                 ├──────────────────────────────────────────│
│                 │  > Type a message or /command...         │
│                 │  [ wp-calypso / trunk ▼ ]    [ Send ]   │
└─────────────────┴──────────────────────────────────────────┘
```

**Left panel**
- Task list (trunk always first)
- `[+]` button to start a new task

**Right panel**
- Top-right: `[⛶]` fullscreen toggle
- Tabs: `[ Claude ]` (xterm.js pty) / `[ Logs ]` (web server output)
- Bottom icons: `[ Preview ↗ ]` (open browser), `[ Editor ]` (VS Code)
- Input bar: type a message → sent directly to Claude pty; type `/` → slash command
- `[ repo / base branch ▼ ]` dropdown + `[ Send ]` button

---

## Claude Behaviour

### Trunk chat instructions (CLAUDE.md)
```
You are running on the trunk branch in read-only mode.
Do not modify any files directly on trunk.

If the user asks you to implement a GitHub issue, Linear ticket,
or make any code changes, you must:
1. Create a new git worktree and branch
2. Notify the backend (write to .tasks/<branch>.jsonl)
3. Continue your work in the new worktree

You can read any file freely. Answer questions, explain code,
and discuss changes without restrictions.
```

### Slash commands → Claude actions
| Command | Claude does |
|---------|-------------|
| `/gh-issue <url>` | Reads issue via MCP, creates branch, implements |
| `/linear <url>` | Reads ticket via MCP, creates branch, implements |
| `/branch <name>` | Checks out existing branch, runs web server |
| `/pr <url>` | Checks out PR branch, reviews or tests |
| Free text | Claude decides — read-only or create branch |

---

## Task File Protocol

All coordination between backend and Claude happens via `.tasks/` in the project root, mounted read-write into the sandbox.

### `.tasks/<branch>.jsonl` format
```jsonl
{"type":"task","command":"/gh-issue","source":"https://...","body":"...","ts":1234567890}
{"type":"summary","text":"Implemented navbar color change...","ts":1234567891}
{"type":"snapshot-request","ts":1234567892}
{"type":"summary","text":"Updated summary after snapshot...","ts":1234567893}
```

### Flow
1. User runs slash command → backend writes `task` entry
2. Claude reads `.tasks/<branch>.jsonl` on startup via seed prompt
3. Right-click → Generate Summary → backend writes `snapshot-request`
4. Sub-agent watches file, notifies Claude, Claude appends `summary`
5. Backend polls for new `summary`, updates sessions store

---

## Sandbox Lifecycle

### Startup
```
App starts
  → docker sandbox ls (check if sandbox exists for repo)
  → if not: docker sandbox run <repo-name> (once, slow)
  → rehydrate running Claude sessions from state
```

### New chat
```
User submits slash command
  → backend writes .tasks/<branch>.jsonl
  → git worktree add (host side)
  → docker sandbox exec --interactive <repo-name>
      bash -c "cd <worktree> && claude --dangerously-skip-permissions"
  → seed prompt: "Read .tasks/<branch>.jsonl and start working"
  → docker sandbox ports <repo-name> --publish <host-port>:<container-port>
  → register route in Caddy: <chat-id>.mac.ts.net → localhost:<host-port>
```

### Stop chat
```
User stops chat
  → kill exec process
  → docker sandbox ports --unpublish
  → remove Caddy route
  → worktree stays (can restart)
```

### Restart Claude (not sandbox)
```
User restarts chat
  → re-run docker sandbox exec in same worktree
  → seed prompt reads .tasks/<branch>.jsonl for context
```

### Remove chat
```
User deletes chat
  → kill exec process
  → docker sandbox ports --unpublish
  → git worktree remove
  → remove Caddy route
  → archive session in sessions store
```

---

## Port Strategy

| Chat | Container port | Host port | URL |
|------|---------------|-----------|-----|
| trunk | 4000 | 4000 | trunk.mac.ts.net |
| issue-42 | 4001 | 4001 | issue-42.mac.ts.net |
| issue-43 | 4002 | 4002 | issue-43.mac.ts.net |

Ports allocated from range `4000–4999`, assigned on chat creation, released on delete.

---

## Network (Tailscale + Caddy)

```
# Caddyfile
*.mac.ts.net {
    reverse_proxy {
        dynamic a
    }
}
```

- Backend dynamically registers/unregisters routes via Caddy Admin API
- Tailscale MagicDNS handles `*.mac.ts.net` resolution
- Works from phone and desktop over Tailscale

---

## Sessions Store

Append-only `sessions.jsonl` (upgrade to SQLite if needed):

```jsonl
{"id":"chat-1","repo":"wp-calypso","branch":"trunk","port":4000,"status":"running","createdAt":...}
{"id":"chat-2","repo":"wp-calypso","branch":"issue-42","port":4001,"issueUrl":"https://...","summary":"...","status":"stopped","createdAt":...}
```

---

## Implementation Order

1. **Single sandbox refactor** — replace per-branch sandboxes with one per repo, use `docker sandbox exec` per chat
2. **Chat UI** — replace branch table with chat list + slash command input
3. **CLAUDE.md + task file** — trunk read-only instructions, `.tasks/` protocol
4. **Seed prompt via task file** — replace quiescence-based injection
5. **Web server in sandbox** — Claude runs web server, backend forwards port
6. **Tailscale + Caddy** — wildcard subdomain per chat
7. **Generate summary** — sub-agent file watcher, right-click trigger
8. **Chat mode (optional)** — stream-json alternative to PTY terminal
