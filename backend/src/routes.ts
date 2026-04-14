import { randomUUID } from "node:crypto";
import { FastifyInstance } from "fastify";
import path from "node:path";
import { deriveRepoPaths } from "./config.js";
import { ensureDashboardRunning, isPortOpen, stopDashboard, waitForDashboard } from "./dashboard.js";
import {
  Branch,
  Repo,
  addRepo,
  allocatePort,
  getActiveBranchId,
  getActiveRepo,
  getBranch,
  getRepo,
  getSettings,
  isTrunk,
  listBranches,
  listRepos,
  removeBranch,
  removeRepo,
  setActiveBranchId,
  setActiveRepoId,
  trunkBranchId,
  updateBranch,
  updateRepo,
  updateSettings,
  upsertBranch,
} from "./state.js";
import { createWorktree, deleteBranch as deleteGitBranch, detectDefaultBranch, listGitBranches, removeWorktree } from "./worktree.js";
import { run, runOrThrow } from "./shell.js";
import {
  createSandbox,
  removeSandbox,
  sandboxLogs,
  sandboxName,
  startSandbox,
  stopSandbox,
} from "./docker.js";

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
  );
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  async function symlinkRepo(repoPath: string, linkTarget: string): Promise<void> {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(repoPath), { recursive: true });
    try {
      const stat = await fs.lstat(repoPath);
      if (stat.isSymbolicLink() || stat.isDirectory() || stat.isFile()) {
        await fs.rm(repoPath, { recursive: true, force: true });
      }
    } catch {}
    await fs.symlink(linkTarget, repoPath);
  }

  app.get("/api/settings", async () => {
    const settings = getSettings();
    return { ...settings, configured: listRepos().length > 0 };
  });

  app.get("/api/system-check", async () => {
    async function check(cmd: string, args: string[]): Promise<{ ok: boolean; detail: string }> {
      const res = await run(cmd, args).catch((err) => ({ code: 1, stdout: "", stderr: err?.message || "" }));
      const text = (res.stdout || res.stderr || "").trim().split("\n")[0] ?? "";
      return { ok: res.code === 0, detail: text };
    }
    const [node, docker, dockerSandbox, gh, claude] = await Promise.all([
      Promise.resolve({ ok: true, detail: process.version }),
      check("docker", ["--version"]),
      check("docker", ["sandbox", "ls"]),
      check("/bin/sh", ["-lc", "gh --version | head -n1"]),
      check("/bin/sh", ["-lc", "command -v claude && claude --version 2>/dev/null | head -n1 || echo found"]),
    ]);
    return {
      checks: [
        { name: "Node runtime", required: true, ...node },
        { name: "Docker CLI", required: true, ...docker },
        { name: "docker sandbox plugin", required: true, ...dockerSandbox },
        { name: "GitHub `gh` CLI", required: false, ...gh },
        { name: "Claude CLI (host)", required: false, ...claude },
      ],
    };
  });

  app.put<{ Body: Partial<{ repoUrl: string; configured: boolean }> }>(
    "/api/settings",
    async (req) => {
      return await updateSettings(req.body ?? {});
    }
  );

  app.get("/api/repos", async () => {
    const repos = listRepos();
    return { repos, activeRepoId: getActiveRepo()?.id };
  });

  app.post<{
    Body: { linkTarget: string; dashboardInstallCmd?: string; dashboardStartCmd?: string };
  }>("/api/repos", async (req, reply) => {
    const { linkTarget, dashboardInstallCmd, dashboardStartCmd } = req.body ?? ({} as any);
    if (!linkTarget) return reply.code(400).send({ error: "linkTarget required" });

    const cleaned = linkTarget.replace(/\/+$/, "");
    const name = path.basename(cleaned) || "repo";
    const defaultBranch = await detectDefaultBranch(cleaned);
    const { repoPath, worktreesDir } = deriveRepoPaths(name, defaultBranch);

    for (const existing of listRepos()) {
      if (existing.linkTarget === cleaned) {
        return reply.code(409).send({ error: `Repo already added: ${existing.name}` });
      }
    }

    try {
      await symlinkRepo(repoPath, cleaned);
    } catch (err: any) {
      return reply.code(500).send({ error: `Failed to symlink repo: ${err.message}` });
    }

    const repo: Repo = {
      id: randomUUID().slice(0, 8),
      name,
      linkTarget: cleaned,
      repoPath,
      worktreesDir,
      defaultBranch,
      dashboardInstallCmd: dashboardInstallCmd?.trim() || undefined,
      dashboardStartCmd: dashboardStartCmd?.trim() || undefined,
      createdAt: Date.now(),
    };
    await addRepo(repo, true);
    return { repo, activeRepoId: repo.id };
  });

  app.put<{ Params: { id: string }; Body: Partial<Pick<Repo, "dashboardInstallCmd" | "dashboardStartCmd">> }>(
    "/api/repos/:id",
    async (req, reply) => {
      const repo = getRepo(req.params.id);
      if (!repo) return reply.code(404).send({ error: "repo not found" });
      const next = await updateRepo(repo.id, req.body ?? {});
      return next;
    }
  );

  app.post<{ Params: { id: string } }>("/api/repos/:id/activate", async (req, reply) => {
    const repo = getRepo(req.params.id);
    if (!repo) return reply.code(404).send({ error: "repo not found" });
    const next = await setActiveRepoId(repo.id);
    const trunk = getBranch(trunkBranchId(repo.id));
    if (trunk && trunk.status !== "running") {
      try {
        await ensureDashboardRunning(trunk.worktreePath, trunk.port);
        await updateBranch(trunk.id, { status: "running", error: undefined });
      } catch (err: any) {
        console.error(`failed to start trunk dashboard for repo ${repo.id}:`, err);
      }
    }
    return { repo: next, activeRepoId: next.id };
  });

  app.delete<{ Params: { id: string } }>("/api/repos/:id", async (req, reply) => {
    const repo = getRepo(req.params.id);
    if (!repo) return reply.code(404).send({ error: "repo not found" });

    for (const branch of Object.values(listBranchesForRepo(repo.id))) {
      if (branch.sandboxName) {
        await stopSandbox(branch.sandboxName, branch.worktreePath).catch(() => {});
        await removeSandbox(branch.sandboxName, branch.worktreePath).catch(() => {});
      }
      if (branch.worktreePath && !isTrunk(branch)) {
        await removeWorktree(branch.worktreePath).catch(() => {});
      }
    }
    stopDashboard(repo.repoPath);
    try {
      const fs = await import("node:fs/promises");
      await fs.rm(repo.repoPath, { force: true });
    } catch {}
    await removeRepo(repo.id);
    return { ok: true, activeRepoId: getActiveRepo()?.id };
  });

  function listBranchesForRepo(repoId: string): Branch[] {
    return listBranches().filter((b) => b.repoId === repoId);
  }

  app.post("/api/pick-folder", async (_req, reply) => {
    try {
      const res = await run("osascript", [
        "-e",
        'POSIX path of (choose folder with prompt "Select Calypso repo folder")',
      ]);
      if (res.code !== 0) return reply.code(204).send();
      const raw = res.stdout.trim();
      const path = raw.endsWith("/") ? raw.slice(0, -1) : raw;
      return { path };
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? "pick-folder failed" });
    }
  });

  app.get("/api/branches", async () => {
    const stateBranches = listBranches();
    const takenNames = new Set(stateBranches.map((b) => b.name));
    const localGit = await listGitBranches();
    const activeRepo = getActiveRepo();
    const stubs: Branch[] = localGit
      .filter((n) => !takenNames.has(n))
      .map((name) => ({
        id: `git:${name}`,
        name,
        repoId: activeRepo?.id ?? "",
        worktreePath: "",
        port: 0,
        status: "stopped",
        createdAt: 1,
      }));
    const merged = [...stateBranches, ...stubs].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.name.localeCompare(b.name);
    });
    const baseBranch = getActiveRepo()?.defaultBranch || "trunk";
    const enriched = await Promise.all(
      merged.map(async (b) => {
        if (isTrunk(b) || !b.worktreePath) return { ...b, hasChanges: false };
        const res = await run("git", [
          "-C",
          b.worktreePath,
          "rev-list",
          "--count",
          `${baseBranch}..${b.name}`,
        ]);
        const count = res.code === 0 ? parseInt(res.stdout.trim(), 10) || 0 : 0;
        return { ...b, hasChanges: count > 0 };
      })
    );
    return { branches: enriched, activeBranchId: getActiveBranchId() };
  });

  app.get("/api/git-branches", async () => ({ branches: await listGitBranches() }));

  app.get<{ Querystring: { name?: string } }>("/api/branches/remote-exists", async (req, reply) => {
    const name = (req.query.name || "").trim();
    if (!name) return reply.code(400).send({ error: "name required" });
    const repo = getActiveRepo();
    if (!repo) return { exists: false };
    const res = await run("git", ["-C", repo.repoPath, "ls-remote", "--heads", "origin", name]);
    return { exists: res.code === 0 && res.stdout.trim().length > 0 };
  });

  app.post<{ Body: { name: string; base?: string } }>(
    "/api/branches",
    async (req, reply) => {
      const { name, base } = req.body ?? ({} as any);
      if (!name) return reply.code(400).send({ error: "name required" });
      const activeRepo = getActiveRepo();
      if (!activeRepo) return reply.code(400).send({ error: "no active repo" });

      const id = randomUUID().slice(0, 8);
      const branchName = name.trim();
      const folderSlug = slugify(branchName) || id;
      const port = allocatePort();

      const branch: Branch = {
        id,
        name: branchName,
        repoId: activeRepo.id,
        worktreePath: "",
        port,
        status: "creating",
        createdAt: Date.now(),
      };
      await upsertBranch(branch);

      try {
        const worktreePath = await createWorktree(folderSlug, branchName, base);
        const sbName = sandboxName(folderSlug);
        await createSandbox(sbName, worktreePath);
        await startSandbox(sbName, worktreePath, port);
        await updateBranch(id, { worktreePath, sandboxName: sbName, status: "running" });
      } catch (err: any) {
        await updateBranch(id, { status: "error", error: err.message });
        return reply.code(500).send({ error: err.message });
      }

      return getBranch(id);
    }
  );

  app.post<{ Params: { id: string } }>("/api/branches/:id/toggle", async (req, reply) => {
    let branch = getBranch(req.params.id);

    if (!branch && req.params.id.startsWith("git:")) {
      const gitName = req.params.id.slice(4);
      const activeRepo = getActiveRepo();
      if (!activeRepo) return reply.code(400).send({ error: "no active repo" });
      const id = randomUUID().slice(0, 8);
      const port = allocatePort();
      const created: Branch = {
        id,
        name: gitName,
        repoId: activeRepo.id,
        worktreePath: "",
        port,
        status: "creating",
        createdAt: Date.now(),
      };
      await upsertBranch(created);
      const folderSlug = slugify(gitName) || id;
      try {
        const worktreePath = await createWorktree(folderSlug, gitName);
        const sbName = sandboxName(folderSlug);
        await createSandbox(sbName, worktreePath);
        await startSandbox(sbName, worktreePath, port);
        await updateBranch(id, { worktreePath, sandboxName: sbName, status: "running" });
      } catch (err: any) {
        await updateBranch(id, { status: "error", error: err.message });
        return reply.code(500).send({ error: err.message });
      }
      return getBranch(id);
    }

    if (!branch) return reply.code(404).send({ error: "not found" });

    if (isTrunk(branch)) {
      if (branch.status === "running") {
        stopDashboard(branch.worktreePath);
        await updateBranch(branch.id, { status: "stopped" });
        return getBranch(branch.id);
      }
      try {
        await ensureDashboardRunning(branch.worktreePath, branch.port);
        await updateBranch(branch.id, { status: "running", error: undefined });
        return getBranch(branch.id);
      } catch (err: any) {
        await updateBranch(branch.id, { status: "error", error: err.message });
        return reply.code(500).send({ error: err.message });
      }
    }

    if (!branch.sandboxName) return reply.code(400).send({ error: "no sandbox" });

    if (branch.status === "running") {
      await stopSandbox(branch.sandboxName, branch.worktreePath).catch(() => {});
      await updateBranch(branch.id, { status: "stopped" });
      return getBranch(branch.id);
    }

    try {
      await startSandbox(branch.sandboxName, branch.worktreePath, branch.port);
      await updateBranch(branch.id, { status: "running", error: undefined });
      return getBranch(branch.id);
    } catch (err: any) {
      await updateBranch(branch.id, { status: "error", error: err.message });
      return reply.code(500).send({ error: err.message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/branches/:id/open-editor", async (req, reply) => {
    const branch = getBranch(req.params.id);
    if (!branch) return reply.code(404).send({ error: "not found" });
    if (!branch.worktreePath) return reply.code(400).send({ error: "no worktree" });
    try {
      const fs = await import("node:fs/promises");
      let target = branch.worktreePath;
      try {
        target = await fs.realpath(branch.worktreePath);
      } catch {}
      await runOrThrow("/bin/sh", ["-lc", `code "${target}"`]);
      return { ok: true };
    } catch (err: any) {
      return reply.code(500).send({ error: `failed to open editor: ${err.message}` });
    }
  });

  app.post<{ Params: { id: string } }>("/api/branches/:id/create-pr", async (req, reply) => {
    const branch = getBranch(req.params.id);
    if (!branch) return reply.code(404).send({ error: "not found" });
    if (isTrunk(branch)) return reply.code(400).send({ error: "cannot create PR for trunk" });
    if (!branch.worktreePath) return reply.code(400).send({ error: "no worktree" });

    try {
      await runOrThrow("git", ["push", "-u", "origin", branch.name], { cwd: branch.worktreePath });
    } catch (err: any) {
      return reply.code(500).send({ error: `git push failed: ${err.message}` });
    }

    const existing = await run("gh", ["pr", "view", "--json", "url", "--jq", ".url"], {
      cwd: branch.worktreePath,
    });
    if (existing.code === 0 && existing.stdout.trim()) {
      const url = existing.stdout.trim();
      await updateBranch(branch.id, { prUrl: url });
      return { url };
    }

    try {
      const url = (await runOrThrow("gh", ["pr", "create", "--fill"], { cwd: branch.worktreePath })).trim();
      await updateBranch(branch.id, { prUrl: url });
      return { url };
    } catch (err: any) {
      return reply.code(500).send({ error: `gh pr create failed: ${err.message}` });
    }
  });

  app.post<{ Params: { id: string } }>("/api/branches/:id/start-dashboard", async (req, reply) => {
    const branch = getBranch(req.params.id);
    if (!branch) return reply.code(404).send({ error: "not found" });
    if (!branch.worktreePath) return reply.code(400).send({ error: "no worktree" });
    if (await isPortOpen(branch.port)) return { running: true };

    await ensureDashboardRunning(branch.worktreePath, branch.port);
    if (await waitForDashboard(branch.port)) return { running: true };
    return reply.code(504).send({ error: "dashboard did not come up within 15 minutes" });
  });

  app.post<{ Params: { id: string } }>("/api/branches/:id/switch", async (req, reply) => {
    const branch = getBranch(req.params.id);
    if (!branch) return reply.code(404).send({ error: "not found" });
    await setActiveBranchId(branch.id);
    return { activeBranchId: branch.id };
  });

  app.get<{ Params: { id: string } }>("/api/branches/:id/logs", async (req, reply) => {
    const branch = getBranch(req.params.id);
    if (!branch) return reply.code(404).send({ error: "not found" });
    if (!branch.sandboxName) return { logs: "" };
    return { logs: await sandboxLogs(branch.sandboxName) };
  });

  app.delete<{ Params: { id: string } }>("/api/branches/:id", async (req, reply) => {
    if (req.params.id.startsWith("git:")) {
      const name = req.params.id.slice(4);
      const activeRepo = getActiveRepo();
      if (!activeRepo) return reply.code(400).send({ error: "no active repo" });
      try {
        await runOrThrow("git", ["-C", activeRepo.repoPath, "branch", "-D", name]);
        return { ok: true };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }

    const branch = getBranch(req.params.id);
    if (!branch) return reply.code(404).send({ error: "not found" });
    if (isTrunk(branch)) return reply.code(400).send({ error: "trunk cannot be deleted" });
    if (branch.sandboxName) {
      await stopSandbox(branch.sandboxName, branch.worktreePath).catch(() => {});
      await removeSandbox(branch.sandboxName, branch.worktreePath).catch(() => {});
    }
    if (branch.worktreePath) await removeWorktree(branch.worktreePath).catch(() => {});
    if (branch.name) await deleteGitBranch(branch.name).catch(() => {});
    await removeBranch(branch.id);
    return { ok: true };
  });
}
