/**
 * sandbox.ts — v2 sandbox model: one Docker sandbox per repo.
 *
 * The repo's sandbox is created once (via `docker sandbox run`) and persists
 * across app restarts. Each branch starts a Claude process inside the sandbox
 * via `docker sandbox exec`. Branches share the same VM, filesystem, Node/yarn
 * install, and network — isolation is via git worktrees, not sandbox boundaries.
 *
 * Key concepts:
 * - `repoSandboxName(repo)` → the single sandbox name for the repo
 * - `ensureRepoSandbox(repo)` → create + start the sandbox if it doesn't exist
 * - `startBranchSession(branchId, sandboxName, worktreePath, port, seedPrompt?)` → exec Claude
 * - `stopBranchSession(branchId)` → kill the exec process
 * - `attachBranchSession(branchId, onData)` → subscribe to PTY output
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import pty, { IPty } from "node-pty";
import { run, runOrThrow } from "./shell.js";
import { config } from "./config.js";
import { listAllBranches, updateBranch, Repo } from "./state.js";

// ---------------------------------------------------------------------------
// Docker path resolution (reused from docker.ts)
// ---------------------------------------------------------------------------

let cachedDockerPath: string | null = null;

export function resolveDockerPath(): string {
  if (cachedDockerPath) return cachedDockerPath;
  const candidates = [
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/usr/bin/docker",
    path.join(os.homedir(), ".orbstack/bin/docker"),
    path.join(os.homedir(), ".rd/bin/docker"),
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return (cachedDockerPath = c);
  }
  try {
    const out = execFileSync("/bin/sh", ["-lc", "command -v docker"], {
      encoding: "utf8",
    }).trim();
    if (out) return (cachedDockerPath = out);
  } catch {}
  return (cachedDockerPath = "docker");
}

// ---------------------------------------------------------------------------
// PTY tracking — keyed by branchId (not sandbox name)
// ---------------------------------------------------------------------------

interface SessionPty {
  term: IPty;
  buffer: string;
  subscribers: Set<(data: string) => void>;
  lastActivity: number;
  sandboxName: string;
  branchId: string;
}

const sessions = new Map<string, SessionPty>();

const SCROLLBACK_LIMIT = 100_000;

export function runningBranchIds(): string[] {
  return [...sessions.keys()];
}

export function sessionLastActivity(branchId: string): number | null {
  return sessions.get(branchId)?.lastActivity ?? null;
}

export function attachBranchSession(
  branchId: string,
  onData: (data: string) => void
): { unsubscribe: () => void; write: (data: string) => void; resize: (cols: number, rows: number) => void } | null {
  const entry = sessions.get(branchId);
  if (!entry) return null;
  if (entry.buffer) onData(entry.buffer);
  entry.subscribers.add(onData);
  return {
    unsubscribe: () => entry.subscribers.delete(onData),
    write: (data: string) => {
      entry.lastActivity = Date.now();
      entry.term.write(data);
    },
    resize: (cols: number, rows: number) => {
      try { entry.term.resize(cols, rows); } catch {}
    },
  };
}

// ---------------------------------------------------------------------------
// Sandbox name
// ---------------------------------------------------------------------------

export function repoSandboxName(repo: Repo): string {
  return `claude-${repo.name}`;
}

// ---------------------------------------------------------------------------
// Sandbox existence / status
// ---------------------------------------------------------------------------

export async function sandboxExists(name: string): Promise<boolean> {
  const res = await run("docker", ["sandbox", "ls"]);
  return res.stdout.split("\n").some((l) => l.trim().split(/\s+/)[0] === name);
}

export async function getSandboxStatus(name: string): Promise<"running" | "stopped" | "missing"> {
  const res = await run("docker", ["sandbox", "ls"]);
  for (const line of res.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === name) {
      return parts[2] === "running" ? "running" : "stopped";
    }
  }
  return "missing";
}

// ---------------------------------------------------------------------------
// sandboxd reconciliation (reused from docker.ts)
// ---------------------------------------------------------------------------

const SANDBOXD_SOCK = path.join(os.homedir(), ".docker", "sandboxes", "sandboxd.sock");
const SANDBOXES_VM_DIR = path.join(os.homedir(), ".docker", "sandboxes", "vm");

function sandboxdRequest(method: string, url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: SANDBOXD_SOCK, path: url, method, timeout: 5000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve(body);
          else reject(new Error(`sandboxd ${method} ${url} → ${res.statusCode}: ${body.trim()}`));
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("sandboxd request timeout")));
    req.end();
  });
}

export async function reconcileSandboxState(): Promise<void> {
  let vms: { vm_name: string; status: string }[];
  try {
    const body = await sandboxdRequest("GET", "/vm");
    vms = JSON.parse(body);
  } catch {
    return;
  }
  for (const vm of vms) {
    if (vm.status !== "running") continue;
    const sockPath = path.join(SANDBOXES_VM_DIR, vm.vm_name, "docker-public.sock");
    try {
      await fsp.access(sockPath);
    } catch {
      console.warn(`[${vm.vm_name}] reconciling stale "running" state`);
      try {
        await sandboxdRequest("POST", `/vm/${encodeURIComponent(vm.vm_name)}/stop`);
      } catch (err) {
        console.error(`[${vm.vm_name}] force-stop failed:`, err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Credential / config sync (simplified from docker.ts)
// ---------------------------------------------------------------------------

const MOUNT_CREDS = `${config.claudeSandboxDir}/.credentials.json`;
const AGENT_CREDS = "/home/agent/.claude/.credentials.json";
const MOUNT_CONFIG = `${config.claudeSandboxDir}/.claude.json`;
const AGENT_CONFIG = "/home/agent/.claude.json";

export async function syncCredentialsIn(sandboxName: string): Promise<void> {
  await runOrThrow(resolveDockerPath(), [
    "sandbox", "exec", sandboxName, "sh", "-c",
    `mkdir -p /home/agent/.claude && if [ -s ${MOUNT_CREDS} ]; then rm -rf ${AGENT_CREDS} && cp -f ${MOUNT_CREDS} ${AGENT_CREDS} && chmod 600 ${AGENT_CREDS}; fi`,
  ]);
}

export async function syncCredentialsOut(sandboxName: string): Promise<void> {
  if ((await getSandboxStatus(sandboxName)) !== "running") return;
  await runOrThrow(resolveDockerPath(), [
    "sandbox", "exec", sandboxName, "sh", "-c",
    `if [ -s ${AGENT_CREDS} ]; then rm -rf ${MOUNT_CREDS} && cp -f ${AGENT_CREDS} ${MOUNT_CREDS} && chmod 600 ${MOUNT_CREDS}; fi`,
  ]);
}

async function buildClaudeConfig(worktreePath?: string): Promise<string> {
  let authFields: Record<string, unknown> = {};
  try {
    const host = JSON.parse(
      await fsp.readFile(path.join(os.homedir(), ".claude.json"), "utf8")
    );
    authFields = {
      oauthAccount: host.oauthAccount,
      userID: host.userID,
      anonymousId: host.anonymousId,
    };
  } catch {}

  let mountConfig: Record<string, unknown> = {};
  try {
    mountConfig = JSON.parse(await fsp.readFile(MOUNT_CONFIG, "utf8"));
  } catch {}

  const mountProjects = (mountConfig as any).projects ?? {};
  const worktreeOverrides: Record<string, unknown> = {};
  if (worktreePath) {
    let sourceEntry: Record<string, unknown> | undefined;
    for (const entry of Object.values(mountProjects)) {
      const e = entry as Record<string, unknown>;
      if (Array.isArray(e?.allowedTools) && e.allowedTools.length > 0) {
        sourceEntry = e;
        break;
      }
    }
    const tasksPatterns = [
      `Read(${config.tasksDir}/)`,
      `Read(${config.tasksDir}/**)`,
    ];
    const existingTools: string[] = Array.isArray(sourceEntry?.allowedTools)
      ? (sourceEntry.allowedTools as string[]) : [];
    const mergedTools = [...existingTools];
    for (const p of tasksPatterns) {
      if (!mergedTools.includes(p)) mergedTools.push(p);
    }
    worktreeOverrides[worktreePath] = {
      ...(sourceEntry ?? {}),
      allowedTools: mergedTools,
      hasTrustDialogAccepted: true,
      hasClaudeMdExternalIncludesApproved: true,
      hasClaudeMdExternalIncludesWarningShown: true,
      projectOnboardingSeenCount: 1,
    };
  }

  return JSON.stringify({
    ...authFields,
    ...mountConfig,
    hasCompletedOnboarding: true,
    numStartups: (mountConfig as any).numStartups ?? 1,
    effortCalloutDismissed: true,
    effortCalloutV2Dismissed: true,
    projects: { ...mountProjects, ...worktreeOverrides },
  });
}

export async function syncClaudeConfigIn(sandboxName: string, worktreePath?: string): Promise<void> {
  const configJson = await buildClaudeConfig(worktreePath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(resolveDockerPath(), [
      "sandbox", "exec", "-i", sandboxName, "sh", "-c",
      `cat > ${AGENT_CONFIG} && chmod 600 ${AGENT_CONFIG}`,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`syncClaudeConfigIn exit ${code}: ${stderr}`))
    );
    child.stdin.write(configJson);
    child.stdin.end();
  });
}

export async function syncClaudeConfigOut(sandboxName: string): Promise<void> {
  if ((await getSandboxStatus(sandboxName)) !== "running") return;
  await runOrThrow(resolveDockerPath(), [
    "sandbox", "exec", sandboxName, "sh", "-c",
    `if [ -s ${AGENT_CONFIG} ]; then rm -rf ${MOUNT_CONFIG} && cp -f ${AGENT_CONFIG} ${MOUNT_CONFIG} && chmod 600 ${MOUNT_CONFIG}; fi`,
  ]);
}

// ---------------------------------------------------------------------------
// Repo-level sandbox lifecycle
// ---------------------------------------------------------------------------

/**
 * Ensure the repo's sandbox exists and is running. Creates it if missing.
 * Mounts: worktreesDir (contains all worktrees), .claude-sandbox, .tasks.
 */
export async function ensureRepoSandbox(repo: Repo): Promise<string> {
  const name = repo.sandboxName || repoSandboxName(repo);
  await reconcileSandboxState();

  const status = await getSandboxStatus(name);
  if (status === "running") return name;

  if (status === "missing") {
    await fsp.mkdir(config.claudeSandboxDir, { recursive: true });
    await fsp.mkdir(config.tasksDir, { recursive: true });
    const mounts = [
      repo.worktreesDir,    // contains trunk + all branch worktrees
      config.claudeSandboxDir,
      config.tasksDir,
    ];
    // Also mount the original repo if it's different (for git objects)
    if (repo.linkTarget && !mounts.includes(repo.linkTarget)) {
      mounts.push(repo.linkTarget);
    }
    try {
      await runOrThrow("docker", [
        "sandbox", "create", "--name", name,
        config.dockerImage,
        ...mounts,
      ]);
    } catch (err) {
      if (await sandboxExists(name)) {
        await run("docker", ["sandbox", "rm", name]);
      }
      throw err;
    }
  }

  // Start the sandbox VM (status was "stopped" or we just created it)
  // We use `docker sandbox run` in the background to start the VM,
  // then kill the foreground process — the VM keeps running.
  const dockerPath = resolveDockerPath();
  const startProc = spawn(dockerPath, ["sandbox", "run", name], {
    stdio: "ignore",
    detached: true,
  });
  startProc.unref();
  // Wait for the sandbox to become running
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if ((await getSandboxStatus(name)) === "running") break;
  }

  // Install yarn globally (needed for git hooks + dev server)
  try {
    await run(resolveDockerPath(), [
      "sandbox", "exec", name, "sh", "-c",
      "command -v yarn >/dev/null 2>&1 || npm install -g yarn >/dev/null 2>&1",
    ]);
  } catch {}

  // Sync credentials + config
  try { await syncCredentialsIn(name); } catch {}
  try { await syncClaudeConfigIn(name); } catch {}

  return name;
}

/**
 * Stop and remove the repo's sandbox entirely.
 */
export async function removeRepoSandbox(sandboxName: string): Promise<void> {
  // Kill all branch sessions first
  for (const [branchId, session] of sessions) {
    if (session.sandboxName === sandboxName) {
      try { session.term.kill(); } catch {}
      sessions.delete(branchId);
    }
  }
  await run("docker", ["sandbox", "stop", sandboxName]).catch(() => {});
  await run("docker", ["sandbox", "rm", sandboxName]).catch(() => {});
}

// ---------------------------------------------------------------------------
// Branch-level session lifecycle
// ---------------------------------------------------------------------------

/**
 * Start a Claude session for a branch inside the repo's sandbox.
 */
export async function startBranchSession(
  branchId: string,
  sandboxName: string,
  worktreePath: string,
  port: number,
  seedPrompt?: string
): Promise<void> {
  if (sessions.has(branchId)) return;

  // Sync config for this worktree path
  try { await syncClaudeConfigIn(sandboxName, worktreePath); } catch {}

  const dockerPath = resolveDockerPath();
  const execArgs = ["sandbox", "exec", "-it", "-w", worktreePath];
  execArgs.push(sandboxName, "sh", "-lc", "exec claude --dangerously-skip-permissions");

  const term = pty.spawn(dockerPath, execArgs, {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd: process.env.HOME || process.cwd(),
    env: process.env as { [key: string]: string },
  });

  const entry: SessionPty = {
    term,
    buffer: "",
    subscribers: new Set(),
    lastActivity: Date.now(),
    sandboxName,
    branchId,
  };

  term.onData((data) => {
    entry.lastActivity = Date.now();
    entry.buffer = (entry.buffer + data).slice(-SCROLLBACK_LIMIT);
    for (const sub of entry.subscribers) sub(data);
  });

  term.onExit(() => {
    sessions.delete(branchId);
    const branch = listAllBranches().find((b) => b.id === branchId);
    if (branch && branch.status === "running") {
      updateBranch(branch.id, { status: "stopped" }).catch(() => {});
    }
    syncCredentialsOut(sandboxName).catch(() => {});
    syncClaudeConfigOut(sandboxName).catch(() => {});
  });

  sessions.set(branchId, entry);

  if (seedPrompt) scheduleSeedPrompt(entry, branchId, seedPrompt);
}

/**
 * Stop a branch's Claude session (kill the exec process).
 * Does NOT stop the sandbox VM.
 */
export async function stopBranchSession(branchId: string): Promise<void> {
  const entry = sessions.get(branchId);
  if (!entry) return;
  try {
    await syncCredentialsOut(entry.sandboxName);
    await syncClaudeConfigOut(entry.sandboxName);
  } catch {}
  try { entry.term.kill(); } catch {}
  sessions.delete(branchId);
}

/**
 * Restart a branch's Claude session (kill old, start new).
 */
export async function restartBranchSession(
  branchId: string,
  sandboxName: string,
  worktreePath: string,
  port: number,
  seedPrompt?: string
): Promise<void> {
  await stopBranchSession(branchId);
  await startBranchSession(branchId, sandboxName, worktreePath, port, seedPrompt);
}

// ---------------------------------------------------------------------------
// Seed prompt (quiescence-based PTY injection)
// ---------------------------------------------------------------------------

function scheduleSeedPrompt(entry: SessionPty, id: string, prompt: string): void {
  let quiesceTimer: NodeJS.Timeout | null = null;
  let sent = false;

  const send = () => {
    if (sent) return;
    sent = true;
    if (quiesceTimer) clearTimeout(quiesceTimer);
    clearTimeout(hardTimer);
    entry.subscribers.delete(listener);
    try {
      entry.term.write(prompt + "\r");
    } catch (err) {
      console.error(`seed prompt write(${id}) failed:`, err);
    }
  };

  const listener = () => {
    if (sent) return;
    if (quiesceTimer) clearTimeout(quiesceTimer);
    quiesceTimer = setTimeout(send, 1500);
  };

  entry.subscribers.add(listener);
  const hardTimer = setTimeout(send, 30_000);
}

// ---------------------------------------------------------------------------
// Utility exports
// ---------------------------------------------------------------------------

export async function sandboxLogs(sandboxName: string, tail = 200): Promise<string> {
  const res = await run("docker", [
    "sandbox", "exec", sandboxName, "sh", "-lc",
    `tail -n ${tail} /var/log/*.log 2>/dev/null || true`,
  ]);
  return (res.stdout + res.stderr).trim();
}
