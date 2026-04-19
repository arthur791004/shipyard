import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const configDir = path.join(projectRoot, ".config");
const tasksDir = path.join(projectRoot, ".tasks");
const DEFAULT_REPO_NAME = "wp-calypso";
const DEFAULT_BRANCH_FALLBACK = "trunk";

export function deriveRepoPaths(
  repoName: string,
  defaultBranch: string = DEFAULT_BRANCH_FALLBACK
): { repoPath: string; worktreesDir: string } {
  const repoRoot = path.join(configDir, "repo", repoName);
  return {
    repoPath: path.join(repoRoot, defaultBranch),
    worktreesDir: repoRoot,
  };
}

const defaultPaths = deriveRepoPaths(DEFAULT_REPO_NAME);

export const config = {
  port: Number(process.env.PORT ?? 9090),
  branchProxyPort: Number(process.env.BRANCH_PROXY_PORT ?? 3000),
  proxyTargetPortFallback: 4000,
  projectRoot,
  configDir,
  tasksDir,
  dataDir: process.env.DATA_DIR ?? configDir,
  defaultRepoUrl: "git@github.com:Automattic/wp-calypso.git",
  repoPath: process.env.REPO_PATH ?? defaultPaths.repoPath,
  worktreesDir: process.env.WORKTREES_DIR ?? defaultPaths.worktreesDir,
  dockerImage: process.env.DOCKER_IMAGE ?? "claude",
  claudeAuthDir: process.env.CLAUDE_AUTH_DIR ?? path.join(os.homedir(), ".claude"),
  claudeSandboxDir: process.env.CLAUDE_SANDBOX_DIR ?? path.join(os.homedir(), ".claude-sandbox"),
  portRangeStart: 4001,
  portRangeEnd: 4999,
  maxConcurrentSandboxes: Number(process.env.MAX_SANDBOXES ?? 9),
  sandboxIdleMs: Number(process.env.SANDBOX_IDLE_MS ?? 30 * 60 * 1000),
  idleSweeperIntervalMs: Number(process.env.SANDBOX_IDLE_CHECK_MS ?? 60 * 1000),
  credentialSyncIntervalMs: Number(process.env.CREDENTIAL_SYNC_MS ?? 5 * 60 * 1000),
};
