import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { executionSkillsHome, assertStartupPath, bootSelection, canonicalStartupRoot, persistBinding, startupsDirectory, StartupBootError, type Selection } from "./src/boot";
import { claudeIntegrationPath, claudeManagerArgs, requireClaudeTrust, writeClaudeFiles } from "./src/claude-launch";
import type { Environment } from "./src/employee-entry";
import { scopeSchema } from "./src/contracts";
import { loadProfile, profileText } from "./src/profiles";
import { prepareManagerLaunch, readPrivateJson, parseRuntimeHostConfig } from "./src/v7-launch";

const bindingSchema = z.strictObject({ scope: scopeSchema, executionLimit: z.number().int().positive().safe().nullable() });
export function managerLaunch(input: Readonly<{ environment: Environment; cwd: string; skillsHome: string; startupRoot: string; skillsRoot: string; bun: string }>): readonly string[] {
  const paneId: string | undefined = input.environment.HERDR_PANE_ID?.trim();
  if (input.environment.HERDR_ENV !== "1" || paneId === undefined || paneId === "")
    throw new StartupBootError("startup-claude must run inside a Herdr pane (HERDR_ENV=1 and HERDR_PANE_ID)");
  const name: string = z.string().regex(/^[a-zA-Z0-9_-]+$/).parse(input.environment.STARTUP_NAME);
  const requestedRoot: string = input.environment.STARTUP_ROOT ?? input.startupRoot;
  if (!isAbsolute(requestedRoot)) throw new StartupBootError(`STARTUP_ROOT must be absolute: ${requestedRoot}`);
  const root: string = canonicalStartupRoot(resolve(requestedRoot), true);
  let managerSession: string = randomUUID();
  const bindingPath: string = join(root, "binding.json");
  assertStartupPath(root, bindingPath, "file");
  if (existsSync(bindingPath)) managerSession = bindingSchema.parse(readPrivateJson(bindingPath)).scope.managerSession;
  const selection: Selection | null = bootSelection({
    cwd: input.cwd, skillsHome: input.skillsHome, startupRoot: root,
    skillsRoot: input.skillsRoot, host: hostname(), managerSession, command: null, explicitName: name, executionLimit: null,
  });
  if (selection === null) throw new StartupBootError(`No Startup selected for ${name}`);
  if (input.environment.CLAUDE_CONFIG_DIR !== undefined && resolve(input.environment.CLAUDE_CONFIG_DIR) !== selection.startupRoot)
    throw new StartupBootError("CLAUDE_CONFIG_DIR conflicts with the selected Startup root");
  const claudeEnvironment: Environment = { ...input.environment, CLAUDE_CONFIG_DIR: selection.startupRoot };
  const integration: string = claudeIntegrationPath(claudeEnvironment);
  void integration;
  const claudeJson: string = join(selection.startupRoot, ".claude.json");
  requireClaudeTrust({ boundRoot: selection.boundRoot, startupRoot: selection.startupRoot, claudeJson });

  const savedPath: string = join(selection.startupRoot, "runtime-config.json");
  assertStartupPath(selection.startupRoot, savedPath, "file");
  const saved = existsSync(savedPath) ? parseRuntimeHostConfig(readPrivateJson(savedPath)) : null;
  if (saved !== null && (!("harness" in saved) || saved.harness !== "claude"))
    throw new StartupBootError(`Startup ${saved.name} is bound to OMP; reopen its manager with OMP instead of startup-claude`);
  if (saved !== null && (saved.skillsHome !== selection.skillsHome || saved.startupRoot !== selection.startupRoot || saved.stateDirectory !== selection.startupRoot || saved.boundRoot !== selection.boundRoot || saved.managerSession !== selection.managerSession))
    throw new StartupBootError(`Saved Claude runtime does not match its Startup root binding: ${savedPath}`);
  if (saved !== null && saved.managerPaneId !== paneId)
    throw new StartupBootError(`Startup ${saved.name} manager belongs to Herdr pane ${saved.managerPaneId}; run startup-claude in that pane`);

  persistBinding(selection);
  const files = writeClaudeFiles({ startupRoot: selection.startupRoot, skillsRoot: input.skillsRoot, bun: input.bun });
  const promptFile: string = join(selection.startupRoot, "startup", "claude", "manager.prompt.md");
  assertStartupPath(selection.startupRoot, promptFile, "file");
  const prompt: string = profileText(loadProfile({ skillsRoot: input.skillsRoot, role: "manager", employeeId: "manager", generation: 1 }));
  if (!existsSync(promptFile)) writeFileSync(promptFile, prompt, { flag: "wx", mode: 0o600 });
  const stat = lstatSync(promptFile);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0 || readFileSync(promptFile, "utf8") !== prompt)
    throw new StartupBootError(`Claude manager prompt differs from the canonical manager role and loop; inspect and remove it explicitly: ${promptFile}`);
  const session: Readonly<{ kind: "new" | "resume"; id: string }> = saved === null
    ? { kind: "new", id: selection.managerSession }
    : { kind: "resume", id: saved.managerSession };
  const settings = saved === null ? prepareManagerLaunch({ scope: { skillsHome: selection.skillsHome, startupRoot: selection.startupRoot, host: selection.host, name: selection.name, boundRoot: selection.boundRoot, managerSession: selection.managerSession }, harness: "claude", now: Date.now, expectedControl: null }) : null;
  return claudeManagerArgs({ session, model: settings?.requested.model.value ?? null, effort: settings?.requested.effort.value ?? null, promptFile, ...files });
}
async function launch(): Promise<void> {
  if (process.argv.length > 2) throw new StartupBootError("startup-claude takes no arguments; set STARTUP_NAME to choose a Startup");
  const environment: Environment = process.env;
  const skillsHome: string = executionSkillsHome(environment);
  const skillsRoot: string = resolve(environment.STARTUP_SKILLS_ROOT ?? join(import.meta.dir, "../.."));
  const requestedRoot: string = environment.STARTUP_ROOT ?? join(startupsDirectory(skillsHome), z.string().parse(environment.STARTUP_NAME));
  const args: readonly string[] = managerLaunch({
    environment, cwd: process.cwd(), skillsHome, startupRoot: requestedRoot,
    bun: process.execPath, skillsRoot,
  });
  const startupRoot: string = canonicalStartupRoot(resolve(requestedRoot), false);
  const child = Bun.spawn(["claude", ...args], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, JP_SKILLS_HOME: skillsHome, STARTUP_ROOT: startupRoot, CLAUDE_CONFIG_DIR: startupRoot },
  });
  process.exit(await child.exited);
}
if (import.meta.main) await launch().catch((error: unknown) => {
  process.stderr.write(`startup-claude: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
