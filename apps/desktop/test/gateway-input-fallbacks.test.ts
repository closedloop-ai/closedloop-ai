import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import {
  OperationDispatcher,
  type OperationRequestContext,
} from "../src/server/operation-dispatcher.js";
import { asNumber, asString } from "../src/server/operations/git-pr-exec.js";
import { describeUnverifiedEnabledState } from "../src/server/operations/health-check-plugin-read-copy.js";
import { PLUGIN_STATE_UNVERIFIED_ERROR } from "../src/server/operations/health-check-types.js";
import { parseBody } from "../src/server/operations/parse-body.js";
import type { PluginInstallStatus } from "../src/server/operations/plugin-cache.js";
import { registerSystemCheckRoutes } from "../src/server/operations/system-check-routes.js";
import { ProcessManager } from "../src/server/process-manager.js";
import { readJsonFileSync } from "../src/server/read-json-file-sync.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("readJsonFileSync distinguishes valid JSON from absent or unreadable input", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "gateway-json-fallbacks-"));
  tempDirs.push(directory);
  const validPath = path.join(directory, "valid.json");
  const invalidPath = path.join(directory, "invalid.json");
  writeFileSync(validPath, JSON.stringify({ branchId: "branch-1" }));
  writeFileSync(invalidPath, "{not-json");

  assert.deepEqual(readJsonFileSync(validPath), { branchId: "branch-1" });
  assert.equal(readJsonFileSync(path.join(directory, "missing.json")), null);
  assert.equal(readJsonFileSync(invalidPath), null);
  assert.equal(readJsonFileSync(directory), null);
});

test("GitHub operation fields accept only non-blank strings and finite numbers", () => {
  assert.equal(asString("  branch-name  "), "  branch-name  ");
  assert.equal(asString("   "), null);
  assert.equal(asString(42), null);

  assert.equal(asNumber(42), 42);
  assert.equal(asNumber("42"), 42);
  assert.equal(asNumber("   "), null);
  assert.equal(asNumber("not-a-number"), null);
  assert.equal(asNumber(Number.POSITIVE_INFINITY), null);
});

test("gateway request bodies distinguish empty, valid, and malformed JSON", () => {
  const withBody = (body: string): OperationRequestContext =>
    ({ body }) as OperationRequestContext;

  assert.deepEqual(parseBody(withBody("  \n")), {});
  assert.deepEqual(parseBody(withBody('{"branchId":"branch-1"}')), {
    branchId: "branch-1",
  });
  assert.equal(parseBody(withBody("{not-json")), null);
});

test("System Check exposes binary paths only when both host adapters are wired", async () => {
  const processManager = new ProcessManager({
    getAllowedDirectories: () => [],
  });
  const partial = new OperationDispatcher();
  registerSystemCheckRoutes(partial, {
    processManager,
    getSymphonyDir: () => tmpdir(),
    getBinaryPaths: () => ({ git: "/usr/bin/git" }),
    getAppVersion: () => undefined,
  });

  assert.equal(await dispatchBinaryPaths(partial), false);

  const complete = new OperationDispatcher();
  registerSystemCheckRoutes(complete, {
    processManager,
    getSymphonyDir: () => tmpdir(),
    getBinaryPaths: () => ({ git: "/usr/bin/git" }),
    applyBinaryPathPatch: () => ({ git: "/usr/bin/git" }),
    getAppVersion: () => undefined,
  });

  assert.equal(await dispatchBinaryPaths(complete), true);
});

test("an unclassified plugin-state failure uses the actionable missing-state copy", () => {
  const status: PluginInstallStatus = {
    pluginRef: "code@closedloop-ai",
    hasValidUserScopedEntry: true,
    hasUserScopedEntry: true,
    hasExistingUserInstallPath: true,
    hasAnyInstallPath: true,
    disabled: false,
    enabledStateUnverified: true,
    hasProjectScopedEntry: false,
    projectScopedPaths: [],
  };

  assert.deepEqual(describeUnverifiedEnabledState(status), {
    error: PLUGIN_STATE_UNVERIFIED_ERROR,
    remediation:
      "Run: claude plugin list, confirm code@closedloop-ai is listed as enabled at user scope, then rerun System Check",
  });
});

function dispatchBinaryPaths(
  dispatcher: OperationDispatcher
): Promise<boolean> {
  return dispatcher.dispatch({
    method: "GET",
    pathname: "/api/gateway/settings/binary-paths",
    params: {},
    query: new URLSearchParams(),
    rawBody: Buffer.alloc(0),
    body: "",
    request: {},
    response: {
      statusCode: 200,
      setHeader: () => undefined,
      end: () => undefined,
    },
  } as unknown as OperationRequestContext);
}
