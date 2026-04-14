import { FastifyInstance } from "fastify";
import pty, { IPty } from "node-pty";
import { getBranch, isTrunk } from "./state.js";
import { attachSandbox, resolveDockerPath } from "./docker.js";
import { attachSharedPty, ensureSharedPty } from "./sharedPty.js";
import { dashboardKey } from "./dashboard.js";

export async function registerTerminal(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { kind?: string } }>(
    "/api/branches/:id/terminal",
    { websocket: true },
    (socket, req) => {
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
        const handle = attachSharedPty(dashboardKey(branch.worktreePath), (data) => {
          try { socket.send(data); } catch {}
        });
        if (!handle) {
          try {
            socket.send("\r\n[dashboard not running — start it first]\r\n");
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

      if (!branch.sandboxName) {
        try {
          socket.send("\r\n[branch has no sandbox]\r\n");
          socket.close();
        } catch {}
        return;
      }

      if (kind === "claude") {
        const handle = attachSandbox(branch.sandboxName, (data) => {
          try { socket.send(data); } catch {}
        });
        if (!handle) {
          try {
            socket.send("\r\n[sandbox not running — start the branch first]\r\n");
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

      const term = pty.spawn(
        resolveDockerPath(),
        [
          "sandbox",
          "exec",
          "-it",
          "-w",
          branch.worktreePath,
          branch.sandboxName,
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
