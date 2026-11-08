import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type WorktreeWriter = Readonly<{ pid: number; command: string; path: string }>;
export type WorktreeWriterScan = Readonly<{ status: "observed"; writers: readonly WorktreeWriter[] }> | Readonly<{ status: "unavailable"; reason: string }>;

export async function scanWorktreeWriters(worktree: string): Promise<WorktreeWriterScan> {
  const lsof = Bun.which("lsof");
  if (!lsof) return { status: "unavailable", reason: "lsof is unavailable" };
  let output: string;
  try {
    ({ stdout: output } = await promisify(execFile)(lsof, ["-nP", "-F", "pcfan", "+D", worktree], { encoding: "utf8", timeout: 3000, maxBuffer: 1024 * 1024 }));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === 1 && "stdout" in error && typeof error.stdout === "string" && "stderr" in error && error.stderr === "") output = error.stdout;
    else return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
  const writers: WorktreeWriter[] = [];
  let pid = 0;
  let command = "";
  let access = "";
  for (const line of output.split("\n")) {
    const value = line.slice(1);
    switch (line[0]) {
      case "p": pid = Number(value); command = ""; access = ""; break;
      case "c": command = value; break;
      case "f": access = ""; break;
      case "a": access = value; break;
      case "n": if ((access === "w" || access === "u") && Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) writers.push({ pid, command, path: value }); break;
    }
  }
  return { status: "observed", writers };
}
