// End-to-end tests for the shipyard:sandbox CLI (commit + push flows).
//
// Layer 1 — backend endpoint behaviour via Fastify inject:
//           /push: 404/400 preconditions and dry-run response shape.
//           /commit: 404/400 preconditions, create commit, --amend with
//           new message, --amend --no-edit, nothing-to-commit surfacing.
//           Commit tests run against a real tmp git repo (tag test-initial
//           marks the pristine state) since commits are local — no need
//           for a dry-run path.
//
// Layer 2 — the CLI script itself: invokes shipyard:sandbox as a subprocess
//           against a real booted backend (127.0.0.1 on an ephemeral port)
//           with SHIPYARD_BACKEND_URL pointed at it. This exercises the
//           same plumbing Claude uses from inside the sandbox — in prod
//           the only difference is that the sandbox resolves the backend
//           via host.docker.internal and needs the per-sandbox proxy
//           allow rule set by ensureRepoSandbox.
//
// Layer 3 — CLAUDE.md injection produces the text that tells Claude to use
//           `shipyard:sandbox commit` and `shipyard:sandbox push`. This is
//           the context a new chat reads on startup, so it's load-bearing
//           for the automated flow.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// Must set DATA_DIR before importing anything that reads config, because
// config.ts captures process.env.DATA_DIR at module-load time.
const tmpDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "shipyard-test-"));
process.env.DATA_DIR = tmpDataDir;

const state = await import("../src/state.js");
const { registerRoutes } = await import("../src/routes.js");
const { injectTaskIntoClaudeMd, taskFilePath } = await import("../src/tasks.js");
const { runOrThrow } = await import("../src/shell.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "..", "sandbox-bin", "shipyard:sandbox");
const GIT_WRAPPER_PATH = path.resolve(__dirname, "..", "sandbox-bin", "git");

const REPO_ID = "test-repo";
const BRANCH_ID = "test-branch";
const COMMIT_BRANCH_ID = "commit-branch";

let app: FastifyInstance;
let port: number;
let tmpWorktree: string;
let commitWorktree: string;

beforeAll(async () => {
  await state.loadState();

  tmpWorktree = await fsp.mkdtemp(path.join(os.tmpdir(), "shipyard-wt-"));

  const now = Date.now();
  await state.addRepo({
    id: REPO_ID,
    name: "test-repo",
    linkTarget: tmpWorktree,
    repoPath: tmpWorktree,
    worktreesDir: path.dirname(tmpWorktree),
    defaultBranch: "main",
    createdAt: now,
  });

  await state.upsertBranch({
    id: BRANCH_ID,
    name: "feature-x",
    repoId: REPO_ID,
    worktreePath: tmpWorktree,
    port: 4100,
    status: "running",
    createdAt: now,
  });

  // Also seed a branch with no worktree to test the 400 path.
  await state.upsertBranch({
    id: "no-wt-branch",
    name: "no-wt",
    repoId: REPO_ID,
    worktreePath: "",
    port: 4101,
    status: "stopped",
    createdAt: now,
  });

  // A real git repo for the commit endpoint + CLI tests. `test-initial` is
  // a tag marking the pristine state so each test can reset back to it.
  commitWorktree = await fsp.mkdtemp(path.join(os.tmpdir(), "shipyard-commit-"));
  await runOrThrow("git", ["init", "-q"], { cwd: commitWorktree });
  await runOrThrow("git", ["config", "user.email", "test@example.com"], { cwd: commitWorktree });
  await runOrThrow("git", ["config", "user.name", "Shipyard Test"], { cwd: commitWorktree });
  // Make sure no global GPG signing / pre-commit config can break the tests.
  await runOrThrow("git", ["config", "commit.gpgsign", "false"], { cwd: commitWorktree });
  await fsp.writeFile(path.join(commitWorktree, "README.md"), "initial\n");
  await runOrThrow("git", ["add", "."], { cwd: commitWorktree });
  await runOrThrow("git", ["commit", "-q", "-m", "initial"], { cwd: commitWorktree });
  await runOrThrow("git", ["tag", "test-initial"], { cwd: commitWorktree });

  await state.upsertBranch({
    id: COMMIT_BRANCH_ID,
    name: "commit-test",
    repoId: REPO_ID,
    worktreePath: commitWorktree,
    port: 4102,
    status: "running",
    createdAt: now,
  });

  app = Fastify({ logger: false });
  await registerRoutes(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
});

afterAll(async () => {
  await app.close();
  await fsp.rm(tmpDataDir, { recursive: true, force: true });
  await fsp.rm(tmpWorktree, { recursive: true, force: true });
  await fsp.rm(commitWorktree, { recursive: true, force: true });
});

async function resetCommitWorktree(): Promise<void> {
  await runOrThrow("git", ["reset", "--hard", "-q", "test-initial"], { cwd: commitWorktree });
  await runOrThrow("git", ["clean", "-fdq"], { cwd: commitWorktree });
}

// -------- Layer 1: endpoint behaviour --------

describe("POST /api/branches/:id/push", () => {
  it("returns 404 for unknown branch", async () => {
    const res = await app.inject({ method: "POST", url: "/api/branches/does-not-exist/push" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
  });

  it("rejects trunk with 400", async () => {
    const trunkId = state.trunkBranchId(REPO_ID);
    const res = await app.inject({ method: "POST", url: `/api/branches/${trunkId}/push` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/trunk/);
  });

  it("rejects branch with no worktree", async () => {
    const res = await app.inject({ method: "POST", url: "/api/branches/no-wt-branch/push" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "no worktree" });
  });

  it("dry-run returns synthetic PR url without running git/gh", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/branches/${BRANCH_ID}/push?dryRun=1`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dryRun).toBe(true);
    expect(body.created).toBe(false);
    expect(body.url).toMatch(/^dry-run:/);
  });
});

describe("POST /api/branches/:id/commit", () => {
  beforeEach(resetCommitWorktree);

  const commitHeaders = { "content-type": "text/plain" };

  it("returns 404 for unknown branch", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/branches/does-not-exist/commit",
      payload: "msg",
      headers: commitHeaders,
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects trunk with 400", async () => {
    const trunkId = state.trunkBranchId(REPO_ID);
    const res = await app.inject({
      method: "POST",
      url: `/api/branches/${trunkId}/commit`,
      payload: "msg",
      headers: commitHeaders,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/trunk/);
  });

  it("rejects branch with no worktree", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/branches/no-wt-branch/commit",
      payload: "msg",
      headers: commitHeaders,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "no worktree" });
  });

  it("rejects empty body when not amending", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/branches/${COMMIT_BRANCH_ID}/commit`,
      payload: "",
      headers: commitHeaders,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/message/i);
  });

  it("stages all changes and creates a new commit", async () => {
    await fsp.writeFile(path.join(commitWorktree, "new.txt"), "hi\n");
    const initialSha = (await runOrThrow("git", ["rev-parse", "test-initial"], { cwd: commitWorktree })).trim();
    const res = await app.inject({
      method: "POST",
      url: `/api/branches/${COMMIT_BRANCH_ID}/commit`,
      payload: "add new file",
      headers: commitHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.message).toBe("add new file");
    expect(body.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.sha).not.toBe(initialSha);
    const count = (await runOrThrow("git", ["rev-list", "--count", "HEAD"], { cwd: commitWorktree })).trim();
    expect(count).toBe("2");
  });

  it("amend with new message rewrites HEAD in place", async () => {
    const initialSha = (await runOrThrow("git", ["rev-parse", "HEAD"], { cwd: commitWorktree })).trim();
    const res = await app.inject({
      method: "POST",
      url: `/api/branches/${COMMIT_BRANCH_ID}/commit?amend=1`,
      payload: "reworded",
      headers: commitHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.message).toBe("reworded");
    expect(body.sha).not.toBe(initialSha);
    const count = (await runOrThrow("git", ["rev-list", "--count", "HEAD"], { cwd: commitWorktree })).trim();
    expect(count).toBe("1");
  });

  it("amend with empty body (--no-edit) folds new changes into HEAD and keeps the message", async () => {
    await fsp.writeFile(path.join(commitWorktree, "additional.txt"), "extra\n");
    const res = await app.inject({
      method: "POST",
      url: `/api/branches/${COMMIT_BRANCH_ID}/commit?amend=1`,
      payload: "",
      headers: commitHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.message).toBe("initial");
    const count = (await runOrThrow("git", ["rev-list", "--count", "HEAD"], { cwd: commitWorktree })).trim();
    expect(count).toBe("1");
    const files = (await runOrThrow("git", ["ls-tree", "--name-only", "HEAD"], { cwd: commitWorktree })).trim().split("\n");
    expect(files).toContain("additional.txt");
  });

  it("surfaces `nothing to commit` as 500", async () => {
    // Worktree is reset to test-initial; nothing to stage.
    const res = await app.inject({
      method: "POST",
      url: `/api/branches/${COMMIT_BRANCH_ID}/commit`,
      payload: "no changes",
      headers: commitHeaders,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/git commit failed/);
  });
});

// -------- Layer 2: CLI subprocess --------

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI_PATH, args, {
      env: { ...process.env, ...env },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

describe("shipyard:sandbox CLI", () => {
  it("prints usage when no command is given", async () => {
    const { code, stderr } = await runCli([], {
      SHIPYARD_BRANCH_ID: BRANCH_ID,
      SHIPYARD_BACKEND_URL: `http://127.0.0.1:${port}`,
    });
    expect(code).toBe(2);
    expect(stderr).toMatch(/usage/i);
  });

  it("errors with exit 1 when SHIPYARD_BRANCH_ID is unset", async () => {
    const { code, stderr } = await runCli(["push"], {
      SHIPYARD_BRANCH_ID: "",
      SHIPYARD_BACKEND_URL: `http://127.0.0.1:${port}`,
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/SHIPYARD_BRANCH_ID/);
  });

  it("push (dry-run) calls backend and prints synthetic PR response", async () => {
    const { code, stdout, stderr } = await runCli(["push"], {
      SHIPYARD_BRANCH_ID: BRANCH_ID,
      SHIPYARD_BACKEND_URL: `http://127.0.0.1:${port}`,
      SHIPYARD_PUSH_DRYRUN: "1",
    });
    expect(code, `stderr=${stderr}`).toBe(0);
    const body = JSON.parse(stdout);
    expect(body.dryRun).toBe(true);
    expect(body.url).toMatch(/^dry-run:/);
  });

  it("surfaces backend 404 as a non-zero exit", async () => {
    const { code, stdout } = await runCli(["push"], {
      SHIPYARD_BRANCH_ID: "does-not-exist",
      SHIPYARD_BACKEND_URL: `http://127.0.0.1:${port}`,
      SHIPYARD_PUSH_DRYRUN: "1",
    });
    expect(code).not.toBe(0);
    // --fail-with-body makes curl still write the response body to stdout
    // (its own "curl: (22)..." message goes to stderr).
    expect(stdout).toMatch(/not found/);
  });

  it("rejects unknown subcommand with exit 2", async () => {
    const { code, stderr } = await runCli(["bogus"], {
      SHIPYARD_BRANCH_ID: BRANCH_ID,
      SHIPYARD_BACKEND_URL: `http://127.0.0.1:${port}`,
    });
    expect(code).toBe(2);
    expect(stderr).toMatch(/usage/i);
  });
});

describe("shipyard:sandbox commit CLI", () => {
  beforeEach(resetCommitWorktree);

  it("errors with exit 2 when neither -m nor --amend is given", async () => {
    const { code, stderr } = await runCli(["commit"], {
      SHIPYARD_BRANCH_ID: COMMIT_BRANCH_ID,
      SHIPYARD_BACKEND_URL: `http://127.0.0.1:${port}`,
    });
    expect(code).toBe(2);
    expect(stderr).toMatch(/-m/);
  });

  it("errors with exit 2 when -m is missing its argument", async () => {
    const { code, stderr } = await runCli(["commit", "-m"], {
      SHIPYARD_BRANCH_ID: COMMIT_BRANCH_ID,
      SHIPYARD_BACKEND_URL: `http://127.0.0.1:${port}`,
    });
    expect(code).toBe(2);
    expect(stderr).toMatch(/-m requires an argument/);
  });

  it("commit -m stages and commits via the backend", async () => {
    await fsp.writeFile(path.join(commitWorktree, "cli-test.txt"), "hello from CLI\n");
    const { code, stdout, stderr } = await runCli(["commit", "-m", "from CLI"], {
      SHIPYARD_BRANCH_ID: COMMIT_BRANCH_ID,
      SHIPYARD_BACKEND_URL: `http://127.0.0.1:${port}`,
    });
    expect(code, `stderr=${stderr}`).toBe(0);
    const body = JSON.parse(stdout);
    expect(body.message).toBe("from CLI");
    expect(body.sha).toMatch(/^[0-9a-f]{40}$/);
    const files = (await runOrThrow("git", ["ls-tree", "--name-only", "HEAD"], { cwd: commitWorktree })).trim().split("\n");
    expect(files).toContain("cli-test.txt");
  });

  it("commit -m preserves a multi-line message verbatim", async () => {
    await fsp.writeFile(path.join(commitWorktree, "multi.txt"), "x\n");
    const body = "subject line\n\nbody paragraph with %percent% and \"quotes\"";
    const { code, stderr } = await runCli(["commit", "-m", body], {
      SHIPYARD_BRANCH_ID: COMMIT_BRANCH_ID,
      SHIPYARD_BACKEND_URL: `http://127.0.0.1:${port}`,
    });
    expect(code, `stderr=${stderr}`).toBe(0);
    const stored = (await runOrThrow("git", ["log", "-1", "--format=%B"], { cwd: commitWorktree })).trim();
    expect(stored).toBe(body);
  });

  it("commit --amend -m rewrites the HEAD message", async () => {
    const { code, stdout, stderr } = await runCli(["commit", "--amend", "-m", "reworded via CLI"], {
      SHIPYARD_BRANCH_ID: COMMIT_BRANCH_ID,
      SHIPYARD_BACKEND_URL: `http://127.0.0.1:${port}`,
    });
    expect(code, `stderr=${stderr}`).toBe(0);
    const body = JSON.parse(stdout);
    expect(body.message).toBe("reworded via CLI");
    const count = (await runOrThrow("git", ["rev-list", "--count", "HEAD"], { cwd: commitWorktree })).trim();
    expect(count).toBe("1");
  });
});

// -------- Layer 2b: git wrapper --------

function runGitWrapper(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(GIT_WRAPPER_PATH, args, { cwd });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

describe("sandbox-bin/git wrapper", () => {
  beforeEach(resetCommitWorktree);

  it("blocks `git commit` and points at shipyard:sandbox commit", async () => {
    const { code, stderr } = await runGitWrapper(["commit", "-m", "nope"], commitWorktree);
    expect(code).toBe(1);
    expect(stderr).toMatch(/shipyard:sandbox commit/);
    expect(stderr).toMatch(/git commit/);
  });

  it("blocks `git commit --amend` via the same path", async () => {
    const { code, stderr } = await runGitWrapper(["commit", "--amend", "--no-edit"], commitWorktree);
    expect(code).toBe(1);
    expect(stderr).toMatch(/shipyard:sandbox commit --amend/);
  });

  it("blocks `git -C <path> commit` (subcommand after top-level flag)", async () => {
    const { code, stderr } = await runGitWrapper(["-C", commitWorktree, "commit", "-m", "nope"], "/tmp");
    expect(code).toBe(1);
    expect(stderr).toMatch(/shipyard:sandbox commit/);
  });

  it("blocks `git push` and points at shipyard:sandbox push", async () => {
    const { code, stderr } = await runGitWrapper(["push"], commitWorktree);
    expect(code).toBe(1);
    expect(stderr).toMatch(/shipyard:sandbox push/);
  });

  it("passes `git status` through to the real git", async () => {
    const { code, stderr } = await runGitWrapper(["status", "--porcelain"], commitWorktree);
    expect(code, `stderr=${stderr}`).toBe(0);
  });

  it("passes `git log -1` through to the real git", async () => {
    const { code, stdout, stderr } = await runGitWrapper(["log", "-1", "--format=%s"], commitWorktree);
    expect(code, `stderr=${stderr}`).toBe(0);
    expect(stdout.trim()).toBe("initial");
  });
});

// -------- Layer 3: CLAUDE.md injection guides Claude to the CLI --------

describe("injectTaskIntoClaudeMd", () => {
  it("writes a Sandbox-rules section covering commit, push, and open-PR via shipyard:sandbox", async () => {
    const worktree = await fsp.mkdtemp(path.join(os.tmpdir(), "shipyard-cmd-"));
    try {
      await injectTaskIntoClaudeMd(worktree, "demo-slug");
      const body = await fsp.readFile(path.join(worktree, "CLAUDE.md"), "utf8");
      // Sandbox rules appear before Current Task so Claude reads them first.
      expect(body.indexOf("Sandbox rules")).toBeLessThan(body.indexOf("Current Task"));
      // All three actions Claude needs to know are explicitly named.
      expect(body).toMatch(/\*\*Commit\*\*: `shipyard:sandbox commit/);
      expect(body).toMatch(/\*\*Push\*\*: `shipyard:sandbox push`/);
      expect(body).toMatch(/\*\*Open a PR\*\*/);
      // The warning about interception makes the ban explicit even if
      // Claude doesn't read the bullets.
      expect(body).toMatch(/intercepted/);
      // Points Claude at the per-branch task history file.
      expect(body).toContain(taskFilePath("demo-slug"));
    } finally {
      await fsp.rm(worktree, { recursive: true, force: true });
    }
  });
});
