import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStore, readOwnerControl } from "../src/store";
import { launchRuntimeHost, managerProcessInstance, parseRuntimeHostConfig } from "../src/v7-launch";
import { startRuntimeHost } from "../runtime-host";

const roots: string[] = [];
const children: number[] = [];
afterEach(async () => {
  const spawned = new Set(children.splice(0));
  for (const root of roots) {
    const path = join(root, "home", "startup", "test", "runtime-launch.json");
    if (!existsSync(path)) continue;
    const intent: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof intent === "object" && intent !== null && "pid" in intent && typeof intent.pid === "number" && intent.pid !== 2147483647 && intent.pid !== process.pid) spawned.add(intent.pid);
  }
  for (const pid of spawned) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ }
    // The real detached runtime must exit before its socket and SQLite directory are removed.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { process.kill(pid, 0); } catch { break; }
      await Bun.sleep(20);
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tern-rebind-")));
  roots.push(root);
  const home = join(root, "home");
  const boundRoot = join(root, "repo");
  const startupRoot = join(home, "startup", "test");
  mkdirSync(startupRoot, { recursive: true, mode: 0o700 });
  mkdirSync(boundRoot);
  const managerFile = join(root, "manager.jsonl");
  writeFileSync(managerFile, JSON.stringify({ type: "session", id: "manager-session" }) + "\n");
  const ternBinary = join(root, "tern");
  const inspect = JSON.stringify({ sessions: [{ id: 1, tabs: [{ id: 1, blocks: [{ id: 1, live: true }] }, { id: 2, blocks: [{ id: 3, live: true }] }] }], detached: [] });
  const native = { pid: process.pid, name: "omp", argv: ["omp"], cwd: boundRoot };
  const processResult = JSON.stringify({ pane: 1, child: native, group: process.pid, foreground: native });
  writeFileSync(ternBinary, `#!/bin/sh\ncase "$1" in\ninspect) printf '%s\\n' '${inspect}' ;;\nprocess) printf '%s\\n' '${processResult}' ;;\nnew) printf '%s\\n' '{"session":1,"tab":2,"block":3}' ;;\n*) exit 1 ;;\nesac\n`, { mode: 0o700 });
  const oldInstance = randomUUID();
  const config = parseRuntimeHostConfig({ backend: "tern", name: "test", stateDirectory: startupRoot, startupRoot, skillsHome: home, boundRoot, skillsRoot: resolve(import.meta.dir, "../../.."), socketPath: join(startupRoot, "r.sock"), profile: "default", managerSession: "manager-session", managerFile, managerPaneId: "1", managerPid: 2147483647, managerInstance: oldInstance, managerCredential: "saved-secret", ternSession: "1", ternWindow: "", ternBinary, ternSocket: join(root, "tern.sock"), ownerGeneration: 1, policy: { tickMs: 60000, paCadenceMs: 60000, progressDeadlineMs: 120000, connectionDeadlineMs: 60000, executionLimit: 8 } });
  const scope = { skillsHome: home, startupRoot, host: hostname(), name: "test", boundRoot, managerSession: "manager-session" };
  const configPath = join(startupRoot, "runtime-config.json");
  const intentPath = join(startupRoot, "runtime-launch.json");
  const journalPath = join(startupRoot, "runtime-rebind.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  writeFileSync(intentPath, JSON.stringify({ state: "spawned", startedAt: 1, pid: 2147483647 }), { mode: 0o600 });
  const proposed = parseRuntimeHostConfig({ ...config, managerPid: process.pid, managerInstance: managerProcessInstance, managerCredential: "new-secret" });
  return { root, scope, config, proposed, configPath, intentPath, journalPath, oldInstance };
}

function seed(f: ReturnType<typeof fixture>, now: number) {
  return openStore({ path: join(f.scope.startupRoot, "staff.sqlite"), scope: f.scope, owner: { id: "old-owner", managerGeneration: 1, leaseMs: 60000 }, now: () => now });
}

test("explicit Tern manager recovery claims an expired owner with CAS and preserves the original credential", async () => {
  const f = fixture();
  const old = seed(f, Date.now() - 120000);
  old.close();
  const before = readOwnerControl(f.scope);
  await expect(launchRuntimeHost(f.proposed)).rejects.toThrow();
  expect(readFileSync(f.configPath, "utf8")).toContain("saved-secret");
  const result = await launchRuntimeHost(f.proposed, { allowManagerRebind: true });
  const intent = JSON.parse(readFileSync(f.intentPath, "utf8"));
  children.push(intent.pid);
  expect(result).toMatchObject({ managerPid: process.pid, managerCredential: "saved-secret" });
  expect(existsSync(f.journalPath)).toBe(false);
  expect(readOwnerControl(f.scope).ownerEpoch).toBe(before.ownerEpoch + 1);
});

test("manager recovery refuses an active lease and preserves the old configuration", async () => {
  const f = fixture();
  const old = seed(f, Date.now());
  try {
    await expect(launchRuntimeHost(f.proposed, { allowManagerRebind: true })).rejects.toThrow("lease");
    expect(JSON.parse(readFileSync(f.configPath, "utf8"))).toMatchObject({ managerPid: 2147483647, managerCredential: "saved-secret" });
    expect(existsSync(f.journalPath)).toBe(false);
  } finally { old.close(); }
});

test("an interrupted manager rebind journal blocks a second launch without rewriting evidence", async () => {
  const f = fixture();
  const journal = { state: "prepared", oldPid: 2147483647, newPid: process.pid, oldInstance: f.oldInstance, newInstance: managerProcessInstance, ownerEpoch: 1, revision: 0 };
  writeFileSync(f.journalPath, JSON.stringify(journal), { mode: 0o600 });
  const original = readFileSync(f.configPath, "utf8");
  await expect(launchRuntimeHost(f.proposed, { allowManagerRebind: true })).rejects.toThrow("Interrupted manager rebind");
  expect(readFileSync(f.configPath, "utf8")).toBe(original);
  expect(JSON.parse(readFileSync(f.journalPath, "utf8"))).toEqual(journal);
});

test("runtime host rejects a stale rebind journal rather than bypassing owner CAS", async () => {
  const f = fixture();
  const old = seed(f, Date.now() - 120000);
  old.close();
  const saved = readOwnerControl(f.scope);
  const journal = { state: "prepared", oldPid: 2147483647, newPid: process.pid, oldInstance: f.oldInstance, newInstance: managerProcessInstance, ownerEpoch: saved.ownerEpoch, revision: saved.revision + 1 };
  writeFileSync(f.journalPath, JSON.stringify(journal), { mode: 0o600 });
  await expect(startRuntimeHost(f.proposed)).rejects.toThrow();
  expect(readOwnerControl(f.scope).ownerEpoch).toBe(saved.ownerEpoch);
  expect(JSON.parse(readFileSync(f.journalPath, "utf8"))).toEqual(journal);
});
