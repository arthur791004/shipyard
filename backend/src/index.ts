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
  listAllBranches,
  updateBranch,
  getActiveRepo,
  trunkBranchId,
  isTrunk,
} from "./state.js";
import { registerRoutes } from "./routes.js";
import { registerTerminal } from "./terminal.js";
import { startSandbox } from "./docker.js";
import { ensureDashboardRunning } from "./dashboard.js";

async function main() {
  await loadState();

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

  for (const branch of listAllBranches()) {
    if (isTrunk(branch)) continue;
    if (branch.status !== "running") continue;
    if (branch.sandboxName) {
      try {
        await startSandbox(branch.sandboxName, branch.worktreePath, branch.port);
      } catch (err) {
        console.error(`failed to rehydrate sandbox ${branch.sandboxName}:`, err);
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
