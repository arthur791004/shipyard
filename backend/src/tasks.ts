import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

// Per-branch task history file. One JSONL row per task or summary, appended
// over time. The file lives at <projectRoot>/.tasks/<slug>.jsonl on the host
// and is bind-mounted into every sandbox at the same path, so the seed
// prompt can point Claude at a stable location to pick up context.

export interface TaskEntry {
  type: "task";
  command: "/gh-issue" | "/linear" | "/branch";
  source?: string;
  body?: string;
  port?: number;
  ts: number;
}

export interface SummaryEntry {
  type: "summary";
  text: string;
  ts: number;
}

export type TaskFileEntry = TaskEntry | SummaryEntry;

export function taskFilePath(slug: string): string {
  return path.join(config.tasksDir, `${slug}.jsonl`);
}

export async function ensureTasksDir(): Promise<void> {
  await fsp.mkdir(config.tasksDir, { recursive: true });
}

export async function appendTaskEntry(slug: string, entry: TaskFileEntry): Promise<void> {
  await ensureTasksDir();
  await fsp.appendFile(taskFilePath(slug), JSON.stringify(entry) + "\n", "utf8");
}

// Seed prompt written into the claude PTY at session start. Points Claude
// at the task history file directly — we deliberately don't inject anything
// into the worktree's CLAUDE.md so the checkout stays pristine (no phantom
// diff against the repo). Sandbox rules live in the sandbox user's global
// ~/.claude/CLAUDE.md (see syncSandboxConfig in sandbox.ts).
export function buildSeedPrompt(taskFile: string): string {
  return [
    `Read your task history at \`${taskFile}\`, then start working on the most recent task entry.`,
    "The file is appended over time — re-read it whenever you need more context.",
  ].join(" ");
}

// Inject read-only instructions into trunk's CLAUDE.md so Claude
// doesn't modify files directly on the default branch.
const TRUNK_MARKER = "<!-- shipyard:trunk -->";

export async function injectTrunkClaudeMd(worktreePath: string): Promise<void> {
  const claudeMdPath = path.join(worktreePath, "CLAUDE.md");

  const section = [
    "",
    TRUNK_MARKER,
    "## Shipyard — Trunk (read-only)",
    "",
    "You are running on the trunk branch in read-only mode.",
    "Do NOT modify any files directly on trunk.",
    "",
    "If the user asks you to implement a GitHub issue, Linear ticket,",
    "or make any code changes, you must:",
    "1. Tell them to use `/gh-issue <url>`, `/linear <url>`, or `/branch <name>` to create a task.",
    "2. You can read any file freely — answer questions, explain code, and discuss changes.",
    "",
    "You do NOT have permission to write files, run git commands, or make changes on trunk.",
    TRUNK_MARKER,
  ].join("\n");

  let existing = "";
  try {
    existing = await fsp.readFile(claudeMdPath, "utf8");
  } catch {}

  const markerRegex = new RegExp(
    `\\n?${TRUNK_MARKER}[\\s\\S]*?${TRUNK_MARKER}`,
    "g"
  );
  const cleaned = existing.replace(markerRegex, "");
  await fsp.writeFile(claudeMdPath, cleaned + section, "utf8");
}
