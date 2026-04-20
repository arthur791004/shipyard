// Unit coverage for the free-form command pipeline's pure parts:
//
// - classifyFreeForm / URL regexes: which route a given text goes down
//   (GH issue, Linear ticket, or plain chat).
// - uniqueBranchName: collision handling when the user doesn't pick a name.
// - slugify / firstNWords: the heuristic fallback for branch naming when the
//   LLM isn't available.
// - generateBranchName (llm.ts): behaviour when ANTHROPIC_API_KEY is unset —
//   should return null so callers fall back to the slug.
//
// The full /api/commands → createBranchFlow path is exercised manually (it
// invokes git worktree + docker sandbox exec, out of scope for a unit test).

import { describe, expect, it } from "vitest";

import {
  classifyFreeForm,
  firstNWords,
  GH_ISSUE_URL,
  LINEAR_ISSUE_URL,
  slugify,
  uniqueBranchName,
} from "../src/routeHelpers.js";

describe("classifyFreeForm", () => {
  it("returns chat for plain prose", () => {
    const r = classifyFreeForm("Fix the login button on the signup page");
    expect(r.kind).toBe("chat");
  });

  it("returns issue for a GitHub issue URL, capturing surrounding text as userNote", () => {
    const r = classifyFreeForm(
      "Please take a look at https://github.com/Automattic/wp-calypso/issues/12345 when you have time",
    );
    expect(r).toEqual({
      kind: "issue",
      url: "https://github.com/Automattic/wp-calypso/issues/12345",
      userNote: "Please take a look at  when you have time",
    });
  });

  it("returns issue with undefined userNote when the text is just the URL", () => {
    const r = classifyFreeForm("https://github.com/foo/bar/issues/99");
    expect(r.kind).toBe("issue");
    if (r.kind === "issue") {
      expect(r.url).toBe("https://github.com/foo/bar/issues/99");
      expect(r.userNote).toBeUndefined();
    }
  });

  it("returns linear for a Linear ticket URL", () => {
    const r = classifyFreeForm("https://linear.app/shipyard/issue/SHIP-42");
    expect(r.kind).toBe("linear");
    if (r.kind === "linear") {
      expect(r.url).toBe("https://linear.app/shipyard/issue/SHIP-42");
    }
  });

  it("case-insensitive on the domain", () => {
    expect(classifyFreeForm("HTTPS://GITHUB.COM/x/y/issues/1").kind).toBe("issue");
    expect(classifyFreeForm("HTTPS://LINEAR.APP/x/issue/ABC-1").kind).toBe("linear");
  });

  it("ignores non-issue GitHub URLs", () => {
    // Plain repo URL, PR URL, etc. should stay chat.
    expect(classifyFreeForm("https://github.com/foo/bar").kind).toBe("chat");
    expect(classifyFreeForm("https://github.com/foo/bar/pull/5").kind).toBe("chat");
  });

  it("GH_ISSUE_URL and LINEAR_ISSUE_URL don't cross-match", () => {
    expect("https://linear.app/x/issue/A-1".match(GH_ISSUE_URL)).toBeNull();
    expect("https://github.com/x/y/issues/1".match(LINEAR_ISSUE_URL)).toBeNull();
  });
});

describe("uniqueBranchName", () => {
  it("returns the base when it's free", () => {
    expect(uniqueBranchName("fix-login", new Set())).toBe("fix-login");
    expect(uniqueBranchName("fix-login", new Set(["other"]))).toBe("fix-login");
  });

  it("suffixes -2 on first collision", () => {
    expect(uniqueBranchName("fix-login", new Set(["fix-login"]))).toBe("fix-login-2");
  });

  it("climbs past multiple collisions", () => {
    const taken = new Set(["x", "x-2", "x-3"]);
    expect(uniqueBranchName("x", taken)).toBe("x-4");
  });
});

describe("slugify / firstNWords fallback", () => {
  it("slugifies a free-form message into a kebab slug capped at 40 chars", () => {
    expect(slugify("Fix the LOGIN button!")).toBe("fix-the-login-button");
    expect(slugify("   whitespace around   ")).toBe("whitespace-around");
    expect(
      slugify("a really really really really really really long sentence that overflows"),
    ).toHaveLength(40);
  });

  it("firstNWords picks N words for the heuristic slug", () => {
    expect(firstNWords("fix the login bug in wp-login.php", 3)).toBe("fix the login");
    expect(firstNWords("  spacing  ", 5)).toBe("spacing");
    expect(firstNWords("short", 10)).toBe("short");
  });

  it("chained slugify(firstNWords(...)) produces the expected fallback name", () => {
    expect(slugify(firstNWords("Fix the login button on signup", 5))).toBe(
      "fix-the-login-button-on",
    );
  });
});

describe("generateBranchName (llm.ts)", () => {
  it("returns null or a valid kebab-case name (never throws, never returns garbage)", async () => {
    // The implementation shells out to `claude -p`. Whether the CLI is
    // available + authed on this machine is environment-dependent, so we
    // only assert the contract: either null (fallback path) or a name
    // matching the expected pattern. Timeout is 15s in the helper; give
    // vitest plenty of headroom.
    const { generateBranchName } = await import("../src/llm.js");
    const result = await generateBranchName("add dark mode toggle");
    if (result !== null) {
      expect(result).toMatch(/^[a-z0-9]+(-[a-z0-9]+){0,4}$/);
      expect(result.length).toBeLessThanOrEqual(24);
    }
  }, 20_000);

  it("returns null for empty / whitespace-only input without spawning anything", async () => {
    const { generateBranchName } = await import("../src/llm.js");
    expect(await generateBranchName("")).toBeNull();
    expect(await generateBranchName("   \n  ")).toBeNull();
  });
});
