import { execFileSync } from "node:child_process";
import { z } from "zod";

// Where a repository's reviews live. A Blade origin is `<host>/sythe3.git` over HTTP(S), the same rule `bl` applies;
// every other origin is GitHub. The gates read one review shape whichever forge answers.
export type Forge = "blade" | "github";
export type ReviewView = {
  readonly head: string;
  readonly base: string;
  readonly state: "OPEN" | "MERGED" | "CLOSED";
  readonly isDraft: boolean;
  readonly url: string;
  readonly mergeCommit: string | null;
};
export type ForgeExec = (file: string, args: readonly string[], cwd: string) => string;
export const execForge: ForgeExec = (file, args, cwd) => execFileSync(file, args, { cwd, encoding: "utf8" });

export function forgeOf(cwd: string, exec: ForgeExec): Forge {
  const origin = exec("git", ["config", "--default", "", "--get", "remote.origin.url"], cwd).trim();
  if (!URL.canParse(origin)) return "github";
  const url = new URL(origin);
  return (url.protocol === "https:" || url.protocol === "http:") && url.pathname === "/sythe3.git" ? "blade" : "github";
}

const bladeChange = z.object({
  state: z.enum(["open", "landed", "abandoned"]),
  url: z.string(),
  landedCommit: z.string().nullable(),
  latestRevision: z.object({ commitSha: z.string() }),
});
const githubPull = z.object({
  headRefOid: z.string(),
  baseRefName: z.string(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  isDraft: z.boolean(),
  url: z.string(),
  mergeCommit: z.object({ oid: z.string() }).nullable(),
});
const bladeState = { open: "OPEN", landed: "MERGED", abandoned: "CLOSED" } as const;

// A Blade change always targets main and has no draft state.
export function viewReview(cwd: string, number: number, exec: ForgeExec): ReviewView {
  if (forgeOf(cwd, exec) === "blade") {
    const change = bladeChange.parse(JSON.parse(exec("bl", ["change", "view", String(number), "--json"], cwd)));
    return {
      head: change.latestRevision.commitSha,
      base: "main",
      state: bladeState[change.state],
      isDraft: false,
      url: change.url,
      mergeCommit: change.landedCommit,
    };
  }
  const pull = githubPull.parse(
    JSON.parse(exec("gh", ["pr", "view", String(number), "--json", "headRefOid,baseRefName,state,isDraft,url,mergeCommit"], cwd)),
  );
  return {
    head: pull.headRefOid,
    base: pull.baseRefName,
    state: pull.state,
    isDraft: pull.isDraft,
    url: pull.url,
    mergeCommit: pull.mergeCommit?.oid ?? null,
  };
}
