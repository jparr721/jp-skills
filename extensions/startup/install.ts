import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  unlinkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";

export class StartupInstallError extends Error {}
const packageName = "@jp-skills/startup";
export const ompProfileSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
  .refine(
    (value) => !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value),
  );
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
export function pluginsDirectory(
  profile: string,
  env: NodeJS.ProcessEnv,
): string {
  ompProfileSchema.parse(profile);
  const configName = env.PI_CONFIG_DIR ?? ".omp";
  if (
    !/^[a-zA-Z0-9._-]+$/.test(configName) ||
    configName === "." ||
    configName === ".."
  )
    throw new StartupInstallError(
      "PI_CONFIG_DIR must be a single directory name under the real home",
    );
  const xdg = env.XDG_DATA_HOME
    ? join(resolve(env.XDG_DATA_HOME), "omp", "profiles", profile)
    : null;
  return join(
    xdg !== null &&
      existsSync(xdg) &&
      (process.platform === "darwin" || process.platform === "linux")
      ? xdg
      : join(homedir(), configName, "profiles", profile),
    "plugins",
  );
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
      ["--profile", profile, "plugin", "link", source],
      { env: options.env, encoding: "utf8" },
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
if (import.meta.main) {
  const [action, profile] = z
    .tuple([z.enum(["install", "uninstall"]), ompProfileSchema])
    .parse(process.argv.slice(2));
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
