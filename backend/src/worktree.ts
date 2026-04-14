import fs from "node:fs/promises";
import path from "node:path";
import { run, runOrThrow } from "./shell.js";
import { getActiveRepo, Repo } from "./state.js";

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function requireActiveRepo(): Repo {
  const repo = getActiveRepo();
  if (!repo) throw new Error("No active repo configured");
  return repo;
}

export async function detectDefaultBranch(gitPath: string): Promise<string> {
  const head = await run("git", ["-C", gitPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0) {
    const name = head.stdout.trim().replace(/^origin\//, "");
    if (name) return name;
  }
  const cur = await run("git", ["-C", gitPath, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (cur.code === 0) {
    const name = cur.stdout.trim();
    if (name && name !== "HEAD") return name;
  }
  return "trunk";
}

export async function ensureRepo(): Promise<string> {
  const repo = requireActiveRepo();
  await fs.mkdir(path.dirname(repo.repoPath), { recursive: true });
  if (await exists(path.join(repo.repoPath, ".git"))) return repo.repoPath;
  // No auto-clone in multi-repo mode; symlink is created when a repo is added.
  throw new Error(`Repo not found at ${repo.repoPath}. Re-add the repo in settings.`);
}

async function worktreeAdd(repoPath: string, args: string[], branch: string): Promise<void> {
  const res = await run("git", ["-C", repoPath, ...args]);
  if (res.code === 0) return;
  const combined = `${res.stdout}\n${res.stderr}`;
  // "fatal: 'X' is already used by worktree at '/path/to/other'"
  const m = combined.match(/is already (?:used|checked out) by worktree at '([^']+)'/);
  if (m) {
    const other = m[1];
    throw new Error(
      `Branch "${branch}" is already checked out at ${other}. Switch that checkout to a different branch, then try again.`
    );
  }
  throw new Error(`git worktree add ${branch} failed (${res.code}): ${(res.stderr || res.stdout).trim()}`);
}

export async function createWorktree(folderName: string, branch: string, base?: string): Promise<string> {
  const repo = requireActiveRepo();
  await ensureRepo();
  await fs.mkdir(repo.worktreesDir, { recursive: true });
  const worktreePath = path.join(repo.worktreesDir, folderName);

  const localCheck = await run("git", ["-C", repo.repoPath, "rev-parse", "--verify", branch]);
  if (localCheck.code === 0) {
    await worktreeAdd(repo.repoPath, ["worktree", "add", worktreePath, branch], branch);
    return worktreePath;
  }

  await run("git", ["-C", repo.repoPath, "fetch", "origin", branch]);
  const remoteCheck = await run("git", [
    "-C",
    repo.repoPath,
    "rev-parse",
    "--verify",
    `origin/${branch}`,
  ]);
  if (remoteCheck.code === 0) {
    await worktreeAdd(
      repo.repoPath,
      ["worktree", "add", "-B", branch, worktreePath, `origin/${branch}`],
      branch
    );
    return worktreePath;
  }

  const args = ["worktree", "add", "-b", branch, worktreePath];
  if (base) args.push(base);
  await worktreeAdd(repo.repoPath, args, branch);
  return worktreePath;
}

export async function listGitBranches(): Promise<string[]> {
  const repo = getActiveRepo();
  if (!repo) return [];
  const res = await run("git", [
    "-C",
    repo.repoPath,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/",
  ]);
  if (res.code !== 0) return [];
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
}

export async function removeWorktree(worktreePath: string): Promise<void> {
  const repo = getActiveRepo();
  if (repo) {
    await run("git", ["-C", repo.repoPath, "worktree", "remove", "--force", worktreePath]);
    await run("git", ["-C", repo.repoPath, "worktree", "prune"]);
  }
  await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
}

export async function deleteBranch(branch: string): Promise<void> {
  const repo = getActiveRepo();
  if (!repo) return;
  await run("git", ["-C", repo.repoPath, "branch", "-D", branch]);
}
