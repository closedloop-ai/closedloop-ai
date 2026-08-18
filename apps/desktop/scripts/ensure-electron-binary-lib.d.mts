/**
 * Type declarations for `ensure-electron-binary-lib.mjs` (ISS-5303 — tooling
 * coverage reach). The lib is plain ESM JavaScript, so this sidecar is what lets
 * the typechecked `test/` project consume it without `allowJs`. Keep the
 * signatures in step with the `@ts-check` JSDoc on the implementation.
 */
/**
 * Relative path from Electron's `dist/` to the executable, per platform. The
 * value type is optional because the lookup key is an arbitrary
 * `process.platform`-shaped string.
 */
export declare const ELECTRON_PLATFORM_PATHS: Readonly<
  Record<string, string | undefined>
>;

/**
 * Executable path inside `dist/` for `platform`. Throws for a platform Electron
 * publishes no artifact for.
 */
export declare function getPlatformPath(platform: string): string;

/**
 * The one call {@link detectRosettaTranslation} makes, narrowed to the shape it
 * actually uses — `typeof spawnSync` is an overload set no test double can
 * satisfy.
 */
export type RosettaProbeSpawn = (
  command: string,
  args: string[],
  options: { encoding: "utf8" }
) => { status: number | null; stdout: string };

/**
 * Whether this process is an x64 binary running under Rosetta on Apple silicon.
 * `spawn` is injectable so tests drive both outcomes without spawning.
 */
export declare function detectRosettaTranslation(
  spawn?: RosettaProbeSpawn
): boolean;

/** Host facts {@link getArch} reads when the caller injects nothing. */
export type ArchHost = {
  platform: string;
  arch: string;
  isRosettaTranslated: () => boolean;
};

export declare function defaultArchHost(): ArchHost;

/**
 * Architecture whose Electron artifact should be installed for `platform`:
 * `npm_config_arch`, else the Rosetta correction, else the reported arch.
 */
export declare function getArch(
  platform: string,
  env?: NodeJS.ProcessEnv,
  host?: ArchHost
): string;

/** The retry budget the release-artifact download runs under (ISS-6110). */
export type DownloadRetryBudget = {
  attempts: number;
  delaySeconds: number;
  /**
   * `--retry-max-time`: wall clock from before the first attempt, counting the
   * transfers. 0 disables it, which is what makes the delay schedule the bound.
   */
  retryMaxTimeSeconds: number;
  connectTimeoutSeconds: number;
};

/** The releases degradation the budget is sized to ride out, in seconds. */
export declare const TARGET_OUTAGE_SECONDS: number;

export declare const DOWNLOAD_RETRY: Readonly<DownloadRetryBudget>;

/**
 * curl argv for fetching the Electron release artifact, carrying the retry
 * budget. Extracted so the budget is assertable without a ~100 MB download.
 */
export declare function buildDownloadArgs(
  zipPath: string,
  downloadUrl: string,
  retry?: DownloadRetryBudget
): string[];

/**
 * The retry window in seconds — `attempts × delaySeconds`, a floor on how long
 * a blip may last, since transfer time only adds to it. `NaN` when
 * `retryMaxTimeSeconds` is nonzero, because a wall-clock ceiling that counts the
 * transfers cannot be modeled from these numbers.
 */
export declare function retryWindowSeconds(
  retry?: Pick<
    DownloadRetryBudget,
    "attempts" | "delaySeconds" | "retryMaxTimeSeconds"
  >
): number;
