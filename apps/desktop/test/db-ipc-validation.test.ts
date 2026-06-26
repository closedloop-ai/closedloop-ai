import assert from "node:assert/strict";
import { test } from "node:test";

import {
  coerceDbId,
  MAX_DB_ID_LENGTH,
} from "../src/main/database/ipc-validation.js";

test("coerceDbId accepts a normal id string unchanged", () => {
  assert.equal(coerceDbId("session-123"), "session-123");
  assert.equal(coerceDbId("a"), "a");
});

test("coerceDbId rejects an empty string", () => {
  assert.equal(coerceDbId(""), null);
});

test("coerceDbId rejects an oversized string", () => {
  assert.equal(
    coerceDbId("x".repeat(MAX_DB_ID_LENGTH)),
    "x".repeat(MAX_DB_ID_LENGTH)
  );
  assert.equal(coerceDbId("x".repeat(MAX_DB_ID_LENGTH + 1)), null);
});

test("coerceDbId rejects non-string values that would corrupt database bindings", () => {
  // The exact "[object Object]" primary-key hazard the review flagged.
  assert.equal(coerceDbId({ malicious: true }), null);
  assert.equal(coerceDbId(["a", "b"]), null);
  assert.equal(coerceDbId(42), null);
  assert.equal(coerceDbId(true), null);
  assert.equal(coerceDbId(null), null);
  assert.equal(coerceDbId(undefined), null);
});
