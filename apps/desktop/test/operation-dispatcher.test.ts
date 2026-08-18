/**
 * ISS-5299 — Branch coverage for OperationDispatcher.dispatch() and
 * createClaudeCodeShellEnvProvider().
 *
 * OperationDispatcher (operation-dispatcher.ts):
 *   line 73 — `throw error` — the rethrow when the handler throws something
 *             other than SymphonyDirNotConfiguredError. The contrast arm (503)
 *             is also exercised here to make the rethrow meaningful.
 *
 *   line 53 — `match[index + 1] ?? ""` — DEAD CODE. compilePathPattern emits
 *             only mandatory capture groups (([^/]+), (.+)) and the matcher is
 *             anchored, so on a successful match every group has a defined value.
 *             Reaching it would require mutating the private handlers array, which
 *             AGENTS.md forbids. Not tested.
 *
 * createClaudeCodeShellEnvProvider (otel/claude-code-env.ts):
 *   line 155 — `} catch {` in readReceiverStatus() — the exception path when
 *             getReceiverStatus() itself throws. The function must fail closed and
 *             return the unmodified base env without any OTel vars injected.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { SymphonyDirNotConfiguredError } from "../src/server/operations/symphony-utils.js";
import {
  ClaudeCodeOtelEnvVar,
  createClaudeCodeShellEnvProvider,
} from "../src/server/otel/claude-code-env.js";
import { dispatchOperation } from "./helpers/git-gateway-op-harness.js";

// ─── OperationDispatcher.dispatch() — line 73: rethrow arm ──────────────────

test("dispatch rethrows non-SymphonyDirNotConfiguredError from handler (line 73)", async () => {
  const dispatcher = new OperationDispatcher();
  const sentinelError = new Error("unexpected handler failure");
  dispatcher.register("GET", "/rethrow-test", () => {
    throw sentinelError;
  });

  await assert.rejects(
    dispatchOperation({ dispatcher, method: "GET", pathname: "/rethrow-test" }),
    (err: unknown) => {
      assert.ok(err === sentinelError, "must rethrow the exact same error");
      return true;
    }
  );
});

test("dispatch returns 503 when handler throws SymphonyDirNotConfiguredError (contrast)", async () => {
  const dispatcher = new OperationDispatcher();
  dispatcher.register("GET", "/symphony-unconfigured", () => {
    throw new SymphonyDirNotConfiguredError();
  });

  const result = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/symphony-unconfigured",
  });

  assert.equal(result.statusCode, 503);
  assert.ok(
    typeof result.body.error === "string" && result.body.error.length > 0,
    "503 body must contain an error message"
  );
});

// ─── createClaudeCodeShellEnvProvider — otel/claude-code-env.ts line 155 ────
// readReceiverStatus() wraps getReceiverStatus() in a try/catch. The catch block
// (line 155) returns Unavailable with reason "receiver_status_thrown", causing
// the provider to fail closed and return the unmodified base env.

test("provider fails closed and returns base env when getReceiverStatus throws (line 155)", async () => {
  const TARGET_ENV_KEYS = Object.values(ClaudeCodeOtelEnvVar);

  const provider = createClaudeCodeShellEnvProvider({
    getReceiverStatus: () => {
      throw new Error("receiver crashed");
    },
    getBaseShellEnv: (extra?: Record<string, string>) =>
      Promise.resolve({ BASE_KEY: "base_value", ...extra }),
  });

  const env = await provider({ EXTRA_KEY: "extra_value" });

  // No OTel vars must be injected — the provider must fail closed
  for (const key of TARGET_ENV_KEYS) {
    assert.equal(
      Object.hasOwn(env, key),
      false,
      `OTel key ${key} must not be present when receiver status throws`
    );
  }
  // The base env and the extra values must pass through unchanged
  assert.equal(env.BASE_KEY, "base_value");
  assert.equal(env.EXTRA_KEY, "extra_value");
});
