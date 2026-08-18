/**
 * @file golden-layer2-cell-normalization.test.ts
 * @description FEA-4010 tests for the Layer 2 per-cell normalization: capture-host
 * home paths are canonicalized (on both separator styles, at the top level and
 * nested inside a `Json` column) and oversized cells collapse to a digest.
 *
 * Lives beside its module rather than in `golden-layer2.ts`, which is at the
 * file-size ceiling and shrink-only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalizeHostPaths,
  LONG_TEXT_THRESHOLD,
  normalizeCell,
} from "./golden/golden-layer2-cell-normalization.js";

const WINDOWS_SESSION = String.raw`C:\Users\carol\.codex\sessions\rollout.jsonl`;
const WINDOWS_CANONICAL = String.raw`<HOME>\.codex\sessions\rollout.jsonl`;

test("home paths are canonicalized on both separator styles", () => {
  assert.equal(
    normalizeCell("/Users/alice/.claude/projects/session.jsonl"),
    "<HOME>/.claude/projects/session.jsonl"
  );
  assert.equal(
    normalizeCell("/home/bob/.codex/sessions/rollout.jsonl"),
    "<HOME>/.codex/sessions/rollout.jsonl"
  );
  assert.equal(normalizeCell(WINDOWS_SESSION), WINDOWS_CANONICAL);
  assert.deepEqual(
    normalizeCell(`/Users/alice/${"x".repeat(LONG_TEXT_THRESHOLD)}`),
    normalizeCell(`/home/bob/${"x".repeat(LONG_TEXT_THRESHOLD)}`),
    "home paths must be canonicalized before long snapshot text is hashed"
  );
});

test("an oversized JSON cell collapses to a digest, like oversized text", () => {
  // A Prisma `Json` column arrives PARSED, so it never met the string branch and
  // rode into the snapshot expanded. One outbox payload was ~10,000
  // pretty-printed lines and embeds `dataRevision`, so bumping that constant
  // rewrote whole files: 24,690 changed snapshot lines on the AA-10 merge, ~870
  // of them real.
  const bigJson = { items: Array.from({ length: 40 }, (_, i) => ({ i })) };
  const digested = normalizeCell(bigJson) as {
    sha256?: string;
    chars?: number;
  };
  assert.equal(typeof digested.sha256, "string");
  assert.equal(digested.chars, JSON.stringify(bigJson).length);
  // Small structured cells stay expanded — they are the reviewable ones.
  assert.deepEqual(normalizeCell({ a: 1 }), { a: 1 });
});

test("canonicalization reaches INSIDE a Json column, on either platform", () => {
  assert.deepEqual(normalizeCell({ cwd: "/Users/alice/repo" }), {
    cwd: "<HOME>/repo",
  });
  assert.deepEqual(
    normalizeCell({ big: `/Users/alice/${"x".repeat(LONG_TEXT_THRESHOLD)}` }),
    normalizeCell({ big: `/home/bob/${"x".repeat(LONG_TEXT_THRESHOLD)}` }),
    "nested home paths are canonicalized before an oversized JSON cell is hashed"
  );

  // A NESTED WINDOWS path is the case that escaping broke: canonicalizing the
  // serialized blob saw `C:\\Users\\carol` (each separator escaped by
  // JSON.stringify) and the single-backslash matcher stopped matching, so the
  // capture username survived into small snapshots and produced host-specific
  // digests in large ones. Normalizing string LEAVES sidesteps escaping.
  assert.deepEqual(normalizeCell({ transcript: WINDOWS_SESSION }), {
    transcript: WINDOWS_CANONICAL,
  });
  assert.deepEqual(
    normalizeCell({ nested: { deep: [WINDOWS_SESSION] } }),
    { nested: { deep: [WINDOWS_CANONICAL] } },
    "arrays and nested objects are walked, not just top-level string fields"
  );
  // Two different Windows capture hosts must digest identically once oversized.
  const pad = "x".repeat(LONG_TEXT_THRESHOLD);
  assert.deepEqual(
    normalizeCell({ big: String.raw`C:\Users\carol\${pad}` + pad }),
    normalizeCell({ big: String.raw`D:\Users\dave\${pad}` + pad }),
    "oversized nested Windows paths must not leak the capture host into the hash"
  );
});

test("canonicalizeHostPaths is exported for callers that pre-normalize text", () => {
  assert.equal(canonicalizeHostPaths("/Users/alice/x"), "<HOME>/x");
  assert.equal(canonicalizeHostPaths("no path here"), "no path here");
});
