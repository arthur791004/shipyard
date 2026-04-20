import { FastifyInstance } from "fastify";
import pty, { IPty } from "node-pty";
import { getBranch, getRepo, isTrunk } from "./state.js";
import { attachBranchSession, resolveDockerPath } from "./sandbox.js";
import { attachSharedPty, ensureSharedPty } from "./sharedPty.js";
import { dashboardKey, dashboardLogFile, ensureDashboardRunning } from "./dashboard.js";

export async function registerTerminal(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { kind?: string } }>(
    "/api/branches/:id/terminal",
    { websocket: true },
    async (socket, req) => {
      const branch = getBranch(req.params.id);
      if (!branch || !branch.worktreePath) {
        try {
          socket.send("\r\n[branch has no worktree]\r\n");
          socket.close();
        } catch {}
        return;
      }

      const kind =
        req.query.kind === "shell"
          ? "shell"
          : req.query.kind === "dashboard"
          ? "dashboard"
          : "claude";

      if (kind === "dashboard") {
        const logOpts = { logFile: dashboardLogFile(branch.worktreePath) };
        const onData = (data: string) => {
          try { socket.send(data); } catch {}
        };
        // Try attaching — replays from log file even if PTY is dead
        let handle = attachSharedPty(dashboardKey(branch.worktreePath), onData, logOpts);
        if (!handle) {
          // No live PTY (log file was replayed above if it existed).
          // Start the dashboard and attach to the fresh PTY.
          try {
            await ensureDashboardRunning(branch.worktreePath, branch.port);
          } catch (err) {
            try {
              socket.send(`\r\n[dashboard failed to start: ${(err as Error).message}]\r\n`);
              socket.close();
            } catch {}
            return;
          }
          handle = attachSharedPty(dashboardKey(branch.worktreePath), onData);
        }
        if (!handle) {
          try {
            socket.send("\r\n[dashboard failed to start]\r\n");
            socket.close();
          } catch {}
          return;
        }
        socket.on("message", (raw: Buffer) => {
          const msg = raw.toString();
          if (msg.startsWith("\x01resize:")) {
            const [cols, rows] = msg.slice(8).split(",").map(Number);
            if (cols && rows) handle!.resize(cols, rows);
            return;
          }
          handle!.write(msg);
        });
        socket.on("close", () => {
          handle!.unsubscribe();
        });
        return;
      }

      // Trunk runs on the host — Claude and shell via host-side sharedPty.
      if (isTrunk(branch)) {
        const key = `${branch.id}:${kind}`;
        const shellCmd = kind === "claude" ? "claude" : "exec $SHELL -l";
        ensureSharedPty(key, () =>
          pty.spawn("/bin/sh", ["-lc", shellCmd], {
            name: "xterm-256color",
            cols: 120,
            rows: 30,
            cwd: branch.worktreePath,
            env: process.env as { [key: string]: string },
          })
        );
        const handle = attachSharedPty(key, (data) => {
          try { socket.send(data); } catch {}
        });
        if (!handle) {
          try { socket.close(); } catch {}
          return;
        }
        socket.on("message", (raw: Buffer) => {
          const msg = raw.toString();
          if (msg.startsWith("\x01resize:")) {
            const [cols, rows] = msg.slice(8).split(",").map(Number);
            if (cols && rows) handle.resize(cols, rows);
            return;
          }
          handle.write(msg);
        });
        socket.on("close", () => {
          handle.unsubscribe();
        });
        return;
      }

      const repo = getRepo(branch.repoId);
      if (!repo?.sandboxName) {
        try {
          socket.send("\r\n[no sandbox for repo]\r\n");
          socket.close();
        } catch {}
        return;
      }

      if (kind === "claude") {
        // v2: attach by branch ID (sessions keyed by branchId, not sandboxName)
        const onData = (data: string) => {
          try { socket.send(data); } catch {}
        };
        const handle = attachBranchSession(branch.id, onData);
        if (!handle) {
          try {
            socket.send("\r\n[session not running — click to start]\r\n");
            socket.close();
          } catch {}
          return;
        }
        socket.on("message", (raw: Buffer) => {
          const msg = raw.toString();
          if (msg.startsWith("\x01resize:")) {
            const [cols, rows] = msg.slice(8).split(",").map(Number);
            if (cols && rows) handle.resize(cols, rows);
            return;
          }
          handle.write(msg);
        });
        socket.on("close", () => {
          handle.unsubscribe();
        });
        return;
      }

      // Shell tab: exec a bash session inside the repo's sandbox
      if (!repo?.sandboxName) {
        try { socket.close(); } catch {}
        return;
      }
      const term = pty.spawn(
        resolveDockerPath(),
        [
          "sandbox",
          "exec",
          "-it",
          "-w",
          branch.worktreePath,
          repo.sandboxName,
          "bash",
        ],
        {
          name: "xterm-256color",
          cols: 120,
          rows: 30,
          cwd: process.env.HOME || process.cwd(),
          env: process.env as { [key: string]: string },
        }
      );
      wireUpPty(socket, term);
    }
  );
}

function wireUpPty(socket: { send: (data: string) => void; on: (event: string, cb: (...args: any[]) => void) => void; close: () => void }, term: IPty) {
  term.onData((data) => {
    try { socket.send(data); } catch {}
  });
  term.onExit(() => {
    try { socket.close(); } catch {}
  });

  socket.on("message", (raw: Buffer) => {
    const msg = raw.toString();
    if (msg.startsWith("\x01resize:")) {
      const [cols, rows] = msg.slice(8).split(",").map(Number);
      if (cols && rows) {
        try { term.resize(cols, rows); } catch {}
      }
      return;
    }
    term.write(msg);
  });

  socket.on("close", () => {
    try { term.kill(); } catch {}
  });
}
