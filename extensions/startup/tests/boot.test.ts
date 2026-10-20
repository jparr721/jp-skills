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
import { bootSelection, ompDirectories, ompProfileFromEnvironment, parseBootCommand, persistBinding, StartupBootError } from "../src/boot";

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

// Each expectation was observed on OMP 18.11.1 by starting it under an isolated HOME and reading where it created sessions/ and plugins/.
test("OMP directories follow OMP's own profile, override and XDG resolution", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "startup-omp-dirs-")));
  directories.push(home);
  mkdirSync(join(home, "xdg-app", "omp"), { recursive: true });
  mkdirSync(join(home, "xdg-work", "omp", "profiles", "work"), { recursive: true });
  const base = join(home, ".omp");
  const dirs = (environment: Readonly<Record<string, string>>, profile: string) => ompDirectories({ HOME: home, ...environment }, profile);
  expect(dirs({}, "default")).toEqual({ root: base, agent: join(base, "agent") });
  expect(dirs({}, "work")).toEqual({ root: join(base, "profiles", "work"), agent: join(base, "profiles", "work", "agent") });
  expect(dirs({ PI_CONFIG_DIR: ".cfg" }, "default")).toEqual({ root: join(home, ".cfg"), agent: join(home, ".cfg", "agent") });
  expect(dirs({ PI_CODING_AGENT_DIR: join(home, "custom") }, "default")).toEqual({ root: base, agent: join(home, "custom") });
  expect(dirs({ PI_CODING_AGENT_DIR: join(home, "custom") }, "work")).toEqual(dirs({}, "work"));
  const xdgApp = join(home, "xdg-app", "omp");
  expect(dirs({ XDG_DATA_HOME: join(home, "xdg-app") }, "default")).toEqual({ root: xdgApp, agent: xdgApp });
  expect(dirs({ XDG_DATA_HOME: join(home, "xdg-app") }, "work")).toEqual(dirs({}, "work"));
  expect(dirs({ XDG_DATA_HOME: join(home, "xdg-app"), PI_CODING_AGENT_DIR: join(home, "custom") }, "default")).toEqual({ root: base, agent: join(home, "custom") });
  const xdgWork = join(home, "xdg-work", "omp", "profiles", "work");
  expect(dirs({ XDG_DATA_HOME: join(home, "xdg-work") }, "work")).toEqual({ root: xdgWork, agent: xdgWork });
  expect(dirs({ XDG_DATA_HOME: join(home, "xdg-work") }, "default")).toEqual({ root: join(home, "xdg-work", "omp"), agent: join(home, "xdg-work", "omp") });
  expect(dirs({ XDG_DATA_HOME: join(home, "missing") }, "default")).toEqual(dirs({}, "default"));
});

test("the active OMP profile is OMP_PROFILE even when empty, else PI_PROFILE, else the default", () => {
  expect(ompProfileFromEnvironment({})).toBe("default");
  expect(ompProfileFromEnvironment({ OMP_PROFILE: "", PI_PROFILE: "other" })).toBe("default");
  expect(ompProfileFromEnvironment({ OMP_PROFILE: "default", PI_PROFILE: "other" })).toBe("default");
  expect(ompProfileFromEnvironment({ OMP_PROFILE: " work ", PI_PROFILE: "other" })).toBe("work");
  expect(ompProfileFromEnvironment({ PI_PROFILE: "other" })).toBe("other");
  for (const OMP_PROFILE of ["invalid/profile", "Upper", "../x"]) expect(() => ompProfileFromEnvironment({ OMP_PROFILE })).toThrow(StartupBootError);
});
