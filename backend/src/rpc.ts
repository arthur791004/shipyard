// File-based RPC bridge between sandboxed Claude and the backend.
//
// The claude sandbox is locked behind an egress proxy that blocks the
// backend's TCP port, so shipyard:sandbox can't call the HTTP API directly.
// Instead the CLI drops request files into a bind-mounted directory and
// this watcher picks them up, replays them against the Fastify handlers via
// app.inject(), and writes response files back.
//
// Protocol (all files in getRpcDir()):
//   <id>.body       — raw body (e.g. commit message), optional
//   <id>.req        — single line "<cmd> <branch_id> <querystring>"
//                     — written last (atomic mv from .tmp), signals readiness
//   <id>.<status>   — raw response body; 3-digit HTTP status in extension
//
// The backend processes <id>.req, writes <id>.<status>, and removes the
// request/body files. The CLI polls for <id>.<status>, prints the body,
// and exits with 0 for 2xx or 22 (mimicking curl) otherwise.

import fsp from "node:fs/promises";
import path from "node:path";
import { FastifyInstance } from "fastify";
import { config } from "./config.js";

const POLL_INTERVAL_MS = 50;
const ALLOWED_CMDS = new Set(["push", "commit"]);

export function getRpcDir(): string {
  // SHIPYARD_RPC_DIR lets tests point at a tmp dir without touching the
  // real .tasks directory. Production uses the default.
  return process.env.SHIPYARD_RPC_DIR ?? path.join(config.tasksDir, "shipyard-rpc");
}

async function processRequest(app: FastifyInstance, id: string): Promise<void> {
  const dir = getRpcDir();
  const reqPath = path.join(dir, `${id}.req`);
  const bodyPath = path.join(dir, `${id}.body`);

  let reqLine: string;
  try {
    reqLine = (await fsp.readFile(reqPath, "utf8")).trim();
  } catch {
    return; // already handled or removed
  }

  const [cmd = "", branchId = "", qs = ""] = reqLine.split(" ");

  let status = 400;
  let responseBody = JSON.stringify({ error: "invalid request" });

  if (!ALLOWED_CMDS.has(cmd) || !branchId) {
    // fall through to write response below
  } else {
    let body = "";
    try {
      body = await fsp.readFile(bodyPath, "utf8");
    } catch {}

    try {
      const url = `/api/branches/${encodeURIComponent(branchId)}/${cmd}${qs ? `?${qs}` : ""}`;
      const res = await app.inject({
        method: "POST",
        url,
        payload: body,
        headers: body ? { "content-type": "text/plain" } : undefined,
      });
      status = res.statusCode;
      responseBody = res.body;
    } catch (err: any) {
      status = 500;
      responseBody = JSON.stringify({ error: err?.message ?? "rpc error" });
    }
  }

  const resPath = path.join(dir, `${id}.${status}`);
  const tmpPath = `${resPath}.tmp`;
  await fsp.writeFile(tmpPath, responseBody);
  await fsp.rename(tmpPath, resPath);

  await fsp.unlink(reqPath).catch(() => {});
  await fsp.unlink(bodyPath).catch(() => {});
}

export async function startRpcWatcher(app: FastifyInstance): Promise<() => void> {
  const dir = getRpcDir();
  await fsp.mkdir(dir, { recursive: true });

  const inFlight = new Set<string>();

  async function tick(): Promise<void> {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.endsWith(".req")) continue;
      const id = name.slice(0, -".req".length);
      if (inFlight.has(id)) continue;
      inFlight.add(id);
      processRequest(app, id)
        .catch((err) => app.log.error({ err }, `rpc process ${id} failed`))
        .finally(() => inFlight.delete(id));
    }
  }

  // Pick up any requests that landed while the backend was down.
  tick();
  const timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref?.();

  return () => clearInterval(timer);
}
