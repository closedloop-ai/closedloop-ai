/**
 * ISS-11105 — the preflight Node guard when no pinned version can be named:
 * `.nvmrc` absent or blank, and a process started with no entry script.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkPreflightNode,
  formatUnsupportedNodeMessage,
  isCliInvocation,
} from "../scripts/assert-supported-node.mjs";

const GENERIC_PIN_LINE =
  "This repo pins its Node version in .nvmrc, which every CI workflow consumes";
const PLACEHOLDER_REMEDY = "mise use node@<.nvmrc version>";
const NAMED_PIN_LINE = /This repo pins Node \S+ in \.nvmrc/;

const scratchRoots: string[] = [];
const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  while (scratchRoots.length > 0) {
    rmSync(scratchRoots.pop() as string, { recursive: true, force: true });
  }
});

describe("formatUnsupportedNodeMessage without a pinned version", () => {
  it("falls back to the generic pin sentence and a placeholder remedy", () => {
    const message = formatUnsupportedNodeMessage({
      nodeVersion: "25.0.0",
      range: "^24",
      pinnedVersion: null,
    });

    expect(message).toContain(GENERIC_PIN_LINE);
    expect(message).toContain(PLACEHOLDER_REMEDY);
    expect(message).not.toMatch(NAMED_PIN_LINE);
  });
});

describe("checkPreflightNode when .nvmrc names no version", () => {
  it.each([
    ["is absent", null],
    ["holds only whitespace", "  \n"],
  ])("refuses with the generic message when .nvmrc %s", (_label, nvmrc) => {
    const { root, scripts } = scratchTree(nvmrc);

    const result = checkPreflightNode({
      nodeVersion: "25.0.0",
      scriptDirectory: scripts,
      repoRoot: root,
    });

    expect(result.verdict).toBe("unsupported");
    expect(result.message).toContain(GENERIC_PIN_LINE);
    expect(result.message).toContain(PLACEHOLDER_REMEDY);
  });
});

describe("isCliInvocation with no entry script", () => {
  it("is false when process.argv has no script path", () => {
    process.argv = [originalArgv[0] as string];

    expect(
      isCliInvocation(
        new URL("../scripts/assert-supported-node.mjs", import.meta.url).href
      )
    ).toBe(false);
  });
});

/**
 * `<root>/apps/desktop/{scripts,node_modules/dependency-cruiser}` with a
 * manifest accepting only `^24`, plus `<root>/.nvmrc` when `nvmrc` is a string.
 */
function scratchTree(nvmrc: string | null) {
  const root = mkdtempSync(path.join(tmpdir(), "iss11105-node-"));
  scratchRoots.push(root);
  const scripts = path.join(root, "apps", "desktop", "scripts");
  mkdirSync(scripts, { recursive: true });
  const depcruiseDir = path.join(
    root,
    "apps",
    "desktop",
    "node_modules",
    "dependency-cruiser"
  );
  mkdirSync(depcruiseDir, { recursive: true });
  writeFileSync(
    path.join(depcruiseDir, "package.json"),
    '{"engines":{"node":"^24"}}'
  );
  if (nvmrc !== null) {
    writeFileSync(path.join(root, ".nvmrc"), nvmrc);
  }
  return { root, scripts };
}
