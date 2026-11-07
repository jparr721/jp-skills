import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listStartups, readStartupConfig, StartupConfigError } from "../src/startup-config";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const base = {
  name: "alpha", skillsHome: "/h", startupRoot: "/h/startup/alpha", stateDirectory: "/h/startup/alpha", boundRoot: "/repo", skillsRoot: "/skills",
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

test("a legacy runtime-config without binding.json is skipped by list and refused by get", () => {
  const f = fixture(base);
  const directory = join(f.home, "startup", "oldshape");
  mkdirSync(directory);
  const badPath = join(directory, "runtime-config.json");
  const legacyConfig = { name: "oldshape", home: "/h", stateDirectory: "/h/startup/oldshape", boundRoot: "/repo", skillsRoot: "/skills", socketPath: "/h/startup/oldshape/runtime.sock", profile: "old", managerSession: "m", managerFile: "/sessions/m.jsonl", managerPaneId: "w1:p1", managerCredential: "secret", herdrSession: "s", workspaceId: "w1", herdrBinary: "herdr", herdrIntegration: "/i.ts", ownerGeneration: 1, policy: { tickMs: 1000, paCadenceMs: 60000, progressDeadlineMs: 300000, connectionDeadlineMs: 30000, executionLimit: 6 } };
  writeFileSync(badPath, JSON.stringify(legacyConfig), { mode: 0o600 });
  expect(listStartups(f.home)).toEqual([{ name: "alpha", harness: "omp", profile: "old" }]);
  let message = "";
  try {
    readStartupConfig({ home: f.home, name: "oldshape", key: null });
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(StartupConfigError);
    expect(error instanceof Error ? error.name : "").not.toBe("ZodError");
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("oldshape");
  expect(message).toContain(badPath);
  expect(message).not.toContain("secret");
});

test("a bare home-only stub is malformed current and fails strict, not legacy", () => {
  const f = fixture(base);
  const directory = join(f.home, "startup", "stub");
  mkdirSync(directory);
  const badPath = join(directory, "runtime-config.json");
  writeFileSync(badPath, JSON.stringify({ name: "stub", home: "/h" }), { mode: 0o600 });
  let listMessage = "";
  try {
    listStartups(f.home);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(StartupConfigError);
    expect(error instanceof Error ? error.name : "").not.toBe("ZodError");
    listMessage = error instanceof Error ? error.message : String(error);
  }
  expect(listMessage).toContain("stub");
  expect(listMessage).toContain(badPath);
  expect(listMessage).not.toContain("secret");
  expect(() => readStartupConfig({ home: f.home, name: "stub", key: null })).toThrow(StartupConfigError);
});

test("a malformed current runtime-config fails strict as named StartupConfigError, not ZodError", () => {
  const f = fixture(base);
  const directory = join(f.home, "startup", "malformed");
  mkdirSync(directory);
  const badPath = join(directory, "runtime-config.json");
  writeFileSync(badPath, JSON.stringify({ name: "malformed", skillsHome: "/h" }), { mode: 0o600 });
  for (const run of [() => listStartups(f.home), () => readStartupConfig({ home: f.home, name: "malformed", key: null })]) {
    let message = "";
    try {
      run();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(StartupConfigError);
      message = error instanceof Error ? error.message : String(error);
      expect(error instanceof Error ? error.name : "").not.toBe("ZodError");
    }
    expect(message).toContain("malformed");
    expect(message).toContain(badPath);
    expect(message).not.toContain("secret");
  }
});

test("an unknown key on a current runtime-config fails strict as named StartupConfigError, not ZodError", () => {
  const f = fixture({ ...base, name: "extra", bogus: 1 });
  let listMessage = "";
  try {
    listStartups(f.home);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(StartupConfigError);
    listMessage = error instanceof Error ? error.message : String(error);
    expect(error instanceof Error ? error.name : "").not.toBe("ZodError");
  }
  expect(listMessage).toContain("extra");
  expect(listMessage).toContain(f.path);
  expect(listMessage).not.toContain("secret");
  expect(() => readStartupConfig({ home: f.home, name: "extra", key: null })).toThrow(StartupConfigError);
});

test("a corrupt runtime-config fails as named StartupConfigError, not SyntaxError", () => {
  const f = fixture(base);
  writeFileSync(f.path, "{not json", { mode: 0o600 });
  for (const run of [() => listStartups(f.home), () => readStartupConfig({ home: f.home, name: "alpha", key: null })]) {
    let message = "";
    try {
      run();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(StartupConfigError);
      expect(error).not.toBeInstanceOf(SyntaxError);
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("alpha");
    expect(message).toContain(f.path);
  }
});
