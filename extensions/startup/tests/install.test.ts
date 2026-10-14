import { afterEach, expect, test } from "bun:test";
import {
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
import { manageInstallation, pluginsDirectory } from "../install";
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
