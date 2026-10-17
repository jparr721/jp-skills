import { StartupBootError } from "./boot";
import type { Employee } from "./contracts";

// Each Startup role runs on one OMP model role, so retuning a model is a profile edit, never a launch edit.
export const ompModelRoleBinding: Readonly<Record<Exclude<Employee["role"], "manager">, string>> = {
  architect: "plan",
  dev: "slow",
  qa: "advisor",
  devops: "slow",
  pa: "smol",
};
export type ModelQuery = Readonly<{ resolve: (spec: string) => unknown }>;
function alias(modelRole: string): string {
  return `@${modelRole}`;
}
export function ompModelArgs(role: Employee["role"]): readonly string[] {
  if (role === "manager") throw new StartupBootError("The manager is launched by the user, not by Startup, so it has no bound model role");
  return ["--model", alias(ompModelRoleBinding[role])];
}
export function requireOmpModelRoles(models: ModelQuery | undefined, profile: string): void {
  if (models === undefined)
    throw new StartupBootError("Startup requires the OMP model query capability (ctx.models) to verify each employee's bound model role; upgrade OMP");
  const users = new Map<string, string[]>();
  for (const [role, modelRole] of Object.entries(ompModelRoleBinding))
    users.set(alias(modelRole), [...(users.get(alias(modelRole)) ?? []), role]);
  const unresolved: string[] = [...users].filter(([spec]) => models.resolve(spec) === undefined).map(([spec, roles]) => `${spec} (${roles.join(", ")})`);
  if (unresolved.length > 0)
    throw new StartupBootError(`OMP profile "${profile}" has no model for ${unresolved.join("; ")}; Startup launches each employee on its bound model role. Assign them under modelRoles in that profile's config.yml or with the /model role picker, then retry`);
}
