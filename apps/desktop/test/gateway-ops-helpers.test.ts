/**
 * ISS-5299 — Branch coverage for helper gateway operations.
 *
 * Targets (all under apps/desktop/src/server/operations/):
 *   parse-body.ts             (1 branch  — non-empty body path)
 *   response-utils.ts         (2 branches — code / details ternaries in jsonError)
 *
 * Lives beside gateway-server.test.ts but is a separate file because that suite is on
 * the shrink-only noExcessiveLinesPerFile list in biome.jsonc and must never grow.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { parseBody } from "../src/server/operations/parse-body.js";
import { json, jsonError } from "../src/server/operations/response-utils.js";
import { dispatchOperation } from "./helpers/git-gateway-op-harness.js";

// ---------------------------------------------------------------------------
// parse-body.ts
// ---------------------------------------------------------------------------

test("parseBody: non-empty valid JSON → parsed object", async () => {
  const dispatcher = new OperationDispatcher();
  let result: Record<string, unknown> | null | undefined;
  dispatcher.register("POST", "/pb-valid", (ctx) => {
    result = parseBody(ctx);
    json(ctx, 200, {});
  });
  await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/pb-valid",
    body: '{"hello":"world","count":3}',
  });
  assert.deepEqual(result, { hello: "world", count: 3 });
});

test("parseBody: invalid JSON → null", async () => {
  const dispatcher = new OperationDispatcher();
  let result: Record<string, unknown> | null | undefined;
  dispatcher.register("POST", "/pb-invalid", (ctx) => {
    result = parseBody(ctx);
    json(ctx, 200, {});
  });
  await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/pb-invalid",
    body: "{not valid json",
  });
  assert.equal(result, null);
});

test("parseBody: empty body → {}", async () => {
  const dispatcher = new OperationDispatcher();
  let result: Record<string, unknown> | null | undefined;
  dispatcher.register("POST", "/pb-empty", (ctx) => {
    result = parseBody(ctx);
    json(ctx, 200, {});
  });
  await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/pb-empty",
    body: "   ",
  });
  assert.deepEqual(result, {});
});

// ---------------------------------------------------------------------------
// response-utils.ts
// ---------------------------------------------------------------------------

test("json: sets status code and serialises payload", async () => {
  const dispatcher = new OperationDispatcher();
  dispatcher.register("GET", "/ru-json", (ctx) => {
    json(ctx, 201, { created: true });
  });
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/ru-json",
  });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(JSON.parse(res.rawBody), { created: true });
});

test("jsonError: no code, no details → only error key present", async () => {
  const dispatcher = new OperationDispatcher();
  dispatcher.register("GET", "/ru-err-min", (ctx) => {
    jsonError(ctx, 400, { error: "bad input" });
  });
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/ru-err-min",
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.rawBody), { error: "bad input" });
});

test("jsonError: with code and details — undefined detail values omitted", async () => {
  const dispatcher = new OperationDispatcher();
  dispatcher.register("GET", "/ru-err-full", (ctx) => {
    jsonError(ctx, 422, {
      error: "validation failed",
      code: "INVALID_FIELD",
      details: { field: "name", extra: undefined },
    });
  });
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/ru-err-full",
  });
  assert.equal(res.statusCode, 422);
  assert.deepEqual(JSON.parse(res.rawBody), {
    error: "validation failed",
    code: "INVALID_FIELD",
    details: { field: "name" },
  });
});
