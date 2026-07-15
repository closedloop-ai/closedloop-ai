/**
 * @file historical-parse-source.test.ts
 * @description Direct coverage for the worker-side source-admission security
 * gate (FEA-2235 coverage gap). `historical-parse-source.parseHistoricalSource`
 * re-applies `isImportableCollectorSource` inside the off-main-process worker and
 * is the only path that constructs the real per-harness collectors, so the gate
 * and the 5-way dispatch are exercised here rather than only through synthetic
 * collectors. The gate primitive (`isImportableSourcePath`) is tested directly
 * with arbitrary roots so the in-root happy path is deterministic without
 * depending on the real home directory.
 */
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { parseHistoricalSource } from "../src/main/collectors/engine/historical-parse-source.js";
import {
  isImportableCollectorSource,
  isImportableSourcePath,
} from "../src/main/collectors/engine/source-admission.js";
import {
  Harness,
  type HarnessCollector,
  HarnessValues,
} from "../src/main/collectors/types.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

const OUTSIDE_ROOTS_PATTERN = /outside collector roots/;
const UNSUPPORTED_HARNESS_PATTERN = /Unsupported historical collector/;

/** Minimal real `HarnessCollector` for gate tests; override only what matters. */
function collectorWith(over: Partial<HarnessCollector>): HarnessCollector {
  return {
    key: Harness.Claude,
    cacheName: "test",
    watchRoots: () => [],
    watchMatch: () => true,
    listSources: () => [],
    parse: () => Promise.resolve([]),
    ...over,
  };
}

function writeFile(dir: string, name: string, contents = "{}"): string {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, contents, "utf8");
  return filePath;
}

// ── isImportableSourcePath — the security primitive ──────────────────────────

test("isImportableSourcePath accepts a regular file directly under a root", () => {
  const root = makeTempDir("adm-");
  const file = writeFile(root, "transcript.jsonl");
  assert.equal(isImportableSourcePath(file, [root]), true);
});

test("isImportableSourcePath accepts a file nested below a root", () => {
  const root = makeTempDir("adm-");
  mkdirSync(path.join(root, "a", "b"), { recursive: true });
  const file = writeFile(path.join(root, "a", "b"), "transcript.jsonl");
  assert.equal(isImportableSourcePath(file, [root]), true);
});

test("isImportableSourcePath rejects a file outside every root", () => {
  const root = makeTempDir("adm-root-");
  const other = makeTempDir("adm-other-");
  const file = writeFile(other, "transcript.jsonl");
  assert.equal(isImportableSourcePath(file, [root]), false);
});

test("isImportableSourcePath rejects a nonexistent path", () => {
  const root = makeTempDir("adm-");
  assert.equal(
    isImportableSourcePath(path.join(root, "missing.jsonl"), [root]),
    false
  );
});

test("isImportableSourcePath rejects a directory (not a regular file)", () => {
  const root = makeTempDir("adm-");
  const sub = path.join(root, "subdir");
  mkdirSync(sub);
  assert.equal(isImportableSourcePath(sub, [root]), false);
});

test("isImportableSourcePath rejects a symlink even when it targets an in-root file (no symlink escape)", () => {
  const root = makeTempDir("adm-");
  const target = writeFile(root, "target.jsonl");
  const link = path.join(root, "link.jsonl");
  symlinkSync(target, link);
  // lstat does not follow the link, so the symlink is not a regular file.
  assert.equal(isImportableSourcePath(link, [root]), false);
});

test("isImportableSourcePath rejects a '..' path that resolves outside the root", () => {
  const parent = makeTempDir("adm-parent-");
  const root = path.join(parent, "root");
  mkdirSync(root);
  const outside = writeFile(parent, "outside.jsonl");
  // `<root>/../outside.jsonl` lstats fine but realpaths outside the root.
  const traversal = path.join(root, "..", path.basename(outside));
  assert.equal(isImportableSourcePath(traversal, [root]), false);
});

test("isImportableSourcePath accepts a file under any of multiple roots", () => {
  const rootA = makeTempDir("adm-a-");
  const rootB = makeTempDir("adm-b-");
  const file = writeFile(rootB, "transcript.jsonl");
  assert.equal(isImportableSourcePath(file, [rootA, rootB]), true);
});

// ── isImportableCollectorSource — roots resolution + unscoped opt-out ─────────

test("isImportableCollectorSource allows unscoped sources only when explicitly opted in", () => {
  const optedIn = collectorWith({
    watchRoots: () => [],
    allowUnscopedSourceAdmission: true,
  });
  const notOptedIn = collectorWith({ watchRoots: () => [] });
  assert.equal(isImportableCollectorSource(optedIn, "/anywhere.jsonl"), true);
  assert.equal(
    isImportableCollectorSource(notOptedIn, "/anywhere.jsonl"),
    false
  );
});

test("isImportableCollectorSource prefers sourceRoots() over watchRoots()", () => {
  const watchRoot = makeTempDir("adm-watch-");
  const sourceRoot = makeTempDir("adm-source-");
  const collector = collectorWith({
    watchRoots: () => [watchRoot],
    sourceRoots: () => [sourceRoot],
  });
  const underSource = writeFile(sourceRoot, "ok.jsonl");
  const underWatch = writeFile(watchRoot, "nope.jsonl");
  assert.equal(isImportableCollectorSource(collector, underSource), true);
  // Under watchRoots but NOT sourceRoots → rejected, because sourceRoots wins.
  assert.equal(isImportableCollectorSource(collector, underWatch), false);
});

// ── parseHistoricalSource — gate wiring + per-harness dispatch ────────────────

for (const harness of HarnessValues) {
  test(`parseHistoricalSource rejects an out-of-root source for the ${harness} collector`, async () => {
    // A real file under a temp dir is outside every real collector root (which
    // live under the home directory), so the gate must reject it.
    const dir = makeTempDir("hps-");
    const file = writeFile(dir, "transcript.jsonl");
    await assert.rejects(
      () => parseHistoricalSource(harness, file),
      OUTSIDE_ROOTS_PATTERN
    );
  });
}

test("parseHistoricalSource rejects a nonexistent source", async () => {
  await assert.rejects(
    () =>
      parseHistoricalSource(Harness.Claude, "/nonexistent/transcript.jsonl"),
    OUTSIDE_ROOTS_PATTERN
  );
});

test("parseHistoricalSource throws synchronously on an unknown harness", () => {
  assert.throws(
    () => parseHistoricalSource("bogus" as Harness, "/x.jsonl"),
    UNSUPPORTED_HARNESS_PATTERN
  );
});
