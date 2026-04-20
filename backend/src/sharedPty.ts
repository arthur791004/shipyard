import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { IPty } from "node-pty";

interface SharedPty {
  term: IPty;
  buffer: string;
  subscribers: Set<(data: string) => void>;
  logFd?: number;
}

const pool = new Map<string, SharedPty>();
const SCROLLBACK_LIMIT = 100_000;

export interface SharedPtyOptions {
  /** If set, PTY output is appended to this file and the buffer is pre-seeded
   *  from it on startup.  This lets the Logs tab survive backend restarts. */
  logFile?: string;
}

export function ensureSharedPty(key: string, spawn: () => IPty, opts?: SharedPtyOptions): void {
  if (pool.has(key)) return;

  // Pre-seed buffer from log file if it exists
  let buffer = "";
  let logFd: number | undefined;
  if (opts?.logFile) {
    try {
      fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
      buffer = fs.readFileSync(opts.logFile, "utf-8").slice(-SCROLLBACK_LIMIT);
    } catch {}
    try {
      logFd = fs.openSync(opts.logFile, "a");
    } catch {}
  }

  const term = spawn();
  const entry: SharedPty = { term, buffer, subscribers: new Set(), logFd };
  term.onData((data) => {
    entry.buffer = (entry.buffer + data).slice(-SCROLLBACK_LIMIT);
    if (entry.logFd !== undefined) {
      try { fs.writeSync(entry.logFd, data); } catch {}
    }
    for (const sub of entry.subscribers) sub(data);
  });
  term.onExit(() => {
    if (entry.logFd !== undefined) {
      try { fs.closeSync(entry.logFd); } catch {}
    }
    if (pool.get(key) === entry) pool.delete(key);
  });
  pool.set(key, entry);
}

/**
 * Attach to a live shared PTY.  If the PTY is not in the pool but a logFile
 * is provided, replays the log file contents as a one-shot replay (read-only
 * — no write/resize since there's no live PTY).  Returns `null` only when
 * there is no live PTY and no log file to replay from.
 */
export function attachSharedPty(
  key: string,
  onData: (data: string) => void,
  opts?: SharedPtyOptions,
): { unsubscribe: () => void; write: (data: string) => void; resize: (cols: number, rows: number) => void } | null {
  const entry = pool.get(key);
  if (entry) {
    if (entry.buffer) onData(entry.buffer);
    entry.subscribers.add(onData);
    return {
      unsubscribe: () => entry.subscribers.delete(onData),
      write: (data) => entry.term.write(data),
      resize: (cols, rows) => {
        try { entry.term.resize(cols, rows); } catch {}
      },
    };
  }

  // No live PTY — try to replay from log file
  if (opts?.logFile) {
    try {
      const contents = fs.readFileSync(opts.logFile, "utf-8").slice(-SCROLLBACK_LIMIT);
      if (contents) onData(contents);
    } catch {}
  }
  return null;
}

export function killSharedPty(key: string): void {
  const entry = pool.get(key);
  if (!entry) return;
  pool.delete(key);
  if (entry.logFd !== undefined) {
    try { fs.closeSync(entry.logFd); } catch {}
  }
  try { entry.term.kill(); } catch {}
}
