import { z } from "zod";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import nodeProcess from "node:process";

export type TernCommandResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;
export type TernRunner = (argv: readonly string[]) => Promise<TernCommandResult>;
export type TernLocation = Readonly<{ sessionId: string; tabId: string; blockId: string }>;
export type TernProcess = Readonly<{
  pane: string;
  child: Readonly<{ pid: number; name: string; argv: string[]; cwd: string }> | null;
  group: number | null;
  foreground: Readonly<{ pid: number; name: string; argv: string[]; cwd: string }> | null;
}>;
export type TernRuntime = Readonly<{
  check: () => Promise<void>;
  createTab: (input: Readonly<{ cwd: string; argv: readonly string[] }>) => Promise<TernLocation>;
  split: (input: Readonly<{ blockId: string; cwd: string; argv: readonly string[] }>) => Promise<TernLocation>;
  process: (input: Readonly<{ blockId: string }>) => Promise<TernProcess>;
  isAbsent: (input: Readonly<{ blockId: string }>) => Promise<boolean>;
  isProcessAbsent: (input: Readonly<{ pid: number }>) => Promise<boolean>;
  ownsProcess: (input: Readonly<{ blockId: string; pid: number }>) => Promise<boolean>;
}>;

const text = z.string().min(1).refine((s) => !s.includes("\0"));
const id = z.string().regex(/^[1-9][0-9]*$/).refine((s) => Number.isSafeInteger(Number(s)) && String(Number(s)) === s);
const numericId = z.number().int().positive().safe();
const block = z.object({ id: numericId, live: z.boolean() });
const layout = z.object({ sessions: z.array(z.object({ id: numericId, tabs: z.array(z.object({ id: numericId, blocks: z.array(block) })) })), detached: z.array(z.unknown()).optional() });
const created = z.object({ session: numericId, tab: numericId, block: numericId });
const processInfo = z.object({ pid: numericId, name: z.string(), argv: z.array(z.string()), cwd: z.string() });
const processResult = z.object({ pane: numericId, child: processInfo.nullable(), group: numericId.nullable(), foreground: processInfo.nullable() });
const launch = z.strictObject({ cwd: text.refine((s) => s.startsWith("/")), argv: z.array(z.string().refine((s) => !s.includes("\0"))).min(1).refine((args) => args[0] !== "") });

export class TernRuntimeError extends Error {
  constructor(readonly code: "invalid_request" | "command_failed" | "invalid_response" | "binding_mismatch" | "spawn_failed", detail: string) {
    super(detail);
    this.name = "TernRuntimeError";
  }
}

async function execute<T>(run: TernRunner, command: readonly string[], schema: z.ZodType<T>): Promise<T> {
  let result: TernCommandResult;
  try { result = await run(command); }
  catch (error: unknown) { throw new TernRuntimeError("spawn_failed", `Tern command outcome may be uncertain; reconcile before retrying: ${error instanceof Error ? error.message : String(error)}`); }
  if (result.exitCode !== 0) throw new TernRuntimeError("command_failed", `Tern command failed; reconcile before retrying: ${result.stderr}`);
  let value: unknown;
  try { value = JSON.parse(result.stdout); }
  catch { throw new TernRuntimeError("invalid_response", "Tern returned invalid JSON; reconcile before retrying a write"); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new TernRuntimeError("invalid_response", `Tern returned an unexpected response: ${parsed.error.message}`);
  return parsed.data;
}

function locate(data: z.infer<typeof layout>, blockId: string): (TernLocation & { live: boolean }) | null {
  const matches = data.sessions.flatMap((session) => session.tabs.flatMap((tab) => tab.blocks.filter((item) => String(item.id) === blockId).map((item) => ({ sessionId: String(session.id), tabId: String(tab.id), blockId, live: item.live }))));
  if (matches.length > 1) throw new TernRuntimeError("binding_mismatch", "Block appears more than once in the selected window");
  return matches[0] ?? null;
}

export async function ternContext(input: Readonly<{ binary: string; window: string; blockId: string; run: TernRunner }>): Promise<TernLocation & { window: string }> {
  text.parse(input.binary); z.string().refine((s) => !s.includes("\0")).parse(input.window); id.parse(input.blockId);
  const data = await execute(input.run, [input.binary, "inspect", "--window", input.window, "--json"], layout);
  const found = locate(data, input.blockId);
  if (!found || !found.live) throw new TernRuntimeError("binding_mismatch", "Current block is not live in the selected Tern window");
  return { window: input.window, sessionId: found.sessionId, tabId: found.tabId, blockId: found.blockId };
}

export function createTernRuntime(input: Readonly<{ binary: string; window: string; sessionId: string; run: TernRunner; parentPid: (pid: number) => Promise<number | null> }>): TernRuntime {
  text.parse(input.binary); z.string().refine((s) => !s.includes("\0")).parse(input.window); id.parse(input.sessionId);
  const prefix = [input.binary];
  const window = ["--window", input.window, "--json"];
  async function inspect(): Promise<z.infer<typeof layout>> { return execute(input.run, [...prefix, "inspect", ...window], layout); }
  async function scoped(blockId: string, live = true): Promise<TernLocation & { live: boolean }> {
    id.parse(blockId);
    const found = locate(await inspect(), blockId);
    if (!found || found.sessionId !== input.sessionId || (live && !found.live)) throw new TernRuntimeError("binding_mismatch", "Block is not live in the selected Tern session and window");
    return found;
  }
  async function create(args: readonly string[]): Promise<TernLocation> {
    const result = await execute(input.run, [...prefix, ...args], created);
    const location = { sessionId: String(result.session), tabId: String(result.tab), blockId: String(result.block) };
    if (location.sessionId !== input.sessionId) throw new TernRuntimeError("binding_mismatch", "Created block belongs to a different session; reconcile before retrying");
    const actual = await scoped(location.blockId, false);
    if (actual.tabId !== location.tabId) throw new TernRuntimeError("binding_mismatch", "Created block belongs to a different tab; reconcile before retrying");
    return location;
  }
  async function process(request: Readonly<{ blockId: string }>): Promise<TernProcess> {
    await scoped(request.blockId);
    const result = await execute(input.run, [...prefix, "process", request.blockId, ...window], processResult);
    if (String(result.pane) !== request.blockId) throw new TernRuntimeError("binding_mismatch", "Process response belongs to a different block");
    return { ...result, pane: String(result.pane) };
  }
  return {
    check: async () => {
      const data = await inspect();
      if (data.sessions.filter((s) => String(s.id) === input.sessionId).length !== 1) throw new TernRuntimeError("binding_mismatch", "Selected Tern session is not present exactly once in the selected window");
    },
    createTab: async (request) => {
      const value = launch.parse(request);
      await inspect().then((data) => { if (!data.sessions.some((s) => String(s.id) === input.sessionId)) throw new TernRuntimeError("binding_mismatch", "Selected session is absent"); });
      return create(["new", "tab", input.sessionId, "--cwd", value.cwd, "--keep-open", ...window, "--", ...value.argv]);
    },
    split: async (request) => {
      const value = z.strictObject({ blockId: id, cwd: launch.shape.cwd, argv: launch.shape.argv }).parse(request);
      const parent = await scoped(value.blockId);
      const result = await create(["split", value.blockId, "right", "--cwd", value.cwd, "--keep-open", ...window, "--", ...value.argv]);
      if (result.tabId !== parent.tabId) throw new TernRuntimeError("binding_mismatch", "Split block belongs to a different tab; reconcile before retrying");
      return result;
    },
    process,
    isAbsent: async ({ blockId }) => {
      id.parse(blockId);
      const data = await inspect();
      if (data.sessions.filter((session) => String(session.id) === input.sessionId).length !== 1)
        throw new TernRuntimeError("binding_mismatch", "Cannot prove absence without the selected session");
      if (!data.detached || data.detached.length !== 0)
        throw new TernRuntimeError("binding_mismatch", "Cannot prove absence while detached blocks are unaccounted for");
      const found = locate(data, blockId);
      if (found && found.sessionId !== input.sessionId)
        throw new TernRuntimeError("binding_mismatch", "Block is present in a different session");
      return !found || !found.live;
    },
    isProcessAbsent: async ({ pid }) => {
      numericId.parse(pid);
      try {
        nodeProcess.kill(pid, 0);
        return false;
      } catch (error: unknown) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
        if (error instanceof Error && "code" in error && error.code === "EPERM") return false;
        throw error;
      }
    },
    ownsProcess: async ({ blockId, pid }) => {
      if (!numericId.safeParse(pid).success) return false;
      try {
        const before = await process({ blockId });
        if (!before.child) return false;
        let current: number | null = pid;
        const seen = new Set<number>();
        while (current !== null && current !== before.child.pid && !seen.has(current) && seen.size < 256) {
          seen.add(current);
          current = await input.parentPid(current);
        }
        if (current !== before.child.pid) return false;
        const after = await process({ blockId });
        return after.child !== null && after.child.pid === before.child.pid && await input.parentPid(pid) !== null;
      } catch { return false; }
    },
  };
}

const execFileAsync = promisify(execFile);
export async function ternParentPid(pid: number): Promise<number | null> {
  if (!numericId.safeParse(pid).success) return null;
  try {
    const result = await execFileAsync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], { timeout: 3000 });
    const value = result.stdout.trim();
    if (!/^[0-9]+$/.test(value)) return null;
    const parent = Number(value);
    return Number.isSafeInteger(parent) && parent > 0 ? parent : null;
  } catch { return null; }
}

export function createTernCommandRunner(input: Readonly<{ socket: string; timeoutMs: number }>): TernRunner {
  text.parse(input.socket); numericId.parse(input.timeoutMs);
  return async (argv) => {
    if (argv.length === 0 || argv.some((arg) => arg.includes("\0"))) throw new TernRuntimeError("invalid_request", "Invalid command arguments");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const child = Bun.spawn([...argv], { env: { ...process.env, TERN_DAEMON_SOCKET: input.socket }, stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: controller.signal, killSignal: "SIGKILL" });
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (controller.signal.aborted) throw new TernRuntimeError("spawn_failed", "Tern command timed out; reconcile before retrying a write");
      return { exitCode, stdout, stderr };
    } finally { clearTimeout(timer); }
  };
}
