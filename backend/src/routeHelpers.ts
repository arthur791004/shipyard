// Pure helpers shared by routes.ts and its tests. Keep this module
// side-effect-free so tests can import it without booting Fastify.

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function firstNWords(text: string, n: number): string {
  return text.trim().split(/\s+/).slice(0, n).join(" ");
}

// Shared URL regexes — /gh-issue and /linear verbs validate against these,
// and the free-form handler scans pasted text for them to auto-route.
export const GH_ISSUE_URL = /https?:\/\/[^\s]*github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/i;
export const LINEAR_ISSUE_URL = /https?:\/\/[^\s]*linear\.app\/[^/\s]+\/issue\/[A-Za-z]+-\d+/i;

export type FreeFormRoute =
  | { kind: "issue"; url: string; userNote?: string }
  | { kind: "linear"; url: string; userNote?: string }
  | { kind: "chat" };

/**
 * Decide how to route a free-form prompt. If the text contains a GH issue
 * URL or Linear ticket URL, we route through that verb's flow (preserving
 * any surrounding text as a user note). Otherwise it's a chat — the caller
 * is responsible for generating a branch name.
 */
export function classifyFreeForm(text: string): FreeFormRoute {
  const gh = text.match(GH_ISSUE_URL);
  if (gh) {
    const url = gh[0];
    const userNote = text.replace(url, "").trim();
    return { kind: "issue", url, userNote: userNote || undefined };
  }
  const linear = text.match(LINEAR_ISSUE_URL);
  if (linear) {
    const url = linear[0];
    const userNote = text.replace(url, "").trim();
    return { kind: "linear", url, userNote: userNote || undefined };
  }
  return { kind: "chat" };
}

/**
 * Pick a branch name that's not already in `taken`. The user didn't choose
 * the name, so we have to handle collisions silently — append `-2`, `-3`, …
 * until we find a free slot.
 */
export function uniqueBranchName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}
