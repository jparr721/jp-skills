import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isLegacyBinding, startupsDirectory } from "./boot";
import type { Json } from "./contracts";
import { parseRuntimeHostConfig, readPrivateJson, RuntimeLaunchError, type RuntimeHostConfig } from "./v7-launch";

export class StartupConfigError extends Error {}
export type StartupSummary = Readonly<{ name: string; harness: "omp" | "claude"; profile: string }>;
const nameSchema = /^[a-zA-Z0-9_-]+$/;
function configPath(home: string, name: string): string {
  if (!nameSchema.test(name)) throw new StartupConfigError(`Startup names contain letters, digits, underscore or hyphen; received "${name}"`);
  return join(startupsDirectory(home), name, "runtime-config.json");
}
// A runtime-config positively recognizable as pre-skillsHome shape: old `home`
// plus corroborating old roots, and none of the current root keys. Anything
// else (bare stubs, missing roots without `home`, extra keys on current
// records) is malformed current data and must fail strict.
function isLegacyRuntimeConfig(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (!("home" in value)) return false;
  if ("skillsHome" in value || "startupRoot" in value || "backend" in value || "harness" in value) return false;
  if (typeof value.home !== "string") return false;
  return "stateDirectory" in value && "boundRoot" in value && "skillsRoot" in value && "socketPath" in value && "managerSession" in value;
}
function invalidConfig(name: string, path: string, error: unknown): StartupConfigError {
  return new StartupConfigError(`Startup ${name} saved config is invalid and needs explicit recovery: ${path}: ${error instanceof Error ? error.message : String(error)}`);
}
// Enumeration skips positively-recognized legacy only. Unreadable or malformed
// records stay present so loadConfig fails them loudly with name and path.
function skipsLegacy(directory: string, configFile: string): boolean {
  try {
    if (isLegacyBinding(directory)) return true;
  } catch {
    return false;
  }
  try {
    return isLegacyRuntimeConfig(readPrivateJson(configFile));
  } catch {
    return false;
  }
}
function loadConfig(home: string, name: string): RuntimeHostConfig {
  const path: string = configPath(home, name);
  if (!existsSync(path)) throw new StartupConfigError(`No saved Startup named ${name} under ${startupsDirectory(home)}; run list to see saved Startups`);
  let legacyBinding: boolean;
  try {
    legacyBinding = isLegacyBinding(dirname(path));
  } catch (error: unknown) {
    throw invalidConfig(name, join(dirname(path), "binding.json"), error);
  }
  if (legacyBinding) throw new StartupConfigError(`Startup ${name} was saved in an older format that this version does not read: ${path}`);
  let raw: unknown;
  try {
    raw = readPrivateJson(path);
  } catch (error: unknown) {
    if (error instanceof StartupConfigError || error instanceof RuntimeLaunchError) throw error;
    throw invalidConfig(name, path, error);
  }
  if (isLegacyRuntimeConfig(raw)) throw new StartupConfigError(`Startup ${name} was saved in an older format that this version does not read: ${path}`);
  try {
    return parseRuntimeHostConfig(raw);
  } catch (error: unknown) {
    if (error instanceof StartupConfigError || error instanceof RuntimeLaunchError) throw error;
    throw invalidConfig(name, path, error);
  }
}
function harnessOf(config: RuntimeHostConfig): "omp" | "claude" {
  return "harness" in config ? "claude" : "omp";
}
export function listStartups(home: string): readonly StartupSummary[] {
  const root: string = startupsDirectory(home);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && nameSchema.test(entry.name) && existsSync(configPath(home, entry.name)) && !skipsLegacy(join(root, entry.name), configPath(home, entry.name)))
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
