/**
 * @file collector-entrypoint-drift-report.test.ts
 * @description ISS-7260 — the import path must SAY SO when a session's harness
 * entrypoint falls through the headless rules into the interactive class by
 * default, instead of classifying it silently.
 *
 * These drive `parseSourceForPass`, the production step every harness's parse
 * resolves through, rather than the pure reporter (which has its own suite in
 * `@repo/lib`). Deleting the call from the parse step must fail here.
 *
 * The reporter is one bounded instance for the life of the process, so each case
 * below uses entrypoint values no other case uses — a repeat is deliberately
 * silent, which is the behaviour the last test pins.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type PassParseOptions,
  parseSourceForPass,
} from "../src/main/collectors/engine/collector-manager-source-parse.js";
import type {
  HarnessCollector,
  NormalizedSession,
} from "../src/main/collectors/types.js";

const DEFAULT_CLASSIFICATION_LINE = /INTERACTIVE by default/;

const COLLECTOR = {
  key: "claude",
  cacheName: "claude",
  batch: false,
  listSources: () => [],
  parse: () => Promise.resolve([]),
} as unknown as HarnessCollector;

function sessionWithEntrypoint(entrypoint: string): NormalizedSession {
  return { sessionId: `s-${entrypoint}`, entrypoint } as NormalizedSession;
}

async function parseReturning(
  sessions: NormalizedSession[],
  log: (message: string) => void
): Promise<string> {
  const options: PassParseOptions = {
    parseSource: () => Promise.resolve(sessions),
    collector: COLLECTOR,
    source: "/tmp/iss-7260-transcript.jsonl",
    stat: null,
    extraMtime: null,
    cache: undefined,
    quarantine: undefined,
    lowDutyImport: false,
    parseTimeoutMs: null,
    isImportActive: () => true,
    abortInFlightParse: () => undefined,
    log,
  };
  const { outcome } = await parseSourceForPass(options);
  return outcome.kind;
}

test("ISS-7260: an unrecognized entrypoint is reported by the import path", async () => {
  const lines: string[] = [];
  const kind = await parseReturning(
    [sessionWithEntrypoint("iss7260-unknown-harness")],
    (message) => lines.push(message)
  );
  assert.equal(kind, "sessions", "the parse step must have succeeded");
  const reported = lines.filter((line) =>
    line.includes("iss7260-unknown-harness")
  );
  assert.equal(reported.length, 1, `expected one drift line, got ${lines}`);
  assert.match(reported[0], DEFAULT_CLASSIFICATION_LINE);
});

test("ISS-7260: recognized entrypoints produce no drift line", async () => {
  // The positive sibling above is what makes this meaningful: the step can
  // report, so silence here is the classifier deciding, not a dead call site.
  const lines: string[] = [];
  await parseReturning(
    [
      sessionWithEntrypoint("cli"),
      sessionWithEntrypoint("sdk-cli"),
      sessionWithEntrypoint("codex_exec"),
      sessionWithEntrypoint("opencode"),
      sessionWithEntrypoint("codex_sdk_ts"),
      sessionWithEntrypoint("copilot"),
      sessionWithEntrypoint("cursor"),
    ],
    (message) => lines.push(message)
  );
  assert.deepEqual(lines, []);
});

test("ISS-7260: every distinct unrecognized value in one batch is reported", async () => {
  // The batch is what makes the per-session loop observable: a step that looked
  // at the first session only would still emit one line for a corpus of
  // identical values, and none at all for a batch of recognized ones, so it
  // passes every other case here.
  const lines: string[] = [];
  await parseReturning(
    [
      sessionWithEntrypoint("cli"),
      sessionWithEntrypoint("iss7260-batch-first"),
      sessionWithEntrypoint("sdk-cli"),
      sessionWithEntrypoint("iss7260-batch-second"),
    ],
    (message) => lines.push(message)
  );
  assert.equal(lines.length, 2, `expected two drift lines, got ${lines}`);
  assert.ok(lines.some((line) => line.includes("iss7260-batch-first")));
  assert.ok(lines.some((line) => line.includes("iss7260-batch-second")));
});

test("ISS-7260: a corpus of the same unrecognized value costs exactly one line", async () => {
  const lines: string[] = [];
  const many = Array.from({ length: 50 }, () =>
    sessionWithEntrypoint("iss7260-repeated-harness")
  );
  await parseReturning(many, (message) => lines.push(message));
  assert.equal(lines.length, 1, `expected one line, got ${lines.length}`);

  // A LATER pass over the same value stays silent too — the dedupe is per
  // process, not per source, which is what keeps a 3,000-session backfill from
  // emitting 3,000 identical lines.
  const second: string[] = [];
  await parseReturning(
    [sessionWithEntrypoint("iss7260-repeated-harness")],
    (message) => second.push(message)
  );
  assert.deepEqual(second, []);
});
