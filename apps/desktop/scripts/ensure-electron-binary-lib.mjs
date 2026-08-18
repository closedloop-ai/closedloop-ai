// @ts-check

/**
 * ISS-5303 — the pure half of `ensure-electron-binary.mjs`.
 *
 * The entrypoint cannot be imported by a test: at module scope it resolves the
 * installed `electron` package, reads its `package.json`, and then runs the
 * whole verify/repair sequence — which, on a broken install, downloads a ~100 MB
 * zip from GitHub. The two decisions inside it that are pure logic live here
 * instead:
 *
 *   - which relative path inside Electron's `dist/` holds the executable for a
 *     given platform (the value that gets written into `path.txt`);
 *   - which CPU architecture's release artifact to fetch, including the Rosetta
 *     case where an x64 Node on Apple silicon must fetch the arm64 build.
 *
 * Both take the environment they read as arguments. That is what makes every
 * branch reachable from a test without mutating `process.env`, without spawning
 * `sysctl`, and on a Linux CI runner where the macOS-only branches can never be
 * taken by the real host.
 */
import { spawnSync } from "node:child_process";

/**
 * Relative path from Electron's `dist/` to the executable, per platform.
 *
 * This mirrors the table in `electron/install.js`. The repair path writes the
 * value straight into `<electronDir>/path.txt`, which is exactly what
 * `require("electron")` reads back — so a wrong entry here does not fail loudly,
 * it resolves the module to a path that does not exist.
 *
 * Typed with an optional value on purpose: the lookup key is a raw
 * `process.platform`-shaped string, so the miss is genuinely reachable and
 * {@link getPlatformPath} has to handle it.
 *
 * @type {Readonly<Record<string, string | undefined>>}
 */
export const ELECTRON_PLATFORM_PATHS = Object.freeze({
  darwin: "Electron.app/Contents/MacOS/Electron",
  freebsd: "electron",
  linux: "electron",
  mas: "Electron.app/Contents/MacOS/Electron",
  openbsd: "electron",
  win32: "electron.exe",
});

/**
 * Executable path inside `dist/` for `platform`.
 *
 * Throws rather than returning a fallback: Electron publishes no release
 * artifact for an unlisted platform, so a guess would send the repair path off
 * to download a URL that 404s and report it as a network error.
 *
 * @param {string} platform Platform id, e.g. `process.platform` or an
 *   `npm_config_platform` override.
 * @returns {string}
 */
export function getPlatformPath(platform) {
  const platformPath = ELECTRON_PLATFORM_PATHS[platform];
  if (platformPath == null) {
    throw new Error(
      `Electron builds are not available on platform: ${platform}`
    );
  }
  return platformPath;
}

/**
 * The one call {@link detectRosettaTranslation} makes, narrowed to the shape it
 * actually uses. Narrower than `typeof spawnSync` on purpose: the real
 * signature is a large overload set that a test double cannot satisfy.
 *
 * @typedef {(
 *   command: string,
 *   args: string[],
 *   options: { encoding: "utf8" }
 * ) => { status: number | null, stdout: string }} RosettaProbeSpawn
 */

/**
 * Whether this process is an x64 binary running under Rosetta on Apple silicon.
 *
 * `sysctl.proc_translated` is `1` in exactly that case. Anything else — a
 * non-zero exit, a `sysctl` that is not installed (the spawn fails and `status`
 * is `null`), any other value — means "not translated", so the caller keeps the
 * arch the runtime reported.
 *
 * @param {RosettaProbeSpawn} [spawn] Injected so a test drives both outcomes
 *   without spawning a process, and so the assertion holds on a Linux runner
 *   where the sysctl key does not exist at all.
 * @returns {boolean}
 */
export function detectRosettaTranslation(spawn = spawnSync) {
  const translated = spawn("sysctl", ["-in", "sysctl.proc_translated"], {
    encoding: "utf8",
  });
  return translated.status === 0 && translated.stdout.trim() === "1";
}

/**
 * The host facts {@link getArch} reads when the caller injects nothing.
 *
 * @returns {{ platform: string, arch: string, isRosettaTranslated: () => boolean }}
 */
export function defaultArchHost() {
  return {
    platform: process.platform,
    arch: process.arch,
    isRosettaTranslated: detectRosettaTranslation,
  };
}

/**
 * Architecture whose Electron artifact should be installed for `platform`.
 *
 * Precedence, highest first:
 *
 *   1. `npm_config_arch` — an explicit cross-install (`npm i --arch=arm64`)
 *      always wins, including over the Rosetta correction below.
 *   2. The Rosetta correction — a `darwin` target, on a `darwin` host, whose
 *      runtime reports `x64` while actually running translated, needs the
 *      `arm64` artifact. Without this the repair installs an x64 Electron on an
 *      Apple-silicon machine.
 *   3. The arch the runtime reports.
 *
 * @param {string} platform Target platform the artifact is for.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ platform: string, arch: string, isRosettaTranslated: () => boolean }} [host]
 * @returns {string}
 */
export function getArch(platform, env = process.env, host = defaultArchHost()) {
  if (env.npm_config_arch) {
    return env.npm_config_arch;
  }
  if (
    platform !== "darwin" ||
    host.platform !== "darwin" ||
    host.arch !== "x64"
  ) {
    return host.arch;
  }
  return host.isRosettaTranslated() ? "arm64" : host.arch;
}

/**
 * ISS-6110 — the GitHub-releases degradation this download is sized to ride
 * out. Both blips seen on 2026-08-12 cleared well inside three minutes.
 */
export const TARGET_OUTAGE_SECONDS = 180;

/**
 * ISS-6110 — the retry budget the release-artifact download runs under.
 *
 * The previous `--retry 3` on its own spent 1s + 2s + 4s ≈ 7 SECONDS before
 * giving up, and this download sits in front of nine workflows including the
 * required `desktop` PR gate and `desktop-release.yml`. Two GitHub-releases
 * blips on 2026-08-12 (`curl: (56) Connection died` and four consecutive 503s)
 * outlasted that budget and redded `main` twice in thirty minutes; both SHAs
 * reran green untouched.
 *
 * Three curl details govern the sizing, and all three are easy to read
 * backwards:
 *
 * - `--retry-delay` DISABLES curl's exponential backoff, so the retry schedule
 *   is flatly `attempts × delaySeconds`. An earlier revision paired 5 × 5s with
 *   a 180s `--retry-max-time` and spanned 25 seconds, which a 30-second blip
 *   still outlasts.
 * - `--retry-max-time` is NOT a budget for the delays — it is wall clock from
 *   before the FIRST attempt, and the transfers run inside it: "The retry timer
 *   is reset before the first transfer attempt. Retries are done as usual as
 *   long as the timer has not reached this given limit." That matters precisely
 *   because of the signature below: a reset at 80 MB of a ~105 MB zip burns
 *   20-30s before its delay even starts, so a handful of those eats a nominal
 *   300s ceiling while barely 140s of the delay schedule has elapsed — short of
 *   the window this claims to hold. Sizing a ceiling correctly would mean
 *   predicting transfer time, so it is set to 0 (disabled) and the attempt count
 *   is the only bound. `retryWindowSeconds` is that number, and it is honest
 *   ONLY while the ceiling stays disabled — which the tests assert.
 * - `--retry-all-errors` is needed for the mid-transfer connection reset
 *   (exit 56) ONLY. Plain `--retry` already treats a timeout and HTTP
 *   408/429/500/502/503/504 as transient, so the 503 burst was inside curl's
 *   default retry set all along and simply outlasted the 7-second budget.
 *
 * Two costs, both accepted deliberately. `--retry-all-errors` also retries a
 * genuine 404, so a bad Electron version pin burns the delay schedule (~180s,
 * no transfer to slow it) before failing. And with the ceiling disabled a
 * sustained outage can hold the step for `attempts × (delay + transfer)` —
 * order of ten minutes — before it gives up. Both are rare, both fail either
 * way, and the job's own `timeout-minutes` is the real backstop.
 *
 * @type {Readonly<{
 *   attempts: number,
 *   delaySeconds: number,
 *   retryMaxTimeSeconds: number,
 *   connectTimeoutSeconds: number,
 * }>}
 */
export const DOWNLOAD_RETRY = Object.freeze({
  attempts: 12,
  delaySeconds: 15,
  /** 0 disables curl's retry ceiling — see the note above; not a placeholder. */
  retryMaxTimeSeconds: 0,
  connectTimeoutSeconds: 20,
});

/**
 * curl argv for fetching the Electron release artifact.
 *
 * Extracted from the entrypoint so the retry budget is assertable without
 * downloading a ~100 MB zip: the entrypoint runs its whole verify/repair
 * sequence at module scope, so a test can never import it.
 *
 * `--fail` stays in place so an HTML error page is never written over the zip,
 * and the caller still checksums whatever lands against Electron's own
 * `checksums.json`. This widens the window the download is allowed to take; it
 * does not widen what is accepted.
 *
 * @param {string} zipPath Destination path for the downloaded artifact.
 * @param {string} downloadUrl Release-artifact URL.
 * @param {{
 *   attempts: number,
 *   delaySeconds: number,
 *   retryMaxTimeSeconds: number,
 *   connectTimeoutSeconds: number,
 * }} [retry]
 * @returns {string[]}
 */
export function buildDownloadArgs(
  zipPath,
  downloadUrl,
  retry = DOWNLOAD_RETRY
) {
  return [
    "--fail",
    "--location",
    "--retry",
    String(retry.attempts),
    "--retry-all-errors",
    "--retry-delay",
    String(retry.delaySeconds),
    "--retry-max-time",
    String(retry.retryMaxTimeSeconds),
    "--connect-timeout",
    String(retry.connectTimeoutSeconds),
    "--output",
    zipPath,
    downloadUrl,
  ];
}

/**
 * How long a releases blip may last before the download gives up, in seconds.
 *
 * `--retry-delay` disables curl's exponential backoff, so the retry schedule is
 * flat and spans `attempts × delaySeconds`. Transfer time only ADDS to the real
 * elapsed window, so this is a floor rather than an estimate — which is the
 * whole reason it is trustworthy.
 *
 * It is trustworthy only while `--retry-max-time` is disabled, though. A nonzero
 * ceiling is wall clock counting the transfers too, so it can stop retries well
 * before this many seconds of delay have accrued, and no arithmetic over these
 * three numbers can say when. `NaN` for such a budget is deliberate: it makes an
 * unmodelable case loudly unusable instead of quietly overstating the window.
 *
 * @param {{
 *   attempts: number,
 *   delaySeconds: number,
 *   retryMaxTimeSeconds: number,
 * }} [retry]
 * @returns {number} Seconds, or `NaN` when a nonzero ceiling makes it unmodelable.
 */
export function retryWindowSeconds(retry = DOWNLOAD_RETRY) {
  if (retry.retryMaxTimeSeconds !== 0) {
    return Number.NaN;
  }
  return retry.attempts * retry.delaySeconds;
}
