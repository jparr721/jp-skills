// OMP supplies these exact subpaths in the compiled 18.8.9 extension host.
declare module "@oh-my-pi/pi-coding-agent/task/types" {
  export type NativeSchema = Readonly<{
    or: (schema: unknown) => NativeSchema;
    and: (schema: unknown) => NativeSchema;
    toJsonSchema: () => unknown;
  }>;
  export function getTaskSchema(
    options: Readonly<{
      isolationEnabled: boolean;
      batchEnabled: boolean;
      effortEnabled: boolean;
      evalToolsEnabled: boolean;
      defaultAgent: string;
    }>,
  ): NativeSchema;
}
declare module "@oh-my-pi/pi-coding-agent/task/settings" {
  type Setting<T> = Readonly<{ get: (scope: unknown) => T }>;
  export const cfgTaskMaxConcurrency: Setting<number>;
  export const cfgTaskBatch: Setting<boolean>;
  export const cfgTaskIsolationEnabled: Setting<boolean>;
  export const cfgTaskEnableEffort: Setting<boolean>;
}
declare module "@oh-my-pi/pi-coding-agent/config/registry" {
  export function lookup(
    id: string,
  ): Readonly<{ get: (scope: unknown) => unknown }> | undefined;
}
declare module "@oh-my-pi/pi-coding-agent/task/discovery" {
  export function discoverAgents(
    cwd: string,
    home: string,
    extensionRoots: unknown,
  ): Promise<
    Readonly<{
      agents: readonly Readonly<{
        name: string;
        spawns?: readonly string[] | "*";
      }>[];
    }>
  >;
}
declare module "@oh-my-pi/pi-coding-agent/task/spawn-policy" {
  export function resolveSpawnPolicy(
    spawns: string | undefined,
  ): Readonly<{ defaultAgent: string }>;
}
