import { existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { shellQuote } from "../install";
import { isLegacyBinding, ompProfileSchema, startupsDirectory } from "./boot";
import type { Json } from "./contracts";
import { intentSchema, parseRuntimeHostConfig, processAlive, readPrivateJson, type RuntimeHostConfig } from "./v7-launch";

export class StartupConfigError extends Error {}
export type StartupSummary = Readonly<{ name: string; harness: "omp" | "claude"; profile: string }>;
export type ProfileSwitch = Readonly<{ name: string; previous: string; profile: string; resume: string }>;
const nameSchema = /^[a-zA-Z0-9_-]+$/;
function configPath(home: string, name: string): string {
  if (!nameSchema.test(name)) throw new StartupConfigError(`Startup names contain letters, digits, underscore or hyphen; received "${name}"`);
  return join(startupsDirectory(home), name, "runtime-config.json");
}
function loadConfig(home: string, name: string): RuntimeHostConfig {
  const path: string = configPath(home, name);
  if (!existsSync(path)) throw new StartupConfigError(`No saved Startup named ${name} under ${startupsDirectory(home)}; run list to see saved Startups`);
  if (isLegacyBinding(dirname(path))) throw new StartupConfigError(`Startup ${name} was saved in an older format that this version does not read: ${path}`);
  return parseRuntimeHostConfig(readPrivateJson(path));
}
function harnessOf(config: RuntimeHostConfig): "omp" | "claude" {
  return "harness" in config ? "claude" : "omp";
}
export function listStartups(home: string): readonly StartupSummary[] {
  const root: string = startupsDirectory(home);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && nameSchema.test(entry.name) && existsSync(configPath(home, entry.name)) && !isLegacyBinding(join(root, entry.name)))
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const config: RuntimeHostConfig = loadConfig(home, name);
      return { name, harness: harnessOf(config), profile: config.profile };
    });
}
export function readStartupConfig(input: Readonly<{ home: string; name: string; key: string | null }>): Json {
  const { managerCredential: _credential, ...redacted } = loadConfig(input.home, input.name);
  if (input.key === null) return redacted;
  if (!Object.hasOwn(redacted, input.key))
    throw new StartupConfigError(`Startup ${input.name} has no readable setting ${input.key}; readable settings: ${Object.keys(redacted).join(", ")}`);
  return (redacted as Readonly<Record<string, Json>>)[input.key] as Json;
}
function requireStoppedCoordinator(stateDirectory: string, name: string): void {
  if (existsSync(join(stateDirectory, "runtime-launch.lock")))
    throw new StartupConfigError(`Startup ${name} has a coordinator launch in progress; wait for it to finish, then retry`);
  const intentPath: string = join(stateDirectory, "runtime-launch.json");
  if (!existsSync(intentPath)) return;
  const intent = intentSchema.parse(readPrivateJson(intentPath));
  if (intent.state === "prepared")
    throw new StartupConfigError(`Startup ${name} has an uncertain coordinator launch; preserve ${intentPath} and reconcile it before switching profiles`);
  if (processAlive(intent.pid))
    throw new StartupConfigError(`Startup ${name} coordinator pid ${intent.pid} is running with the old profile in memory; stop that process, then retry`);
}
export function requireSwitchable(input: Readonly<{ home: string; name: string }>): RuntimeHostConfig {
  const config: RuntimeHostConfig = loadConfig(input.home, input.name);
  if (harnessOf(config) === "claude")
    throw new StartupConfigError(`Startup ${input.name} has a Claude Code manager, which takes its OMP profile from the OMP_PROFILE of the shell that starts it; start startup-claude under that profile instead`);
  requireStoppedCoordinator(dirname(configPath(input.home, input.name)), input.name);
  return config;
}
export function setStartupProfile(input: Readonly<{ home: string; name: string; profile: string; saved: readonly string[] }>): ProfileSwitch {
  const config: RuntimeHostConfig = requireSwitchable(input);
  const profile: string = ompProfileSchema.parse(input.profile);
  if (profile !== "default" && !input.saved.includes(profile))
    throw new StartupConfigError(`${profile} is not a saved OMP profile; saved OMP profiles: ${input.saved.join(", ")}`);
  const resume: string = `OMP_PROFILE=${profile} omp ${profile === "default" ? "" : `--profile ${profile} `}--resume ${shellQuote(config.managerFile)}`;
  const result: ProfileSwitch = { name: input.name, previous: config.profile, profile, resume };
  if (config.profile === profile) return result;
  const path: string = configPath(input.home, input.name);
  const temporary: string = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...config, profile }), { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
  return result;
}
