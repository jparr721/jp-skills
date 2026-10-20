import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isLegacyBinding, startupsDirectory } from "./boot";
import type { Json } from "./contracts";
import { parseRuntimeHostConfig, readPrivateJson, type RuntimeHostConfig } from "./v7-launch";

export class StartupConfigError extends Error {}
export type StartupSummary = Readonly<{ name: string; harness: "omp" | "claude"; profile: string }>;
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
