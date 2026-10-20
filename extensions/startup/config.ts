import { z } from "zod";
import { executionSkillsHome } from "./src/boot";
import { RuntimeLaunchError } from "./src/v7-launch";
import { listStartups, readStartupConfig, StartupConfigError } from "./src/startup-config";

const nameSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const usage: string = "usage: config.ts list | get NAME [KEY]";
const commandSchema = z.union([
  z.tuple([z.literal("list")]),
  z.tuple([z.literal("get"), nameSchema]),
  z.tuple([z.literal("get"), nameSchema, z.string().min(1)]),
]);
function run(): unknown {
  const parsed = commandSchema.safeParse(process.argv.slice(2));
  if (!parsed.success) throw new StartupConfigError(usage);
  const command = parsed.data;
  const home: string = executionSkillsHome(process.env);
  if (command[0] === "list") return listStartups(home);
  return readStartupConfig({ home, name: command[1], key: command[2] ?? null });
}
try {
  process.stdout.write(JSON.stringify(run(), null, 2) + "\n");
} catch (error: unknown) {
  if (!(error instanceof StartupConfigError || error instanceof RuntimeLaunchError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
