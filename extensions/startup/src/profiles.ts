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
import {
  encode,
  type Employee,
  type Json,
  type Source,
  roleSchema,
} from "./contracts";

export class ProfileSourceError extends Error {}
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
  const directory: string = join(input.root, ".omp", "agents");
  for (const candidate of [join(input.root, ".omp"), directory])
    if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink())
      throw new ProfileSourceError(`Generated profile directory ownership conflict: ${candidate}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path: string = join(directory, `${input.profile.name}.md`);
  const spawns: string = input.profile.roleName === "pa" ? "" : "spawns: [task]\n";
  const content = `---\nname: ${input.profile.name}\ndescription: Canonical Startup employee context\n${spawns}blocking: false\nread-summarize: false\n---\n${profileText(input.profile)}\n`;
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || readFileSync(path, "utf8") !== content)
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
