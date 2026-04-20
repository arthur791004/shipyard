import fsp from "node:fs/promises";
import Fastify from "fastify";
import cors from "@fastify/cors";
import httpProxy from "@fastify/http-proxy";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import {
  loadState,
  getActiveBranchId,
  getBranch,
  getRepo,
  listAllBranches,
  updateBranch,
  getActiveRepo,
  trunkBranchId,
  isTrunk,
} from "./state.js";
import { ensureSession } from "./sessions.js";
import { registerRoutes } from "./routes.js";
import { registerTerminal } from "./terminal.js";
import {
  ensureRepoSandbox,
  markShuttingDown,
  reconcileSandboxState,
  runningBranchIds,
  sessionLastActivity,
  startBranchSession,
  stopBranchSession,
} from "./sandbox.js";
import { ensureDashboardRunning } from "./dashboard.js";
import { buildSeedPrompt, taskFilePath } from "./tasks.js";

async function main() {
  await loadState();
  await reconcileSandboxState().catch((err) =>
    console.error("reconcileSandboxState on boot failed:", err)
  );

  // Trunk runs on the host (no sandbox, no --dangerously-skip-permissions).
  const activeRepo = getActiveRepo();
  if (activeRepo) {
    const trunkId = trunkBranchId(activeRepo.id);
    const trunk = getBranch(trunkId);
    if (trunk) {
      const trunkOk = await fsp
        .access(trunk.worktreePath)
        .then(() => true)
        .catch(() => false);
      if (!trunkOk) {
        await updateBranch(trunkId, {
          status: "error",
          error: `missing worktree: ${trunk.worktreePath}`,
        });
      } else {
        ensureDashboardRunning(trunk.worktreePath, trunk.port).catch((err) =>
          console.error("failed to rehydrate trunk dashboard:", err)
        );
        await updateBranch(trunkId, { status: "running", sandboxName: undefined });
      }
    }
  }

  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(websocket);
  await registerRoutes(app);
  await registerTerminal(app);

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/preview")) return;
    const id = getActiveBranchId();
    const branch = id ? getBranch(id) : undefined;
    if (!branch) {
      reply
        .code(503)
        .type("text/html")
        .send(
          `<h3>No active branch</h3><p>Click <strong>Visit</strong> on a branch to route <code>/preview/</code> to its dashboard.</p>`
        );
    }
  });

  await app.register(httpProxy, {
    upstream: "",
    prefix: "/preview",
    rewritePrefix: "",
    replyOptions: {
      getUpstream: () => {
        const id = getActiveBranchId();
        const branch = id ? getBranch(id) : undefined;
        if (!branch) return `http://127.0.0.1:${config.proxyTargetPortFallback}`;
        return `http://127.0.0.1:${branch.port}`;
      },
      onError: (reply: any, _details: any) => {
        reply.code(503).type("text/html").send(
          `<h3>Dashboard not ready</h3><p>The dev server is still starting inside the sandbox. Refresh in a moment.</p>`
        );
      },
    },
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`backend listening on :${config.port}`);

  const branchProxy = Fastify({ logger: false });
  await branchProxy.register(httpProxy, {
    upstream: "",
    websocket: true,
    replyOptions: {
      getUpstream: () => {
        const id = getActiveBranchId();
        const branch = id ? getBranch(id) : undefined;
        if (!branch) return `http://127.0.0.1:${config.proxyTargetPortFallback}`;
        return `http://127.0.0.1:${branch.port}`;
      },
      rewriteRequestHeaders: (req, headers) => ({
        ...headers,
        host: req.headers.host ?? headers.host,
      }),
      rewriteHeaders: (headers: any) => {
        // Strip X-Frame-Options so the preview can be embedded in an iframe
        delete headers["x-frame-options"];
        return headers;
      },
      onError: (reply: any, _details: any) => {
        reply.code(503).type("text/html").send(
          `<h3>Dashboard not ready</h3><p>The dev server is still starting inside the sandbox. Refresh in a moment.</p>`
        );
      },
    },
  });
  try {
    await branchProxy.listen({ port: config.branchProxyPort, host: "0.0.0.0" });
    app.log.info(`branch proxy listening on :${config.branchProxyPort}`);
  } catch (err) {
    app.log.error({ err }, `failed to bind branch proxy on :${config.branchProxyPort}`);
  }

  startIdleSandboxSweeper(app.log);

  // v2: Rehydrate in background. Ensure repo sandboxes exist, then
  // restart branch sessions for branches that were running.
  (async () => {
    // First pass: ensure each repo's sandbox is up
    const seenRepos = new Set<string>();
    for (const branch of listAllBranches()) {
      const repo = getRepo(branch.repoId);
      if (!repo || seenRepos.has(repo.id)) continue;
      seenRepos.add(repo.id);
      if (repo.sandboxName) {
        try {
          await ensureRepoSandbox(repo);
          app.log.info(`repo sandbox ${repo.sandboxName} ready`);
        } catch (err) {
          app.log.error({ err }, `failed to ensure repo sandbox ${repo.sandboxName}`);
        }
      }
    }

    // Second pass: restart branch sessions
    for (const branch of listAllBranches()) {
      if (isTrunk(branch)) continue;
      const repo = getRepo(branch.repoId);
      if (repo) await ensureSession(repo.name, branch.name).catch(() => {});
      if (branch.status !== "running" || !repo?.sandboxName) continue;

      try {
        const folderSlug = branch.worktreePath.split("/").pop() || branch.id;
        const fs = await import("node:fs/promises");
        let seed: string | undefined;
        try {
          await fs.access(taskFilePath(folderSlug));
          seed = buildSeedPrompt(taskFilePath(folderSlug));
        } catch {}

        await startBranchSession(branch.id, repo.sandboxName, branch.worktreePath, branch.port, seed);
        app.log.info(`rehydrated branch session ${branch.name}`);
      } catch (err) {
        app.log.error({ err }, `failed to rehydrate branch ${branch.name}`);
        await updateBranch(branch.id, { status: "stopped" }).catch(() => {});
      }
    }
  })();
}

// Periodically stop idle sandboxes and flag stuck creates.
//
// Two sweeps on the same tick:
//  1. Idle stop — running PTY with no activity for > sandboxIdleMs.
//  2. Stuck create — branch sitting in status="creating" for > 5 min,
//     including branches orphaned by a mid-create backend crash. Marked
//     as "error" so the user can see and delete them.
//
// Trunks are skipped in both passes.
function startIdleSandboxSweeper(log: { info: (msg: string) => void; error: (obj: unknown, msg?: string) => void }) {
  const idleMs = config.sandboxIdleMs;
  const stuckCreateMs = 5 * 60 * 1000;
  if (idleMs <= 0) return;
  const interval = setInterval(async () => {
    const now = Date.now();

    // v2: check branch sessions (keyed by branchId)
    for (const branchId of runningBranchIds()) {
      const last = sessionLastActivity(branchId);
      if (last == null || now - last < idleMs) continue;
      const branch = listAllBranches().find((b) => b.id === branchId);
      if (!branch || isTrunk(branch)) continue;
      log.info(`[${branch.name}] idle >${Math.round(idleMs / 60000)}m, auto-stopping`);
      try {
        await stopBranchSession(branchId);
        await updateBranch(branch.id, { status: "stopped" });
      } catch (err) {
        log.error({ err }, `idle auto-stop(${branch.name}) failed`);
      }
    }

    for (const branch of listAllBranches()) {
      if (isTrunk(branch)) continue;
      if (branch.status !== "creating") continue;
      if (now - branch.createdAt < stuckCreateMs) continue;
      log.info(`[${branch.id}] stuck in "creating" for >${Math.round(stuckCreateMs / 60000)}m, marking as error`);
      try {
        await updateBranch(branch.id, { status: "error", error: "startup stalled" });
      } catch (err) {
        log.error({ err }, `stuck-create flag(${branch.id}) failed`);
      }
    }
  }, config.idleSweeperIntervalMs);
  interval.unref?.();
}

// Flip the sandbox shutdown flag on any graceful-exit signal so the PTY
// `onExit` handlers don't mark still-running branches as stopped. Without
// this, `tsx watch` reloads (and any SIGTERM from a process supervisor)
// would leave every branch session stranded in `stopped` state across
// restarts. We call `process.exit` ourselves because registering a signal
// handler suppresses Node's default exit-on-signal behavior — omitting
// the exit would block tsx-watch until it escalates to SIGKILL.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(sig, () => {
    markShuttingDown();
    process.exit(0);
  });
}
process.on("beforeExit", () => markShuttingDown());

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
