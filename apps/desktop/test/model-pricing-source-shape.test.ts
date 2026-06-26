import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const APP_DIR = path.join(import.meta.dirname, "..");
const COMPUTE_TOKEN_COST_PATTERN = /\bcomputeTokenCost\b/;
const LOCAL_SESSION_COST_SURFACE_PATTERN =
  /\b(cost_usd_estimated|estimatedCostUsd|tokenUsageByModel|activityBuckets)\b/;
const ALLOWED_RELATIVE_PATHS = new Set([
  "src/main/model-pricing/model-pricing.ts",
  "src/shared/token-cost.ts",
]);
const COST_SURFACE_ROOTS = ["src/main", "src/shared"] as const;
const TYPESCRIPT_FILE_PATTERN = /\.ts$/;

test("Desktop local session cost derivation does not import computeTokenCost directly", () => {
  const violations = COST_SURFACE_ROOTS.flatMap((root) =>
    listTypescriptFiles(path.join(APP_DIR, root))
  )
    .map((filePath) => path.relative(APP_DIR, filePath))
    .filter((relativePath) => !ALLOWED_RELATIVE_PATHS.has(relativePath))
    .filter((relativePath) => {
      const source = readFileSync(path.join(APP_DIR, relativePath), "utf8");
      return (
        LOCAL_SESSION_COST_SURFACE_PATTERN.test(source) &&
        COMPUTE_TOKEN_COST_PATTERN.test(source)
      );
    });

  assert.deepEqual(violations, []);
});

function listTypescriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listTypescriptFiles(entryPath);
    }
    return TYPESCRIPT_FILE_PATTERN.test(entry.name) ? [entryPath] : [];
  });
}
