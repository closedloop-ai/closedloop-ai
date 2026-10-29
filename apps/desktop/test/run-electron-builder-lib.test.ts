import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import {
  classifyMacSigningEnv,
  classifyRetryableMacSigningFailure,
  MacSigningMode,
  macSigningFailureMessage,
  REQUIRED_MAC_SIGNING_ENV_VARS,
} from "../scripts/run-electron-builder-lib.mjs";
import {
  accessedProperties,
  calledIdentifiers,
  declaredFunctionNames,
  methodsCalledOn,
  namedImportsFrom,
  parseDesktopScript,
} from "./helpers/entrypoint-wiring.js";

const LIB_MODULE = "./run-electron-builder-lib.mjs";
const ENTRYPOINT = "run-electron-builder.mjs";
const REAL_SCRIPTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts"
);
/** GITHUB_RUN_ID is a path segment `packaging-stage-path.mjs` refuses to widen. */
const UNSAFE_STAGE_ID_CHARS = /[^A-Za-z0-9_-]/g;

const SIGNING_VAR_VALUES: Record<string, string> = {
  CSC_LINK: "base64-certificate",
  CSC_KEY_PASSWORD: "hunter2",
  APPLE_ID: "release@closedloop.ai",
  APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop",
  APPLE_TEAM_ID: "TEAM123456",
};

function envWith(names: readonly string[]): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of names) {
    env[name] = SIGNING_VAR_VALUES[name];
  }
  return env;
}

/** Every subset of the five required vars, as configured-name lists. */
function everyConfiguredSubset(): string[][] {
  let subsets: string[][] = [[]];
  for (const name of REQUIRED_MAC_SIGNING_ENV_VARS) {
    subsets = subsets.flatMap((subset) => [subset, [...subset, name]]);
  }
  return subsets;
}

describe("ISS-5303: run-electron-builder classifies the Apple signing secrets", () => {
  test("all five present and non-empty is the release signing path", () => {
    const classification = classifyMacSigningEnv(
      envWith(REQUIRED_MAC_SIGNING_ENV_VARS)
    );

    assert.equal(classification.mode, MacSigningMode.Signed);
    assert.deepEqual(classification.emptyDefined, []);
    assert.deepEqual(classification.absent, []);
    assert.deepEqual(classification.configured, [
      ...REQUIRED_MAC_SIGNING_ENV_VARS,
    ]);
  });

  test("none of the five defined is the local ad-hoc build path", () => {
    // Unset is NOT an error: electron-builder ad-hoc-signs and skips
    // notarization by design, and requiring signing here would make a local
    // `pnpm package` impossible.
    const classification = classifyMacSigningEnv({
      PATH: "/usr/bin",
      HOME: "/home/dev",
    });

    assert.equal(classification.mode, MacSigningMode.Unsigned);
    assert.deepEqual(classification.emptyDefined, []);
    assert.deepEqual(classification.absent, [...REQUIRED_MAC_SIGNING_ENV_VARS]);
  });

  test("ignores env vars that are not part of the signing contract", () => {
    const classification = classifyMacSigningEnv({
      ...envWith(REQUIRED_MAC_SIGNING_ENV_VARS),
      NOTARIZE: "",
      CSC_IDENTITY_AUTO_DISCOVERY: "",
    });

    assert.equal(classification.mode, MacSigningMode.Signed);
    assert.deepEqual(classification.emptyDefined, []);
  });
});

describe("ISS-5303: a partially configured environment is never signable", () => {
  for (const missing of REQUIRED_MAC_SIGNING_ENV_VARS) {
    test(`${missing} entirely absent, the other four set`, () => {
      const classification = classifyMacSigningEnv(
        envWith(REQUIRED_MAC_SIGNING_ENV_VARS.filter((n) => n !== missing))
      );

      assert.notEqual(classification.mode, MacSigningMode.Signed);
      assert.equal(classification.mode, MacSigningMode.Partial);
      assert.deepEqual(classification.absent, [missing]);
      assert.deepEqual(classification.emptyDefined, []);
    });

    test(`${missing} defined but empty, the other four set`, () => {
      // The CI failure this guard exists for: a referenced-but-unshared org
      // secret expands to "". Signing/notarization then half-happens and CI
      // reports green on a DMG Gatekeeper blocks.
      const classification = classifyMacSigningEnv({
        ...envWith(REQUIRED_MAC_SIGNING_ENV_VARS),
        [missing]: "",
      });

      assert.notEqual(classification.mode, MacSigningMode.Signed);
      assert.equal(classification.mode, MacSigningMode.Misconfigured);
      assert.deepEqual(classification.emptyDefined, [missing]);
    });

    test(`${missing} defined as whitespace, the other four set`, () => {
      const classification = classifyMacSigningEnv({
        ...envWith(REQUIRED_MAC_SIGNING_ENV_VARS),
        [missing]: "  \n\t ",
      });

      assert.equal(classification.mode, MacSigningMode.Misconfigured);
      assert.deepEqual(classification.emptyDefined, [missing]);
    });
  }

  test("a key present with an undefined value counts as defined-but-empty", () => {
    const classification = classifyMacSigningEnv({
      ...envWith(REQUIRED_MAC_SIGNING_ENV_VARS),
      APPLE_TEAM_ID: undefined,
    });

    assert.equal(classification.mode, MacSigningMode.Misconfigured);
    assert.deepEqual(classification.emptyDefined, ["APPLE_TEAM_ID"]);
  });

  test("an empty-defined var outranks absent siblings", () => {
    // Fail-closed ordering: "one secret is blank" is a wiring bug regardless of
    // how many of the rest are simply not set, so it must not read as the
    // benign local `unsigned` path.
    const classification = classifyMacSigningEnv({ CSC_LINK: "" });

    assert.equal(classification.mode, MacSigningMode.Misconfigured);
    assert.deepEqual(classification.emptyDefined, ["CSC_LINK"]);
    assert.equal(classification.absent.length, 4);
  });

  test("`signed` is reachable ONLY from a fully configured environment", () => {
    // Exhaustive over all 32 subsets: this is the fail-closed direction stated
    // as a property rather than as a handful of examples. Widening the
    // classifier to accept any proper subset goes red here.
    let signedSubsets = 0;

    for (const configured of everyConfiguredSubset()) {
      const { mode } = classifyMacSigningEnv(envWith(configured));
      const isComplete =
        configured.length === REQUIRED_MAC_SIGNING_ENV_VARS.length;

      assert.equal(
        mode === MacSigningMode.Signed,
        isComplete,
        `configured=[${configured.join(",")}] classified as ${mode}`
      );
      if (mode === MacSigningMode.Signed) {
        signedSubsets += 1;
      }
    }

    assert.equal(signedSubsets, 1);
  });

  test("does not mutate the environment it classifies", () => {
    const env = envWith(REQUIRED_MAC_SIGNING_ENV_VARS);
    const before = { ...env };

    classifyMacSigningEnv(env);

    assert.deepEqual(env, before);
  });
});

describe("ISS-5303: the refusal message", () => {
  test("names every offending var and both remedies", () => {
    const message = macSigningFailureMessage(["CSC_LINK", "APPLE_TEAM_ID"]);

    assert.ok(message.startsWith("macOS signing/notarization env var(s)"));
    assert.ok(message.includes("CSC_LINK, APPLE_TEAM_ID"));
    // CI's remedy is the org-secret share; a developer's remedy is to UNSET.
    assert.ok(message.includes("org secrets"));
    assert.ok(message.includes("unset CSC_LINK/CSC_KEY_PASSWORD entirely"));
  });

  test("carries the exact vars the classifier reported", () => {
    const { emptyDefined } = classifyMacSigningEnv({
      ...envWith(REQUIRED_MAC_SIGNING_ENV_VARS),
      APPLE_ID: "",
      APPLE_APP_SPECIFIC_PASSWORD: "",
    });

    assert.ok(
      macSigningFailureMessage(emptyDefined).includes(
        "APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD"
      )
    );
  });
});

describe("ISS-5303: the required-secret set is the contract", () => {
  test("is exactly the five vars the release workflow sets together", () => {
    // Signing and notarization are one unit. Dropping a name here would let a
    // signed-but-un-notarized build class as `signed`.
    assert.deepEqual(
      [...REQUIRED_MAC_SIGNING_ENV_VARS],
      [
        "CSC_LINK",
        "CSC_KEY_PASSWORD",
        "APPLE_ID",
        "APPLE_APP_SPECIFIC_PASSWORD",
        "APPLE_TEAM_ID",
      ]
    );
  });
});

describe("ISS-5303: run-electron-builder.mjs is wired to the lib", () => {
  test("imports exactly the three symbols the lib exports for it", () => {
    // The entrypoint spawns a full electron-builder packaging run at module
    // scope, so nothing above this line executes it. Without this assertion,
    // re-inlining `classifyMacSigningEnv` back into the shell leaves all 32
    // subset cases green while packaging runs a SECOND, untested copy of the
    // fail-closed refusal.
    const entrypoint = parseDesktopScript(ENTRYPOINT);

    assert.deepEqual(namedImportsFrom(entrypoint, LIB_MODULE), [
      "MacSigningMode",
      "classifyMacSigningEnv",
      "classifyRetryableMacSigningFailure",
      "macSigningFailureMessage",
    ]);
  });

  test("the imported names are the ones the lib actually exports", () => {
    // Not a tautology: it is the join between the two halves. The assertion
    // above reads the entrypoint's source, this one reads the loaded module, so
    // an import of a name the lib no longer exports fails here rather than at
    // `pnpm package` time.
    const imported = namedImportsFrom(
      parseDesktopScript(ENTRYPOINT),
      LIB_MODULE
    );
    const exported: Record<string, unknown> = {
      MacSigningMode,
      classifyMacSigningEnv,
      classifyRetryableMacSigningFailure,
      macSigningFailureMessage,
    };

    for (const name of imported) {
      assert.notEqual(
        exported[name],
        undefined,
        `${ENTRYPOINT} imports ${name}, which the lib does not export`
      );
    }
  });

  test("keeps no local copy of the classification", () => {
    const declared = declaredFunctionNames(parseDesktopScript(ENTRYPOINT));

    assert.deepEqual(
      declared.filter(
        (name) =>
          name === "classifyMacSigningEnv" ||
          name === "macSigningFailureMessage"
      ),
      []
    );
  });

  test("still classifies the env and still renders the refusal", () => {
    // Import without call is the other half of the revert: an entrypoint that
    // imports the classifier and then branches on a hand-rolled `if
    // (process.env.CSC_LINK === "")` would satisfy the import assertion alone.
    const called = calledIdentifiers(parseDesktopScript(ENTRYPOINT));

    assert.equal(called.includes("classifyMacSigningEnv"), true);
    assert.equal(called.includes("macSigningFailureMessage"), true);
    // ISS-10381: the retry gate, on the same terms. An entrypoint that imported
    // the classifier and then retried on `status !== 0` alone would widen a
    // one-class retry into a retry-everything, which is the decision this
    // classifier exists to refuse.
    assert.equal(called.includes("classifyRetryableMacSigningFailure"), true);
  });

  test("refuses on Misconfigured and on nothing else", () => {
    // Which member the shell compares against IS the fail-closed policy.
    // Branching on `Partial` instead would keep every assertion above green
    // while letting an empty-defined CSC_LINK through to electron-builder.
    // A source-level MEMBER NAME, so the literal is the contract here — there
    // is no runtime constant whose value is the key `"Misconfigured"`. The
    // lookup below is what ties it back to the exported const object.
    const memberName = "Misconfigured";
    assert.equal(MacSigningMode[memberName], MacSigningMode.Misconfigured);
    assert.deepEqual(
      accessedProperties(parseDesktopScript(ENTRYPOINT), "MacSigningMode"),
      [memberName]
    );
  });
});

/**
 * The verbatim tail of candidate run 34992566918 (2026-09-15), the failure
 * ISS-10381 was filed for. Trimmed of the runner's absolute path, which is not
 * what classification reads.
 */
const OBSERVED_TIMESTAMP_FAILURE = [
  "  ⨯ Command failed: codesign --sign Developer ID Application: ClosedLoop.ai, Inc. (***) --force --timestamp --options runtime locale.pak",
  "locale.pak: replacing existing signature",
  "locale.pak: A timestamp was expected but was not found.",
].join("\n");

/**
 * The ISS-9161 keychain break. Deliberately a NON-retryable row: this repo
 * diagnosed it as a deterministic macOS 26.6 behaviour change and fixed it with
 * a patch, so a retry would be eight wasted minutes and a second copy of the
 * error. PRD-707 FR2 names this class; the exclusion is the deviation, and it
 * is pinned here rather than left to inspection.
 */
const ISS_9161_KEYCHAIN_FAILURE =
  "security: SecKeychainUnlock: The user name or passphrase you entered is not correct.";

/** Signing failures that are real rejections, whatever they cost to produce. */
const NON_RETRYABLE_SIGNING_FAILURES: Record<string, string> = {
  "no identity": "  ⨯ No identity found for signing",
  "identity missing from keychain":
    "The specified item could not be found in the keychain.",
  "revoked certificate": "CSSMERR_TP_CERT_REVOKED",
  "entitlement mismatch":
    "Invalid Entitlements: the entitlements are not valid for this identity",
  "unsigned nested code": "code object is not signed at all",
  "ISS-9161 keychain import": ISS_9161_KEYCHAIN_FAILURE,
};

const TIMESTAMP_AUTHORITY = "Apple timestamp authority";
/**
 * Written out rather than imported from the entrypoint, deliberately. This
 * exact prefix is what `docs/runbooks/desktop-release-failure-triage.md` tells
 * an operator to read a green build by, so a shared constant would let a
 * rename move both sides at once and leave the runbook quoting a string that no
 * longer appears in any run.
 */
const RETRY_ANNOTATION = "::warning title=Desktop signing retried::";

/** The three sibling modules a copy of the entrypoint needs to run. */
const ENTRYPOINT_CHAIN = [
  ENTRYPOINT,
  "run-electron-builder-lib.mjs",
  "packaging-stage-path.mjs",
];

const STUB_ELECTRON_BUILDER = `#!/bin/sh
attempt=$(( $(cat "$STUB_ATTEMPT_FILE") + 1 ))
printf '%s' "$attempt" > "$STUB_ATTEMPT_FILE"
if [ "$attempt" -le "$STUB_FAILING_ATTEMPTS" ]; then
  i=0
  while [ "$i" -lt "$STUB_NOISE_LINES" ]; do
    printf '  • packaging       platform=darwin arch=universal electron=43.0.0\\n' >&2
    i=$(( i + 1 ))
  done
  if [ -n "$STUB_CONGESTED_FAILURE_STREAM" ]; then
    # Establish the reader BEFORE printf can wake the parent's release writer.
    exec 3<> "$STUB_RELEASE_FIFO" || exit 97
  fi
  if [ "$STUB_CONGESTED_FAILURE_STREAM" = "stdout" ]; then
    printf '%s\\n' "$STUB_FAILURE_OUTPUT"
    read -r release <&3 || exit 97
    head -c "$STUB_FLOOD_BYTES" /dev/zero | tr '\\0' 'x' >&2
  elif [ "$STUB_CONGESTED_FAILURE_STREAM" = "stderr" ]; then
    printf '%s\\n' "$STUB_FAILURE_OUTPUT" >&2
    read -r release <&3 || exit 97
    head -c "$STUB_FLOOD_BYTES" /dev/zero | tr '\\0' 'x'
  else
    if [ "$STUB_FLOOD_BYTES" -gt 0 ]; then
      head -c "$STUB_FLOOD_BYTES" /dev/zero | tr '\\0' 'x'
    fi
    printf '%s\\n' "$STUB_FAILURE_OUTPUT" >&2
  fi
  if [ -n "$STUB_TERMINATE_SIGNAL" ]; then
    kill -"$STUB_TERMINATE_SIGNAL" $$
  fi
  exit 1
fi
printf 'packaged\\n'
exit 0
`;

const STUB_SUCCESS_STDOUT = "packaged\n";
/** Room for the flood case; the default 1 MiB would abort the spawn instead. */
const DRIVE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

type DriveOutcome = {
  attempts: number;
  status: number | null;
  output: string;
  stdoutBytes: number;
  stderrBytes: number;
};

type DriveOptions = {
  /** Lines of packaging chatter emitted before the failure. */
  noiseLines?: number;
  /**
   * Bytes of flood output. By default they go to stdout BEFORE the failure;
   * under `congestedFailureStream` they go to the OTHER stream, AFTER it.
   */
  floodBytes?: number;
  /** Signal the stub kills ITSELF with, instead of exiting with a status. */
  terminateSignal?: string;
  /**
   * Emit the failure on THIS stream, then BLOCK on `releaseFifo` before
   * flooding the OTHER one with `floodBytes`. That is the arrival order a
   * congested `pipe` produces in production, and it is the opposite of the
   * default (flood first, failure last). The block is what makes the order a
   * fact rather than a race — see `driveEntrypointReleasedAfterDiagnostic`.
   */
  congestedFailureStream?: "stdout" | "stderr";
  /**
   * A FIFO the stub reads one line from before it floods. Required by
   * `congestedFailureStream`, and deliberately not defaulted: the stub exits 97
   * rather than flood ungated, because an ungated flood is exactly the vacuous
   * case this option exists to rule out.
   */
  releaseFifo?: string;
};

/**
 * Drive a byte-for-byte COPY of the entrypoint with `electron-builder` stubbed,
 * and report how many times the stub was invoked.
 *
 * A copy, not this path, for the reason `scripts/tooling-reach-ledger.mjs`
 * states for every entrypoint in this class: executing the shipped file would
 * credit it in the node lane's reach numbers on the strength of a stub, and the
 * ledger entry that names it unreachable would silently rot. The AST wiring
 * assertions above are what tie the copy's behaviour back to the shipped file.
 */
function driveEntrypointCopy(
  failureOutput: string,
  failingAttempts: number,
  options: DriveOptions = {}
): DriveOutcome {
  const prepared = prepareEntrypointRun(
    failureOutput,
    failingAttempts,
    options
  );
  try {
    const run = spawnSync(process.execPath, [prepared.entrypointPath], {
      encoding: "utf8",
      env: prepared.env,
      timeout: 30_000,
      maxBuffer: DRIVE_MAX_BUFFER_BYTES,
    });
    if (run.error) {
      throw run.error;
    }
    return {
      attempts: readAttempts(prepared.attemptFile),
      status: run.status,
      output: `${run.stdout}${run.stderr}`,
      stdoutBytes: run.stdout.length,
      stderrBytes: run.stderr.length,
    };
  } finally {
    prepared.dispose();
  }
}

type PreparedRun = {
  entrypointPath: string;
  env: Record<string, string | undefined>;
  attemptFile: string;
  dispose: () => void;
};

/**
 * Stage a runnable copy of the entrypoint chain with `electron-builder` stubbed.
 *
 * Split out of {@link driveEntrypointCopy} so the congestion driver below can
 * stage the identical tree and then drive it ASYNCHRONOUSLY. A `spawnSync`
 * parent cannot react to the child mid-run, and reacting mid-run is the whole
 * difficulty there.
 */
function prepareEntrypointRun(
  failureOutput: string,
  failingAttempts: number,
  options: DriveOptions
): PreparedRun {
  const workspace = mkdtempSync(path.join(tmpdir(), "electron-builder-drive-"));
  const runId = path.basename(workspace).replace(UNSAFE_STAGE_ID_CHARS, "");
  const stageRoot = path.join(
    tmpdir(),
    "closedloop-desktop-packaging-stage",
    runId
  );
  const dispose = () => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(stageRoot, { recursive: true, force: true });
  };
  try {
    const scriptsDir = path.join(workspace, "scripts");
    const binDir = path.join(workspace, "bin");
    const attemptFile = path.join(workspace, "attempts");
    mkdirSync(scriptsDir);
    mkdirSync(binDir);
    mkdirSync(stageRoot, { recursive: true });
    for (const name of ENTRYPOINT_CHAIN) {
      copyFileSync(
        path.join(REAL_SCRIPTS_DIR, name),
        path.join(scriptsDir, name)
      );
    }
    writeFileSync(attemptFile, "0");
    writeFileSync(
      path.join(binDir, "electron-builder"),
      STUB_ELECTRON_BUILDER,
      {
        mode: 0o755,
      }
    );

    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      GITHUB_RUN_ID: runId,
      STUB_ATTEMPT_FILE: attemptFile,
      STUB_FAILING_ATTEMPTS: String(failingAttempts),
      STUB_FAILURE_OUTPUT: failureOutput,
      STUB_NOISE_LINES: String(options.noiseLines ?? 0),
      STUB_FLOOD_BYTES: String(options.floodBytes ?? 0),
      STUB_TERMINATE_SIGNAL: options.terminateSignal ?? "",
      STUB_CONGESTED_FAILURE_STREAM: options.congestedFailureStream ?? "",
      STUB_RELEASE_FIFO: options.releaseFifo ?? "",
    };
    // The local ad-hoc path, deterministically: an inherited blank signing var
    // would make the entrypoint refuse before it ever spawned the stub.
    for (const name of REQUIRED_MAC_SIGNING_ENV_VARS) {
      delete env[name];
    }

    return {
      entrypointPath: path.join(scriptsDir, ENTRYPOINT),
      env,
      attemptFile,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** How many times the stub ran, from the file it counts itself in. */
function readAttempts(attemptFile: string): number {
  return Number.parseInt(readFileSync(attemptFile, "utf8"), 10);
}

type ReleasedOutcome = {
  attempts: number;
  status: number | null;
  output: string;
  /** Flood bytes this process observed AFTER it opened the release point. */
  floodBytesAfterDiagnostic: number;
};

/**
 * Drive the entrypoint copy with the stub's flood held at a release point THIS
 * process opens, and open it only once the diagnostic has arrived whole on the
 * other stream.
 *
 * This is what makes the two cases below able to fail. Left to itself the
 * arrival order is a race and proves nothing: `spawnSync` drains the
 * entrypoint's own sinks, so `pipe` never pauses, and nothing separates two OS
 * pipes the child wrote to microseconds apart — a shared tail can receive the
 * diagnostic last and pass. Here not one byte of the flood EXISTS until the
 * diagnostic has crossed the entrypoint, because the stub blocks reading
 * `releaseFifo` and this process only writes to it from the handler that saw
 * the diagnostic come out. The entrypoint captures a chunk in the same `data`
 * emit that forwards it, so "we saw it" means "it is already in the tail", and
 * every one of `floodBytes` is captured after it — with no dependence on
 * pipe-buffer sizes, scheduler order, or a wall-clock wait.
 *
 * The stub opens its FIFO read/write descriptor BEFORE emitting the diagnostic,
 * so the non-blocking release write cannot race the reader's open. It may queue
 * before `read` runs, but no flood byte is written until `read` consumes it.
 */
async function driveEntrypointReleasedAfterDiagnostic(
  congestedFailureStream: "stdout" | "stderr",
  floodBytes: number
): Promise<ReleasedOutcome> {
  const fifoDir = mkdtempSync(path.join(tmpdir(), "electron-builder-release-"));
  const releaseFifo = path.join(fifoDir, "release");
  const mkfifo = spawnSync("mkfifo", [releaseFifo], { encoding: "utf8" });
  if (mkfifo.status !== 0) {
    throw new Error(`mkfifo ${releaseFifo} failed: ${mkfifo.stderr}`);
  }
  const prepared = prepareEntrypointRun(OBSERVED_TIMESTAMP_FAILURE, 1, {
    congestedFailureStream,
    floodBytes,
    releaseFifo,
  });
  try {
    const child = spawn(process.execPath, [prepared.entrypointPath], {
      env: prepared.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    let output = "";
    let carried = "";
    let released = false;
    let releaseError: unknown;
    let floodBytesAfterDiagnostic = 0;
    const observe = (stream: "stdout" | "stderr", chunk: string) => {
      output += chunk;
      if (stream !== congestedFailureStream) {
        if (released) {
          floodBytesAfterDiagnostic += chunk.length;
        }
        return;
      }
      carried += chunk;
      if (released || !carried.includes(OBSERVED_TIMESTAMP_FAILURE)) {
        return;
      }
      released = true;
      try {
        openRelease(releaseFifo);
      } catch (error) {
        releaseError = error;
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => observe("stdout", chunk));
    child.stderr.on("data", (chunk: string) => observe("stderr", chunk));
    const status = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    if (releaseError) {
      throw releaseError;
    }
    return {
      attempts: readAttempts(prepared.attemptFile),
      status,
      output,
      floodBytesAfterDiagnostic,
    };
  } finally {
    prepared.dispose();
    rmSync(fifoDir, { recursive: true, force: true });
  }
}

/** Release the stub through the reader it opened before emitting the diagnostic. */
function openRelease(releaseFifo: string): void {
  // biome-ignore lint/suspicious/noBitwiseOperators: open(2) flags are a bitmask, and there is no string spelling of O_NONBLOCK.
  const fd = openSync(releaseFifo, constants.O_WRONLY | constants.O_NONBLOCK);
  try {
    writeSync(fd, "release\n");
  } finally {
    closeSync(fd);
  }
}

describe("ISS-10381: only a transient signing failure is retryable", () => {
  test("the Apple timestamp-authority failure this ticket was filed for", () => {
    assert.equal(
      classifyRetryableMacSigningFailure(OBSERVED_TIMESTAMP_FAILURE),
      TIMESTAMP_AUTHORITY
    );
  });

  test("codesign's sibling timestamp-service refusal", () => {
    assert.equal(
      classifyRetryableMacSigningFailure(
        "locale.pak: The timestamp service is not available."
      ),
      TIMESTAMP_AUTHORITY
    );
  });

  for (const [label, output] of Object.entries(
    NON_RETRYABLE_SIGNING_FAILURES
  )) {
    test(`${label} is never retried`, () => {
      assert.equal(classifyRetryableMacSigningFailure(output), null);
    });
  }

  test("an unrecognised failure is not retryable", () => {
    // The allowlist polarity, stated as a property: a signing failure nobody
    // has classified yet fails on its first error rather than being retried on
    // the chance that it might be transient.
    assert.equal(
      classifyRetryableMacSigningFailure("⨯ something nobody has seen before"),
      null
    );
    assert.equal(classifyRetryableMacSigningFailure(""), null);
  });

  test("matches wherever in the text it is given the line falls", () => {
    // Position-independence of the CLASSIFIER only. What the entrypoint
    // actually captures, and from which end, is pinned by the noisy-run case
    // in the next block — not here.
    const noise = "• packaging platform=darwin\n".repeat(200);
    assert.equal(
      classifyRetryableMacSigningFailure(
        `${noise}${OBSERVED_TIMESTAMP_FAILURE}\n${noise}`
      ),
      TIMESTAMP_AUTHORITY
    );
  });

  test("no pattern matches across the join between the two tails", () => {
    // The entrypoint hands this function `${stdoutTail}\n${stderrTail}`
    // (ISS-10547), so the text is two slices of the run and not one. A pattern
    // that spanned that newline would splice the end of one stream onto the
    // start of the other and retry on a line neither stream carried.
    const stdoutTail = "locale.pak: A timestamp was expected";
    const stderrTail = "but was not found.";

    assert.equal(
      classifyRetryableMacSigningFailure(`${stdoutTail}\n${stderrTail}`),
      null
    );
    assert.equal(classifyRetryableMacSigningFailure(stdoutTail), null);
    assert.equal(classifyRetryableMacSigningFailure(stderrTail), null);
    // The positive control, and the case is vacuous without it: the same two
    // halves on ONE line DO match, so the `null` above is attributable to the
    // join rather than to a fixture typo that would pass forever.
    assert.equal(
      classifyRetryableMacSigningFailure(`${stdoutTail} ${stderrTail}`),
      TIMESTAMP_AUTHORITY
    );
  });
});

describe("ISS-10381: the entrypoint retries the signing step once", () => {
  test("a transient failure is retried, and the run says it was", () => {
    const outcome = driveEntrypointCopy(OBSERVED_TIMESTAMP_FAILURE, 1);

    assert.equal(outcome.attempts, 2);
    assert.equal(outcome.status, 0);
    assert.ok(
      outcome.output.includes(RETRY_ANNOTATION),
      "a green run that needed a retry must still announce it, or a degrading signing service is invisible"
    );
    assert.ok(outcome.output.includes(TIMESTAMP_AUTHORITY));
  });

  test("a non-transient failure fails on the first attempt", () => {
    // ISS-10381 AC2. The counterfactual this kills: retrying on `status !== 0`
    // alone, which turns every real rejection into a doubled wait.
    const outcome = driveEntrypointCopy(ISS_9161_KEYCHAIN_FAILURE, 1);

    assert.equal(outcome.attempts, 1);
    assert.notEqual(outcome.status, 0);
    assert.ok(!outcome.output.includes(RETRY_ANNOTATION));
    assert.ok(
      outcome.output.includes(ISS_9161_KEYCHAIN_FAILURE),
      "the original error must still be legible; it is what a reader acts on"
    );
  });

  test("one retry, never a loop", () => {
    // A transient class that keeps failing is a real outage, not a blip: the
    // second failure is terminal, so a degraded timestamp authority costs one
    // extra attempt rather than an unbounded build.
    const outcome = driveEntrypointCopy(OBSERVED_TIMESTAMP_FAILURE, 99);

    assert.equal(outcome.attempts, 2);
    assert.notEqual(outcome.status, 0);
  });

  test("the failure is still found under a packaging log that overruns the window", () => {
    // The bound in `run-electron-builder.mjs` keeps the LAST slice of the run's
    // output, and the direction is load-bearing rather than cosmetic: under
    // `.slice(0, OUTPUT_TAIL_LIMIT_CHARS)` — keep the head — every other case
    // here stays green, because their stubs emit a few hundred bytes and head
    // and tail are the same string. A real packaging run is not like that, so
    // the retry would silently stop firing and only a rare transient would ever
    // have revealed it. 2000 lines of ~60 chars clears the 64 KiB window.
    const outcome = driveEntrypointCopy(OBSERVED_TIMESTAMP_FAILURE, 1, {
      noiseLines: 2000,
    });

    assert.equal(outcome.attempts, 2);
    assert.equal(outcome.status, 0);
    assert.ok(outcome.output.includes(RETRY_ANNOTATION));
  });

  test("a successful first attempt is never retried", () => {
    const outcome = driveEntrypointCopy(OBSERVED_TIMESTAMP_FAILURE, 0);

    assert.equal(outcome.attempts, 1);
    assert.equal(outcome.status, 0);
    assert.ok(!outcome.output.includes(RETRY_ANNOTATION));
  });

  test("a signal-killed attempt is never retried, whatever its output says", () => {
    // `close` reports a signal-terminated child as `status === null`, so a gate
    // written as `status !== 0` classifies it — and this stub prints the
    // transient line BEFORE killing itself, which is exactly the output a
    // cancelled run carries when the timestamp blip hit an earlier file. A
    // cancelled, timed-out or OOM-killed packaging attempt is not a signing
    // blip; retrying one doubles a build somebody or something already stopped.
    const outcome = driveEntrypointCopy(OBSERVED_TIMESTAMP_FAILURE, 1, {
      terminateSignal: "TERM",
    });

    assert.equal(outcome.attempts, 1);
    assert.notEqual(outcome.status, 0);
    assert.ok(!outcome.output.includes(RETRY_ANNOTATION));
  });

  test("a multi-megabyte packaging log is forwarded whole, and still classified", () => {
    // The volume half of the backpressure contract, and only that half. Every
    // byte the stub writes crosses two real OS pipes and must arrive intact,
    // the classified tail must still find the failure under a log far larger
    // than the window, and the SECOND attempt's own write must still land after
    // the first attempt's EOF. What it does NOT pin is the pause itself, nor
    // the `{ end: false }` that guards that EOF — a piped stdout tolerates the
    // `.end()` either way, so no CI assertion separates them. The pause is
    // pinned structurally, below.
    const floodBytes = 2 * 1024 * 1024;
    const outcome = driveEntrypointCopy(OBSERVED_TIMESTAMP_FAILURE, 1, {
      floodBytes,
    });

    assert.equal(outcome.attempts, 2);
    assert.equal(outcome.status, 0);
    assert.equal(outcome.stdoutBytes, floodBytes + STUB_SUCCESS_STDOUT.length);
    assert.ok(outcome.output.includes(RETRY_ANNOTATION));
  });

  test("forwards the child's streams with `pipe`, never a bare sink write", () => {
    // A SHAPE assertion, and deliberately only that. `pipe` pauses the child
    // when the sink stops accepting; a `write()` whose return value is dropped
    // inside a `data` handler keeps reading and grows this process's send queue
    // without a bound. That difference shows up at runtime only as an absence —
    // bytes that do not arrive, memory that does not grow — which cannot be
    // asserted without a wall-clock wait, so the mechanism is pinned here and
    // the bytes are pinned by the flood case above.
    const entrypoint = parseDesktopScript(ENTRYPOINT);

    assert.deepEqual(methodsCalledOn(entrypoint, "child.stdout"), [
      "on",
      "pipe",
    ]);
    assert.deepEqual(methodsCalledOn(entrypoint, "child.stderr"), [
      "on",
      "pipe",
    ]);
    assert.deepEqual(methodsCalledOn(entrypoint, "process.stdout"), []);
    assert.deepEqual(methodsCalledOn(entrypoint, "process.stderr"), []);
  });
});

describe("ISS-10547: a flood on one stream cannot evict the other's diagnostic", () => {
  /**
   * Eight times the entrypoint's 64 KiB window, and every one of these bytes is
   * captured AFTER the diagnostic: the stub cannot write the first of them
   * until `driveEntrypointReleasedAfterDiagnostic` opens the release point, and
   * it opens that only on seeing the diagnostic come out of the entrypoint. So
   * the margin is a property of the harness, not of scheduler luck. It is still
   * one-way and NOT pinned by an assertion — raising `OUTPUT_TAIL_LIMIT_CHARS`
   * past this literal would disarm both cases rather than redden them, so keep
   * it far above the production window.
   */
  const CONGESTION_FLOOD_BYTES = 512 * 1024;
  /** The spawn is bounded at 30s; this leaves room to report rather than hang. */
  const CONGESTION_CASE_TIMEOUT_MS = 60_000;

  test("the stderr diagnostic survives a stdout flood forced to arrive after it", {
    timeout: CONGESTION_CASE_TIMEOUT_MS,
  }, async () => {
    // stdout and stderr are separate OS pipes, so arrival order is not the
    // child's write order: in production `pipe` pauses a congested stdout
    // while stderr keeps flowing, and the signing-failure line reaches the
    // parent BEFORE the resumed flood. A shared tail slices the line off and
    // the ISS-10381 retry silently stops firing — a real `codesign
    // --timestamp` blip classified as permanent. The harness FORCES that
    // order rather than hoping for it; see the driver for why it has to.
    const outcome = await driveEntrypointReleasedAfterDiagnostic(
      "stderr",
      CONGESTION_FLOOD_BYTES
    );

    assert.equal(outcome.attempts, 2);
    assert.equal(outcome.status, 0);
    assert.ok(outcome.output.includes(RETRY_ANNOTATION));
    assert.ok(
      outcome.floodBytesAfterDiagnostic >= CONGESTION_FLOOD_BYTES,
      "the whole flood must have landed after the diagnostic and overrun the window, or this case proves nothing"
    );
  });

  test("the stdout diagnostic survives a stderr flood forced to arrive after it", {
    timeout: CONGESTION_CASE_TIMEOUT_MS,
  }, async () => {
    // The mirror, and it is load-bearing rather than symmetry for its own
    // sake: classifying the stderr tail alone passes the case above and fails
    // here. Nothing pins electron-builder's `⨯` line to one of the two pipes.
    const outcome = await driveEntrypointReleasedAfterDiagnostic(
      "stdout",
      CONGESTION_FLOOD_BYTES
    );

    assert.equal(outcome.attempts, 2);
    assert.equal(outcome.status, 0);
    assert.ok(outcome.output.includes(RETRY_ANNOTATION));
    assert.ok(
      outcome.floodBytesAfterDiagnostic >= CONGESTION_FLOOD_BYTES,
      "the whole flood must have landed after the diagnostic and overrun the window, or this case proves nothing"
    );
  });
});
