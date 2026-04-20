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
  DEFAULT_DASHBOARD_INSTALL_CMD,
} from "./state.js";
import { createWorktree, deleteBranch as deleteGitBranch, detectDefaultBranch, listGitBranches, removeWorktree } from "./worktree.js";
import { run, runOrThrow } from "./shell.js";
import {
  ensureRepoSandbox,
  repoSandboxName,
  getSandboxStatus,
  removeRepoSandbox,
  restartBranchSession,
  startBranchSession,
  stopBranchSession,
  sandboxLogs,
} from "./sandbox.js";
import { createSession, ensureSession, findSessionByBranch, listSessions, updateSession } from "./sessions.js";
import { appendTaskEntry, buildSeedPrompt, injectTrunkClaudeMd, taskFilePath, TaskEntry } from "./tasks.js";
import { generateBranchName } from "./llm.js";

import { classifyFreeForm, firstNWords, slugify, uniqueBranchName as uniqueFromSet } from "./routeHelpers.js";

const TASK_INSTRUCTIONS = [
  "## Instructions",
  "",
  "1. Read the context above carefully.",
  "2. Plan the implementation — keep changes focused and minimal.",
  "3. Implement the changes and verify with relevant tests.",
  "4. Commit with a clear message using `shipyard:sandbox commit -m \"msg\"`.",
  "5. When ready, push + open/refresh the PR with `shipyard:sandbox push`.",
].join("\n");

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Accept raw commit messages as text/plain bodies from shipyard:sandbox commit.
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });

  async function cloneRepo(repoPath: string, sourceRepo: string, branch: string): Promise<void> {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(repoPath), { recursive: true });
    try {
      const stat = await fs.lstat(repoPath);
      if (stat.isSymbolicLink() || stat.isDirectory() || stat.isFile()) {
        await fs.rm(repoPath, { recursive: true, force: true });
      }
    } catch {}
    // --local uses hardlinks for objects (fast, no extra disk for .git).
    // --branch ensures we clone the default branch regardless of what
    // the source repo currently has checked out.
    await runOrThrow("git", ["clone", "--local", "--branch", branch, sourceRepo, repoPath]);
    // The clone's origin points to the local checkout. Add the real
    // remote so `git fetch` / `git pull` gets latest from GitHub.
    const upstreamRes = await run("git", ["-C", sourceRepo, "remote", "get-url", "origin"]);
    if (upstreamRes.code === 0 && upstreamRes.stdout.trim()) {
      const upstream = upstreamRes.stdout.trim();
      await run("git", ["-C", repoPath, "remote", "set-url", "origin", upstream]);
      // Keep the local checkout as a named remote for fast local fetches.
      await run("git", ["-C", repoPath, "remote", "add", "local", sourceRepo]);
    }
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

  app.put<{ Body: Partial<{ repoUrl: string; configured: boolean; pushDryRun: boolean }> }>(
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
      await cloneRepo(repoPath, cleaned, defaultBranch);
    } catch (err: any) {
      return reply.code(500).send({ error: `Failed to clone repo: ${err.message}` });
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
    // Inject read-only instructions into trunk's CLAUDE.md
    await injectTrunkClaudeMd(repoPath).catch(() => {});

    // Create the single sandbox for this repo (v2: one sandbox per repo)
    const sbName = repoSandboxName(repo);
    repo.sandboxName = sbName;
    await addRepo(repo, true);

    // Return immediately. Sandbox creation + yarn install + dashboard
    // start all run in the background.
    (async () => {
      try {
        await ensureRepoSandbox(repo);
        await updateRepo(repo.id, { sandboxName: sbName });
        console.log(`[${name}] repo sandbox ${sbName} ready`);
      } catch (err) {
        console.error(`[${name}] sandbox creation failed:`, err);
      }

      // Install deps on the host (fast, cached)
      const install = dashboardInstallCmd?.trim() || DEFAULT_DASHBOARD_INSTALL_CMD;
      try {
        console.log(`[${name}] running ${install} on host...`);
        await runOrThrow("/bin/sh", ["-lc", install], { cwd: repoPath });
      } catch (err) {
        console.error(`[${name}] install failed:`, err);
      }

      // Start trunk dashboard on the host
      const trunk = getBranch(trunkBranchId(repo.id));
      if (trunk) {
        try {
          await ensureDashboardRunning(trunk.worktreePath, trunk.port);
          await updateBranch(trunk.id, { status: "running" });
        } catch (err) {
          console.error(`[${name}] dashboard failed:`, err);
        }
      }
    })();

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

    // v2: remove the single repo sandbox (kills all branch sessions)
    if (repo.sandboxName) {
      await removeRepoSandbox(repo.sandboxName).catch(() => {});
    }
    for (const branch of Object.values(listBranchesForRepo(repo.id))) {
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
        'POSIX path of (choose folder with prompt "Select repo folder")',
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
        port,
        ts: Date.now(),
      });
    }

    try {
      const worktreePath = await createWorktree(folderSlug, branchName, base);

      // v2: use the repo's single sandbox (no per-branch sandbox).
      // Sandbox rules live in the agent user's ~/.claude/CLAUDE.md (written
      // by ensureRepoSandbox → syncSandboxConfig), so we don't touch the
      // worktree's CLAUDE.md at all. Per-branch task context rides on the
      // seed prompt pointing at the task history file.
      const repo = getActiveRepo()!;
      const sbName = repo.sandboxName || repoSandboxName(repo);
      await ensureRepoSandbox(repo);
      const seed = taskEntry ? buildSeedPrompt(taskFilePath(folderSlug)) : undefined;
      await startBranchSession(id, sbName, worktreePath, port, seed);
      await updateBranch(id, { worktreePath, status: "running" });

      // Note: yarn install is NOT run for branch worktrees — they share
      // node_modules with the trunk clone. Running it would cause EEXIST
      // symlink conflicts. Install only runs once on repo creation.
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

  function uniqueBranchName(base: string): string {
    return uniqueFromSet(base, new Set(listBranches().map((b) => b.name)));
  }

  async function createGhIssueBranch(url: string, userNote?: string): Promise<Branch> {
    const m = url.match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/);
    const branchName = m ? `issue-${m[1]}` : `issue-${Date.now()}`;
    const repo = getActiveRepo();
    if (!repo) throw new Error("no active repo");

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
    if (userNote) sections.push(`## User note\n\n${userNote}`);
    if (issueTitle || issueBody) {
      sections.push(`## Issue: ${issueTitle || url}\n\n${issueBody}`);
    } else {
      sections.push(`## Issue\n\nURL: ${url}\n\n(Could not pre-fetch issue content. Read the issue at the URL above.)`);
    }
    if (issueComments.trim()) {
      sections.push(`## Comments\n\n${issueComments}`);
    }
    sections.push(TASK_INSTRUCTIONS);

    const branch = await createBranchFlow(branchName, undefined, {
      command: "/gh-issue",
      source: url,
      body: sections.join("\n\n"),
    });
    await createSession({ repo: repo.name, branch: branch.name, issueUrl: url });
    return branch;
  }

  async function createLinearBranch(url: string, userNote?: string): Promise<Branch> {
    const m = url.match(/linear\.app\/[^/]+\/issue\/([A-Za-z]+-\d+)/);
    if (!m) throw new Error("not a Linear issue URL");
    const identifier = m[1];
    const branchName = identifier.toLowerCase();

    let ticketTitle = "";
    let ticketBody = "";
    const linearApiKey = process.env.LINEAR_API_KEY;
    if (linearApiKey) {
      try {
        const query = JSON.stringify({
          query: `{ issue(id: "${identifier}") { title description } }`,
        });
        const res = await run("curl", [
          "-s", "-X", "POST",
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
    if (userNote) sections.push(`## User note\n\n${userNote}`);
    if (ticketTitle || ticketBody) {
      sections.push(`## ${identifier}: ${ticketTitle}\n\n${ticketBody}`);
    } else {
      sections.push(`## Linear ticket: ${identifier}\n\nURL: ${url}\n\n(Set LINEAR_API_KEY to pre-fetch ticket content, or read it at the URL above.)`);
    }
    sections.push(TASK_INSTRUCTIONS);

    const branch = await createBranchFlow(branchName, undefined, {
      command: "/linear",
      source: url,
      body: sections.join("\n\n"),
    });
    const repo = getActiveRepo();
    if (repo) await createSession({ repo: repo.name, branch: branch.name, linearUrl: url });
    return branch;
  }

  async function createChatBranch(text: string): Promise<Branch> {
    // Prefer a short LLM-generated name, fall back to a heuristic slug of
    // the first few words when the API key is missing or the call fails.
    let name = await generateBranchName(text).catch(() => null);
    if (!name) name = slugify(firstNWords(text, 5)) || "chat";
    name = uniqueBranchName(name);

    const branch = await createBranchFlow(name, undefined, {
      command: "/chat",
      body: text,
    });
    const repo = getActiveRepo();
    if (repo) await createSession({ repo: repo.name, branch: branch.name });
    return branch;
  }

  async function handleFreeForm(
    text: string,
  ): Promise<{ kind: "chat" | "issue" | "linear"; branch: Branch }> {
    const route = classifyFreeForm(text);
    if (route.kind === "issue") {
      return { kind: "issue", branch: await createGhIssueBranch(route.url, route.userNote) };
    }
    if (route.kind === "linear") {
      return { kind: "linear", branch: await createLinearBranch(route.url, route.userNote) };
    }
    return { kind: "chat", branch: await createChatBranch(text) };
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
    if (!raw) return reply.code(400).send({ error: "empty command" });

    // Free-form: anything not starting with "/" is a natural-language
    // prompt. Auto-route pasted GH/Linear URLs, otherwise generate a
    // short branch name with Haiku and hand the text to the sandbox as
    // the task.
    if (!raw.startsWith("/")) {
      try {
        return await handleFreeForm(raw);
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
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
      try {
        const branch = await createGhIssueBranch(url);
        return { kind: "issue", branch };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }

    if (verb === "linear") {
      const url = rest[0];
      if (!url) return reply.code(400).send({ error: "/linear <url>" });
      try {
        const branch = await createLinearBranch(url);
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
        const sbName = activeRepo.sandboxName || repoSandboxName(activeRepo);
        await ensureRepoSandbox(activeRepo);
        await startBranchSession(id, sbName, worktreePath, port);
        await updateBranch(id, { worktreePath, status: "running" });
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

    const repo = getRepo(branch.repoId);
    if (!repo) return reply.code(400).send({ error: "repo not found" });
    if (!repo.sandboxName) {
      repo.sandboxName = repoSandboxName(repo);
      await updateRepo(repo.id, { sandboxName: repo.sandboxName });
    }

    if (branch.status === "running") {
      await stopBranchSession(branch.id);
      await updateBranch(branch.id, { status: "stopped" });
      return getBranch(branch.id);
    }

    await updateBranch(branch.id, { status: "starting" });
    try {
      await ensureRepoSandbox(repo);
      await startBranchSession(branch.id, repo.sandboxName, branch.worktreePath, branch.port);
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
    const repo = getRepo(branch.repoId);
    if (!repo) return reply.code(400).send({ error: "repo not found" });
    if (!repo.sandboxName) {
      repo.sandboxName = repoSandboxName(repo);
      await updateRepo(repo.id, { sandboxName: repo.sandboxName });
    }
    const hard = req.query.hard === "1";

    const folderSlug = slugify(branch.name) || branch.id;
    let seed: string | undefined;
    try {
      const fs = await import("node:fs/promises");
      await fs.access(taskFilePath(folderSlug));
      seed = buildSeedPrompt(taskFilePath(folderSlug));
    } catch {}

    await updateBranch(branch.id, { status: "restarting" });
    try {
      if (hard) {
        // Hard restart: rebuild the repo sandbox from scratch
        await removeRepoSandbox(repo.sandboxName);
        await ensureRepoSandbox(repo);
      }
      await restartBranchSession(branch.id, repo.sandboxName, branch.worktreePath, branch.port, seed);
      await updateBranch(branch.id, { status: "running", error: undefined });
      return { ok: true };
    } catch (err: any) {
      console.error(`restart(${branch.id}) failed:`, err);
      await updateBranch(branch.id, { status: "error", error: err.message }).catch(() => {});
      return reply.code(500).send({ error: `restart failed: ${err.message}` });
    }
  });

  app.post<{
    Params: { id: string };
    Querystring: { dryRun?: string };
    Body: string;
  }>("/api/branches/:id/push", async (req, reply) => {
    const branch = getBranch(req.params.id);
    if (!branch) return reply.code(404).send({ error: "not found" });
    if (isTrunk(branch)) return reply.code(400).send({ error: "cannot push trunk" });
    if (!branch.worktreePath) return reply.code(400).send({ error: "no worktree" });

    // Title for the PR is passed as an HTTP header (ASCII-safe). Body is
    // the request's text/plain body. Either can be empty — when both are
    // provided we create the PR with exactly those; otherwise we fall
    // back to `gh pr create --fill` (title/body derived from the commit).
    const titleHeader = req.headers["x-shipyard-title"];
    const title = (Array.isArray(titleHeader) ? titleHeader[0] : titleHeader)?.toString().trim() ?? "";
    const body = typeof req.body === "string" ? req.body : "";

    // Test/CI escape hatch: skip the real git/gh invocations and return a
    // synthetic PR URL. Triggered either per-request (?dryRun=1 from the
    // CLI's --dry-run / SHIPYARD_PUSH_DRYRUN env) or globally via the
    // Settings.pushDryRun toggle — the latter lets devs test the full
    // "Claude builds → commits → pushes" flow without touching origin.
    const globalDryRun = getSettings().pushDryRun === true;
    const dryRun = req.query?.dryRun === "1" || globalDryRun;
    if (dryRun) {
      app.log.info(`[push:dry-run] branch=${branch.name} worktree=${branch.worktreePath} title=${title ? "set" : "unset"} body=${body ? body.length : 0} source=${globalDryRun ? "global-setting" : "request"}`);
      return {
        url: `dry-run://branches/${branch.id}/pr`,
        created: false,
        dryRun: true,
        source: globalDryRun ? "setting" : "request",
        title: title || undefined,
        body: body || undefined,
      };
    }

    // Push from the host (where SSH keys and gh auth are available).
    try {
      await runOrThrow("git", ["push", "-u", "origin", branch.name], {
        cwd: branch.worktreePath,
      });
    } catch (err: any) {
      return reply.code(500).send({ error: `git push failed: ${err.message}` });
    }

    // Check if a PR already exists for this branch.
    const existing = await run("gh", ["pr", "view", "--json", "url", "--jq", ".url"], {
      cwd: branch.worktreePath,
    });
    if (existing.code === 0 && existing.stdout.trim()) {
      const url = existing.stdout.trim();
      // If Claude passed a fresh title + body, update the existing PR so
      // its description reflects the latest state of the branch. A bare
      // `shipyard:sandbox push` (no title, no body) leaves the PR body
      // untouched, which is the right default when you just want to push
      // new commits without rewriting the description.
      if (title && body) {
        try {
          await runOrThrow("gh", ["pr", "edit", "--title", title, "--body", body], {
            cwd: branch.worktreePath,
          });
          return { url, created: false, updated: true };
        } catch (err: any) {
          return reply.code(500).send({ error: `gh pr edit failed: ${err.message}` });
        }
      }
      return { url, created: false };
    }

    // Create a new PR. If Claude provided both title + body (following the
    // repo's PR template), use them. Otherwise fall back to --fill (title
    // and body from the commit message).
    const createArgs = title && body
      ? ["pr", "create", "--title", title, "--body", body]
      : ["pr", "create", "--fill"];
    try {
      const url = (
        await runOrThrow("gh", createArgs, { cwd: branch.worktreePath })
      ).trim();
      return { url, created: true };
    } catch (err: any) {
      return reply.code(500).send({ error: `gh pr create failed: ${err.message}` });
    }
  });

  // Host-mediated commit — the bind-mounted worktree's git index can't be
  // safely written from inside the sandbox (cross-version format mismatch
  // with the host). Claude calls this via `shipyard:sandbox commit` instead.
  app.post<{ Params: { id: string }; Querystring: { amend?: string }; Body: string }>(
    "/api/branches/:id/commit",
    async (req, reply) => {
      const branch = getBranch(req.params.id);
      if (!branch) return reply.code(404).send({ error: "not found" });
      if (isTrunk(branch)) return reply.code(400).send({ error: "cannot commit to trunk" });
      if (!branch.worktreePath) return reply.code(400).send({ error: "no worktree" });

      const amend = req.query?.amend === "1";
      const message = typeof req.body === "string" ? req.body : "";
      if (!amend && !message) {
        return reply.code(400).send({ error: "commit message required" });
      }

      try {
        await runOrThrow("git", ["add", "-A"], { cwd: branch.worktreePath });
      } catch (err: any) {
        return reply.code(500).send({ error: `git add failed: ${err.message}` });
      }

      const commitArgs = ["commit"];
      if (amend) commitArgs.push("--amend");
      if (message) commitArgs.push("-m", message);
      else if (amend) commitArgs.push("--no-edit");

      try {
        await runOrThrow("git", commitArgs, { cwd: branch.worktreePath });
      } catch (err: any) {
        return reply.code(500).send({ error: `git commit failed: ${err.message}` });
      }

      try {
        const sha = (await runOrThrow("git", ["rev-parse", "HEAD"], { cwd: branch.worktreePath })).trim();
        const subject = (await runOrThrow("git", ["log", "-1", "--format=%s"], { cwd: branch.worktreePath })).trim();
        return { sha, message: subject };
      } catch (err: any) {
        return reply.code(500).send({ error: `failed to read HEAD: ${err.message}` });
      }
    }
  );

  // Look up the PR URL (if any) for this branch by asking gh. Returns
  // { url: null } when the branch hasn't been pushed yet or there's no
  // associated PR on the remote.
  app.get<{ Params: { id: string } }>("/api/branches/:id/pr", async (req, reply) => {
    const branch = getBranch(req.params.id);
    if (!branch) return reply.code(404).send({ error: "not found" });
    if (isTrunk(branch) || !branch.worktreePath) return { url: null };
    try {
      const res = await run("gh", ["pr", "view", "--json", "url", "--jq", ".url"], {
        cwd: branch.worktreePath,
      });
      const url = res.code === 0 ? res.stdout.trim() : "";
      return { url: url || null };
    } catch {
      return { url: null };
    }
  });

  // Pull latest changes from origin into the clone's default branch.
  app.post<{ Params: { id: string } }>("/api/repos/:id/sync", async (req, reply) => {
    const repo = getRepo(req.params.id);
    if (!repo) return reply.code(404).send({ error: "repo not found" });
    try {
      // Fetch from origin (the real remote, e.g. GitHub)
      await runOrThrow("git", ["-C", repo.repoPath, "fetch", "origin"]);
      // Also fetch from the local checkout for any unpushed local work
      await run("git", ["-C", repo.repoPath, "fetch", "local"]);
      // Fast-forward the default branch
      await runOrThrow("git", ["-C", repo.repoPath, "pull", "--ff-only", "origin", repo.defaultBranch]);
      return { ok: true };
    } catch (err: any) {
      return reply.code(500).send({ error: `sync failed: ${err.message}` });
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
    await stopBranchSession(branch.id).catch(() => {});
    if (branch.worktreePath) await removeWorktree(branch.worktreePath).catch(() => {});
    if (branch.name) await deleteGitBranch(branch.name).catch(() => {});
    const repo = getActiveRepo();
    if (repo) {
      const session = await findSessionByBranch(repo.name, branch.name);
      if (session) await updateSession(session.id, { completedAt: Date.now() });
    }
    await removeBranch(branch.id);
    return { ok: true };
  });
}
