# TODO

## 1. Task file via shared `.tasks/` folder

Replace the current quiescence-based seed-prompt injection with a more reliable file-based approach.

- Backend writes `.tasks/<branch-name>.jsonl` in the `calypso-multi-agent` project root when a command is dispatched
- Mount `.tasks/` (read-only) into every sandbox alongside the worktree
- Fixed seed prompt becomes: `"Read .tasks/<branch-name>.jsonl for context and start working on the latest task"`
- Seed prompt is now short and stable — quiescence detection becomes much more reliable
- Claude can re-read the file at any time for context
- Snapshot appends a `summary` entry to the same file, so Claude sees full history on restart

`.tasks/<branch-name>.jsonl` format:
```jsonl
{"type": "task", "command": "/gh-issue", "source": "https://...", "body": "...", "ts": 1234567890}
{"type": "summary", "text": "Implemented navbar color change...", "ts": 1234567891}
{"type": "task", "command": "/gh-issue", "source": "https://...", "body": "...", "ts": 1234567892}
```

## 2. Web server inside sandbox + port forwarding

Move the per-branch dev server from host into the sandbox so Claude can manage it directly.

- Claude starts the dev server inside the sandbox (e.g. `yarn start-dashboard`) binding to `0.0.0.0`
- After sandbox starts, backend automatically calls `docker sandbox ports <n> --publish <host-port>:<container-port>` to forward the port
- Remove the host-side `dashboard.ts` pty process for sandboxed branches (trunk stays as-is)
- Port assignment stays the same (`4001–4999` range), just forwarded from sandbox instead of host
- Published ports don't survive sandbox stop/restart — re-run `docker sandbox ports` on resume

## 3. Right-click → Generate Summary

Right-click a task → **Generate Summary**. Backend asks Claude to summarize what it has done so far, then appends the result to `.tasks/<branch-name>.jsonl`.

- New endpoint: `POST /api/branches/:id/snapshot`
- Backend types a short prompt into the sandbox PTY: `"Summarize what you've done so far and write it to .tasks/<branch-name>.jsonl as {"type":"summary","text":"...","ts":<timestamp>}, then continue what you were doing"`
- Polls `.tasks/<branch-name>.jsonl` for a new `summary` entry (3s interval, 2 min timeout)
- On success, call `updateSession(id, { summary })` so the UI can display it as a subtitle under the branch name
- Surface a "timed out" toast if Claude doesn't comply within 2 min

## 4. Generate summary via sub-agent file watcher

Instead of writing into the PTY directly, use a sub-agent inside the sandbox to watch `.tasks/<branch-name>.jsonl` for requests.

- On sandbox start, main Claude spawns a sub-agent that watches `.tasks/<branch-name>.jsonl`
- Backend appends `{"type":"snapshot-request","ts":<timestamp>}` to trigger a summary
- Sub-agent detects the new entry and notifies main Claude
- Main Claude generates a summary and sub-agent appends it back:
  `{"type":"summary","text":"...","ts":<timestamp>}`
- Backend polls for the new `summary` entry (3s interval, 2 min timeout)
- On success, call `updateSession(id, { summary })` so the UI can display it

Sub-agent watcher (simple bash loop or Claude Code sub-agent):
```bash
while true; do
  if grep -q "snapshot-request" .tasks/<branch>.jsonl; then
    # notify main Claude
  fi
  sleep 2
done
```

Benefits over PTY injection:
- Main Claude is never interrupted mid-task
- No timing or quiescence guessing
- Clean separation of concerns

## 5. Chat mode vs Terminal mode

Add a setting to switch between two interaction modes per sandbox.

**Terminal mode** (current)
- Claude runs in PTY, right panel shows raw terminal output
- You interact by typing directly into xterm.js

**Chat mode**
- Claude runs with `--input-format stream-json --output-format stream-json`
- Right panel shows chat bubble UI instead of raw terminal
- Send messages via input box, responses streamed back as structured JSON
- Generate summary becomes a simple `send_message()` call — no PTY timing, no file polling needed
- Sub-agent file watcher (TODO #4) not needed in this mode

**Settings**
- Global default in settings (terminal | chat)
- Per-branch override via right-click context menu → "Switch to Chat / Terminal mode"
- Mode stored in `state.json` per branch
