import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listStartups, readStartupConfig, requireSwitchable, setStartupProfile, StartupConfigError } from "../src/startup-config";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const base = {
  name: "alpha", home: "/h", stateDirectory: "/h/startup/alpha", boundRoot: "/repo", skillsRoot: "/skills",
  socketPath: "/h/startup/alpha/runtime.sock", profile: "old", managerSession: "m", managerFile: "/sessions/m.jsonl",
  managerPaneId: "w1:p1", managerCredential: "secret", herdrSession: "s", workspaceId: "w1", herdrBinary: "herdr",
  herdrIntegration: "/i.ts", ownerGeneration: 1,
  policy: { tickMs: 1000, paCadenceMs: 60000, progressDeadlineMs: 300000, connectionDeadlineMs: 30000, executionLimit: 6 },
};
function fixture(config: Record<string, unknown>) {
  const home = mkdtempSync(join(tmpdir(), "startup-config-"));
  roots.push(home);
  const directory = join(home, "startup", String(config.name));
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "runtime-config.json");
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  return { home, directory, path };
}

test("listStartups reports each saved Startup with its harness and profile", () => {
  const f = fixture(base);
  mkdirSync(join(f.home, "startup", "beta"));
  writeFileSync(join(f.home, "startup", "beta", "runtime-config.json"), JSON.stringify({ ...base, name: "beta", profile: "other", harness: "claude" }), { mode: 0o600 });
  mkdirSync(join(f.home, "startup", "claude"));
  expect(listStartups(f.home)).toEqual([{ name: "alpha", harness: "omp", profile: "old" }, { name: "beta", harness: "claude", profile: "other" }]);
});

test("readStartupConfig redacts the manager credential and reads one key", () => {
  const f = fixture(base);
  const { managerCredential: _credential, ...redacted } = base;
  expect(readStartupConfig({ home: f.home, name: "alpha", key: null })).toEqual(redacted);
  expect(readStartupConfig({ home: f.home, name: "alpha", key: "profile" })).toBe("old");
  expect(() => readStartupConfig({ home: f.home, name: "alpha", key: "managerCredential" })).toThrow(StartupConfigError);
  expect(() => readStartupConfig({ home: f.home, name: "missing", key: null })).toThrow(StartupConfigError);
});

test("setStartupProfile rewrites only the profile and keeps the file owner-only", () => {
  const f = fixture(base);
  const result = setStartupProfile({ home: f.home, name: "alpha", profile: "new", saved: ["new", "old"] });
  expect(result).toEqual({ name: "alpha", previous: "old", profile: "new", resume: "OMP_PROFILE=new omp --profile new --resume '/sessions/m.jsonl'" });
  expect(JSON.parse(readFileSync(f.path, "utf8"))).toEqual({ ...base, profile: "new" });
  expect(statSync(f.path).mode & 0o777).toBe(0o600);
});

test("setStartupProfile accepts the default profile and the current profile unchanged", () => {
  const f = fixture(base);
  expect(setStartupProfile({ home: f.home, name: "alpha", profile: "default", saved: [] }).profile).toBe("default");
  expect(setStartupProfile({ home: f.home, name: "alpha", profile: "default", saved: [] }).previous).toBe("default");
});

test("setStartupProfile refuses an unsaved profile and a Claude Startup without writing", () => {
  const f = fixture(base);
  expect(() => setStartupProfile({ home: f.home, name: "alpha", profile: "ghost", saved: ["new"] })).toThrow(/saved OMP profiles: new/);
  expect(JSON.parse(readFileSync(f.path, "utf8")).profile).toBe("old");
  const claude = fixture({ ...base, name: "gamma", harness: "claude" });
  expect(() => setStartupProfile({ home: claude.home, name: "gamma", profile: "new", saved: ["new"] })).toThrow(/Claude/);
});

test("setStartupProfile refuses while the coordinator runs or its launch is uncertain", () => {
  const live = fixture(base);
  writeFileSync(join(live.directory, "runtime-launch.json"), JSON.stringify({ state: "spawned", startedAt: 1, pid: process.pid }), { mode: 0o600 });
  expect(() => setStartupProfile({ home: live.home, name: "alpha", profile: "new", saved: ["new"] })).toThrow(new RegExp(`pid ${process.pid}`));
  const prepared = fixture(base);
  writeFileSync(join(prepared.directory, "runtime-launch.json"), JSON.stringify({ state: "prepared", startedAt: 1 }), { mode: 0o600 });
  expect(() => setStartupProfile({ home: prepared.home, name: "alpha", profile: "new", saved: ["new"] })).toThrow(/uncertain/);
  expect(JSON.parse(readFileSync(live.path, "utf8")).profile).toBe("old");
});

test("the resume command shell-quotes the transcript path", () => {
  const f = fixture({ ...base, managerFile: "/Users/a b/it's.jsonl" });
  expect(setStartupProfile({ home: f.home, name: "alpha", profile: "new", saved: ["new"] }).resume).toBe("OMP_PROFILE=new omp --profile new --resume '/Users/a b/it'\\''s.jsonl'");
});

test("requireSwitchable checks the Startup before any profile is chosen", () => {
  const f = fixture(base);
  expect(() => requireSwitchable({ home: f.home, name: "missing" })).toThrow(StartupConfigError);
  const claude = fixture({ ...base, name: "gamma", harness: "claude" });
  expect(() => requireSwitchable({ home: claude.home, name: "gamma" })).toThrow(/Claude/);
  writeFileSync(join(f.directory, "runtime-launch.json"), JSON.stringify({ state: "spawned", startedAt: 1, pid: process.pid }), { mode: 0o600 });
  expect(() => requireSwitchable({ home: f.home, name: "alpha" })).toThrow(new RegExp(`pid ${process.pid}`));
});
