import { expect, test } from "bun:test";
import { StartupBootError } from "../src/boot";
import { roleSchema } from "../src/contracts";
import { ompModelArgs, ompModelRoleBinding, requireOmpModelRoles } from "../src/model-roles";

test("every Startup role is bound to an OMP model role", () => {
  expect(Object.keys(ompModelRoleBinding).sort()).toEqual(roleSchema.options.filter((role) => role !== "manager").sort());
});

test("OMP launch args select the bound model role by alias", () => {
  expect(ompModelArgs("architect")).toEqual(["--model", "@plan"]);
  expect(ompModelArgs("dev")).toEqual(["--model", "@slow"]);
  expect(ompModelArgs("qa")).toEqual(["--model", "@advisor"]);
  expect(ompModelArgs("devops")).toEqual(["--model", "@slow"]);
  expect(ompModelArgs("pa")).toEqual(["--model", "@smol"]);
});

test("the manager has no bound model role to launch", () => {
  expect(() => ompModelArgs("manager")).toThrow(StartupBootError);
});

test("preflight accepts a profile that resolves every bound model role", () => {
  const asked: string[] = [];
  requireOmpModelRoles({ resolve: (spec) => { asked.push(spec); return { id: "model" }; } }, "startup-v7");
  expect(asked.sort()).toEqual(["@advisor", "@plan", "@slow", "@smol"]);
});

test("preflight names every unresolved model role with the Startup roles that need it", () => {
  const unresolved = new Set(["@plan", "@slow"]);
  const attempt = () => requireOmpModelRoles({ resolve: (spec) => unresolved.has(spec) ? undefined : { id: "model" } }, "startup-v7");
  expect(attempt).toThrow(StartupBootError);
  expect(attempt).toThrow(/profile "startup-v7"/);
  expect(attempt).toThrow(/@plan \(architect\)/);
  expect(attempt).toThrow(/@slow \(dev, devops\)/);
});

test("preflight refuses a host without the model query capability", () => {
  expect(() => requireOmpModelRoles(undefined, "startup-v7")).toThrow(StartupBootError);
  expect(() => requireOmpModelRoles(undefined, "startup-v7")).toThrow(/ctx\.models/);
});

test("a resolver that throws is not swallowed", () => {
  expect(() => requireOmpModelRoles({ resolve: () => { throw new RangeError("registry offline"); } }, "startup-v7")).toThrow(RangeError);
});
