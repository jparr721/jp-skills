import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chooseProfile, manageClaudeInstallation, manageInstallation, pickProfile, pluginsDirectory, savedOmpProfiles, StartupInstallError } from "../install";
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "startup-install-")));
  temporary.push(root);
  const profile = "isolated-test";
  const env = { XDG_DATA_HOME: root };
  const plugins = join(root, "omp/profiles", profile, "plugins");
  mkdirSync(plugins, { recursive: true });
  return {
    profile,
    env,
    plugins,
    source: resolve(import.meta.dir, ".."),
    omp: "must-not-execute",
    action: "install" as const,
  };
}
test("native named profile resolution uses existing profile XDG path and rejects unsafe selection", () => {
  const f = fixture();
  expect(pluginsDirectory(f.profile, f.env)).toBe(f.plugins);
  expect(() => pluginsDirectory("../default", f.env)).toThrow();
  expect(() =>
    pluginsDirectory(f.profile, { PI_CONFIG_DIR: "/tmp" }),
  ).toThrow();
});
test("installer refuses foreign plugin link, config, dependency and malformed lock before native execution", () => {
  for (const kind of ["link", "config", "dependency", "malformed"]) {
    const f = fixture();
    const lock = join(f.plugins, "omp-plugins.lock.json");
    const before =
      kind === "config"
        ? '{"plugins":{"@jp-skills/startup":{"enabled":false}},"settings":{}}'
        : kind === "malformed"
          ? "user invalid JSON"
          : '{"settings":{"other":true}}';
    writeFileSync(lock, before);
    if (kind === "link") {
      mkdirSync(join(f.plugins, "node_modules/@jp-skills"), {
        recursive: true,
      });
      symlinkSync(f.source, join(f.plugins, "node_modules/@jp-skills/startup"));
    }
    if (kind === "dependency")
      writeFileSync(
        join(f.plugins, "package.json"),
        '{"dependencies":{"@jp-skills/startup":"foreign"}}',
      );
    expect(() => manageInstallation(f)).toThrow();
    expect(readFileSync(lock, "utf8")).toBe(before);
  }
});
test("uninstall preserves changed ownership and has no unmanaged removal path", () => {
  const f = fixture();
  const lock = join(f.plugins, "omp-plugins.lock.json");
  writeFileSync(lock, '{"plugins":{}}');
  expect(() => manageInstallation({ ...f, action: "uninstall" })).toThrow(
    "No owned",
  );
  const before = readFileSync(lock, "utf8");
  writeFileSync(
    join(f.plugins, "jp-skills-startup.install.json"),
    JSON.stringify({
      version: 1,
      source: f.source,
      profile: f.profile,
      plugins: f.plugins,
      before: null,
      after: "different",
    }),
  );
  expect(() => manageInstallation({ ...f, action: "uninstall" })).toThrow(
    "ownership changed",
  );
  expect(readFileSync(lock, "utf8")).toBe(before);
});

test("installer revalidates foreign preimages after version detection before native link", () => {
  for (const kind of ["target", "parent", "dependency", "config", "receipt"]) {
    const f = fixture();
    const parent = join(f.plugins, "node_modules/@jp-skills");
    mkdirSync(parent, { recursive: true });
    const lock = join(f.plugins, "omp-plugins.lock.json");
    const original = '{"plugins":{},"settings":{"user":{"keep":true}}}\n';
    writeFileSync(lock, original);
    const foreign = join(f.plugins, "foreign.txt");
    const sentinel = join(f.plugins, "native-link-ran");
    const executable = join(f.plugins, "omp-fixture");
    writeFileSync(
      executable,
      `#!${process.execPath}
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
const plugins=${JSON.stringify(f.plugins)};
if(process.argv[2]==="--version") {
  const kind=${JSON.stringify(kind)};
  if(kind==="target") { mkdirSync(plugins+"/node_modules/@jp-skills/startup"); writeFileSync(plugins+"/node_modules/@jp-skills/startup/user.txt","foreign bytes"); }
  if(kind==="parent") { renameSync(plugins+"/node_modules/@jp-skills", plugins+"/foreign-parent"); symlinkSync(plugins+"/foreign-parent", plugins+"/node_modules/@jp-skills"); writeFileSync(plugins+"/foreign-parent/user.txt","foreign bytes"); }
  if(kind==="dependency") writeFileSync(plugins+"/package.json", '{"dependencies":{"@jp-skills/startup":"foreign"}}');
  if(kind==="config") writeFileSync(plugins+"/omp-plugins.lock.json", '{"settings":{"@jp-skills/startup":{"user":true}}}');
  if(kind==="receipt") writeFileSync(plugins+"/jp-skills-startup.install.json", "foreign receipt");
  writeFileSync(${JSON.stringify(foreign)},"foreign bytes");
  process.stdout.write("omp/18.8.9\\n");
} else { writeFileSync(${JSON.stringify(sentinel)}, "called"); process.exit(73); }
`,
      { mode: 0o700 },
    );
    expect(() => manageInstallation({ ...f, omp: executable })).toThrow();
    expect(existsSync(sentinel)).toBe(false);
    expect(readFileSync(foreign, "utf8")).toBe("foreign bytes");
    if (kind === "target")
      expect(readFileSync(join(parent, "startup/user.txt"), "utf8")).toBe(
        "foreign bytes",
      );
    if (kind === "parent")
      expect(readFileSync(join(parent, "user.txt"), "utf8")).toBe(
        "foreign bytes",
      );
    if (kind === "dependency")
      expect(readFileSync(join(f.plugins, "package.json"), "utf8")).toBe(
        '{"dependencies":{"@jp-skills/startup":"foreign"}}',
      );
    if (kind === "config")
      expect(readFileSync(lock, "utf8")).toBe(
        '{"settings":{"@jp-skills/startup":{"user":true}}}',
      );
    else expect(readFileSync(lock, "utf8")).toBe(original);
    if (kind === "receipt")
      expect(
        readFileSync(join(f.plugins, "jp-skills-startup.install.json"), "utf8"),
      ).toBe("foreign receipt");
  }
});
test("managed installers serialize before external version detection", () => {
  const f = fixture();
  const executable = join(f.plugins, "omp-fixture");
  const conflict = join(f.plugins, "competitor.json");
  writeFileSync(
    executable,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { manageInstallation } from ${JSON.stringify(resolve(import.meta.dir, "../install.ts"))};
try { manageInstallation(${JSON.stringify(f)}); writeFileSync(${JSON.stringify(conflict)}, JSON.stringify({error:"none"})); }
catch(error) { writeFileSync(${JSON.stringify(conflict)}, JSON.stringify({error:error.message})); }
process.stdout.write("wrong-version\\n");
`,
    { mode: 0o700 },
  );
  expect(() => manageInstallation({ ...f, omp: executable })).toThrow(
    "requires OMP",
  );
  expect(JSON.parse(readFileSync(conflict, "utf8")).error).toContain(
    "already in progress",
  );
});

test.each(["18.8.9", "18.10.4", "19.0.0", "19.0.0-preview.1"])("V7 installer accepts OMP %s and restores prior profile bytes on uninstall", (version: string) => {
  const f = fixture();
  const original: string = '{"settings":{"user":{"keep":true}}}\n';
  const lock: string = join(f.plugins, "omp-plugins.lock.json");
  writeFileSync(lock, original);
  const executable: string = join(f.plugins, "omp-v7-fixture");
  writeFileSync(executable, `#!${process.execPath}
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
const plugins = ${JSON.stringify(f.plugins)};
if (process.argv[2] === "--version") process.stdout.write(${JSON.stringify("omp/")} + ${JSON.stringify(version)} + String.fromCharCode(10));
else {
  const source = process.argv[6];
  const manifest = JSON.parse(readFileSync(source + "/package.json", "utf8"));
  if (manifest.omp.extensions.length !== 1 || manifest.omp.extensions[0] !== "v7.ts") throw new Error("V7 entry not selected");
  mkdirSync(plugins + "/node_modules/@jp-skills", { recursive: true });
  symlinkSync(source, plugins + "/node_modules/@jp-skills/startup");
  writeFileSync(plugins + "/omp-plugins.lock.json", JSON.stringify({ plugins: { "@jp-skills/startup": { version: manifest.version, enabledFeatures: null, enabled: true } }, settings: { user: { keep: true } } }, null, 2));
}
`, { mode: 0o700 });
  const installed = manageInstallation({ ...f, omp: executable });
  expect(installed.action).toBe("install");
  expect(realpathSync(join(f.plugins, "node_modules/@jp-skills/startup"))).toBe(f.source);
  expect(JSON.parse(readFileSync(lock, "utf8")).plugins["@jp-skills/startup"].enabled).toBe(true);
  manageInstallation({ ...f, action: "uninstall", omp: "must-not-execute" });
  expect(readFileSync(lock, "utf8")).toBe(original);
  expect(existsSync(join(f.plugins, "node_modules/@jp-skills/startup"))).toBe(false);
});

function claudeFixture(version: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "startup-claude-install-")));
  temporary.push(root);
  const source = realpathSync(resolve(import.meta.dir, ".."));
  const skillsRoot = realpathSync(resolve(source, "../.."));
  const claudeDir = join(root, ".claude");
  mkdirSync(join(claudeDir, "hooks"), { recursive: true, mode: 0o700 });
  mkdirSync(join(claudeDir, "skills"));
  const hook = join(claudeDir, "hooks", "herdr-agent-state.sh");
  writeFileSync(hook, "#!/bin/bash\n# HERDR_INTEGRATION_ID=claude\n# HERDR_INTEGRATION_VERSION=11\n", { mode: 0o700 });
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: `bash '${hook}' session`, timeout: 10 }] }] } }), { mode: 0o600 });
  const names = readdirSync(join(skillsRoot, "skills")).filter((name) => name === "startup" || name === "hire" || name.startsWith("startup-"));
  for (const name of names) symlinkSync(join(skillsRoot, "skills", name), join(claudeDir, "skills", name));
  const claude = join(root, "claude-fixture");
  writeFileSync(claude, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(version)} + String.fromCharCode(10));\n`, { mode: 0o700 });
  return {
    root, source, skillsRoot, claudeDir, names,
    launcher: join(root, ".local/bin/startup-claude"),
    receipt: join(root, ".local/share/jp-skills/startup-claude.install.json"),
    options: { action: "install-claude" as const, source, claude, bun: process.execPath, home: root, env: { CLAUDE_CONFIG_DIR: claudeDir } },
  };
}
test.each(["2.1.302 (Claude Code)", "2.1.310 (Claude Code)", "3.0.0 (Claude Code)"])("install-claude accepts %s, writes the owned launcher and uninstalls it by receipt", (version: string) => {
  const f = claudeFixture(version);
  expect(manageClaudeInstallation(f.options)).toEqual({ action: "install-claude", launcher: f.launcher, receipt: f.receipt });
  const launcher = readFileSync(f.launcher, "utf8");
  expect(launcher).toBe(`#!/bin/sh\nexec '${process.execPath}' '${join(f.source, "claude-manager.ts")}' "$@"\n`);
  expect(statSync(f.launcher).mode & 0o777).toBe(0o755);
  expect(JSON.parse(readFileSync(f.receipt, "utf8"))).toEqual({ version: 1, source: f.source, launcher: f.launcher, sha256: createHash("sha256").update(launcher).digest("hex") });
  expect(() => manageClaudeInstallation(f.options)).toThrow("already installed");
  manageClaudeInstallation({ ...f.options, action: "uninstall-claude", claude: "must-not-execute" });
  expect(existsSync(f.launcher)).toBe(false);
  expect(existsSync(f.receipt)).toBe(false);
});
test.each([
  ["2.1.200 (Claude Code)", "found 2.1.200"],
  ["2.0.999 (Claude Code)", "found 2.0.999"],
  ["claude 2.1.302", "claude 2.1.302"],
])("install-claude rejects Claude Code version output %s before writing", (version: string, message: string) => {
  const f = claudeFixture(version);
  expect(() => manageClaudeInstallation(f.options)).toThrow(message);
  expect(existsSync(f.launcher)).toBe(false);
  expect(existsSync(f.receipt)).toBe(false);
});
test("install-claude requires an executable claude, the Herdr hook and skills from this checkout", () => {
  const missing = claudeFixture("2.1.302 (Claude Code)");
  expect(() => manageClaudeInstallation({ ...missing.options, claude: "must-not-execute" })).toThrow("requires Claude Code");
  const unregistered = claudeFixture("2.1.302 (Claude Code)");
  writeFileSync(join(unregistered.claudeDir, "settings.json"), JSON.stringify({ hooks: {} }));
  expect(() => manageClaudeInstallation(unregistered.options)).toThrow("not registered as a SessionStart hook");
  const foreign = claudeFixture("2.1.302 (Claude Code)");
  rmSync(join(foreign.claudeDir, "skills", "startup"));
  mkdirSync(join(foreign.claudeDir, "skills", "startup"));
  writeFileSync(join(foreign.claudeDir, "skills", "startup", "SKILL.md"), "foreign skill");
  expect(() => manageClaudeInstallation(foreign.options)).toThrow("skills/startup");
  const absent = claudeFixture("2.1.302 (Claude Code)");
  rmSync(join(absent.claudeDir, "skills", "hire"));
  expect(() => manageClaudeInstallation(absent.options)).toThrow("skills/hire");
  for (const f of [missing, unregistered, foreign, absent]) expect(existsSync(f.launcher)).toBe(false);
});
test("uninstall-claude refuses a changed launcher or a missing receipt and preserves both files", () => {
  const f = claudeFixture("2.1.302 (Claude Code)");
  expect(() => manageClaudeInstallation({ ...f.options, action: "uninstall-claude" })).toThrow("No owned startup-claude installation receipt");
  manageClaudeInstallation(f.options);
  writeFileSync(f.launcher, "#!/bin/sh\nexec user-edited\n");
  expect(() => manageClaudeInstallation({ ...f.options, action: "uninstall-claude" })).toThrow("changed since installation");
  expect(readFileSync(f.launcher, "utf8")).toBe("#!/bin/sh\nexec user-edited\n");
  expect(existsSync(f.receipt)).toBe(true);
});

test("saved OMP profiles are the named profile directories under the XDG and home roots", () => {
  const f = fixture();
  const home = realpathSync(mkdtempSync(join(tmpdir(), "startup-home-")));
  temporary.push(home);
  mkdirSync(join(home, ".omp", "profiles", "work"), { recursive: true });
  mkdirSync(join(home, ".omp", "profiles", "Bad Name"), { recursive: true });
  writeFileSync(join(home, ".omp", "profiles", "stray-file"), "");
  expect(savedOmpProfiles(f.env, home)).toEqual(["isolated-test", "work"]);
  expect(savedOmpProfiles({}, home)).toEqual(["work"]);
  expect(() => savedOmpProfiles({ PI_CONFIG_DIR: "../x" }, home)).toThrow(StartupInstallError);
});

test("profile choice uses an explicit name, the only saved profile, or asks among several", async () => {
  const ask = async (saved: readonly string[]): Promise<string> => saved[1] ?? "";
  expect(await chooseProfile({ saved: ["a", "b"], requested: "z", ask })).toBe("z");
  expect(await chooseProfile({ saved: ["only"], requested: null, ask })).toBe("only");
  expect(await chooseProfile({ saved: ["a", "b"], requested: null, ask })).toBe("b");
  await expect(chooseProfile({ saved: [], requested: null, ask })).rejects.toThrow(StartupInstallError);
  await expect(chooseProfile({ saved: ["a", "b"], requested: null, ask: async () => "c" })).rejects.toThrow(/not a saved profile/);
});

test("a numbered answer picks one saved profile and anything else is refused", () => {
  expect(pickProfile(["a", "b"], "2")).toBe("b");
  for (const answer of ["", "0", "3", "b", "1.5"]) expect(() => pickProfile(["a", "b"], answer)).toThrow(StartupInstallError);
});
