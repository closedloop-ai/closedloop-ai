/**
 * ISS-5303 — `scripts/ensure-electron-binary-lib.mjs`.
 *
 * The entrypoint repairs a broken Electron install by downloading the release
 * artifact for `<platform>-<arch>` and writing the executable's in-`dist/` path
 * into `path.txt`. Both of those values are decided by the two helpers under
 * test, and both failure modes are silent-and-late: a wrong platform path makes
 * `require("electron")` resolve to a file that does not exist, and a wrong arch
 * installs an x64 Electron on an Apple-silicon machine.
 *
 * The Rosetta branch is the reason `getArch` takes its host facts as an
 * argument. It is only reachable on an x64 Node running translated on Apple
 * silicon — never on CI, never on this machine — so injection is the only way
 * it is ever exercised.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type ArchHost,
  buildDownloadArgs,
  DOWNLOAD_RETRY,
  defaultArchHost,
  detectRosettaTranslation,
  ELECTRON_PLATFORM_PATHS,
  getArch,
  getPlatformPath,
  type RosettaProbeSpawn,
  retryWindowSeconds,
  TARGET_OUTAGE_SECONDS,
} from "../scripts/ensure-electron-binary-lib.mjs";
import {
  calledIdentifiers,
  declaredFunctionNames,
  namedImportsFrom,
  parseDesktopScript,
} from "./helpers/entrypoint-wiring.js";

const NO_ELECTRON_BUILD_PATTERN =
  /^Error: Electron builds are not available on platform: solaris$/;

const MACOS_EXECUTABLE = "Electron.app/Contents/MacOS/Electron";

/**
 * A host whose Rosetta probe records that it was consulted, so a test can
 * assert the probe is NOT reached on the paths that must short-circuit before
 * it (an explicit `npm_config_arch`, or any non-macOS combination).
 */
function hostWithProbe(
  hostPlatform: string,
  hostArch: string,
  translated: boolean
): { host: ArchHost; probeCalls: number[] } {
  const probeCalls: number[] = [];
  const host: ArchHost = {
    platform: hostPlatform,
    arch: hostArch,
    isRosettaTranslated: () => {
      probeCalls.push(probeCalls.length);
      return translated;
    },
  };
  return { host, probeCalls };
}

function spawnReturning(
  status: number | null,
  stdout: string
): RosettaProbeSpawn {
  return () => ({ status, stdout });
}

/**
 * The retry window curl would actually run, recovered from the argv it is
 * handed. Reading it back out here — rather than from `DOWNLOAD_RETRY` — is
 * what keeps the assertion honest: the flags are what curl obeys, and the
 * budget only reaches curl through them.
 *
 * `--retry-delay` disables the exponential backoff, so the schedule is flat at
 * `--retry × --retry-delay`. A nonzero `--retry-max-time` is wall clock that
 * counts the transfers too, so it can cut the schedule short by an amount no
 * arithmetic over these flags can predict — hence `NaN`, mirroring
 * `retryWindowSeconds`, rather than a `Math.min` that would understate the
 * ceiling's effect and overstate the window.
 */
function retryWindowFromArgs(args: string[]): number {
  const flagValue = (flag: string): number => {
    const index = args.indexOf(flag);
    if (index === -1) {
      throw new Error(`${flag} missing from the download argv`);
    }
    return Number(args[index + 1]);
  };

  if (flagValue("--retry-max-time") !== 0) {
    return Number.NaN;
  }
  return flagValue("--retry") * flagValue("--retry-delay");
}

describe("ISS-5303: getPlatformPath resolves Electron's executable layout", () => {
  test("returns the macOS app-bundle path for darwin and mas", () => {
    assert.equal(getPlatformPath("darwin"), MACOS_EXECUTABLE);
    assert.equal(getPlatformPath("mas"), MACOS_EXECUTABLE);
  });

  test("returns the bare executable for the unix-like platforms", () => {
    assert.equal(getPlatformPath("linux"), "electron");
    assert.equal(getPlatformPath("freebsd"), "electron");
    assert.equal(getPlatformPath("openbsd"), "electron");
  });

  test("returns the .exe for win32", () => {
    assert.equal(getPlatformPath("win32"), "electron.exe");
  });

  test("supports exactly the six platforms Electron publishes", () => {
    // Pinned as a set, not iterated-and-compared: adding a seventh entry is a
    // claim that Electron ships an artifact for it, and that claim should be
    // made deliberately rather than absorbed by a self-referential loop.
    assert.deepEqual(Object.keys(ELECTRON_PLATFORM_PATHS).sort(), [
      "darwin",
      "freebsd",
      "linux",
      "mas",
      "openbsd",
      "win32",
    ]);
  });

  test("throws for a platform with no Electron release", () => {
    // Must not fall back to a guess — a guessed path sends the repair at a
    // download URL that 404s, and the real cause ("no build for this OS")
    // surfaces as a network error instead.
    assert.throws(() => getPlatformPath("solaris"), NO_ELECTRON_BUILD_PATTERN);
  });
});

describe("ISS-5303: getArch picks the artifact architecture", () => {
  test("an explicit npm_config_arch wins over everything", () => {
    // Including over the Rosetta correction: a deliberate cross-install
    // (`npm i --arch=ia32`) must not be silently rewritten to arm64.
    const { host, probeCalls } = hostWithProbe("darwin", "x64", true);

    assert.equal(getArch("darwin", { npm_config_arch: "ia32" }, host), "ia32");
    assert.equal(probeCalls.length, 0);
  });

  test("an x64 runtime translated on Apple silicon gets the arm64 artifact", () => {
    const { host, probeCalls } = hostWithProbe("darwin", "x64", true);

    assert.equal(getArch("darwin", {}, host), "arm64");
    assert.equal(probeCalls.length, 1);
  });

  test("a genuine Intel Mac keeps x64", () => {
    const { host, probeCalls } = hostWithProbe("darwin", "x64", false);

    assert.equal(getArch("darwin", {}, host), "x64");
    assert.equal(probeCalls.length, 1);
  });

  test("an Apple-silicon runtime is already arm64 and is not probed", () => {
    const { host, probeCalls } = hostWithProbe("darwin", "arm64", true);

    assert.equal(getArch("darwin", {}, host), "arm64");
    assert.equal(probeCalls.length, 0);
  });

  test("a darwin target built from a non-darwin host is not probed", () => {
    // `sysctl.proc_translated` describes THIS process, so it says nothing about
    // a cross-build's target and must not be consulted.
    const { host, probeCalls } = hostWithProbe("linux", "x64", true);

    assert.equal(getArch("darwin", {}, host), "x64");
    assert.equal(probeCalls.length, 0);
  });

  test("a non-darwin target takes the runtime's own arch", () => {
    const { host, probeCalls } = hostWithProbe("linux", "arm64", true);

    assert.equal(getArch("linux", {}, host), "arm64");
    assert.equal(probeCalls.length, 0);
  });

  test("an empty npm_config_arch is treated as unset", () => {
    const { host } = hostWithProbe("linux", "arm64", false);

    assert.equal(getArch("linux", { npm_config_arch: "" }, host), "arm64");
  });

  test("the default host reports this runtime, wired to the real probe", () => {
    const host = defaultArchHost();

    assert.equal(host.platform, process.platform);
    assert.equal(host.arch, process.arch);
    assert.equal(host.isRosettaTranslated, detectRosettaTranslation);
  });
});

describe("ISS-5303: detectRosettaTranslation reads sysctl.proc_translated", () => {
  test("is true only for a clean exit reporting 1", () => {
    assert.equal(
      detectRosettaTranslation(spawnReturning(0, "1\n")),
      true,
      "sysctl prints a trailing newline; it has to be trimmed"
    );
  });

  test("is false when sysctl reports 0", () => {
    assert.equal(detectRosettaTranslation(spawnReturning(0, "0\n")), false);
  });

  test("is false when the key does not exist on this host", () => {
    // Non-macOS: `sysctl -in sysctl.proc_translated` exits non-zero. Fail
    // closed — an unreadable probe means "not translated", never "assume yes".
    assert.equal(detectRosettaTranslation(spawnReturning(1, "")), false);
  });

  test("is false when sysctl could not be spawned at all", () => {
    // spawnSync leaves `status` null when the binary is missing; the status
    // check has to short-circuit before the stdout read.
    assert.equal(detectRosettaTranslation(spawnReturning(null, "")), false);
  });

  test("passes the arguments through to the spawner", () => {
    const seen: unknown[][] = [];

    detectRosettaTranslation((command, args, options) => {
      seen.push([command, args, options]);
      return { status: 0, stdout: "1" };
    });

    assert.deepEqual(seen, [
      ["sysctl", ["-in", "sysctl.proc_translated"], { encoding: "utf8" }],
    ]);
  });
});

describe("ISS-6110: buildDownloadArgs carries a survivable retry budget", () => {
  const ZIP = "/tmp/electron-v43.0.0-linux-x64.zip";
  const URL =
    "https://github.com/electron/electron/releases/download/v43.0.0/electron-v43.0.0-linux-x64.zip";

  test("asks curl to retry the mid-transfer reset it otherwise gives up on", () => {
    // Plain --retry already covers the 503 burst: curl counts a timeout and
    // HTTP 408/429/500/502/503/504 as transient. --retry-all-errors is here for
    // the other 2026-08-12 signature, `curl: (56) Connection died`, which is
    // not in that set and ends the transfer on the first occurrence.
    assert.equal(
      buildDownloadArgs(ZIP, URL).includes("--retry-all-errors"),
      true
    );
  });

  test("the argv's own schedule spans the outage window it claims to", () => {
    // The trap this guards, and the reason it reads the schedule off the argv
    // rather than the constants: a budget of 5 retries at a fixed 5s under a
    // 180s --retry-max-time looks like three minutes and is twenty-five
    // seconds, so asserting the delay total and the ceiling separately passes
    // on exactly the budget that let a 30-second blip red the gate.
    const window = retryWindowFromArgs(buildDownloadArgs(ZIP, URL));

    assert.ok(
      window >= TARGET_OUTAGE_SECONDS,
      `retries span ${window}s, short of the ${TARGET_OUTAGE_SECONDS}s outage window`
    );
    assert.equal(window, retryWindowSeconds());
    assert.ok(DOWNLOAD_RETRY.connectTimeoutSeconds > 0);
  });

  test("the retry ceiling is disabled, so the delay schedule is the only bound", () => {
    // The earlier version of this test compared the ceiling against
    // `attempts × delay` and could not fail on the case it was named for
    // (closedloop-ai-stage, PR #4906). --retry-max-time is wall clock from
    // before the FIRST attempt and the transfers run inside it, so what has to
    // fit under it is the delays PLUS the transfer time — and a ~105 MB zip
    // that resets at 80 MB burns 20-30s per attempt before its delay starts.
    // A few of those exhaust a nominal 300s ceiling at ~140s of schedule, short
    // of the window the budget promises, while a delays-only comparison stays
    // green. Sizing it correctly would mean predicting transfer time, so the
    // ceiling is disabled instead and the attempt count is the only bound.
    assert.equal(
      DOWNLOAD_RETRY.retryMaxTimeSeconds,
      0,
      "--retry-max-time must stay disabled: any nonzero ceiling races the transfers and can cut the schedule short by an amount this budget cannot predict"
    );
    const args = buildDownloadArgs(ZIP, URL);
    assert.equal(
      args[args.indexOf("--retry-max-time") + 1],
      "0",
      "the disabled ceiling has to reach curl, not just live in the constant"
    );
  });

  test("keeps --fail and --location so only a real zip is ever written", () => {
    const args = buildDownloadArgs(ZIP, URL);

    // --fail: an error page must not land at zipPath and reach the checksum as
    // a mismatch instead of as the HTTP failure it was.
    assert.equal(args.includes("--fail"), true);
    // --location: the releases URL redirects to objects.githubusercontent.com.
    assert.equal(args.includes("--location"), true);
  });

  test("ends with --output <zip> <url> so no flag is read as the filename", () => {
    const args = buildDownloadArgs(ZIP, URL);

    assert.deepEqual(args.slice(-3), ["--output", ZIP, URL]);
  });

  test("a budget with a live ceiling reports no window rather than a wrong one", () => {
    // Re-enabling --retry-max-time makes the window unmodelable: the ceiling is
    // wall clock counting the transfers, so 9 × 7 = 63s of delays is an upper
    // bound curl may never reach, and reporting 63 (or a Math.min'd 40) would
    // state a tolerance the download does not have. Both the helper and the
    // production function answer NaN, which fails the window assertion loudly
    // instead of passing on a number nobody can stand behind.
    const ceilinged = {
      attempts: 9,
      delaySeconds: 7,
      retryMaxTimeSeconds: 40,
      connectTimeoutSeconds: 30,
    };

    assert.ok(
      Number.isNaN(retryWindowFromArgs(buildDownloadArgs(ZIP, URL, ceilinged)))
    );
    assert.ok(Number.isNaN(retryWindowSeconds(ceilinged)));
    // And the disabled-ceiling budget is the one that yields a real number.
    assert.equal(
      retryWindowSeconds({
        attempts: 9,
        delaySeconds: 7,
        retryMaxTimeSeconds: 0,
      }),
      63
    );
  });

  test("threads an injected budget through instead of the frozen default", () => {
    const args = buildDownloadArgs(ZIP, URL, {
      attempts: 9,
      delaySeconds: 7,
      retryMaxTimeSeconds: 600,
      connectTimeoutSeconds: 30,
    });

    assert.deepEqual(args.slice(0, 12), [
      "--fail",
      "--location",
      "--retry",
      "9",
      "--retry-all-errors",
      "--retry-delay",
      "7",
      "--retry-max-time",
      "600",
      "--connect-timeout",
      "30",
      "--output",
    ]);
  });
});

describe("ISS-5303: ensure-electron-binary.mjs is wired to the lib", () => {
  test("imports the helpers and redeclares none of them", () => {
    const entrypoint = parseDesktopScript("ensure-electron-binary.mjs");

    assert.deepEqual(
      namedImportsFrom(entrypoint, "./ensure-electron-binary-lib.mjs"),
      ["buildDownloadArgs", "getArch", "getPlatformPath"]
    );

    const declared = declaredFunctionNames(entrypoint);
    assert.equal(declared.includes("getArch"), false);
    assert.equal(declared.includes("getPlatformPath"), false);
    assert.equal(declared.includes("buildDownloadArgs"), false);
  });

  test("calls all three on the repair path", () => {
    // buildDownloadArgs included: the budget above only protects CI if the
    // entrypoint stops hand-rolling its own curl argv.
    const called = calledIdentifiers(
      parseDesktopScript("ensure-electron-binary.mjs")
    );

    assert.equal(called.includes("getArch"), true);
    assert.equal(called.includes("getPlatformPath"), true);
    assert.equal(called.includes("buildDownloadArgs"), true);
  });
});
