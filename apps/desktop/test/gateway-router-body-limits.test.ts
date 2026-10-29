import assert from "node:assert/strict";
import { test } from "vitest";
import {
  bigintToSafeNumber,
  parseStrictContentLength,
  REQUEST_BODY_TOO_LARGE_CODE,
  RequestBodyTooLargeError,
} from "../src/server/router-body-limits.js";

test("parseStrictContentLength: valid decimal string returns bigint", () => {
  assert.equal(parseStrictContentLength("12345"), 12345n);
});

test("parseStrictContentLength: zero returns 0n", () => {
  assert.equal(parseStrictContentLength("0"), 0n);
});

test("parseStrictContentLength: null returns null", () => {
  assert.equal(parseStrictContentLength(null), null);
});

test("parseStrictContentLength: empty string returns null", () => {
  assert.equal(parseStrictContentLength(""), null);
});

test("parseStrictContentLength: non-digit characters return null", () => {
  assert.equal(parseStrictContentLength("12abc"), null);
});

test("parseStrictContentLength: negative number returns null", () => {
  assert.equal(parseStrictContentLength("-1"), null);
});

test("parseStrictContentLength: decimal number returns null", () => {
  assert.equal(parseStrictContentLength("1.5"), null);
});

test("parseStrictContentLength: whitespace returns null", () => {
  assert.equal(parseStrictContentLength("  "), null);
});

test("bigintToSafeNumber: value within safe range returns number", () => {
  assert.equal(bigintToSafeNumber(42n), 42);
});

test("bigintToSafeNumber: zero returns 0", () => {
  assert.equal(bigintToSafeNumber(0n), 0);
});

test("bigintToSafeNumber: MAX_SAFE_INTEGER returns the number", () => {
  assert.equal(
    bigintToSafeNumber(BigInt(Number.MAX_SAFE_INTEGER)),
    Number.MAX_SAFE_INTEGER
  );
});

test("bigintToSafeNumber: above MAX_SAFE_INTEGER returns undefined", () => {
  assert.equal(
    bigintToSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
    undefined
  );
});

test("RequestBodyTooLargeError: stores all properties", () => {
  const error = new RequestBodyTooLargeError({
    limitBytes: 1024,
    routeName: "test-route",
    declaredSizeBytes: 2048,
    observedSizeBytes: 2050,
  });
  assert.equal(error.message, "request body too large");
  assert.equal(error.name, "RequestBodyTooLargeError");
  assert.equal(error.code, REQUEST_BODY_TOO_LARGE_CODE);
  assert.equal(error.limitBytes, 1024);
  assert.equal(error.routeName, "test-route");
  assert.equal(error.declaredSizeBytes, 2048);
  assert.equal(error.observedSizeBytes, 2050);
});

test("RequestBodyTooLargeError: optional size fields default to undefined", () => {
  const error = new RequestBodyTooLargeError({
    limitBytes: 1024,
    routeName: "test-route",
  });
  assert.equal(error.declaredSizeBytes, undefined);
  assert.equal(error.observedSizeBytes, undefined);
});
