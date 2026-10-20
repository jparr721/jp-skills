import { homedir } from "node:os";
import { z } from "zod";
import { savedOmpProfiles, StartupInstallError } from "./install";
import { executionSkillsHome, ompProfileSchema } from "./src/boot";
import { RuntimeLaunchError } from "./src/v7-launch";
import { listStartups, readStartupConfig, setStartupProfile, StartupConfigError } from "./src/startup-config";

const nameSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const usage: string = "usage: config.ts profiles | list | get NAME [KEY] | set NAME profile PROFILE";
const commandSchema = z.union([
  z.tuple([z.literal("profiles")]),
  z.tuple([z.literal("list")]),
  z.tuple([z.literal("get"), nameSchema]),
  z.tuple([z.literal("get"), nameSchema, z.string().min(1)]),
  z.tuple([z.literal("set"), nameSchema, z.literal("profile"), ompProfileSchema]),
]);
function run(): unknown {
  const parsed = commandSchema.safeParse(process.argv.slice(2));
  if (!parsed.success) throw new StartupConfigError(usage);
  const command = parsed.data;
  const home: string = executionSkillsHome(process.env);
  const saved: readonly string[] = savedOmpProfiles(process.env, homedir());
  if (command[0] === "profiles") return saved;
  if (command[0] === "list") return listStartups(home);
  if (command[0] === "get") return readStartupConfig({ home, name: command[1], key: command[2] ?? null });
  return setStartupProfile({ home, name: command[1], profile: command[3], saved });
}
try {
  process.stdout.write(JSON.stringify(run(), null, 2) + "\n");
} catch (error: unknown) {
  if (!(error instanceof StartupConfigError || error instanceof StartupInstallError || error instanceof RuntimeLaunchError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
