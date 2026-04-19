// Short branch-name generation from a free-form user prompt. Shells out
// to the host's `claude -p` (Claude Code in non-interactive mode), which
// reuses the user's existing OAuth — no ANTHROPIC_API_KEY needed. Returns
// null when the CLI isn't installed, the call fails, times out, or the
// response isn't shaped like a usable kebab-case name; callers fall back
// to a heuristic slug in those cases.

import { spawn } from "node:child_process";

const TIMEOUT_MS = 15_000;
const MAX_INPUT_CHARS = 500;
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+){0,4}$/;

const PROMPT_PREFIX = [
  "You name git branches. Reply with ONLY a kebab-case branch name:",
  "2–4 lowercase words, characters limited to a-z / 0-9 / -, max 24 characters.",
  "No explanation, no quotes, no slashes, no leading or trailing punctuation.",
  "",
  "Task:",
  "",
].join("\n");

function runClaude(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("claude", ["-p", prompt], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let settled = false;
    const done = (val: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      done(null);
    }, TIMEOUT_MS);
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => done(null));
    child.on("close", (code) => done(code === 0 ? out : null));
  });
}

export async function generateBranchName(text: string): Promise<string | null> {
  const input = text.trim().slice(0, MAX_INPUT_CHARS);
  if (!input) return null;
  const raw = await runClaude(PROMPT_PREFIX + input);
  if (!raw) return null;
  const name = raw.trim().toLowerCase();
  if (name.length > 24) return null;
  return NAME_PATTERN.test(name) ? name : null;
}
