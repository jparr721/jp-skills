import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootSelection, parseBootCommand, persistBinding } from "../src/boot";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "startup-boot-")));
  directories.push(directory);
  const boundRoot = join(directory, "bound");
  const skillsHome = join(directory, "jp-skills-home");
  const skillsRoot = resolve(import.meta.dir, "../../..");
  const configHome = join(directory, "xdg");
  mkdirSync(boundRoot, { mode: 0o700 });
  mkdirSync(skillsHome, { mode: 0o700 });
  return {
    cwd: boundRoot,
    boundRoot,
    skillsHome,
    skillsRoot,
    configHome,
    startupRoot: null,
    host: "host-a",
    managerSession: "manager-session-a",
  };
}

test("new and current selection keep the Startup root under the skills home", () => {
  const f = fixture();
  const selected = bootSelection({
    ...f,
    command: parseBootCommand("new alpha"),
    explicitName: null,
    executionLimit: 7,
  });
  if (selected === null) throw new Error("Missing selection");
  expect(selected).toMatchObject({
    name: "alpha",
    boundRoot: f.boundRoot,
    skillsHome: f.skillsHome,
    startupRoot: join(f.skillsHome, "startup", "alpha"),
    host: "host-a",
    managerSession: "manager-session-a",
    executionLimit: 7,
  });
  persistBinding(selected);

  const child = join(f.boundRoot, "src");
  mkdirSync(child);
  const current = bootSelection({
    ...f,
    cwd: child,
    command: null,
    explicitName: null,
    executionLimit: 3,
  });
  expect(current).toMatchObject({
    name: "alpha",
    boundRoot: f.boundRoot,
    startupRoot: selected.startupRoot,
    executionLimit: 3,
  });
  expect(existsSync(join(f.boundRoot, "AGENTS.md"))).toBe(false);
  expect(existsSync(join(f.boundRoot, "CLAUDE.md"))).toBe(false);
  expect(existsSync(join(f.boundRoot, ".startup", "config.md"))).toBe(false);
  expect(existsSync(join(selected.startupRoot, "binding.json"))).toBe(true);
});

test("current selection skips an old-format Startup root beside a current one", () => {
  const f = fixture();
  const selected = bootSelection({ ...f, command: parseBootCommand("new alpha"), explicitName: null, executionLimit: null });
  if (selected === null) throw new Error("Missing selection");
  persistBinding(selected);
  const old = join(f.skillsHome, "startup", "legacy");
  mkdirSync(old, { mode: 0o700 });
  writeFileSync(join(old, "binding.json"), JSON.stringify({ name: "legacy", bound_root: f.boundRoot }), { mode: 0o600 });
  expect(bootSelection({ ...f, command: null, explicitName: null, executionLimit: null })).toMatchObject({ name: "alpha", startupRoot: selected.startupRoot });
});

test("STARTUP_ROOT is canonicalized and persisted binding rejects a changed root", () => {
  const f = fixture();
  const configured = join(f.configHome, "chosen", "..", "startup");
  const selected = bootSelection({
    ...f,
    startupRoot: configured,
    command: parseBootCommand("new alpha"),
    explicitName: null,
    executionLimit: null,
  });
  if (selected === null) throw new Error("Missing selection");
  expect(selected.startupRoot).toBe(join(f.configHome, "startup"));
  persistBinding(selected);
  const bindingPath = join(selected.startupRoot, "binding.json");
  const binding = JSON.parse(readFileSync(bindingPath, "utf8")) as {
    scope: { startupRoot: string };
  };
  binding.scope.startupRoot = join(f.configHome, "other");
  writeFileSync(bindingPath, JSON.stringify(binding), { mode: 0o600 });
  expect(() => bootSelection({
    ...f,
    startupRoot: selected.startupRoot,
    command: parseBootCommand("select alpha"),
    explicitName: null,
    executionLimit: null,
  })).toThrow("Persisted Startup root");
});

test("an unbound STARTUP_ROOT waits for an explicit Startup name without creating state", () => {
  const f = fixture();
  const startupRoot = join(f.configHome, "selected");
  expect(bootSelection({ ...f, startupRoot, command: null, explicitName: null, executionLimit: null })).toBeNull();
  expect(existsSync(startupRoot)).toBe(false);
  const selected = bootSelection({ ...f, startupRoot, command: parseBootCommand("new alpha"), explicitName: null, executionLimit: null });
  if (selected === null) throw new Error("Missing selection");
  expect(selected.startupRoot).toBe(startupRoot);
});

test("selection refuses symlinked roots and state inside the bound repository", () => {
  const f = fixture();
  const actual = join(f.configHome, "actual");
  mkdirSync(actual, { recursive: true, mode: 0o700 });
  const linked = join(f.configHome, "linked");
  symlinkSync(actual, linked);
  expect(() => bootSelection({
    ...f,
    startupRoot: linked,
    command: parseBootCommand("new alpha"),
    explicitName: null,
    executionLimit: null,
  })).toThrow("symlink");
  expect(() => bootSelection({
    ...f,
    startupRoot: join(f.boundRoot, "runtime"),
    command: parseBootCommand("new alpha"),
    explicitName: null,
    executionLimit: null,
  })).toThrow("outside");
});

test("select rejects an old-format binding at the Startup root instead of importing it", () => {
  const f = fixture();
  const old = join(f.skillsHome, "startup", "alpha");
  mkdirSync(old, { recursive: true, mode: 0o700 });
  writeFileSync(join(old, "binding.json"), JSON.stringify({ name: "alpha", bound_root: f.boundRoot }), { mode: 0o600 });
  expect(() => bootSelection({
    ...f,
    command: parseBootCommand("select alpha"),
    explicitName: null,
    executionLimit: null,
  })).toThrow("Startup binding is invalid");
});

test("boot command preserves work and rejects malformed names and options", () => {
  expect(parseBootCommand('new alpha --dir "relative path" -- inspect status')).toMatchObject({
    kind: "new",
    name: "alpha",
    directory: "relative path",
    work: "inspect status",
  });
  expect(() => parseBootCommand("new ../wrong")).toThrow();
  expect(() => parseBootCommand("new alpha --unknown value")).toThrow();
});
