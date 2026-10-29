/**
 * ISS-5299 — Branch coverage for OperationDispatcher.dispatch() and
 * createClaudeCodeShellEnvProvider().
 *
 * OperationDispatcher (operation-dispatcher.ts):
 *   `throw error` in dispatch() — the rethrow when the handler throws something
 *             other than SymphonyDirNotConfiguredError. The contrast arm (503)
 *             is also exercised here to make the rethrow meaningful.
 *
 *   `match[index + 1] ?? ""` in decodeRouteParams() — DEAD CODE.
 *             compilePathPattern emits only mandatory capture groups (([^/]+),
 *             (.+)) and the matcher is anchored, so on a successful match every
 *             group has a defined value. Reaching it would require mutating the
 *             private handlers array, which AGENTS.md forbids. Not tested.
 *
 * createClaudeCodeShellEnvProvider (otel/claude-code-env.ts):
 *   line 155 — `} catch {` in readReceiverStatus() — the exception path when
 *             getReceiverStatus() itself throws. The function must fail closed and
 *             return the unmodified base env without any OTel vars injected.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
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

// ─── ISS-7585 — malformed percent-encoding in a route param ────────────────
// decodeRouteParams() percent-decodes every captured segment before the handler
// runs. `decodeURIComponent` throws URIError on a truncated escape, and that
// decode used to sit outside dispatch's try, so the rejection escaped handle()
// in router.ts (which has no try/catch) as an unhandled rejection and took the
// process down. The guard must answer 400 without ever reaching the handler,
// and must NOT swallow a URIError the handler itself raises.

const MALFORMED_ESCAPE = "%E0%A4%A";

test("dispatch answers 400 for a malformed percent-escape in a :param (ISS-7585)", async () => {
  const dispatcher = new OperationDispatcher();
  let handlerCalls = 0;
  dispatcher.register("GET", "/items/:id", () => {
    handlerCalls += 1;
  });

  const result = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: `/items/${MALFORMED_ESCAPE}`,
  });

  assert.equal(result.statusCode, 400);
  assert.equal(
    handlerCalls,
    0,
    "the handler must never see an undecodable param"
  );
  assert.ok(
    typeof result.body.error === "string" && result.body.error.length > 0,
    "400 body must carry an error message"
  );
});

test("dispatch answers 400 for a malformed percent-escape in a *wildcard (ISS-7585)", async () => {
  const dispatcher = new OperationDispatcher();
  let handlerCalls = 0;
  dispatcher.register("GET", "/files/*filepath", () => {
    handlerCalls += 1;
  });

  const result = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: `/files/nested/dir/${MALFORMED_ESCAPE}`,
  });

  assert.equal(result.statusCode, 400);
  assert.equal(handlerCalls, 0, "the wildcard handler must not run either");
});

test("dispatch still decodes a well-formed percent-escape (ISS-7585 contrast)", async () => {
  const dispatcher = new OperationDispatcher();
  let observedId: string | null = null;
  dispatcher.register("GET", "/items/:id", (context) => {
    observedId = context.params.id;
    context.response.statusCode = 200;
    context.response.setHeader("content-type", "application/json");
    context.response.end(JSON.stringify({ ok: true }));
  });

  // "a b/中" — a space and a multi-byte character, both legal encodings the
  // guard must leave alone. Without this arm a guard that rejected EVERY
  // encoded param would pass the two 400 tests above.
  const result = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/items/a%20b%2F%E4%B8%AD",
  });

  assert.equal(result.statusCode, 200);
  assert.equal(observedId, "a b/中");
});

test("dispatch rethrows a URIError raised by the handler itself (ISS-7585)", async () => {
  const dispatcher = new OperationDispatcher();
  const handlerError = new URIError("URI malformed");
  dispatcher.register("GET", "/items/:id", () => {
    throw handlerError;
  });

  // The param decodes fine here, so the only URIError comes from the handler.
  // A guard implemented by moving the decode INSIDE the handler try would
  // convert this into a 400 and hide a server-side bug behind a client error.
  await assert.rejects(
    dispatchOperation({ dispatcher, method: "GET", pathname: "/items/ok" }),
    (err: unknown) => {
      assert.ok(
        err === handlerError,
        "must rethrow the handler's own URIError"
      );
      return true;
    }
  );
});
