import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import pty, { IPty } from "node-pty";
import { run, runOrThrow } from "./shell.js";
import { config } from "./config.js";
import { ensureDashboardRunning, stopDashboard } from "./dashboard.js";
import { listAllBranches, updateBranch } from "./state.js";

let cachedDockerPath: string | null = null;

export function resolveDockerPath(): string {
  if (cachedDockerPath) return cachedDockerPath;
  const candidates = [
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/usr/bin/docker",
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

interface SandboxPty {
  term: IPty;
  buffer: string;
  subscribers: Set<(data: string) => void>;
  lastActivity: number;
}

const runningPtys = new Map<string, SandboxPty>();

export function runningSandboxNames(): string[] {
  return [...runningPtys.keys()];
}

export function sandboxLastActivity(name: string): number | null {
  return runningPtys.get(name)?.lastActivity ?? null;
}

const SCROLLBACK_LIMIT = 100_000;

export function attachSandbox(
  name: string,
  onData: (data: string) => void
): { unsubscribe: () => void; write: (data: string) => void; resize: (cols: number, rows: number) => void } | null {
  const entry = runningPtys.get(name);
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

export function sandboxName(slug: string): string {
  return `claude-${slug}`;
}

export async function sandboxExists(name: string): Promise<boolean> {
  const res = await run("docker", ["sandbox", "ls"]);
  return res.stdout.split("\n").some((l) => l.trim().split(/\s+/)[0] === name);
}

// --- sandboxd state reconciliation ---
//
// `docker sandbox` sometimes gets into a stuck state where `sandboxd` still
// claims a VM is "running" but its per-VM docker-public.sock has disappeared
// on disk (e.g. after an unclean Docker Desktop restart). When that happens,
// every subsequent `docker sandbox ls` / `create` / `exec` fails with
// "socket path is empty" — not just for the broken VM, but for the whole
// plugin — because the CLI iterates all VMs before returning.
//
// We bypass the CLI and talk to sandboxd directly over its unix socket to
// force-stop any VM whose reported state is out of sync with the filesystem.

interface SandboxdVm {
  vm_name: string;
  status: string;
}

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

async function sandboxdList(): Promise<SandboxdVm[]> {
  const body = await sandboxdRequest("GET", "/vm");
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? (parsed as SandboxdVm[]) : [];
  } catch {
    return [];
  }
}

export async function reconcileSandboxState(): Promise<void> {
  let vms: SandboxdVm[];
  try {
    vms = await sandboxdList();
  } catch {
    return; // sandboxd unreachable — nothing we can reconcile
  }
  for (const vm of vms) {
    if (vm.status !== "running") continue;
    const sockPath = path.join(SANDBOXES_VM_DIR, vm.vm_name, "docker-public.sock");
    try {
      await fsp.access(sockPath);
    } catch {
      console.warn(
        `[${vm.vm_name}] reconciling stale "running" state — docker-public.sock is missing`
      );
      try {
        await sandboxdRequest("POST", `/vm/${encodeURIComponent(vm.vm_name)}/stop`);
      } catch (err) {
        console.error(`[${vm.vm_name}] force-stop failed:`, err);
      }
    }
  }
}

export async function createSandbox(name: string, worktreePath: string): Promise<void> {
  await reconcileSandboxState();
  if (await sandboxExists(name)) return;
  await fsp.mkdir(config.claudeSandboxDir, { recursive: true });
  await fsp.mkdir(config.tasksDir, { recursive: true });
  const mounts = [worktreePath, config.claudeSandboxDir, config.tasksDir];
  const mainRepoPath = await resolveMainRepoPath(worktreePath);
  if (mainRepoPath && !mounts.includes(mainRepoPath)) mounts.push(mainRepoPath);
  try {
    await runOrThrow("docker", [
      "sandbox",
      "create",
      "--name",
      name,
      config.dockerImage,
      ...mounts,
    ]);
  } catch (err) {
    // A partial `create` can leave a half-registered record that blocks every
    // subsequent create with the same name. Sweep it away so the caller can
    // retry without manual `docker sandbox rm`.
    if (await sandboxExists(name)) {
      await run("docker", ["sandbox", "rm", name]);
    }
    throw err;
  }
}

async function resolveMainRepoPath(worktreePath: string): Promise<string | null> {
  try {
    const raw = await fsp.readFile(path.join(worktreePath, ".git"), "utf8");
    const m = raw.match(/^gitdir:\s*(.+?)\s*$/m);
    if (!m) return null;
    const gitDir = m[1];
    const idx = gitDir.indexOf("/.git/");
    if (idx === -1) return null;
    return await fsp.realpath(gitDir.slice(0, idx));
  } catch {
    return null;
  }
}

const MOUNT_CREDS = `${config.claudeSandboxDir}/.credentials.json`;
const AGENT_CREDS = "/home/agent/.claude/.credentials.json";
const MOUNT_CONFIG = `${config.claudeSandboxDir}/.claude.json`;
const AGENT_CONFIG = "/home/agent/.claude.json";

async function listRunningSandboxes(): Promise<string[]> {
  const res = await run("docker", ["sandbox", "ls"]);
  if (res.code !== 0) return [];
  const names: string[] = [];
  for (const raw of res.stdout.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("SANDBOX")) continue;
    const parts = line.split(/\s+/);
    if (parts.length >= 3 && parts[2] === "running") names.push(parts[0]);
  }
  return names;
}

async function refreshMountFromPeers(excludeName: string): Promise<void> {
  // Source peers from `docker sandbox ls` rather than our in-process
  // `runningPtys` map — after a backend restart the map is empty until
  // rehydrate runs, and even then pty spawning can fail silently. Docker's
  // view of the world is the source of truth for "is a sandbox running".
  const peers = await listRunningSandboxes();
  for (const peerName of peers) {
    if (peerName === excludeName) continue;
    try {
      await syncCredentialsOut(peerName);
      await syncClaudeConfigOut(peerName);
      return; // any one peer is enough — they all share the same OAuth account
    } catch (err) {
      console.error(`refreshMountFromPeers(${peerName}) failed:`, err);
    }
  }
}

export async function syncCredentialsIn(name: string): Promise<void> {
  await runOrThrow(resolveDockerPath(), [
    "sandbox",
    "exec",
    name,
    "sh",
    "-c",
    // Only overwrite the agent's credentials if the host mount actually
    // has non-empty contents. An empty file on the mount would otherwise
    // wipe a valid in-container file and force a re-login.
    `mkdir -p /home/agent/.claude && if [ -s ${MOUNT_CREDS} ]; then rm -rf ${AGENT_CREDS} && cp -f ${MOUNT_CREDS} ${AGENT_CREDS} && chmod 600 ${AGENT_CREDS}; fi`,
  ]);
}

async function buildMinimalClaudeConfig(worktreePath?: string): Promise<string> {
  const projectEntry = worktreePath
    ? {
        [worktreePath]: {
          allowedTools: [],
          hasTrustDialogAccepted: true,
          projectOnboardingSeenCount: 1,
          hasClaudeMdExternalIncludesApproved: false,
          hasClaudeMdExternalIncludesWarningShown: false,
        },
      }
    : {};
  try {
    const raw = await fsp.readFile(path.join(os.homedir(), ".claude.json"), "utf8");
    const full = JSON.parse(raw);
    const minimal = {
      hasCompletedOnboarding: true,
      oauthAccount: full.oauthAccount,
      userID: full.userID,
      anonymousId: full.anonymousId,
      installMethod: full.installMethod ?? "sandbox",
      numStartups: 1,
      effortCalloutDismissed: true,
      effortCalloutV2Dismissed: true,
      hasShownOpus45Notice: full.hasShownOpus45Notice,
      hasShownOpus46Notice: full.hasShownOpus46Notice,
      lastReleaseNotesSeen: full.lastReleaseNotesSeen,
      lastOnboardingVersion: full.lastOnboardingVersion,
      projects: projectEntry,
    };
    return JSON.stringify(minimal);
  } catch {
    return JSON.stringify({ hasCompletedOnboarding: true, projects: projectEntry });
  }
}

export async function syncClaudeConfigIn(name: string, worktreePath?: string): Promise<void> {
  if (await fileExistsNonEmpty(config.claudeSandboxDir + "/.claude.json")) {
    await runOrThrow(resolveDockerPath(), [
      "sandbox",
      "exec",
      name,
      "sh",
      "-c",
      // `-s` guard so a truncated host mount file can't clobber a good
      // in-container one on re-sync.
      `if [ -s ${MOUNT_CONFIG} ]; then cp -f ${MOUNT_CONFIG} ${AGENT_CONFIG} && chmod 600 ${AGENT_CONFIG}; fi`,
    ]);
    return;
  }
  const minimal = await buildMinimalClaudeConfig(worktreePath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      resolveDockerPath(),
      [
        "sandbox",
        "exec",
        "-i",
        name,
        "sh",
        "-c",
        `cat > ${AGENT_CONFIG} && chmod 600 ${AGENT_CONFIG}`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`syncClaudeConfigIn exit ${code}: ${stderr}`))
    );
    child.stdin.write(minimal);
    child.stdin.end();
  });
}

async function fileExistsNonEmpty(p: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(p);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export async function syncCredentialsOut(name: string): Promise<void> {
  if ((await getSandboxStatus(name)) !== "running") return;
  await runOrThrow(resolveDockerPath(), [
    "sandbox",
    "exec",
    name,
    "sh",
    "-c",
    // `-s` (non-empty) instead of `-f` (exists) so a mid-shutdown truncate
    // inside the sandbox can't flush a 0-byte file over the host mount.
    `if [ -s ${AGENT_CREDS} ]; then rm -rf ${MOUNT_CREDS} && cp -f ${AGENT_CREDS} ${MOUNT_CREDS} && chmod 600 ${MOUNT_CREDS}; fi`,
  ]);
}

export async function syncClaudeConfigOut(name: string): Promise<void> {
  if ((await getSandboxStatus(name)) !== "running") return;
  await runOrThrow(resolveDockerPath(), [
    "sandbox",
    "exec",
    name,
    "sh",
    "-c",
    `if [ -s ${AGENT_CONFIG} ]; then rm -rf ${MOUNT_CONFIG} && cp -f ${AGENT_CONFIG} ${MOUNT_CONFIG} && chmod 600 ${MOUNT_CONFIG}; fi`,
  ]);
}

function spawnSandboxPty(
  name: string,
  worktreePath?: string,
  dashboardPort?: number,
  seedPrompt?: string
): SandboxPty {
  if (runningPtys.has(name)) return runningPtys.get(name)!;
  const dockerPath = resolveDockerPath();
  let term: IPty;
  try {
    term = pty.spawn(dockerPath, ["sandbox", "run", name], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: process.env.HOME || process.cwd(),
      env: process.env as { [key: string]: string },
    });
  } catch (err: any) {
    throw new Error(
      `pty.spawn ${dockerPath} sandbox run ${name} failed: ${err?.message || err}`
    );
  }
  const entry: SandboxPty = {
    term,
    buffer: "",
    subscribers: new Set(),
    lastActivity: Date.now(),
  };
  term.onData((data) => {
    entry.lastActivity = Date.now();
    entry.buffer = (entry.buffer + data).slice(-SCROLLBACK_LIMIT);
    for (const sub of entry.subscribers) sub(data);
  });
  term.onExit(() => {
    runningPtys.delete(name);
    // If the branch is still marked as running, this exit was not initiated
    // by our own stopSandbox path (which updates state before the kill) —
    // something stopped the sandbox externally (e.g. `docker sandbox stop`
    // from a shell, Docker Desktop restart, host crash-and-reboot, etc).
    // Reflect that in state so the UI doesn't leave the row stuck at running.
    const branch = listAllBranches().find((b) => b.sandboxName === name);
    if (branch && branch.status === "running") {
      updateBranch(branch.id, { status: "stopped" }).catch((err) =>
        console.error(`updateBranch(${branch.id}) on unexpected pty exit failed:`, err)
      );
    }
    syncCredentialsOut(name).catch((err) =>
      console.error(`syncCredentialsOut(${name}) on pty exit failed:`, err)
    );
    syncClaudeConfigOut(name).catch((err) =>
      console.error(`syncClaudeConfigOut(${name}) on pty exit failed:`, err)
    );
  });
  runningPtys.set(name, entry);

  if (worktreePath && dashboardPort) {
    ensureDashboardRunning(worktreePath, dashboardPort).catch((err) =>
      console.error(`ensureDashboardRunning(${worktreePath}:${dashboardPort}) failed:`, err)
    );
  }

  if (seedPrompt) scheduleSeedPrompt(entry, name, seedPrompt);
  return entry;
}

// Watches the sandbox's output for quiescence (1.5s with no new chunks) and
// then types the seed prompt into the PTY as if the user had entered it.
// A hard 30s ceiling fires unconditionally so a chatty startup banner can't
// keep us from ever sending. Typing matches what the user would do, so it
// works for whatever the image's default entrypoint is.
function scheduleSeedPrompt(entry: SandboxPty, name: string, prompt: string): void {
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
      console.error(`seed prompt write(${name}) failed:`, err);
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

// Re-establish our pty handle for a sandbox that docker still reports as
// running but that we've lost track of (e.g. after a backend restart where
// rehydration didn't populate `runningPtys`). No credential sync — we want
// to attach to the existing claude session without clobbering its in-memory
// state.
export async function reattachSandbox(
  name: string,
  worktreePath?: string,
  dashboardPort?: number
): Promise<boolean> {
  if (runningPtys.has(name)) return true;
  if ((await getSandboxStatus(name)) !== "running") return false;
  try {
    spawnSandboxPty(name, worktreePath, dashboardPort);
    return true;
  } catch (err) {
    console.error(`reattachSandbox(${name}) failed:`, err);
    return false;
  }
}

export async function startSandbox(
  name: string,
  worktreePath?: string,
  dashboardPort?: number,
  seedPrompt?: string
): Promise<void> {
  if (runningPtys.has(name)) return;
  // Reconcile stale sandboxd state before touching docker — without this a
  // concurrent stop that left a zombie "running" entry would poison the
  // `docker sandbox exec` calls inside syncCredentialsIn with "socket path
  // is empty" and every subsequent start would also fail.
  await reconcileSandboxState().catch((err) =>
    console.error(`reconcileSandboxState(${name}) failed:`, err)
  );
  // Concurrency cap: count live PTYs we already manage. Does not count toward
  // the cap when we're about to reattach to an already-running sandbox below.
  const alreadyRunningInDocker = (await getSandboxStatus(name)) === "running";
  if (!alreadyRunningInDocker && runningPtys.size >= config.maxConcurrentSandboxes) {
    throw new Error(
      `sandbox concurrency limit reached (${config.maxConcurrentSandboxes}) — stop another sandbox first`
    );
  }
  if (worktreePath && !(await sandboxExists(name))) {
    await createSandbox(name, worktreePath);
  }
  // Pull the freshest creds from any currently-running peer sandbox into the
  // shared mount, so newly-started sandboxes inherit any tokens that were
  // rotated mid-session rather than a stale on-disk snapshot.
  await refreshMountFromPeers(name).catch((err) =>
    console.error(`refreshMountFromPeers(${name}) failed:`, err)
  );
  try {
    await syncCredentialsIn(name);
  } catch (err) {
    console.error(`syncCredentialsIn(${name}) failed:`, err);
  }
  try {
    await syncClaudeConfigIn(name, worktreePath);
  } catch (err) {
    console.error(`syncClaudeConfigIn(${name}) failed:`, err);
  }
  spawnSandboxPty(name, worktreePath, dashboardPort, seedPrompt);
}

export async function stopSandbox(name: string, worktreePath?: string): Promise<void> {
  try {
    await syncCredentialsOut(name);
  } catch (err) {
    console.error(`syncCredentialsOut(${name}) on stop failed:`, err);
  }
  try {
    await syncClaudeConfigOut(name);
  } catch (err) {
    console.error(`syncClaudeConfigOut(${name}) on stop failed:`, err);
  }
  const entry = runningPtys.get(name);
  if (entry) {
    try { entry.term.kill(); } catch {}
    runningPtys.delete(name);
  }
  if (worktreePath) stopDashboard(worktreePath);
  await run("docker", ["sandbox", "stop", name]);
}

export async function removeSandbox(name: string, worktreePath?: string): Promise<void> {
  const entry = runningPtys.get(name);
  if (entry) {
    try { entry.term.kill(); } catch {}
    runningPtys.delete(name);
  }
  if (worktreePath) stopDashboard(worktreePath);
  const res = await run("docker", ["sandbox", "rm", name]);
  // `docker sandbox rm` exits 0 even when its stderr complains that the
  // backing VM is missing (common after a half-failed create). The record
  // itself still gets removed, so we only care whether the sandbox actually
  // disappeared from `docker sandbox ls`.
  if (await sandboxExists(name)) {
    console.error(
      `removeSandbox(${name}) did not fully clean up:`,
      `${res.stdout}\n${res.stderr}`.trim()
    );
  }
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

export async function sandboxLogs(name: string, tail = 200): Promise<string> {
  const res = await run("docker", ["sandbox", "exec", name, "sh", "-lc", `tail -n ${tail} /var/log/*.log 2>/dev/null || true`]);
  return (res.stdout + res.stderr).trim();
}
