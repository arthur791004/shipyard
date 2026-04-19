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

// Inject a task section into the worktree's CLAUDE.md so Claude reads it
// automatically on startup. Appends a fenced section at the end; if the
// file already has our marker, it replaces the section in-place.
const TASK_MARKER = "<!-- shipyard:task -->";

export async function injectTaskIntoClaudeMd(
  worktreePath: string,
  slug: string
): Promise<void> {
  const claudeMdPath = path.join(worktreePath, "CLAUDE.md");
  const taskFile = taskFilePath(slug);

  const section = [
    "",
    TASK_MARKER,
    "## Current Task",
    "",
    `Your task history file is at \`${taskFile}\`.`,
    "Read it, then start working on the most recent task entry.",
    "The file is appended over time — re-read it whenever you need context.",
    "",
    "## Sandbox rules",
    "",
    "Git writes go through the host — use these commands:",
    "",
    "- **Commit**: `shipyard:sandbox commit -m \"msg\"` stages everything and commits. Add `--amend` (with or without `-m`) to fix the previous commit.",
    "- **Push**: `shipyard:sandbox push` pushes the current branch to origin.",
    "- **Open a PR**: also `shipyard:sandbox push` — it runs `gh pr create --fill` on the first push, or returns the existing PR URL on subsequent pushes.",
    "- Do NOT run `git commit`, `git push`, or `gh pr create` directly.",
    "- You CAN run `yarn install` and start the dev server if you need to test changes.",
    "- The host forwards your sandbox port to the browser automatically.",
    TASK_MARKER,
  ].join("\n");

  let existing = "";
  try {
    existing = await fsp.readFile(claudeMdPath, "utf8");
  } catch {}

  const markerRegex = new RegExp(
    `\\n?${TASK_MARKER}[\\s\\S]*?${TASK_MARKER}`,
    "g"
  );
  const cleaned = existing.replace(markerRegex, "");
  await fsp.writeFile(claudeMdPath, cleaned + section, "utf8");
}

// Short nudge for PTY injection — just tells Claude to start. The real
// context comes from CLAUDE.md and the task file.
export function buildSeedPrompt(): string {
  return "Read CLAUDE.md and start working on the task.";
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
