/**
 * Hand-written declarations for the perf-qa dataset-prep CLI (a plain-JS
 * `.mjs` so it runs without a build step), added when ISS-5142 brought
 * `test/**` under typecheck. Keep in sync with the implementation's exported
 * signatures — `test/profiling-prepare-dataset.test.ts` exercises every one of
 * these at runtime, so a drifted shape fails there before it can mislead the
 * compiler for long.
 */
type SpawnProbeResult = {
  status: number | null;
  error?: Error;
};

export function defaultSourceUserDataDir(
  platform?: NodeJS.Platform,
  env?: NodeJS.ProcessEnv,
  homeDir?: string
): string;

export function utcStamp(now?: Date): string;

export function isGitIgnored(
  target: string,
  repoRoot: string,
  runGit?: (args: readonly string[], cwd: string) => SpawnProbeResult
): boolean;

export function toSandboxSettings(
  settings: Record<string, unknown>
): Record<string, unknown>;

/** Returns the snapshot's size in bytes. */
export function snapshotDatabase(sourceDb: string, targetDb: string): number;

/**
 * Session population of a prepared snapshot. `null` on either field means the
 * value could not be read — deliberately distinct from a count of zero.
 */
export type SessionStats = {
  sessionCount: number | null;
  newestLastActivityAt: string | null;
};

export function readSessionStats(dbPath: string): SessionStats;

/** Returns the number of transcript files copied. */
export function copyTranscripts(
  sourceClaudeHome: string,
  sandboxClaudeHome: string,
  limit: number
): number;

/** `null` means "could not probe", deliberately distinct from `false`. */
export function isDesktopRunning(
  runProbe?: () => SpawnProbeResult
): boolean | null;

export function prepareDataset(options: {
  sourceDir: string;
  targetDir: string;
  repoRoot: string;
  withTranscripts?: number;
  sourceClaudeHome?: string;
  runGit?: (args: readonly string[], cwd: string) => SpawnProbeResult;
}): SessionStats & {
  targetDir: string;
  targetDb: string;
  dbBytes: number;
  transcriptsCopied: number;
  sandboxClaudeHome: string;
  settingsKeys: string[];
};
