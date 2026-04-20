// Single source of truth for the slash-command catalogue. Used by
// CommandInput.tsx (autocomplete menu, chips, input validation) and
// Welcome.tsx (first-run help bullets). Adding a new command is one
// entry here.

import { Branch, Session } from "./api";

export interface CommandDef {
  /** The verb including the leading slash, e.g. "/branch". */
  verb: string;
  /** Typed prefix that switches the input into command mode. */
  prefix: string;
  /** Shown in the autocomplete menu + Welcome help; includes arg syntax. */
  usage: string;
  /** Shown as the autocomplete menu description + chip tooltip + Welcome bullet body. */
  desc: string;
  /** Short noun shown on the one-click chip row under the input. */
  chip: string;
  /**
   * Validate a parsed command invocation in the context of the current
   * branches + sessions. Return an error message to block submission,
   * or null when the command is good to fire.
   */
  validate: (
    parts: string[],
    ctx: { branches: Branch[]; sessions: Session[] },
  ) => string | null;
}

export const COMMANDS: CommandDef[] = [
  {
    verb: "/gh-issue",
    prefix: "/gh-issue ",
    usage: "/gh-issue <url>",
    desc: "Claude implements a GitHub issue",
    chip: "GitHub issue",
    validate: (parts, { branches, sessions }) => {
      const url = parts[1];
      if (!url) return "Usage: /gh-issue <url>";
      const m = url.match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/);
      if (!m) return "Not a GitHub issue URL";
      if (sessions.some((s) => s.issueUrl === url && !s.completedAt)) {
        return "Already running for this issue";
      }
      const derivedName = `issue-${m[1]}`;
      if (branches.some((b) => !b.isTrunk && b.name === derivedName)) {
        return `Branch "${derivedName}" already exists`;
      }
      return null;
    },
  },
  {
    verb: "/linear",
    prefix: "/linear ",
    usage: "/linear <url>",
    desc: "Claude implements a Linear ticket",
    chip: "Linear ticket",
    validate: (parts, { branches, sessions }) => {
      const url = parts[1];
      if (!url) return "Usage: /linear <url>";
      const m = url.match(/linear\.app\/[^/]+\/issue\/([A-Za-z]+-\d+)/);
      if (!m) return "Not a Linear issue URL";
      if (sessions.some((s) => s.linearUrl === url && !s.completedAt)) {
        return "Already running for this ticket";
      }
      const derivedName = m[1].toLowerCase();
      if (branches.some((b) => !b.isTrunk && b.name === derivedName)) {
        return `Branch "${derivedName}" already exists`;
      }
      return null;
    },
  },
  {
    verb: "/branch",
    prefix: "/branch ",
    usage: "/branch <name> [base]",
    desc: "open any branch — new for a task, or existing to continue/test",
    chip: "Branch",
    validate: (parts, { branches }) => {
      const name = parts[1];
      if (!name) return "Usage: /branch <name> [base]";
      if (branches.some((b) => !b.isTrunk && b.name === name)) {
        return `Branch "${name}" already exists`;
      }
      return null;
    },
  },
];

export function findCommand(verb: string): CommandDef | undefined {
  return COMMANDS.find((c) => c.verb === verb);
}
