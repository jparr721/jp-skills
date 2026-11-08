import { execFileSync } from "node:child_process";

export function remoteIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const scp = /^(?:[^@/:]+@)([^/:]+):(.+)$/.exec(text);
  let host: string;
  let path: string;
  if (scp) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else {
    let url: URL;
    try { url = new URL(text); } catch { return null; }
    if (!["https:", "http:", "ssh:"].includes(url.protocol) || url.search || url.hash) return null;
    host = url.host;
    path = url.pathname;
  }
  const parts = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/");
  if (!host || parts.length < 2 || parts.some((part) => !part || part === "." || part === "..")) return null;
  const normalizedHost = host.toLowerCase();
  if (normalizedHost === "github.com" && parts.length !== 2) return null;
  const normalizedPath = parts.join("/");
  return `${normalizedHost}/${normalizedHost === "github.com" ? normalizedPath.toLowerCase() : normalizedPath}`;
}

export function inspectRepository(input: Readonly<{ cwd: string; repo: unknown; remote: unknown }>): string | null {
  const remote = remoteIdentity(input.remote);
  const repo = remoteIdentity(input.repo);
  if (!remote) return null;
  if (repo && repo !== remote) return "Saved repository and remote metadata differ; inspect the selected checkout and continue with the verified repository.";
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: input.cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  let names: string[];
  try { names = git("remote").split("\n").filter(Boolean); }
  catch { return "Could not inspect checkout remotes; inspect the selected repository and continue."; }
  for (const name of names) {
    try { if (remoteIdentity(git("remote", "get-url", "--", name)) === remote) return null; }
    catch { continue; }
  }
  return "The saved remote is not configured in the selected checkout; inspect whether it is the intended repository or a fork and continue.";
}
