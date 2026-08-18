/**
 * ISS-5868 — `allRequiredPassed`, driven through the production
 * `GET /api/gateway/health-check` route.
 *
 * ISS-5811 was an outage: the cloud gate read `required && !passed` alone, so
 * the five Closedloop plugin rows the gateway could NOT DETERMINE
 * (`severity: "unknown"`) blocked every web→desktop command. PR #4772 fixed the
 * cloud predicate and left this flag — minted by the gateway itself, read back
 * by the settings card and persisted with the snapshot — the same blindness.
 *
 * These go through the route rather than calling the shared predicate directly:
 * the regression being guarded is the number the OPERATOR's machine reports,
 * and a unit assertion on the helper would stay green if `runHealthCheck`
 * stopped calling it.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { CheckSeverity } from "@closedloop-ai/loops-api/compute-target";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import {
  _setRunCommandForTesting,
  registerHealthCheckRoutes,
} from "../src/server/operations/health-check.js";
import type { ProcessManager } from "../src/server/process-manager.js";
import {
  buildPluginListJson,
  type CheckResultPayload,
  dispatchHealthCheck,
  getChecks,
  makeTempHome,
  parsePayload,
  removeTempHomes,
  unavailableMcp,
  writeAllUserScopedPlugins,
} from "./fixtures/health-check-route.js";

const originalHome = process.env.HOME;
const symphonyDirs: string[] = [];

afterEach(async () => {
  _setRunCommandForTesting();
  if (originalHome === undefined) {
    Reflect.deleteProperty(process.env, "HOME");
  } else {
    process.env.HOME = originalHome;
  }
  for (const dir of symphonyDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  await removeTempHomes();
});

/**
 * A gateway config whose worktree parent IS set and confirmed, so the only
 * failing REQUIRED rows in these fixtures are the ones each test creates on
 * purpose. Without it `worktree-dir` fails as a proven fault and every
 * `allRequiredPassed` assertion below would be answering a different question.
 */
async function makeConfiguredSymphonyDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hc-arp-"));
  symphonyDirs.push(dir);
  // The route derives its config dir as `<symphonyDir>/config`.
  const configDir = path.join(dir, "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "repos.json"),
    JSON.stringify({
      repos: [],
      settings: {
        worktreeParentDir: dir,
        worktreeParentDirConfirmed: true,
      },
    })
  );
  return dir;
}

/** Flips the fixture listing from enabled to disabled. */
const PLUGIN_ENABLED_TRUE_REGEX = /"enabled":true/g;

function commandError(message: string): Error {
  return Object.assign(new Error(message), { code: 1, stderr: message });
}

const STUBBED_BINARIES = ["claude", "codex", "gh", "git", "python3"] as const;

/** Real executables, one per binary, so each resolves and stays distinguishable. */
async function makeBinDir(): Promise<Record<string, string>> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hc-arp-bin-"));
  symphonyDirs.push(dir);
  const paths: Record<string, string> = {};
  for (const name of STUBBED_BINARIES) {
    const binPath = path.join(dir, name);
    await fs.writeFile(binPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    paths[name] = binPath;
  }
  return paths;
}

/**
 * Registers the route with every binary resolving and `claude plugin list`
 * answering (or refusing) as the test dictates. `null` models a listing that
 * could not RUN at all — the machine state ISS-5811 was reported on.
 */
async function registerRoute(
  dispatcher: OperationDispatcher,
  symphonyDir: string,
  pluginListJson: string | null
): Promise<void> {
  const binaries = await makeBinDir();
  _setRunCommandForTesting((cmd, args) => {
    const invocation = args.join(" ");
    // python3 is the one row with a version FLOOR, so a bare "1.0.0" would fail
    // it as a proven fault and mask what these tests assert.
    if (path.basename(cmd) === "python3") {
      return Promise.resolve({ stdout: "Python 3.11.0" });
    }
    if (invocation === "plugin list --json" || invocation === "plugin list") {
      if (pluginListJson === null) {
        return Promise.reject(commandError("plugin list failed"));
      }
      if (invocation === "plugin list") {
        return Promise.reject(commandError("unknown option '--json'"));
      }
      return Promise.resolve({ stdout: pluginListJson });
    }
    return Promise.resolve({ stdout: "1.0.0" });
  });
  registerHealthCheckRoutes(
    dispatcher,
    {} as unknown as ProcessManager,
    () => symphonyDir,
    unavailableMcp,
    () => binaries
  );
}

function requiredNotPassed(checks: CheckResultPayload[]): CheckResultPayload[] {
  return checks.filter((check) => check.required && !check.passed);
}

describe("allRequiredPassed severity awareness (ISS-5868)", () => {
  test("an undeterminable required row no longer sinks the whole flag", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const dispatcher = new OperationDispatcher();
    await registerRoute(dispatcher, await makeConfiguredSymphonyDir(), null);

    const payload = parsePayload(await dispatchHealthCheck(dispatcher));
    const blocked = requiredNotPassed(getChecks(payload));

    // Guard against a vacuous pass: the fixture must actually produce failing
    // REQUIRED rows, and every one of them must be undeterminable.
    assert.ok(
      blocked.length > 0,
      "fixture must produce at least one failing REQUIRED row"
    );
    for (const check of blocked) {
      assert.equal(
        check.severity,
        CheckSeverity.Unknown,
        `${check.id} should be undeterminable, not a proven failure`
      );
    }
    assert.equal(
      payload.allRequiredPassed,
      true,
      "rows the gateway could not determine must not report as required failures"
    );
  });

  test("a PROVEN required failure still sinks the flag", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const dispatcher = new OperationDispatcher();
    // Every plugin listed at user scope but switched OFF: determinable, and a
    // real fault with an action the user can take. No severity is set, so the
    // legacy `!passed → error` derivation applies and the row keeps blocking.
    await registerRoute(
      dispatcher,
      await makeConfiguredSymphonyDir(),
      buildPluginListJson().replace(
        PLUGIN_ENABLED_TRUE_REGEX,
        '"enabled":false'
      )
    );

    const payload = parsePayload(await dispatchHealthCheck(dispatcher));
    const blocked = requiredNotPassed(getChecks(payload));

    assert.ok(
      blocked.some(
        (check) =>
          check.severity === undefined || check.severity === CheckSeverity.Error
      ),
      "fixture must produce a proven required failure"
    );
    assert.equal(payload.allRequiredPassed, false);
  });
});
