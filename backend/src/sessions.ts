import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "./config.js";

interface PrInfo {
  url: string;
  number: number;
}

export interface Session {
  id: string;
  repo: string;
  branch: string;
  issueUrl?: string;
  linearUrl?: string;
  prUrl?: string;
  prNumber?: number;
  summary?: string;
  createdAt: number;
  completedAt?: number;
}

const FILE = path.join(config.dataDir, "sessions.jsonl");

let cache: Session[] | null = null;

async function load(): Promise<Session[]> {
  if (cache) return cache;
  try {
    const raw = await fsp.readFile(FILE, "utf8");
    const rows: Session[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed) as Session);
      } catch {}
    }
    // Fold: later rows with the same id win (updates are stored as appends).
    const byId = new Map<string, Session>();
    for (const row of rows) byId.set(row.id, row);
    cache = [...byId.values()];
  } catch (err: any) {
    if (err?.code !== "ENOENT") console.error("sessions.load failed:", err);
    cache = [];
  }
  return cache;
}

async function appendLine(row: Session): Promise<void> {
  await fsp.mkdir(path.dirname(FILE), { recursive: true });
  await fsp.appendFile(FILE, JSON.stringify(row) + "\n", "utf8");
}

export async function listSessions(): Promise<Session[]> {
  const rows = await load();
  return [...rows].sort((a, b) => b.createdAt - a.createdAt);
}

export async function createSession(
  input: Omit<Session, "id" | "createdAt"> & { id?: string; createdAt?: number }
): Promise<Session> {
  const row: Session = {
    id: input.id ?? randomUUID().slice(0, 8),
    repo: input.repo,
    branch: input.branch,
    issueUrl: input.issueUrl,
    linearUrl: input.linearUrl,
    summary: input.summary,
    createdAt: input.createdAt ?? Date.now(),
    completedAt: input.completedAt,
  };
  const rows = await load();
  rows.push(row);
  await appendLine(row);
  return row;
}

export async function updateSession(
  id: string,
  patch: Partial<Omit<Session, "id" | "createdAt">>
): Promise<Session | null> {
  const rows = await load();
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const next: Session = { ...rows[idx], ...patch, id, createdAt: rows[idx].createdAt };
  rows[idx] = next;
  await appendLine(next);
  return next;
}

// Create a session for (repo, branch) only if one doesn't already exist. Used
// by non-slash-command paths (direct create, toggle-from-git-stub, startup
// backfill) so the UI's unified task list doesn't miss live branches.
export async function ensureSession(repo: string, branch: string): Promise<Session> {
  const rows = await load();
  const existing = rows.find((r) => r.repo === repo && r.branch === branch);
  if (existing) return existing;
  return createSession({ repo, branch });
}

export async function findSessionByBranch(repo: string, branch: string): Promise<Session | null> {
  const rows = await load();
  // Most recent open session for this (repo, branch).
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.repo === repo && r.branch === branch && !r.completedAt) return r;
  }
  return null;
}

// Fetch PR info for a branch using gh CLI. Returns null if no PR exists.
export async function fetchPrInfo(branch: string, cwd: string): Promise<PrInfo | null> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-lc", `gh pr view "${branch}" --json url,number --jq '[.url, .number] | @tsv' 2>/dev/null`], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) return resolve(null);
      try {
        // Output is TSV: url\tnumber
        const [url, numStr] = stdout.trim().split("\t");
        const number = parseInt(numStr, 10);
        if (url && !isNaN(number)) {
          resolve({ url, number });
        } else {
          resolve(null);
        }
      } catch {
        resolve(null);
      }
    });
  });
}

void load();
