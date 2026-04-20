import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config, deriveRepoPaths } from "./config.js";

export type BranchStatus = "creating" | "stopped" | "starting" | "restarting" | "running" | "error";

export interface Branch {
  id: string;
  name: string;
  repoId: string;
  isTrunk?: boolean;
  worktreePath: string;
  /** @deprecated — sandbox is now per-repo, not per-branch. Kept for migration. */
  sandboxName?: string;
  port: number;
  status: BranchStatus;
  createdAt: number;
  error?: string;
}

export interface Repo {
  id: string;
  name: string;
  linkTarget: string;
  repoPath: string;
  worktreesDir: string;
  defaultBranch: string;
  dashboardInstallCmd?: string;
  dashboardStartCmd?: string;
  previewUrl?: string;
  /** Docker sandbox name for this repo (one sandbox per repo). */
  sandboxName?: string;
  createdAt: number;
}

export interface Settings {
  repoUrl: string;
  configured: boolean;
  /**
   * When true, `POST /api/branches/:id/push` is forced into dry-run mode
   * regardless of the request (the CLI's `--dry-run` flag or the
   * `SHIPYARD_PUSH_DRYRUN` env var). Meant for testing the full
   * "Claude builds + commits + pushes" flow without touching origin
   * or creating real PRs. Toggled from the Settings modal.
   */
  pushDryRun?: boolean;
  // legacy fields kept optional for migration
  repoPath?: string;
  worktreesDir?: string;
  defaultBranch?: string;
  dashboardInstallCmd?: string;
  dashboardStartCmd?: string;
}

export const DEFAULT_DASHBOARD_INSTALL_CMD = "yarn install";
export const DEFAULT_DASHBOARD_START_CMD = "yarn start-dashboard";

interface StateFile {
  branches: Record<string, Branch>;
  activeBranchId?: string;
  repos: Record<string, Repo>;
  activeRepoId?: string;
  settings?: Settings;
}

const statePath = path.join(config.dataDir, "state.json");

export function trunkBranchId(repoId: string): string {
  return `trunk-${repoId}`;
}

export function isTrunk(b: Branch): boolean {
  return !!b.isTrunk;
}

let state: StateFile = { branches: {}, repos: {} };

function allocatePortFromState(): number {
  const used = new Set(Object.values(state.branches).map((b) => b.port));
  for (let p = config.portRangeStart; p <= config.portRangeEnd; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error("No free ports in configured range");
}

function ensureTrunkForRepo(repo: Repo): void {
  const id = trunkBranchId(repo.id);
  if (!state.branches[id]) {
    state.branches[id] = {
      id,
      name: repo.defaultBranch,
      repoId: repo.id,
      isTrunk: true,
      worktreePath: repo.repoPath,
      port: allocatePortFromState(),
      status: "stopped",
      createdAt: 0,
    };
  }
}

export async function loadState(): Promise<void> {
  try {
    await fs.mkdir(config.dataDir, { recursive: true });
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.tasks && !parsed.branches) {
      parsed.branches = {};
      for (const [id, t] of Object.entries<any>(parsed.tasks)) {
        parsed.branches[id] = {
          id: t.id,
          name: t.branch ?? t.name,
          worktreePath: t.worktreePath,
          sandboxName: t.sandboxName,
          port: t.port,
          status: t.status,
          createdAt: t.createdAt,
          error: t.error,
        };
      }
      delete parsed.tasks;
      if (parsed.activeTaskId && !parsed.activeBranchId) {
        parsed.activeBranchId = parsed.activeTaskId;
        delete parsed.activeTaskId;
      }
    }
    if (!parsed.repos) parsed.repos = {};
    state = parsed;
    if (!state.branches) state.branches = {};
    if (!state.repos) state.repos = {};
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
  await migrateLegacySettings();
}

async function migrateLegacySettings(): Promise<void> {
  if (Object.keys(state.repos).length > 0) return;

  const legacy = state.settings;
  if (!legacy?.repoPath) return;

  let linkTarget: string | undefined;
  try {
    const lstat = await fs.lstat(legacy.repoPath);
    if (lstat.isSymbolicLink()) linkTarget = await fs.readlink(legacy.repoPath);
  } catch {}
  if (!linkTarget) return;

  const name = path.basename(linkTarget.replace(/\/+$/, "")) || "repo";
  const defaultBranch = legacy.defaultBranch || "trunk";
  const paths = deriveRepoPaths(name, defaultBranch);
  const repoId = randomUUID().slice(0, 8);
  const repo: Repo = {
    id: repoId,
    name,
    linkTarget,
    repoPath: paths.repoPath,
    worktreesDir: paths.worktreesDir,
    defaultBranch,
    dashboardInstallCmd: legacy.dashboardInstallCmd,
    dashboardStartCmd: legacy.dashboardStartCmd,
    createdAt: Date.now(),
  };
  state.repos[repoId] = repo;
  state.activeRepoId = repoId;

  const newBranches: Record<string, Branch> = {};
  for (const [id, b] of Object.entries(state.branches)) {
    if (id === "trunk") {
      const newId = trunkBranchId(repoId);
      newBranches[newId] = {
        ...b,
        id: newId,
        repoId,
        isTrunk: true,
        name: repo.defaultBranch,
        worktreePath: repo.repoPath,
      };
      if (state.activeBranchId === "trunk") state.activeBranchId = newId;
    } else {
      newBranches[id] = { ...b, repoId };
    }
  }
  state.branches = newBranches;

  await persist();
}

async function persist(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2));
}

export function listBranches(): Branch[] {
  const activeRepo = state.activeRepoId;
  const all = Object.values(state.branches);
  const filtered = activeRepo ? all.filter((b) => b.repoId === activeRepo) : all;
  return filtered.sort((a, b) => a.createdAt - b.createdAt);
}

export function listAllBranches(): Branch[] {
  return Object.values(state.branches).sort((a, b) => a.createdAt - b.createdAt);
}

export function getBranch(id: string): Branch | undefined {
  return state.branches[id];
}

export async function upsertBranch(branch: Branch): Promise<Branch> {
  state.branches[branch.id] = branch;
  await persist();
  return branch;
}

export async function updateBranch(id: string, patch: Partial<Branch>): Promise<Branch> {
  const existing = state.branches[id];
  if (!existing) throw new Error(`Branch ${id} not found`);
  const next = { ...existing, ...patch };
  state.branches[id] = next;
  await persist();
  return next;
}

export async function removeBranch(id: string): Promise<void> {
  delete state.branches[id];
  if (state.activeBranchId === id) state.activeBranchId = undefined;
  await persist();
}

export function getActiveBranchId(): string | undefined {
  return state.activeBranchId;
}

export async function setActiveBranchId(id: string | undefined): Promise<void> {
  state.activeBranchId = id;
  await persist();
}

export function getSettings(): Settings {
  if (!state.settings) {
    state.settings = {
      repoUrl: config.defaultRepoUrl,
      configured: Object.keys(state.repos).length > 0,
    };
  }
  return state.settings;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...getSettings(), ...patch };
  state.settings = next;
  await persist();
  return next;
}

export function listRepos(): Repo[] {
  return Object.values(state.repos).sort((a, b) => a.createdAt - b.createdAt);
}

export function getRepo(id: string): Repo | undefined {
  return state.repos[id];
}

export function getActiveRepo(): Repo | undefined {
  return state.activeRepoId ? state.repos[state.activeRepoId] : undefined;
}

export function getActiveRepoId(): string | undefined {
  return state.activeRepoId;
}

export async function addRepo(repo: Repo, activate = true): Promise<Repo> {
  state.repos[repo.id] = repo;
  if (activate || !state.activeRepoId) state.activeRepoId = repo.id;
  ensureTrunkForRepo(repo);
  await persist();
  return repo;
}

export async function updateRepo(id: string, patch: Partial<Repo>): Promise<Repo> {
  const existing = state.repos[id];
  if (!existing) throw new Error(`Repo ${id} not found`);
  const next = { ...existing, ...patch };
  state.repos[id] = next;
  await persist();
  return next;
}

export async function removeRepo(id: string): Promise<void> {
  delete state.repos[id];
  for (const [bid, b] of Object.entries(state.branches)) {
    if (b.repoId === id) delete state.branches[bid];
  }
  if (state.activeRepoId === id) {
    const remaining = Object.keys(state.repos);
    state.activeRepoId = remaining[0];
  }
  await persist();
}

export async function setActiveRepoId(id: string): Promise<Repo> {
  const repo = state.repos[id];
  if (!repo) throw new Error(`Repo ${id} not found`);
  state.activeRepoId = id;
  ensureTrunkForRepo(repo);
  await persist();
  return repo;
}

export function usedPorts(): Set<number> {
  return new Set(Object.values(state.branches).map((b) => b.port));
}

export function allocatePort(): number {
  return allocatePortFromState();
}
