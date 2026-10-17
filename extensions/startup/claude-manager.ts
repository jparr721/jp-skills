import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { bootSelection, StartupBootError, type Selection } from "./src/boot";
import { claudeManagerArgs, requireClaudeTrust, writeClaudeFiles } from "./src/claude-launch";
import { startupHome } from "./src/claude-waiter";
import type { Environment } from "./src/employee-entry";
import { loadProfile, profileText } from "./src/profiles";
import { readPrivateJson, parseRuntimeHostConfig } from "./src/v7-launch";

export function managerLaunch(input: Readonly<{ environment: Environment; cwd: string; home: string; skillsRoot: string; bun: string; claudeJson: string }>): readonly string[] {
  const paneId: string | undefined = input.environment.HERDR_PANE_ID?.trim();
  if (input.environment.HERDR_ENV !== "1" || paneId === undefined || paneId === "")
    throw new StartupBootError("startup-claude must run inside a Herdr pane (HERDR_ENV=1 and HERDR_PANE_ID)");
  const selection: Selection | null = bootSelection({ cwd: input.cwd, home: input.home, skillsRoot: input.skillsRoot, command: null, explicitName: input.environment.STARTUP_NAME ?? null, executionLimit: null });
  const savedPath: string | null = selection === null ? null : join(selection.home, "startup", selection.name, "runtime-config.json");
  let session: Readonly<{ kind: "new" | "resume"; id: string }> = { kind: "new", id: randomUUID() };
  if (savedPath !== null && existsSync(savedPath)) {
    const saved = parseRuntimeHostConfig(readPrivateJson(savedPath));
    if (!("harness" in saved)) throw new StartupBootError(`Startup ${saved.name} is bound to OMP; reopen its manager with OMP instead of startup-claude`);
    if (saved.managerPaneId !== paneId) throw new StartupBootError(`Startup ${saved.name} manager belongs to Herdr pane ${saved.managerPaneId}; run startup-claude in that pane`);
    session = { kind: "resume", id: saved.managerSession };
  }
  requireClaudeTrust({ boundRoot: selection?.boundRoot ?? realpathSync(input.cwd), claudeJson: input.claudeJson });
  const files = writeClaudeFiles({ home: input.home, skillsRoot: input.skillsRoot, bun: input.bun });
  const promptFile: string = join(input.home, "startup", "claude", "manager.prompt.md");
  const prompt: string = profileText(loadProfile({ skillsRoot: input.skillsRoot, role: "manager", employeeId: "manager", generation: 1 }));
  if (!existsSync(promptFile)) writeFileSync(promptFile, prompt, { flag: "wx", mode: 0o600 });
  const stat = lstatSync(promptFile);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0 || readFileSync(promptFile, "utf8") !== prompt)
    throw new StartupBootError(`Claude manager prompt differs from the canonical manager role and loop; inspect and remove it explicitly: ${promptFile}`);
  return claudeManagerArgs({ session, promptFile, ...files });
}
async function launch(): Promise<void> {
  if (process.argv.length > 2) throw new StartupBootError("startup-claude takes no arguments; set STARTUP_NAME to choose a Startup");
  const environment: Environment = process.env;
  const args: readonly string[] = managerLaunch({
    environment, cwd: process.cwd(), home: startupHome(environment), bun: process.execPath,
    skillsRoot: resolve(environment.STARTUP_SKILLS_ROOT ?? join(import.meta.dir, "../..")),
    claudeJson: environment.CLAUDE_CONFIG_DIR === undefined ? join(homedir(), ".claude.json") : join(environment.CLAUDE_CONFIG_DIR, ".claude.json"),
  });
  const child = Bun.spawn(["claude", ...args], { stdio: ["inherit", "inherit", "inherit"] });
  process.exit(await child.exited);
}
if (import.meta.main) await launch().catch((error: unknown) => {
  process.stderr.write(`startup-claude: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
