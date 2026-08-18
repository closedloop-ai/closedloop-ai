/**
 * Hand-written declarations for the Agent Dashboard storage-measurement lib (a
 * plain-JS `.mjs` so the CLI runs without a build step, and there is no
 * `allowJs` anywhere in the desktop tsconfig chain). Keep in sync with the
 * implementation's exported signatures — `test/measure-agent-dashboard-storage.test.ts`
 * exercises every one of these at runtime, so a drifted shape fails there
 * before it can mislead the compiler for long.
 */

export declare const USER_DATA_FLAG: "--user-data";

export declare const AGENT_DASHBOARD_STORAGE_DIRNAME: "agent-dashboard.pgdata";

export declare const AGENT_DASHBOARD_STORAGE_MODE: "sqlite";

export type StorageTarget = {
  mode: string;
  path: string;
};

export type PathMeasurement = {
  bytes: number;
  files: number;
  directories: number;
};

export type StorageMeasurement = PathMeasurement & {
  mode: string;
  path: string;
  exists: boolean;
};

/** `null` means the flag was absent; a valueless flag throws. */
export declare function parseUserDataArg(
  argv: readonly string[]
): string | null;

export declare function measurePath(targetPath: string): PathMeasurement;

export declare function measureExistingDirectory(
  target: StorageTarget
): StorageMeasurement;
