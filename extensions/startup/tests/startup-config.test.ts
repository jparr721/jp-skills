import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listStartups, readStartupConfig, StartupConfigError } from "../src/startup-config";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const base = {
  name: "alpha", ompConfigRoot: "/c/omp", skillsHome: "/h", startupRoot: "/h/startup/alpha", stateDirectory: "/h/startup/alpha", boundRoot: "/repo", skillsRoot: "/skills",
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

test("a Startup saved in the old format is skipped by listStartups and refused by readStartupConfig", () => {
  const f = fixture(base);
  const legacy = join(f.home, "startup", "legacy");
  mkdirSync(legacy);
  writeFileSync(join(legacy, "runtime-config.json"), JSON.stringify({ name: "legacy", home: "/h" }), { mode: 0o600 });
  writeFileSync(join(legacy, "binding.json"), JSON.stringify({ name: "legacy", bound_root: "/repo", executionLimit: null }), { mode: 0o600 });
  expect(listStartups(f.home)).toEqual([{ name: "alpha", harness: "omp", profile: "old" }]);
  expect(() => readStartupConfig({ home: f.home, name: "legacy", key: null })).toThrow(StartupConfigError);
});
