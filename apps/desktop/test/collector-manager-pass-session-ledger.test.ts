/**
 * @file collector-manager-pass-session-ledger.test.ts
 * @description ISS-12036: the pass session ledger, extracted from
 * `collector-manager.ts` when that file crossed the line-count ceiling.
 *
 * The extraction is behaviour-preserving, so what these cases are for is the
 * property that made the two predicates worth keeping together: both read the
 * pre-flight sink snapshot AND what this pass has since written, and a caller
 * that consulted only the snapshot would mis-answer every session imported
 * inside the current pass. `noteImported` is what closes that gap, so each case
 * asserts a predicate on both sides of it.
 *
 * MUTATION: have `noteImported` do nothing and the second half of both cases
 * fails; drop the `importedThisPass` term from `sinkStillHolds` and the batch
 * cursor case fails alone.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { createPassSessionLedger } from "../src/main/collectors/engine/collector-manager-pass-session-ledger.js";
import type { HarnessCollector } from "../src/main/collectors/types.js";

const SOURCE = "/tmp/ledger-transcript.jsonl";
const SESSION_ID = `session:${SOURCE}`;

/** A file collector whose session id is derivable from the path (FEA-1785). */
function fileCollector(): HarnessCollector {
  return {
    key: "claude",
    cacheName: "claude",
    allowUnscopedSourceAdmission: true,
    watchRoots: () => [],
    watchMatch: () => true,
    listSources: () => [],
    parse: async () => [],
    sessionIdForSource: (source: string) => `session:${source}`,
  } as unknown as HarnessCollector;
}

test("ISS-12036: a source this pass wrote is durable, even though the pre-flight snapshot predates it", () => {
  const ledger = createPassSessionLedger(fileCollector(), new Set<string>());

  // The snapshot is empty, so the orphan self-heal would readmit this source.
  assert.equal(ledger.isSourceDurable(SOURCE), false);
  // ...unless THIS pass parsed it to zero sessions, which no later scan revisits.
  assert.equal(ledger.isSourceDurable(SOURCE, true), true);

  ledger.noteImported(SESSION_ID);
  assert.equal(
    ledger.isSourceDurable(SOURCE),
    true,
    "the row this pass wrote is absent from the snapshot and must still count"
  );
});

test("ISS-12036: the batch cursor may skip a session the snapshot lacks but this pass wrote", () => {
  const ledger = createPassSessionLedger(fileCollector(), new Set<string>());

  assert.equal(ledger.sinkStillHolds(SESSION_ID), false);
  ledger.noteImported(SESSION_ID);
  assert.equal(ledger.sinkStillHolds(SESSION_ID), true);

  // ISS-5161: no loader answered, so the cursor is trusted rather than every
  // session replayed — the pre-ISS-5161 behaviour, kept deliberately.
  const unknownSink = createPassSessionLedger(fileCollector(), undefined);
  assert.equal(unknownSink.sinkStillHolds("never-seen"), true);
});
