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
import {
  bootSelection,
  parseBootCommand,
  writeBootGuidance,
  writeClaudeGuidance,
} from "../src/boot";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "startup-boot-"));
  directories.push(directory);
  mkdirSync(join(directory, "bound"));
  const root = realpathSync(join(directory, "bound"));
  return {
    root,
    home: join(directory, "home"),
    skillsRoot: resolve(import.meta.dir, "../../.."),
  };
}
test("boot guidance preserves exact unrelated bytes and is idempotent at selected root", () => {
  const f = fixture();
  const prior = "User instructions\r\nKeep bytes\r\n";
  writeFileSync(join(f.root, "AGENTS.md"), prior);
  const selected = bootSelection({
    ...f,
    cwd: f.root,
    command: parseBootCommand("new example"),
    explicitName: null,
    executionLimit: 7,
  });
  expect(selected).toMatchObject({
    name: "example",
    boundRoot: f.root,
    executionLimit: 7,
  });
  if (!selected) throw new Error("Missing selection");
  const first = writeBootGuidance(selected);
  expect(readFileSync(first, "utf8").startsWith(prior)).toBe(true);
  const bytes = readFileSync(first);
  writeBootGuidance(selected);
  expect(readFileSync(first)).toEqual(bytes);
  const child = join(f.root, "repo");
  mkdirSync(child);
  const again = bootSelection({
    ...f,
    cwd: child,
    command: null,
    explicitName: null,
    executionLimit: 3,
  });
  expect(again).toMatchObject({
    name: "example",
    boundRoot: f.root,
    executionLimit: 3,
  });
  expect(existsSync(join(child, "AGENTS.md"))).toBe(false);
});
test("boot rejects conflicting managed sections and symlinks without touching user bytes", () => {
  const f = fixture();
  const selected = bootSelection({
    ...f,
    cwd: f.root,
    command: parseBootCommand("new example"),
    explicitName: null,
    executionLimit: null,
  });
  if (!selected) throw new Error("Missing selection");
  const file = join(f.root, "AGENTS.md");
  for (const text of [
    "user\n<!-- jp-skills-startup:begin -->",
    "<!-- jp-skills-startup:end -->",
    "<!-- jp-skills-startup:begin -->\nwrong\n<!-- jp-skills-startup:end -->",
  ]) {
    writeFileSync(file, text);
    expect(() => writeBootGuidance(selected)).toThrow();
    expect(readFileSync(file, "utf8")).toBe(text);
  }
  rmSync(file);
  const target = join(f.root, "user.md");
  writeFileSync(target, "user");
  symlinkSync(target, file);
  expect(() => writeBootGuidance(selected)).toThrow("symlink");
  expect(readFileSync(target, "utf8")).toBe("user");
});
test("boot commands preserve work and paths and reject malformed or ambiguous selection", () => {
  expect(
    parseBootCommand('new example --dir "/path with spaces" -- fix this'),
  ).toMatchObject({
    kind: "new",
    name: "example",
    directory: "/path with spaces",
    work: "fix this",
  });
  expect(() => parseBootCommand("new ../wrong")).toThrow();
  expect(() => parseBootCommand("new good --unknown flag")).toThrow();
  const f = fixture();
  mkdirSync(join(f.root, ".startup"));
  writeFileSync(
    join(f.root, ".startup", "config.md"),
    "Ambiguous user prose\n",
  );
  expect(() =>
    bootSelection({
      ...f,
      cwd: f.root,
      command: null,
      explicitName: null,
      executionLimit: null,
    }),
  ).toThrow("binding");
  expect(readFileSync(join(f.root, ".startup", "config.md"), "utf8")).toBe(
    "Ambiguous user prose\n",
  );
});

test("boot preserves existing config and rejects unsafe bytes or in-root state before writes", () => {
  const f = fixture();
  mkdirSync(join(f.root, ".startup"));
  const config = join(f.root, ".startup/config.md");
  writeFileSync(config, "User configuration\r\nKeep exactly\r\n");
  const selection = bootSelection({
    ...f,
    cwd: f.root,
    command: parseBootCommand("new old"),
    explicitName: null,
    executionLimit: null,
  });
  if (!selection) throw new Error("Missing selection");
  const file = join(f.root, "AGENTS.md");
  const invalid = Buffer.from([0xff, 0x0a]);
  writeFileSync(file, invalid);
  expect(() => writeBootGuidance(selection)).toThrow("UTF-8");
  expect(readFileSync(file)).toEqual(invalid);
  writeFileSync(file, "User original");
  writeBootGuidance(selection);
  expect(readFileSync(config, "utf8")).toBe(
    "User configuration\r\nKeep exactly\r\n",
  );
  expect(() =>
    bootSelection({
      ...f,
      home: join(f.root, "bad-home"),
      cwd: f.root,
      command: parseBootCommand("new invalid"),
      explicitName: null,
      executionLimit: null,
    }),
  ).toThrow("outside");
  expect(existsSync(join(f.root, "bad-home"))).toBe(false);
});

test("boot separator ignores quoted path content and retains complete work", () => {
  expect(
    parseBootCommand(
      'new example --dir "/path -- with spaces" -- inspect "quoted" work',
    ),
  ).toMatchObject({
    directory: "/path -- with spaces",
    work: 'inspect "quoted" work',
  });
});

test("Claude guidance imports AGENTS.md in a managed CLAUDE.md block and preserves user bytes", () => {
  const f = fixture();
  const selected = bootSelection({ ...f, cwd: f.root, command: parseBootCommand("new example"), explicitName: null, executionLimit: null });
  if (!selected) throw new Error("Missing selection");
  const prior = "User Claude notes\r\nKeep bytes";
  writeFileSync(join(f.root, "CLAUDE.md"), prior);
  const agents = writeBootGuidance(selected);
  const agentBytes = readFileSync(agents);
  const path = writeClaudeGuidance(selected);
  expect(path).toBe(join(f.root, "CLAUDE.md"));
  const text = readFileSync(path, "utf8");
  expect(text.startsWith(`${prior}\n<!-- jp-skills-startup:begin -->\n<!-- identity: ${JSON.stringify({ version: 1, name: "example", boundRoot: f.root, skillsRoot: f.skillsRoot })} -->\n@AGENTS.md\n`)).toBe(true);
  expect(text.endsWith("<!-- jp-skills-startup:end -->\n")).toBe(true);
  expect(text).toContain("mcp__startup__startup_*");
  const bytes = readFileSync(path);
  writeClaudeGuidance(selected);
  expect(readFileSync(path)).toEqual(bytes);
  expect(readFileSync(agents)).toEqual(agentBytes);
  rmSync(path);
  writeClaudeGuidance(selected);
  expect(readFileSync(path, "utf8").startsWith("<!-- jp-skills-startup:begin -->")).toBe(true);
});
test("Claude guidance rejects malformed sections, invalid UTF-8 and symlinks without touching bytes", () => {
  const f = fixture();
  const selected = bootSelection({ ...f, cwd: f.root, command: parseBootCommand("new example"), explicitName: null, executionLimit: null });
  if (!selected) throw new Error("Missing selection");
  const file = join(f.root, "CLAUDE.md");
  for (const text of ["user\n<!-- jp-skills-startup:begin -->", "<!-- jp-skills-startup:begin -->\nwrong\n<!-- jp-skills-startup:end -->"]) {
    writeFileSync(file, text);
    expect(() => writeClaudeGuidance(selected)).toThrow();
    expect(readFileSync(file, "utf8")).toBe(text);
  }
  const invalid = Buffer.from([0xff, 0x0a]);
  writeFileSync(file, invalid);
  expect(() => writeClaudeGuidance(selected)).toThrow("CLAUDE.md must be valid UTF-8");
  expect(readFileSync(file)).toEqual(invalid);
  rmSync(file);
  writeFileSync(join(f.root, "user.md"), "user");
  symlinkSync(join(f.root, "user.md"), file);
  expect(() => writeClaudeGuidance(selected)).toThrow("symlink");
  expect(readFileSync(join(f.root, "user.md"), "utf8")).toBe("user");
});
