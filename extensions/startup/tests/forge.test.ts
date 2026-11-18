import { expect, test } from "bun:test";
import { forgeOf, viewReview, type ForgeExec } from "../src/forge";

const calls: string[][] = [];
const fake = (origin: string, reply: unknown): ForgeExec => (file, args) => {
  calls.push([file, ...args]);
  if (file === "git") return `${origin}\n`;
  return JSON.stringify(reply);
};

test("an origin at <host>/sythe3.git is Blade; anything else is GitHub", () => {
  expect(forgeOf("/w", fake("https://aspen.example.ts.net/sythe3.git", null))).toBe("blade");
  expect(forgeOf("/w", fake("http://127.0.0.1:8890/sythe3.git", null))).toBe("blade");
  expect(forgeOf("/w", fake("https://github.com/sythelabs/sythe3.git", null))).toBe("github");
  expect(forgeOf("/w", fake("git@github.com:jparr721/jp-skills.git", null))).toBe("github");
  expect(forgeOf("/w", fake("", null))).toBe("github");
});

test("a Blade change reads as the review view the gates use", () => {
  calls.length = 0;
  const landed = viewReview("/w", 7, fake("https://aspen.example.ts.net/sythe3.git", {
    number: 7,
    state: "landed",
    url: "https://aspen.example.ts.net/c/7",
    landedCommit: "c0ffee",
    latestRevision: { number: 2, commitSha: "abc123" },
  }));
  expect(calls[1]).toEqual(["bl", "change", "view", "7", "--json"]);
  expect(landed).toEqual({ head: "abc123", base: "main", state: "MERGED", isDraft: false, url: "https://aspen.example.ts.net/c/7", mergeCommit: "c0ffee" });
  const open = viewReview("/w", 8, fake("https://aspen.example.ts.net/sythe3.git", {
    number: 8, state: "open", url: "u", landedCommit: null, latestRevision: { number: 1, commitSha: "def" },
  }));
  expect(open.state).toBe("OPEN");
  expect(open.mergeCommit).toBeNull();
  const abandoned = viewReview("/w", 9, fake("https://aspen.example.ts.net/sythe3.git", {
    number: 9, state: "abandoned", url: "u", landedCommit: null, latestRevision: { number: 1, commitSha: "def" },
  }));
  expect(abandoned.state).toBe("CLOSED");
});

test("a GitHub pull request reads through gh pr view", () => {
  calls.length = 0;
  const view = viewReview("/w", 12, fake("git@github.com:jparr721/jp-skills.git", {
    headRefOid: "abc", baseRefName: "main", state: "OPEN", isDraft: false, url: "https://github.com/x/y/pull/12", mergeCommit: null,
  }));
  expect(calls[1]).toEqual(["gh", "pr", "view", "12", "--json", "headRefOid,baseRefName,state,isDraft,url,mergeCommit"]);
  expect(view).toEqual({ head: "abc", base: "main", state: "OPEN", isDraft: false, url: "https://github.com/x/y/pull/12", mergeCommit: null });
});
