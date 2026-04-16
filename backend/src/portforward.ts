import net from "node:net";
import { spawn, ChildProcess } from "node:child_process";
import { resolveDockerPath } from "./docker.js";

// Per-sandbox TCP proxy: forwards host:port → sandbox:port via
// `docker sandbox exec -i <name> socat - TCP:localhost:<port>`.
// Each incoming TCP connection spawns a fresh socat process inside
// the sandbox and pipes data through stdin/stdout.

interface PortForward {
  server: net.Server;
  port: number;
  sandboxName: string;
}

const forwards = new Map<string, PortForward>();

export function startPortForward(
  sandboxName: string,
  hostPort: number,
  containerPort: number = hostPort
): void {
  const key = `${sandboxName}:${hostPort}`;
  if (forwards.has(key)) return;

  const dockerPath = resolveDockerPath();

  const server = net.createServer((client) => {
    const proc: ChildProcess = spawn(dockerPath, [
      "sandbox", "exec", "-i",
      sandboxName,
      "socat", "-", `TCP:localhost:${containerPort}`,
    ]);

    if (proc.stdin) client.pipe(proc.stdin);
    if (proc.stdout) proc.stdout.pipe(client);
    proc.stderr?.on("data", () => {});
    proc.on("close", () => client.destroy());
    client.on("close", () => proc.kill());
    client.on("error", () => proc.kill());
  });

  server.on("error", (err) => {
    console.error(`port forward ${sandboxName}:${hostPort} failed:`, err.message);
    forwards.delete(key);
  });

  server.listen(hostPort, "127.0.0.1", () => {
    console.log(`port forward: 127.0.0.1:${hostPort} → ${sandboxName}:${containerPort}`);
  });

  forwards.set(key, { server, port: hostPort, sandboxName });
}

export function stopPortForward(sandboxName: string, hostPort?: number): void {
  for (const [key, fwd] of forwards) {
    if (fwd.sandboxName === sandboxName && (!hostPort || fwd.port === hostPort)) {
      try { fwd.server.close(); } catch {}
      forwards.delete(key);
    }
  }
}

export function stopAllPortForwards(sandboxName: string): void {
  stopPortForward(sandboxName);
}
