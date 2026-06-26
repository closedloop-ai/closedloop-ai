import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const forbiddenNeedles = [
  ["CL", "POSTHOG"].join("_"),
  ["posthog", "node"].join("-"),
  ["posthog", "config"].join("-"),
  ["PostHog", "Analytics"].join(""),
  ["phc", "_"].join(""),
];

const scannedPaths = [
  ".github",
  "apps/desktop/electron-builder.yml",
  "apps/desktop/package.json",
  "apps/desktop/src",
];

const optionalBuildOutputs = [
  "apps/desktop/dist",
  "apps/desktop/dist-dmg/mac-universal/Closedloop.app/Contents/Resources/app.asar",
];

test("Electron package, source, and release surfaces contain no direct PostHog token/client contract", () => {
  const matches: string[] = [];
  for (const relativePath of scannedPaths) {
    collectMatches(path.join(repoRoot, relativePath), relativePath, matches);
  }
  for (const relativePath of optionalBuildOutputs) {
    const absolutePath = path.join(repoRoot, relativePath);
    if (existsSync(absolutePath)) {
      collectMatches(absolutePath, relativePath, matches);
    }
  }
  assert.deepEqual(matches, []);
});

function collectMatches(
  absolutePath: string,
  relativePath: string,
  matches: string[]
): void {
  const stat = statSync(absolutePath);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(absolutePath)) {
      if (
        entry === "dist" ||
        entry === "dist-dmg" ||
        entry === "node_modules"
      ) {
        continue;
      }
      collectMatches(
        path.join(absolutePath, entry),
        path.join(relativePath, entry),
        matches
      );
    }
    return;
  }

  if (isBinaryPath(relativePath)) {
    return;
  }

  const contents = readFileSync(absolutePath, "utf8");
  for (const needle of forbiddenNeedles) {
    if (contents.includes(needle)) {
      matches.push(`${relativePath}: ${needle}`);
    }
  }
}

function isBinaryPath(relativePath: string): boolean {
  return /\.(icns|png|zip|dmg)$/i.test(relativePath);
}
