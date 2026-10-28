import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getPackagingStageRoot } from "./packaging-stage-path.mjs";
import {
  classifyMacSigningEnv,
  classifyRetryableMacSigningFailure,
  MacSigningMode,
  macSigningFailureMessage,
} from "./run-electron-builder-lib.mjs";

/**
 * How much of each of electron-builder's output streams is kept for
 * classification. Its failure is always at the end — it stops at the error —
 * and holding a whole packaging log in memory is unbounded growth over an
 * external input.
 */
const OUTPUT_TAIL_LIMIT_CHARS = 64 * 1024;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const stageRoot = getPackagingStageRoot();

await stat(stageRoot).catch(() => {
  throw new Error(
    "Packaging app is missing. Run `pnpm stage:package` before invoking electron-builder."
  );
});

// Defensive guard for the missing-signing-secret failure mode.
//
// The release workflow sets all five Apple signing + notarization env vars from
// org-level secrets. If those org secrets are not shared with this repository,
// the vars arrive DEFINED-BUT-EMPTY (a referenced-but-unset GitHub secret
// expands to ""). Two distinct failure modes follow, both of which we fail fast
// on here rather than producing a broken release:
//   - empty CSC_LINK: electron-builder treats it as a certificate file path,
//     resolves it to the project directory, and dies with the cryptic
//     `⨯ <projectDir> not a file`.
//   - empty APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID: with
//     `notarize: true`, electron-builder silently SKIPS notarization (it only
//     warns) and ships a signed-but-un-notarized DMG that Gatekeeper blocks on
//     install — a green CI run that yields an unusable build.
// So all five must be present together for the release signing path.
//
// Unset (not just empty) vars are intentionally allowed: that is the local /
// ad-hoc build path (electron-builder ad-hoc-signs, notarization is skipped by
// design), so we must not require signing there. The classification itself
// lives in run-electron-builder-lib.mjs so it can be driven under test without
// spawning electron-builder.
const target = process.platform === "linux" ? "--linux" : "--mac";
const macSigning = classifyMacSigningEnv(target === "--mac" ? process.env : {});
if (macSigning.mode === MacSigningMode.Misconfigured) {
  throw new Error(macSigningFailureMessage(macSigning.emptyDefined));
}

const electronBuilderArgs = [
  target,
  "--config",
  "electron-builder.yml",
  `-c.directories.app=${stageRoot}`,
  ...process.argv.slice(2),
];

let result = await runElectronBuilder(electronBuilderArgs);

// PRD-707 FR2 / ISS-10381: one retry of the signing step, and exactly one — an
// `if`, so the bound is structural rather than a counter someone can widen.
// Apple's timestamp authority refuses a `codesign --timestamp` request
// transiently (candidate run 34992566918, 2026-09-15), and a second attempt
// clears it; every other signing failure is real and keeps its first error.
//
// Retrying the whole electron-builder run is the narrowest thing that can
// recover: the signature is produced inside it, and it recreates its output
// directories, so a half-signed bundle from the failed attempt is not carried
// forward. The `Verify Desktop codesign and notarization` step both lanes run
// afterwards is the machine check that nothing unsigned reaches the channel.
//
// A NUMERIC non-zero status is required before the output is read at all.
// `close` reports a signal-terminated child as `status === null` (the signal
// name arrives separately), which is a cancelled, timed-out or OOM-killed
// packaging attempt — not the transient signing failure. Its partial output can
// still carry the timestamp line from an earlier file in the same run, so
// gating on `status !== 0` alone would retry a kill.
const retryableFailure =
  typeof result.status === "number" && result.status !== 0
    ? classifyRetryableMacSigningFailure(result.output)
    : null;

if (retryableFailure) {
  // Emitted BEFORE the retry, so a run that went on to succeed still says it
  // needed one. A silent retry is how a degrading signing service turns into a
  // green build and no signal; this annotation is what makes a rising retry
  // rate visible on the run and readable from the checks API.
  //
  // It survives the two wrappers between here and Actions. Both lanes reach
  // this script through `pnpm turbo package:turbo --filter=desktop`, and turbo
  // on Actions groups rather than per-line-prefixes: candidate run
  // 34992566918's log carries `::group::`-folded, UNPREFIXED electron-builder
  // lines, and pnpm's own `::error::` from inside that same task rendered as
  // `##[error]`. A workflow command written here therefore still begins its
  // line when Actions reads it.
  console.warn(
    `::warning title=Desktop signing retried::${retryableFailure} failure on the first packaging attempt; retrying once (PRD-707 FR2). A rising rate here means the signing dependency is degrading, not that this build is unhealthy.`
  );
  result = await runElectronBuilder(electronBuilderArgs);
}

// `exitCode` rather than `process.exit()`: stdout is a pipe under Actions and
// the writes above are this process's own, so an immediate exit can truncate
// the very error a reader needs.
process.exitCode = result.status ?? 1;

/**
 * Run electron-builder once, streaming its output through so a multi-minute
 * packaging run still logs live, while keeping a bounded tail of each stream to
 * classify a failure with.
 *
 * The stream is piped rather than inherited because a failure cannot be
 * classified from an exit code. Under Actions that changes nothing — stdout is
 * already a pipe there — but a developer running this straight from a terminal
 * loses electron-builder's TTY colour and progress rendering. That is the price
 * of the classification, and it is the only reason to pay it.
 *
 * @param {readonly string[]} args
 * @returns {Promise<{ status: number | null, output: string }>}
 */
function runElectronBuilder(args) {
  const child = spawn("electron-builder", [...args], {
    cwd: appDir,
    stdio: ["inherit", "pipe", "pipe"],
  });

  // `pipe` rather than a `write` inside the data handler: it is the stdlib's
  // backpressure. A blocked sink — the Actions pipe under load — makes
  // `write()` return false, and `pipe` pauses the child's stream until `drain`
  // instead of growing this process's send queue without a bound while the
  // child keeps producing. `end: false` because these sinks outlive the child
  // and must survive the retry: `pipe`'s default would call `.end()` on them at
  // the first attempt's EOF, and Node documents `end()` on `process.stdout` as
  // throwing rather than closing. A piped stdout under Actions tolerates it, so
  // no CI assertion can distinguish the two — a developer's TTY is where it
  // would surface.
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });

  // A second listener on the same streams, so the captured tail is exactly the
  // bytes that were forwarded: `pipe`'s pause stops delivery to both.
  //
  // One tail PER STREAM (ISS-10547). They are separate OS pipes, so arrival
  // order in a shared buffer is not the child's write order: under congestion
  // `pipe` pauses stdout while stderr keeps flowing, the signing-failure line
  // lands first, and the resumed stdout flood evicts it before the retry gate
  // ever reads it. Two bounded tails are still O(1).
  let stdoutTail = "";
  let stderrTail = "";
  child.stdout.on("data", (chunk) => {
    stdoutTail = boundedTail(stdoutTail, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrTail = boundedTail(stderrTail, chunk);
  });

  return new Promise((resolve, reject) => {
    // A spawn failure is not a signing failure and must not be retried as one.
    child.on("error", reject);
    // Classification reads both streams: electron-builder's failure can be on
    // either, and the newline keeps the two tails from splicing into a line
    // that neither stream actually carried.
    child.on("close", (status) =>
      resolve({ status, output: `${stdoutTail}\n${stderrTail}` })
    );
  });
}

/**
 * Append a chunk to a tail, keeping the last {@link OUTPUT_TAIL_LIMIT_CHARS}.
 *
 * @param {string} tail
 * @param {Buffer} chunk
 * @returns {string}
 */
function boundedTail(tail, chunk) {
  return (tail + chunk.toString("utf8")).slice(-OUTPUT_TAIL_LIMIT_CHARS);
}
