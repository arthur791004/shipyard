import net from "node:net";
import pty from "node-pty";
import { ensureSharedPty, killSharedPty } from "./sharedPty.js";
import {
  DEFAULT_DASHBOARD_INSTALL_CMD,
  DEFAULT_DASHBOARD_START_CMD,
  getActiveRepo,
} from "./state.js";

export function dashboardKey(worktreePath: string): string {
  return `dashboard:${worktreePath}`;
}

export function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: "127.0.0.1" });
    const done = (ok: boolean) => {
      s.removeAllListeners();
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(500);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.once("timeout", () => done(false));
  });
}

export async function ensureDashboardRunning(worktreePath: string, port: number): Promise<void> {
  if (await isPortOpen(port)) return;
  const repo = getActiveRepo();
  const installCmd = repo?.dashboardInstallCmd?.trim() || DEFAULT_DASHBOARD_INSTALL_CMD;
  const startCmd = repo?.dashboardStartCmd?.trim() || DEFAULT_DASHBOARD_START_CMD;
  const shellCmd = `${installCmd} && PORT=${port} ${startCmd}`;
  ensureSharedPty(dashboardKey(worktreePath), () =>
    pty.spawn("/bin/sh", ["-lc", shellCmd], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: worktreePath,
      env: process.env as { [key: string]: string },
    })
  );
}

export async function waitForDashboard(port: number, timeoutMs = 900_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await isPortOpen(port)) return true;
  }
  return false;
}

export function stopDashboard(worktreePath: string): void {
  killSharedPty(dashboardKey(worktreePath));
}
