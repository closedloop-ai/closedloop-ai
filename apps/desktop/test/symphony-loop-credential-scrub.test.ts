import assert from "node:assert/strict";
import { test } from "node:test";
import { scrubObjectCredentials } from "../src/server/operations/symphony-loop.js";

function alphaNum(n: number): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < n; i++) {
    s += chars[i % chars.length];
  }
  return s;
}

test("scrubObjectCredentials redacts tokens recursively in objects and arrays", () => {
  const token = `ghr_${alphaNum(36)}`;
  const scrubbed = scrubObjectCredentials({
    ok: true,
    results: [{ repo: "a", errors: [`push failed: ${token}`] }],
  }) as {
    ok: boolean;
    results: Array<{ repo: string; errors: string[] }>;
  };

  assert.equal(scrubbed.ok, true);
  assert.ok(!scrubbed.results[0].errors[0].includes(token));
  assert.ok(scrubbed.results[0].errors[0].includes("[REDACTED_GH_TOKEN]"));
});
