import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { askProfile, chooseProfile, ompProfileSchema, savedOmpProfiles, StartupInstallError } from "./install";
import { executionConfigHome } from "./src/boot";
import { RuntimeLaunchError } from "./src/v7-launch";
import { listStartups, readStartupConfig, requireSwitchable, setStartupProfile, StartupConfigError } from "./src/startup-config";

const nameSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const usage: string = "usage: config.ts profiles | list | get NAME [KEY] | set NAME profile [PROFILE]";
const commandSchema = z.union([
  z.tuple([z.literal("profiles")]),
  z.tuple([z.literal("list")]),
  z.tuple([z.literal("get"), nameSchema]),
  z.tuple([z.literal("get"), nameSchema, z.string().min(1)]),
  z.tuple([z.literal("set"), nameSchema, z.literal("profile")]),
  z.tuple([z.literal("set"), nameSchema, z.literal("profile"), ompProfileSchema]),
]);
async function run(): Promise<unknown> {
  const parsed = commandSchema.safeParse(process.argv.slice(2));
  if (!parsed.success) throw new StartupConfigError(usage);
  const command = parsed.data;
  const home: string = resolve(process.env.JP_SKILLS_HOME ?? join(executionConfigHome(process.env.XDG_CONFIG_HOME), "jp-skills"));
  const saved: readonly string[] = savedOmpProfiles(process.env, homedir());
  if (command[0] === "profiles") return saved;
  if (command[0] === "list") return listStartups(home);
  if (command[0] === "get") return readStartupConfig({ home, name: command[1], key: command[2] ?? null });
  requireSwitchable({ home, name: command[1] });
  return setStartupProfile({ home, name: command[1], profile: await chooseProfile({ saved, requested: command[3] ?? null, ask: askProfile }), saved });
}
try {
  process.stdout.write(JSON.stringify(await run(), null, 2) + "\n");
} catch (error: unknown) {
  if (!(error instanceof StartupConfigError || error instanceof StartupInstallError || error instanceof RuntimeLaunchError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
