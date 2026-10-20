import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  unlinkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ompDirectories, ompProfileSchema } from "./src/boot";
import { claudeIntegrationPath } from "./src/claude-launch";

export class StartupInstallError extends Error {}
const packageName = "@jp-skills/startup";
const configSchema = z.strictObject({
  plugins: z.record(z.string(), z.unknown()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
const receiptSchema = z.strictObject({
  version: z.literal(1),
  source: z.string(),
  profile: z.string(),
  plugins: z.string(),
  before: z.string().nullable(),
  after: z.string(),
});
export type InstallOptions = Readonly<{
  action: "install" | "uninstall";
  profile: string;
  source: string;
  omp: string;
  env: NodeJS.ProcessEnv;
}>;
export function profileFromAnswer(answer: string): string {
  const name: string = answer.trim();
  if (name === "") return "default";
  const parsed = ompProfileSchema.safeParse(name);
  if (!parsed.success)
    throw new StartupInstallError(
      `"${name}" is not a valid OMP profile name; use lowercase letters, digits, dots, underscores or hyphens, at most 64 characters`,
    );
  return parsed.data;
}
export async function askProfile(question: string): Promise<string> {
  if (!process.stdin.isTTY) return "default";
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  // Bun leaves question() pending on Ctrl-C and Ctrl-D, so a closed terminal must cancel the prompt.
  const cancelled = new Promise<never>((_, reject) => {
    terminal.once("close", () => reject(new StartupInstallError("Profile prompt cancelled")));
  });
  terminal.once("SIGINT", () => terminal.close());
  try {
    return profileFromAnswer(await Promise.race([terminal.question(question), cancelled]));
  } finally {
    terminal.close();
  }
}
export function pluginsDirectory(
  profile: string,
  env: NodeJS.ProcessEnv,
): string {
  ompProfileSchema.parse(profile);
  return join(ompDirectories(env, profile).root, "plugins");
}
function checkParents(path: string): string {
  const identities: string[] = [];
  let current = path;
  while (true) {
    const stat = lstatSync(current, { throwIfNoEntry: false });
    identities.push(
      `${current}:${stat ? `${stat.dev}:${stat.ino}` : "absent"}`,
    );
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new StartupInstallError(
          `Installation parent must be a real directory: ${current}`,
        );
    }
    const parent = dirname(current);
    if (parent === current) return JSON.stringify(identities);
    current = parent;
  }
}
function readRegular(path: string): string | null {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new StartupInstallError(
      `Installation file ownership conflict: ${path}`,
    );
  return readFileSync(path, "utf8");
}
function replace(path: string, content: string): void {
  const temporary = path + ".startup-tmp";
  writeFileSync(temporary, content, {
    flag: "wx",
    mode: lstatSync(path).mode & 0o777,
  });
  renameSync(temporary, path);
}
export function manageInstallation(options: InstallOptions): Readonly<{
  profile: string;
  plugins: string;
  source: string;
  action: string;
}> {
  const profile = ompProfileSchema.parse(options.profile);
  const source = realpathSync(options.source);
  const manifest = z
    .object({
      name: z.literal(packageName),
      version: z.string(),
      omp: z.object({ extensions: z.tuple([z.literal("v7.ts")]) }),
    })
    .parse(JSON.parse(readFileSync(join(source, "package.json"), "utf8")));
  const plugins = pluginsDirectory(profile, options.env);
  checkParents(join(plugins, "node_modules", "@jp-skills"));
  mkdirSync(plugins, { recursive: true });
  const mutex = join(plugins, ".jp-skills-startup.install.lock");
  let descriptor: number;
  try {
    descriptor = openSync(mutex, "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new StartupInstallError(
        `Startup installation already in progress: ${mutex}`,
      );
    throw error;
  }
  const owner = fstatSync(descriptor);
  try {
    const parents = checkParents(join(plugins, "node_modules", "@jp-skills"));
    const lock = join(plugins, "omp-plugins.lock.json");
    const receiptPath = join(plugins, "jp-skills-startup.install.json");
    const link = join(plugins, "node_modules", "@jp-skills", "startup");
    const priorReceipt = readRegular(receiptPath);
    const current = readRegular(lock);
    const config = configSchema.parse(
      current === null ? {} : JSON.parse(current),
    );
    const linked = lstatSync(link, { throwIfNoEntry: false });
    const receipt =
      priorReceipt === null
        ? null
        : receiptSchema.parse(JSON.parse(priorReceipt));
    if (receipt !== null) {
      if (
        receipt.source !== source ||
        receipt.profile !== profile ||
        receipt.plugins !== plugins ||
        (linked !== undefined &&
          (!linked.isSymbolicLink() || realpathSync(link) !== source)) ||
        (current !== receipt.after && current !== receipt.before)
      )
        throw new StartupInstallError(
          "Startup installation ownership changed; preserve files and reconcile the installation receipt before retrying",
        );
      if (options.action === "uninstall") {
        if (current !== receipt.before) {
          if (receipt.before === null) rmSync(lock);
          else replace(lock, receipt.before);
        }
        if (linked !== undefined) rmSync(link);
        rmSync(receiptPath);
      }
      if (
        options.action === "install" &&
        (!linked || current !== receipt.after)
      )
        throw new StartupInstallError(
          "Interrupted Startup installation; uninstall the owned partial installation before retrying",
        );
      return { profile, plugins, source, action: options.action };
    }
    if (options.action === "uninstall")
      throw new StartupInstallError(
        "No owned Startup installation receipt; refusing to remove another installation",
      );
    if (
      linked ||
      config.plugins?.[packageName] !== undefined ||
      config.settings?.[packageName] !== undefined
    )
      throw new StartupInstallError(
        "Startup plugin name or path is already owned; refusing native link replacement",
      );
    const dependencies = readRegular(join(plugins, "package.json"));
    if (
      dependencies !== null &&
      z
        .object({ dependencies: z.record(z.string(), z.unknown()).optional() })
        .parse(JSON.parse(dependencies)).dependencies?.[packageName] !==
        undefined
    )
      throw new StartupInstallError(
        "Startup plugin already exists in native package dependencies",
      );
    const version = spawnSync(options.omp, ["--version"], {
      env: options.env,
      encoding: "utf8",
    });
    if (version.status !== 0 || !/^omp\/\S+$/.test(version.stdout.trim()))
      throw new StartupInstallError(
        `Installer requires OMP with a working --version command; executable=${options.omp}, status=${version.status}, stdout=${version.stdout}, stderr=${version.stderr}`,
      );
    if (
      checkParents(join(plugins, "node_modules", "@jp-skills")) !== parents ||
      lstatSync(link, { throwIfNoEntry: false }) !== undefined ||
      readRegular(lock) !== current ||
      readRegular(join(plugins, "package.json")) !== dependencies ||
      readRegular(receiptPath) !== priorReceipt
    )
      throw new StartupInstallError(
        "Startup installation preimage changed during version detection; preserve files and retry after reconciling ownership",
      );
    const expected = {
      plugins: {
        ...config.plugins,
        [packageName]: {
          version: manifest.version,
          enabledFeatures: null,
          enabled: true,
        },
      },
      settings: config.settings ?? {},
    };
    const expectedBytes = JSON.stringify(expected, null, 2);
    writeFileSync(
      receiptPath,
      JSON.stringify(
        {
          version: 1,
          source,
          profile,
          plugins,
          before: current,
          after: expectedBytes,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    const command = spawnSync(
      options.omp,
      ["plugin", "link", source],
      { env: { ...options.env, OMP_PROFILE: profile }, encoding: "utf8" },
    );
    const after = readRegular(lock);
    if (
      command.status !== 0 ||
      after !== expectedBytes ||
      !lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() ||
      realpathSync(link) !== source
    ) {
      throw new StartupInstallError(
        `Native link did not produce the expected owned installation. Preserve partial files for reconciliation: profile=${profile}, plugins=${plugins}, status=${command.status}, stdout=${command.stdout}, stderr=${command.stderr}`,
      );
    }
    return { profile, plugins, source, action: options.action };
  } finally {
    closeSync(descriptor);
    const retained = lstatSync(mutex, { throwIfNoEntry: false });
    if (retained?.dev === owner.dev && retained.ino === owner.ino)
      unlinkSync(mutex);
    else
      throw new StartupInstallError(
        `Startup installation mutex ownership changed; preserve files: ${mutex}`,
      );
  }
}
const claudeReceiptSchema = z.strictObject({
  version: z.literal(1),
  source: z.string(),
  launcher: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ClaudeInstallOptions = Readonly<{
  action: "install-claude" | "uninstall-claude";
  source: string;
  claude: string;
  bun: string;
  home: string;
  env: NodeJS.ProcessEnv;
}>;
const minimumClaude: readonly [number, number, number] = [2, 1, 302];
function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function requireClaudeVersion(claude: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync(claude, ["--version"], { env, encoding: "utf8" });
  const output: string = (result.stdout ?? "").trim();
  const match = /^(\d+)\.(\d+)\.(\d+) \(Claude Code\)$/.exec(output);
  if (result.status !== 0 || match === null)
    throw new StartupInstallError(
      `Installer requires Claude Code with a working --version command; executable=${claude}, status=${result.status}, stdout=${output}, stderr=${result.stderr ?? ""}`,
    );
  const found: readonly number[] = match.slice(1, 4).map(Number);
  const index: number = found.findIndex((part, position) => part !== minimumClaude[position]);
  if (index !== -1 && (found[index] ?? 0) < (minimumClaude[index] ?? 0))
    throw new StartupInstallError(
      `Startup requires Claude Code ${minimumClaude.join(".")} or newer; found ${found.join(".")}`,
    );
}
function requireCheckoutSkills(skillsRoot: string, claudeDirectory: string): void {
  const names: readonly string[] = readdirSync(join(skillsRoot, "skills")).filter(
    (name) => name === "startup" || name === "hire" || name.startsWith("startup-"),
  );
  for (const name of names) {
    const installed = join(claudeDirectory, "skills", name);
    const expected = realpathSync(join(skillsRoot, "skills", name));
    if (!existsSync(join(installed, "SKILL.md")) || realpathSync(installed) !== expected)
      throw new StartupInstallError(
        `Claude Code skill ${installed} must resolve to this checkout's ${expected}; link it before installing startup-claude`,
      );
  }
}
export function manageClaudeInstallation(options: ClaudeInstallOptions): Readonly<{
  action: string;
  launcher: string;
  receipt: string;
}> {
  const source = realpathSync(options.source);
  const launcher = join(options.home, ".local", "bin", "startup-claude");
  const receiptPath = join(options.home, ".local", "share", "jp-skills", "startup-claude.install.json");
  const result = { action: options.action, launcher, receipt: receiptPath };
  if (options.action === "uninstall-claude") {
    const prior = readRegular(receiptPath);
    if (prior === null)
      throw new StartupInstallError(
        "No owned startup-claude installation receipt; refusing to remove another launcher",
      );
    const receipt = claudeReceiptSchema.parse(JSON.parse(prior));
    const current = readRegular(launcher);
    if (receipt.launcher !== launcher || current === null || sha256(current) !== receipt.sha256)
      throw new StartupInstallError(
        `startup-claude launcher changed since installation; preserve ${launcher} and ${receiptPath} and reconcile them explicitly`,
      );
    rmSync(launcher);
    rmSync(receiptPath);
    return result;
  }
  requireClaudeVersion(options.claude, options.env);
  claudeIntegrationPath(options.env);
  requireCheckoutSkills(realpathSync(join(source, "..", "..")), options.env.CLAUDE_CONFIG_DIR ?? join(options.home, ".claude"));
  const bun = spawnSync(options.bun, ["--version"], { env: options.env, encoding: "utf8" });
  if (bun.status !== 0 || !/^\d+\.\d+\.\d+/.test((bun.stdout ?? "").trim()))
    throw new StartupInstallError(
      `Installer requires Bun at ${options.bun}; status=${bun.status}, stdout=${bun.stdout ?? ""}, stderr=${bun.stderr ?? ""}`,
    );
  if (lstatSync(launcher, { throwIfNoEntry: false }) !== undefined || lstatSync(receiptPath, { throwIfNoEntry: false }) !== undefined)
    throw new StartupInstallError(
      `startup-claude is already installed or its path is owned elsewhere; run uninstall-claude or remove ${launcher} explicitly`,
    );
  const content = `#!/bin/sh\nexec ${shellQuote(options.bun)} ${shellQuote(join(source, "claude-manager.ts"))} "$@"\n`;
  mkdirSync(dirname(launcher), { recursive: true });
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(launcher, content, { flag: "wx", mode: 0o755 });
  chmodSync(launcher, 0o755);
  writeFileSync(
    receiptPath,
    JSON.stringify({ version: 1, source, launcher, sha256: sha256(content) }, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return result;
}
if (import.meta.main && ["install-claude", "uninstall-claude"].includes(process.argv[2] ?? "")) {
  const [action] = z
    .tuple([z.enum(["install-claude", "uninstall-claude"])])
    .parse(process.argv.slice(2));
  process.stdout.write(
    JSON.stringify(
      manageClaudeInstallation({
        action,
        source: import.meta.dir,
        claude: "claude",
        bun: process.execPath,
        home: homedir(),
        env: process.env,
      }),
    ) + "\n",
  );
} else if (import.meta.main) {
  const [action, requested] = z
    .tuple([z.enum(["install", "uninstall"]), ompProfileSchema.optional()])
    .parse(process.argv.slice(2));
  const profile: string =
    requested ?? (await askProfile("OMP profile name (existing or new), or press Enter for the default profile: "));
  process.stdout.write(
    JSON.stringify(
      manageInstallation({
        action,
        profile,
        source: import.meta.dir,
        omp: process.env.OMP_BINARY ?? "omp",
        env: process.env,
      }),
    ) + "\n",
  );
}
