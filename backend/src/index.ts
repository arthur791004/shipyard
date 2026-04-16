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
  getSandboxStatus,
  reconcileSandboxState,
  restartSandboxClaude,
  runningSandboxNames,
  sandboxLastActivity,
  startSandbox,
  stopSandbox,
} from "./docker.js";
import { ensureDashboardRunning } from "./dashboard.js";

async function main() {
  await loadState();
  await reconcileSandboxState().catch((err) =>
    console.error("reconcileSandboxState on boot failed:", err)
  );

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
        console.error(
          `[trunk] worktreePath does not exist: ${trunk.worktreePath}\n` +
            `        This usually means .config/state.json is stale from a previous repo layout.\n` +
            `        Re-pick your repo folder in Settings, or delete .config/state.json and restart.`
        );
        await updateBranch(trunkId, {
          status: "error",
          error: `missing worktree: ${trunk.worktreePath}`,
          sandboxName: undefined,
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
    },
  });
  try {
    await branchProxy.listen({ port: config.branchProxyPort, host: "0.0.0.0" });
    app.log.info(`branch proxy listening on :${config.branchProxyPort}`);
  } catch (err) {
    app.log.error({ err }, `failed to bind branch proxy on :${config.branchProxyPort}`);
  }

  startIdleSandboxSweeper(app.log);

  // Rehydrate sandboxes in the background AFTER the server is listening,
  // so the API is responsive immediately and the frontend doesn't get
  // ECONNREFUSED while sandboxes boot (which can take 5-10s each).
  (async () => {
    for (const branch of listAllBranches()) {
      if (isTrunk(branch)) continue;
      const repo = getRepo(branch.repoId);
      if (repo) await ensureSession(repo.name, branch.name).catch(() => {});
      if (branch.status !== "running") continue;
      if (branch.sandboxName) {
        try {
          const vmStatus = await getSandboxStatus(branch.sandboxName);
          if (vmStatus === "running") {
            // VM is still running from a previous backend session. Use
            // exec to start a fresh Claude inside it (not `run` which
            // hangs on an already-running VM).
            await restartSandboxClaude(branch.sandboxName, branch.worktreePath);
            app.log.info(`rehydrated sandbox ${branch.sandboxName} (exec)`);
          } else if (vmStatus === "stopped") {
            // VM exists but is stopped — start it normally.
            await startSandbox(branch.sandboxName, branch.worktreePath, branch.port);
            app.log.info(`rehydrated sandbox ${branch.sandboxName} (start)`);
          } else {
            // VM is missing entirely — mark as stopped.
            await updateBranch(branch.id, { status: "stopped" });
            app.log.info(`sandbox ${branch.sandboxName} missing, marked stopped`);
          }
        } catch (err) {
          app.log.error({ err }, `failed to rehydrate sandbox ${branch.sandboxName}`);
        }
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

    for (const name of runningSandboxNames()) {
      const last = sandboxLastActivity(name);
      if (last == null || now - last < idleMs) continue;
      const branch = listAllBranches().find((b) => b.sandboxName === name);
      if (!branch || isTrunk(branch)) continue;
      log.info(`[${name}] idle >${Math.round(idleMs / 60000)}m, auto-stopping`);
      try {
        await stopSandbox(name, branch.worktreePath);
        await updateBranch(branch.id, { status: "stopped" });
      } catch (err) {
        log.error({ err }, `idle auto-stop(${name}) failed`);
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
