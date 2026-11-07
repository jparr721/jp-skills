import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanWorktreeWriters } from "../src/worktree-writers";

test("observes a live write handle and clears after the writer exits", async () => {
  if (!Bun.which("lsof") || !Bun.which("python3")) return;
  const root = mkdtempSync(join(tmpdir(), "startup-writer-"));
  const child = spawn("python3", ["-c", "import sys,time; f=open(sys.argv[1], 'w'); print('ready', flush=True); time.sleep(30)", join(root, "held")], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); });
    const live = await scanWorktreeWriters(root);
    expect(live.status).toBe("observed");
    if (live.status !== "observed") throw new Error(live.reason);
    expect(live.writers.some((writer) => writer.pid === child.pid && writer.path.endsWith("/held"))).toBe(true);
    child.kill();
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    const done = await scanWorktreeWriters(root);
    expect(done).toEqual({ status: "observed", writers: [] });
  } finally { child.kill(); rmSync(root, { recursive: true, force: true }); }
}, 15000);
