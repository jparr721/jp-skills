import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { assertStartupPath, ensureStartupRoot } from "./boot";
import {
  encode,
  type Employee,
  type Json,
  type Source,
  roleSchema,
} from "./contracts";
import { requestedRoleSettingsSchema, roleSettingsInputSchema, runtimeHarnessSchema, type RequestedRoleSettings, type RoleSettingsInput, type SavedRoleSettings } from "./runtime-contracts";

export class ProfileSourceError extends Error {}
export type RoleSettingsValidation =
  | Readonly<{ status: "accepted"; requested: RequestedRoleSettings }>
  | Readonly<{ status: "unsupported"; requested: RoleSettingsInput; reason: string }>;
export type Profile = Readonly<{
  employeeId: string;
  generation: number;
  name: string;
  marker: string;
  source: Source;
  roleName: Employee["role"];
  role: string;
  loop: string;
}>;
function revision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
export function validateRoleSettings(input: RoleSettingsInput): RoleSettingsValidation {
  const parsed: RoleSettingsInput = roleSettingsInputSchema.parse(input);
  const model: string | null = parsed.model === null ? null : parsed.model.trim();
  const effort: string | null = parsed.effort === null ? null : parsed.effort.trim();
  if (model !== null && (model.length === 0 || model.length > 256 || /[\u0000-\u001f\u007f]/.test(model)))
    return { status: "unsupported", requested: parsed, reason: "Model must be a nonempty CLI value without control characters" };
  const allowedEfforts: readonly string[] = parsed.harness === "omp"
    ? ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]
    : ["low", "medium", "high", "xhigh", "max"];
  if (effort !== null && !allowedEfforts.includes(effort))
    return { status: "unsupported", requested: parsed, reason: `${parsed.harness} CLI does not support effort value ${effort}` };
  const requested: RequestedRoleSettings = requestedRoleSettingsSchema.parse({
    role: parsed.role,
    harness: runtimeHarnessSchema.parse(parsed.harness),
    model: { value: model, validation: model === null ? "not_requested" : "unverified" },
    effort: { value: effort, validation: effort === null ? "not_requested" : "unverified" },
  });
  return { status: "accepted", requested };
}
export function ompSettingsArgs(settings: SavedRoleSettings): readonly string[] {
  if (settings.requested.harness !== "omp") throw new ProfileSourceError("OMP launch settings require an OMP selection");
  const args: string[] = [];
  if (settings.requested.model.value !== null) args.push("--model", settings.requested.model.value);
  if (settings.requested.effort.value !== null) args.push("--thinking", settings.requested.effort.value);
  return args;
}
export function loadProfile(
  input: Readonly<{
    skillsRoot: string;
    role: Employee["role"];
    employeeId: string;
    generation: number;
  }>,
): Profile {
  const role: Employee["role"] = roleSchema.parse(input.role);
  const rolePath: string = realpathSync(
    join(input.skillsRoot, "skills", `startup-role-${role}`, "SKILL.md"),
  );
  const loopPath: string = realpathSync(
    join(input.skillsRoot, "skills", "startup-loop", "SKILL.md"),
  );
  const roleText: string = readFileSync(rolePath, "utf8");
  const loop: string = readFileSync(loopPath, "utf8");
  if (!roleText.trim() || !loop.trim())
    throw new ProfileSourceError(
      "Canonical role and loop sources must be nonempty",
    );
  const marker: string = `STARTUP_BINDING=${encode({ employeeId: input.employeeId, generation: input.generation })}`;
  return {
    employeeId: input.employeeId,
    generation: input.generation,
    name: `startup-${revision(marker).slice(0, 24)}`,
    marker,
    source: {
      rolePath,
      roleRevision: revision(roleText),
      loopPath,
      loopRevision: revision(loop),
    },
    roleName: role,
    role: roleText,
    loop,
  };
}
export function verifyProfile(profile: Profile): void {
  if (
    !existsSync(profile.source.rolePath) ||
    !existsSync(profile.source.loopPath)
  )
    throw new ProfileSourceError(
      `Canonical source unavailable for ${profile.employeeId}`,
    );
  if (
    revision(readFileSync(profile.source.rolePath, "utf8")) !==
      profile.source.roleRevision ||
    revision(readFileSync(profile.source.loopPath, "utf8")) !==
      profile.source.loopRevision
  )
    throw new ProfileSourceError(
      `Canonical source changed for ${profile.employeeId}; explicit source reconciliation required`,
    );
}
export function profileText(profile: Profile): string {
  verifyProfile(profile);
  return `${profile.marker}\n${profile.role}\n${profile.loop}`;
}
export function writeProfile(
  input: Readonly<{ root: string; profile: Profile }>,
): string {
  const root: string = ensureStartupRoot(input.root);
  const directory: string = join(root, ".omp", "agents");
  for (const candidate of [join(root, ".omp"), directory]) {
    assertStartupPath(root, candidate, "directory");
    if (existsSync(candidate)) {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0)
        throw new ProfileSourceError(`Generated profile directory ownership conflict: ${candidate}`);
    }
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertStartupPath(root, directory, "directory");
  const path: string = join(directory, `${input.profile.name}.md`);
  assertStartupPath(root, path, "file");
  const spawns: string = input.profile.roleName === "pa" ? "" : "spawns: [task]\n";
  const content = `---\nname: ${input.profile.name}\ndescription: Canonical Startup employee context\n${spawns}blocking: false\nread-summarize: false\n---\n${profileText(input.profile)}\n`;
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0 || readFileSync(path, "utf8") !== content)
      throw new ProfileSourceError(`Generated profile ownership conflict: ${path}`);
  } else writeFileSync(path, content, { mode: 0o600, flag: "wx" });
  return path;
}
export function projectEmployee(
  input: Readonly<{
    profile: Profile;
    checkpoint: Json;
    cue: Json;
    team: Json;
  }>,
): string {
  return `${profileText(input.profile)}\nSTARTUP_CHECKPOINT=${encode(input.checkpoint)}\nSTARTUP_CUE=${encode(input.cue)}\nSTARTUP_TEAM=${encode(input.team)}`;
}
