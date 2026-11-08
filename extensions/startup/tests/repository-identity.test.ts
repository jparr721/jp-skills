import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteIdentity, inspectRepository } from "../src/repository-identity";

test("normalizes explicit Git remotes without treating relative paths as repositories", () => {
  expect(remoteIdentity("https://github.com/Example/Project.git")).toBe("github.com/example/project");
  expect(remoteIdentity("git@github.com:Example/Project.git")).toBe("github.com/example/project");
  expect(remoteIdentity("ssh://git@github.com/Example/Project")).toBe("github.com/example/project");
  expect(remoteIdentity("org/repo")).toBeNull();
  expect(remoteIdentity("../repo")).toBeNull();
  expect(remoteIdentity("origin")).toBeNull();
  expect(remoteIdentity("https://github.com/example/project/issues/42")).toBeNull();
});

test("reports uncertain remote metadata without blocking a separate checkout or fork", () => {
  const directory = mkdtempSync(join(tmpdir(), "startup-repo-"));
  const source = join(directory, "source");
  const checkout = join(directory, "checkout");
  try {
    execFileSync("git", ["init", "-q", source]);
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { cwd: source });
    execFileSync("git", ["clone", "-q", source, checkout]);
    execFileSync("git", ["remote", "set-url", "origin", "https://github.com/Example/Project.git"], { cwd: checkout });
    expect(inspectRepository({ cwd: checkout, repo: null, remote: "git@github.com:example/project.git" })).toBeNull();
    expect(inspectRepository({ cwd: checkout, repo: null, remote: "https://github.com/other/project" })).toContain("inspect");
    expect(inspectRepository({ cwd: checkout, repo: "relative/path", remote: null })).toBeNull();
    expect(inspectRepository({ cwd: checkout, repo: "https://github.com/upstream/project", remote: "git@github.com:fork/project.git" })).toContain("inspect");
    expect(inspectRepository({ cwd: checkout, repo: "https://github.com/example/project/issues/42", remote: null })).toBeNull();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
