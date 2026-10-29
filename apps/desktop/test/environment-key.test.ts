/**
 * ISS-7096 M0 / ISS-7240: the stable environment-key derivation. These cases
 * moved here with `normalizeEnvironmentKey` itself when it was extracted out of
 * `compute-target-environment-store.ts` — the function is pure, so its coverage
 * no longer needs the libSQL fixture the store's own suite opens.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeEnvironmentKey } from "../src/shared/environment-key.js";

const STAGE = "https://api.stage.example";

test("normalizeEnvironmentKey lowercases to the bare origin and is idempotent", () => {
  assert.equal(normalizeEnvironmentKey("HTTPS://API.Stage.Example/"), STAGE);
  assert.equal(normalizeEnvironmentKey(`${STAGE}/some/path?q=1`), STAGE);
  assert.equal(normalizeEnvironmentKey(STAGE), STAGE);
  assert.equal(normalizeEnvironmentKey(normalizeEnvironmentKey(STAGE)), STAGE);
  assert.equal(
    normalizeEnvironmentKey("http://localhost:3002"),
    "http://localhost:3002"
  );
});

test("normalizeEnvironmentKey answers null for unusable input, never a garbage key", () => {
  assert.equal(normalizeEnvironmentKey(null), null);
  assert.equal(normalizeEnvironmentKey(undefined), null);
  assert.equal(normalizeEnvironmentKey(""), null);
  assert.equal(normalizeEnvironmentKey("not a url"), null);
});
