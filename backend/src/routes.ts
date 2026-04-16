import { randomUUID } from "node:crypto";
import { FastifyInstance } from "fastify";
import path from "node:path";
import { config, deriveRepoPaths } from "./config.js";
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
  getSandboxStatus,
  removeSandbox,
  restartSandboxClaude,
  sandboxLogs,
  sandboxName,
  startSandbox,
  stopSandbox,
} from "./docker.js";
import { createSession, ensureSession, findSessionByBranch, listSessions, updateSession } from "./sessions.js";
import { appendTaskEntry, buildSeedPrompt, injectTaskIntoClaudeMd, taskFilePath, TaskEntry } from "./tasks.js";

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
    return {
      ...settings,
      configured: listRepos().length > 0,
      maxConcurrentSandboxes: config.maxConcurrentSandboxes,
    };
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
    Body: { linkTarget: string; dashboardInstallCmd?: string; dashboardStartCmd?: string; previewUrl?: string };
  }>("/api/repos", async (req, reply) => {
    const { linkTarget, dashboardInstallCmd, dashboardStartCmd, previewUrl } = req.body ?? ({} as any);
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
      previewUrl: previewUrl?.trim() || undefined,
      createdAt: Date.now(),
    };
    await addRepo(repo, true);
    return { repo, activeRepoId: repo.id };
  });

  app.put<{ Params: { id: string }; Body: Partial<Pick<Repo, "dashboardInstallCmd" | "dashboardStartCmd" | "previewUrl">> }>(
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
    function rank(b: Branch): number {
      if (isTrunk(b)) return 0;
      if (b.id.startsWith("git:")) return 3;
      if (b.status === "running" || b.status === "starting" || b.status === "creating") return 1;
      return 2;
    }
    const merged = [...stateBranches, ...stubs].sort((a, b) => {
      const d = rank(a) - rank(b);
      if (d !== 0) return d;
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

  async function createBranchFlow(
    name: string,
    base?: string,
    taskEntry?: Omit<TaskEntry, "type" | "ts">
  ): Promise<Branch> {
    const activeRepo = getActiveRepo();
    if (!activeRepo) throw new Error("no active repo");

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

    // Write the task history file before starting the sandbox so Claude
    // can read it on startup.
    if (taskEntry) {
      await appendTaskEntry(folderSlug, {
        type: "task",
        command: taskEntry.command,
        source: taskEntry.source,
        body: taskEntry.body,
        ts: Date.now(),
      });
    }

    try {
      const worktreePath = await createWorktree(folderSlug, branchName, base);

      // Inject task instructions into the worktree's CLAUDE.md so Claude
      // reads them automatically on startup — no PTY timing dependency.
      if (taskEntry) {
        await injectTaskIntoClaudeMd(worktreePath, folderSlug);
      }

      const sbName = sandboxName(folderSlug);
      await createSandbox(sbName, worktreePath);
      // Short nudge via PTY as a fallback in case Claude doesn't auto-start
      // from CLAUDE.md. The real context is in the file, not the prompt.
      await startSandbox(sbName, worktreePath, port, taskEntry ? buildSeedPrompt() : undefined);
      await updateBranch(id, { worktreePath, sandboxName: sbName, status: "running" });
    } catch (err) {
      // Drop the placeholder record instead of leaving an empty "error"
      // row behind — retries would otherwise accumulate duplicates.
      await removeBranch(id).catch(() => {});
      throw err;
    }

    const created = getBranch(id);
    if (!created) throw new Error("branch vanished after create");
    return created;
  }

  app.post<{ Body: { name: string; base?: string } }>(
    "/api/branches",
    async (req, reply) => {
      const { name, base } = req.body ?? ({} as any);
      if (!name) return reply.code(400).send({ error: "name required" });
      try {
        const branch = await createBranchFlow(name, base);
        const repo = getActiveRepo();
        if (repo) await ensureSession(repo.name, branch.name);
        return branch;
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  app.post<{ Body: { command: string } }>("/api/commands", async (req, reply) => {
    const raw = (req.body?.command ?? "").trim();
    if (!raw.startsWith("/")) {
      return reply.code(400).send({ error: "command must start with /" });
    }
    const [head, ...rest] = raw.slice(1).split(/\s+/);
    const verb = (head || "").toLowerCase();

    if (verb === "branch") {
      const name = rest[0];
      const base = rest[1];
      if (!name) return reply.code(400).send({ error: "/branch <name> [base]" });
      try {
        // Plain /branch gets no task entry and no seed prompt — just a blank
        // sandbox. The user drives Claude directly from the terminal.
        const branch = await createBranchFlow(name, base);
        const repo = getActiveRepo();
        if (repo) await createSession({ repo: repo.name, branch: branch.name });
        return { kind: "branch", branch };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }

    if (verb === "gh-issue") {
      const url = rest[0];
      if (!url) return reply.code(400).send({ error: "/gh-issue <url>" });
      const m = url.match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/);
      const branchName = m ? `issue-${m[1]}` : `issue-${Date.now()}`;
      const repo = getActiveRepo();
      if (!repo) return reply.code(400).send({ error: "no active repo" });

      // Pre-fetch issue content on the host (where gh is authenticated) so
      // Claude inside the sandbox doesn't need gh CLI access.
      let issueTitle = "";
      let issueBody = "";
      let issueComments = "";
      try {
        const res = await run(
          "gh",
          ["issue", "view", url, "--json", "title,body,comments", "--jq",
           '(.title) + "\\n---BODY---\\n" + (.body) + "\\n---COMMENTS---\\n" + ([.comments[] | "**" + .author.login + "**: " + .body] | join("\\n\\n"))'],
          { cwd: repo.repoPath }
        );
        if (res.code === 0) {
          const out = res.stdout.trim();
          const bodyIdx = out.indexOf("\n---BODY---\n");
          const commentsIdx = out.indexOf("\n---COMMENTS---\n");
          if (bodyIdx >= 0 && commentsIdx >= 0) {
            issueTitle = out.slice(0, bodyIdx);
            issueBody = out.slice(bodyIdx + 12, commentsIdx);
            issueComments = out.slice(commentsIdx + 16);
          } else {
            issueBody = out;
          }
        }
      } catch {}

      const sections: string[] = [];
      if (issueTitle || issueBody) {
        sections.push(`## Issue: ${issueTitle || url}\n\n${issueBody}`);
      } else {
        sections.push(`## Issue\n\nURL: ${url}\n\n(Could not pre-fetch issue content. Read the issue at the URL above.)`);
      }
      if (issueComments.trim()) {
        sections.push(`## Comments\n\n${issueComments}`);
      }
      sections.push([
        "## Instructions",
        "",
        "1. Read the issue and comments above carefully.",
        "2. Plan the implementation — keep changes focused and minimal.",
        "3. Implement the changes and verify with relevant tests.",
        "4. Commit with a clear message referencing the issue.",
        "5. Push and open a PR: `git push -u origin HEAD && gh pr create --fill`",
      ].join("\n"));

      try {
        const branch = await createBranchFlow(branchName, undefined, {
          command: "/gh-issue",
          source: url,
          body: sections.join("\n\n"),
        });
        await createSession({ repo: repo.name, branch: branch.name, issueUrl: url });
        return { kind: "issue", branch };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }

    if (verb === "linear") {
      const url = rest[0];
      if (!url) return reply.code(400).send({ error: "/linear <url>" });
      const m = url.match(/linear\.app\/[^/]+\/issue\/([A-Za-z]+-\d+)/);
      if (!m) return reply.code(400).send({ error: "not a Linear issue URL" });
      const identifier = m[1];
      const branchName = identifier.toLowerCase();

      // Pre-fetch Linear ticket via the API if LINEAR_API_KEY is set.
      let ticketTitle = "";
      let ticketBody = "";
      const linearApiKey = process.env.LINEAR_API_KEY;
      if (linearApiKey) {
        try {
          const query = JSON.stringify({
            query: `{ issue(id: "${identifier}") { title description } }`,
          });
          const res = await run("curl", [
            "-s",
            "-X", "POST",
            "-H", "Content-Type: application/json",
            "-H", `Authorization: ${linearApiKey}`,
            "-d", query,
            "https://api.linear.app/graphql",
          ]);
          if (res.code === 0) {
            const data = JSON.parse(res.stdout);
            ticketTitle = data?.data?.issue?.title ?? "";
            ticketBody = data?.data?.issue?.description ?? "";
          }
        } catch {}
      }

      const sections: string[] = [];
      if (ticketTitle || ticketBody) {
        sections.push(`## ${identifier}: ${ticketTitle}\n\n${ticketBody}`);
      } else {
        sections.push(`## Linear ticket: ${identifier}\n\nURL: ${url}\n\n(Set LINEAR_API_KEY to pre-fetch ticket content, or read it at the URL above.)`);
      }
      sections.push([
        "## Instructions",
        "",
        "1. Read the ticket above carefully.",
        "2. Plan the implementation — keep changes focused and minimal.",
        "3. Implement the changes and verify with relevant tests.",
        "4. Commit with a clear message referencing the ticket.",
        "5. Push and open a PR: `git push -u origin HEAD && gh pr create --fill`",
      ].join("\n"));

      try {
        const branch = await createBranchFlow(branchName, undefined, {
          command: "/linear",
          source: url,
          body: sections.join("\n\n"),
        });
        const repo = getActiveRepo();
        if (repo) await createSession({ repo: repo.name, branch: branch.name, linearUrl: url });
        return { kind: "linear", branch };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }

    return reply.code(400).send({ error: `unknown command: /${verb}` });
  });

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
        await ensureSession(activeRepo.name, gitName);
      } catch (err: any) {
        await removeBranch(id).catch(() => {});
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

    await updateBranch(branch.id, { status: "starting" });
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

  app.post<{ Params: { id: string }; Querystring: { hard?: string } }>("/api/branches/:id/refresh", async (req, reply) => {
    const branch = getBranch(req.params.id);
    if (!branch) return reply.code(404).send({ error: "not found" });
    if (!branch.sandboxName) return reply.code(400).send({ error: "no sandbox" });
    const hard = req.query.hard === "1";

    const slug = branch.sandboxName.replace(/^claude-/, "");
    let seed: string | undefined;
    try {
      const fs = await import("node:fs/promises");
      await fs.access(taskFilePath(slug));
      seed = buildSeedPrompt();
    } catch {}

    await updateBranch(branch.id, { status: "restarting" });
    try {
      if (hard) {
        // Hard restart: nuke the entire sandbox and rebuild from scratch.
        // Fixes stale permissions, broken VM state, corrupted config.
        await stopSandbox(branch.sandboxName, branch.worktreePath).catch(() => {});
        await removeSandbox(branch.sandboxName, branch.worktreePath).catch(() => {});
        if (branch.worktreePath) await createSandbox(branch.sandboxName, branch.worktreePath);
        await startSandbox(branch.sandboxName, branch.worktreePath, branch.port, seed);
      } else {
        const vmStatus = await getSandboxStatus(branch.sandboxName);
        if (vmStatus === "running") {
          try {
            await restartSandboxClaude(branch.sandboxName, branch.worktreePath, seed);
          } catch {
            console.warn(`restart(${branch.sandboxName}): exec failed, rebuilding sandbox`);
            await removeSandbox(branch.sandboxName, branch.worktreePath).catch(() => {});
            if (branch.worktreePath) await createSandbox(branch.sandboxName, branch.worktreePath);
            await startSandbox(branch.sandboxName, branch.worktreePath, branch.port, seed);
          }
        } else {
          try {
            await startSandbox(branch.sandboxName, branch.worktreePath, branch.port, seed);
          } catch {
            console.warn(`restart(${branch.sandboxName}): start failed, rebuilding sandbox`);
            await removeSandbox(branch.sandboxName, branch.worktreePath).catch(() => {});
            if (branch.worktreePath) await createSandbox(branch.sandboxName, branch.worktreePath);
            await startSandbox(branch.sandboxName, branch.worktreePath, branch.port, seed);
          }
        }
      }
      await updateBranch(branch.id, { status: "running", error: undefined });
      return { ok: true };
    } catch (err: any) {
      console.error(`restart(${branch.sandboxName}) failed:`, err);
      await updateBranch(branch.id, { status: "error", error: err.message }).catch(() => {});
      return reply.code(500).send({ error: `restart failed: ${err.message}` });
    }
  });

  app.get("/api/sessions", async () => ({ sessions: await listSessions() }));

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
        // Find any worktrees referencing this branch and remove them before
        // `branch -D`, which refuses to drop a ref that's still checked out.
        const list = await run("git", [
          "-C",
          activeRepo.repoPath,
          "worktree",
          "list",
          "--porcelain",
        ]);
        if (list.code === 0) {
          const blocks = list.stdout.split(/\n\n+/);
          const targets: string[] = [];
          for (const block of blocks) {
            const lines = block.split("\n");
            const worktreeLine = lines.find((l) => l.startsWith("worktree "));
            const branchLine = lines.find((l) => l.startsWith("branch "));
            if (!worktreeLine || !branchLine) continue;
            const wtPath = worktreeLine.slice("worktree ".length).trim();
            const ref = branchLine.slice("branch ".length).trim();
            if (ref === `refs/heads/${name}`) targets.push(wtPath);
          }
          for (const wt of targets) {
            await run("git", ["-C", activeRepo.repoPath, "worktree", "remove", "--force", wt]);
          }
        }
        await run("git", ["-C", activeRepo.repoPath, "worktree", "prune"]);
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
    // Mark the session as completed so the same issue/linear URL can be
    // re-run after deletion — the frontend validation checks completedAt.
    const repo = getActiveRepo();
    if (repo) {
      const session = await findSessionByBranch(repo.name, branch.name);
      if (session) await updateSession(session.id, { completedAt: Date.now() });
    }
    await removeBranch(branch.id);
    return { ok: true };
  });
}
