/**
 * @file component-invocations-findings-disposition.test.ts
 * @description ISS-11325: a persisted findings row must say WHY it reads what it
 * reads — and the four states must be distinguishable on ONE locator.
 *
 * Every case drives `db.importer.importSession`, the entry point the live
 * collector uses, and reads `findings_disposition` back out of SQLite beside the
 * two count columns. The vocabulary's own folds are covered in isolation by
 * `packages/api/src/types/agent-component-findings-disposition.test.ts`; what
 * these cases pin is that the write path reaches the column with the right member
 * for each of the ingest's real outcomes.
 *
 * THE STATES, AND THE FACT THAT THEY ARE DISTINCT:
 *
 * | outcome                      | counts  | `findings_disposition`         |
 * | ---------------------------- | ------- | ------------------------------ |
 * | this run read the envelope    | present | `measured-this-run`           |
 * | a prior run's funnel survived | present | `carried-forward`             |
 * | the fold budget declined it   | absent  | `withheld-count-capped`       |
 * | the byte gate refused it      | absent  | `withheld-byte-gated`         |
 * | nothing could read it         | absent  | `withheld-unreadable`         |
 * | more than one of those        | absent  | `withheld-ambiguous-reason`   |
 *
 * AND THE UNAFFECTED ROW SAYS NOTHING. The first case imports TWO reviewer
 * invocations against an envelope naming ONE, and asserts the row left without a
 * funnel carries a NULL disposition — because an assertion that a reason is
 * present is satisfied by a reason that is always present, which would make the
 * whole disclosure unconditional decoration rather than a signal. The
 * funnel-LESS row is the one that can catch that: the withheld stamp skips every
 * row already holding a funnel, so the placed row would stay green under exactly
 * the mutation the assertion claims to guard (@tamsinb review).
 */
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { AgentComponentFindingsDisposition } from "@repo/api/src/types/agent-component-findings-disposition";
import { CODE_REVIEW_FINDINGS_FOLD_BUDGET } from "@repo/lib/code-review/findings-funnel-ingest";
import { describe, test } from "vitest";
import {
  envelopeWithConfirmedCount,
  findingsRows,
  importWithEnvelope,
  locatorTempDir,
  openDb,
  paddedEnvelope,
  RUN_ID,
  reviewSession,
  twoRunSession,
  WORKER_COMPONENT_KEY,
  writeEnvelope,
  writeRunEnvelope,
} from "./helpers/code-review-findings-locator.js";

/**
 * The one worker row, asserted to exist rather than defaulted, so a case can
 * never pass by finding nothing. Every case here is about a column ON that row,
 * so a missing row is a different failure and must read as one.
 */
function workerRow(
  rows: readonly {
    component_key: string;
    findings_emitted: bigint | number | null;
    findings_invalidated: bigint | number | null;
    findings_disposition: string | null;
  }[]
) {
  const worker = rows.find((row) => row.component_key === WORKER_COMPONENT_KEY);
  if (worker === undefined) {
    /* Thrown rather than asserted so the lint rule that keeps assertions inside
       a test stays satisfied; a missing row still fails the case loudly, and with
       a different message from any column expectation below. */
    throw new Error(
      `the reviewer's invocation row must persist; got ${rows.length} row(s)`
    );
  }
  return worker;
}

describe("ISS-11325 persisted findings disposition", () => {
  test("a run this pass read says the counts are its own, and a pass that withheld nothing says nothing", async () => {
    const dir = await locatorTempDir("iss11325-measured-");
    const db = await openDb(dir);
    try {
      /* TWO worker invocations and an envelope naming ONE reviewer, so exactly
         one row can be placed and the other ends the pass funnel-less.
         (@tamsinb review) The funnel-less row is what makes this case able to
         fail: `markWithheldFindingsRows` SKIPS any row that already holds a
         funnel, so asserting "no withholding" on the placed row alone stays
         green even if the withheld fold were hardcoded to stamp on every pass.
         This row is the one such a mutation would reach. */
      const workers = (
        await importWithEnvelope(
          dir,
          db,
          "session-11325-measured",
          envelopeWithConfirmedCount("auditor", 2),
          [WORKER_COMPONENT_KEY, WORKER_COMPONENT_KEY]
        )
      ).filter((row) => row.component_key === WORKER_COMPONENT_KEY);
      if (workers.length !== 2) {
        /* Thrown rather than asserted so the lint rule that keeps assertions
           inside a test stays satisfied; a wrong row count is a different
           failure from any column expectation below. */
        throw new Error(
          `both reviewer invocations must persist; got ${workers.length}`
        );
      }
      const placed = workers.filter((row) => row.findings_emitted !== null);
      const unplaced = workers.filter((row) => row.findings_emitted === null);
      assert.equal(placed.length, 1);
      assert.equal(unplaced.length, 1);

      assert.equal(Number(placed[0]?.findings_emitted), 3);
      /* A NON-CIRCULAR literal: the member's own string, not the const read back
         through the same module the production code wrote it with. */
      assert.equal(placed[0]?.findings_disposition, "measured-this-run");
      assert.equal(
        placed[0]?.findings_disposition,
        AgentComponentFindingsDisposition.MeasuredThisRun
      );

      /* THE UNAFFECTED ROW SAYS NOTHING. Nothing was withheld this pass, so the
         row with no funnel carries no reason either — NULL, not a withholding
         member and not a measurement it never made. */
      assert.equal(unplaced[0]?.findings_disposition, null);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a funnel carried forward from an earlier run says so rather than reading as current", async () => {
    const dir = await locatorTempDir("iss11325-carried-");
    const db = await openDb(dir);
    const sessionId = "session-11325-carried";
    try {
      const cwd = path.join(dir, "repo");
      await mkdir(cwd, { recursive: true });
      /* PRE-SEED A CONFLICTING AMBIENT VALUE: the first import writes a real
         measurement AND stamps `measured-this-run`, so the re-import below has to
         overwrite a label that contradicts it. Precedence is what is under test,
         not merely presence. */
      await writeEnvelope(cwd, envelopeWithConfirmedCount("auditor", 2));
      await db.importer.importSession(reviewSession(sessionId, cwd), "claude");
      const seeded = workerRow(await findingsRows(db, sessionId));
      assert.equal(Number(seeded.findings_emitted), 3);
      assert.equal(seeded.findings_disposition, "measured-this-run");

      // The run directory is cleaned up; the session still names it, so this pass
      // withholds — and `preserveStrongerEvidence` keeps the prior measurement.
      await rm(path.join(cwd, ".closedloop-ai"), {
        recursive: true,
        force: true,
      });
      await db.importer.importSession(reviewSession(sessionId, cwd), "claude");
      const reimported = workerRow(await findingsRows(db, sessionId));
      /* AC3: the carried value is NOT deleted. The fix is labelling it. */
      assert.equal(Number(reimported.findings_emitted), 3);
      assert.equal(Number(reimported.findings_invalidated), 1);
      assert.equal(reimported.findings_disposition, "carried-forward");
      assert.equal(
        reimported.findings_disposition,
        AgentComponentFindingsDisposition.CarriedForward
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an envelope nothing could read says unreadable, not merely absent", async () => {
    const dir = await locatorTempDir("iss11325-unreadable-");
    const db = await openDb(dir);
    try {
      const worker = workerRow(
        await importWithEnvelope(dir, db, "session-11325-unreadable", null)
      );
      assert.equal(worker.findings_emitted, null);
      assert.equal(worker.findings_invalidated, null);
      assert.equal(worker.findings_disposition, "withheld-unreadable");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an envelope past the byte gate says byte-gated, not unreadable", async () => {
    const dir = await locatorTempDir("iss11325-bytes-");
    const db = await openDb(dir);
    try {
      const worker = workerRow(
        await importWithEnvelope(
          dir,
          db,
          "session-11325-bytes",
          // Past the 8 MiB `stat` gate: the file is never opened.
          envelopeWithConfirmedCount("auditor", 2, "p".repeat(9 * 1024 * 1024))
        )
      );
      assert.equal(worker.findings_emitted, null);
      /* The byte-gated envelope is ALSO counted as unreadable by the ingest — it
         is never opened — so this is the case that reddens if the two populations
         are folded together and the row degrades to ambiguous. */
      assert.equal(worker.findings_disposition, "withheld-byte-gated");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an envelope past the findings-count budget says count-capped, not byte-gated", async () => {
    const dir = await locatorTempDir("iss11325-count-");
    const db = await openDb(dir);
    try {
      const worker = workerRow(
        await importWithEnvelope(
          dir,
          db,
          "session-11325-count",
          // Small in BYTES and large in ENTRIES — the only shape that reaches the
          // count gate without first tripping the byte gate. Derived from the
          // exported budget, so raising it cannot quietly stop this exceeding it.
          paddedEnvelope("auditor", CODE_REVIEW_FINDINGS_FOLD_BUDGET + 1)
        )
      );
      assert.equal(worker.findings_emitted, null);
      assert.equal(worker.findings_disposition, "withheld-count-capped");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("two different withholding reasons in one pass say so instead of naming one of them", async () => {
    const dir = await locatorTempDir("iss11325-ambiguous-");
    const db = await openDb(dir);
    try {
      const cwd = path.join(dir, "repo");
      await mkdir(cwd, { recursive: true });
      const oversizeRunId = "cr-oversize";
      await writeRunEnvelope(
        cwd,
        oversizeRunId,
        envelopeWithConfirmedCount("auditor", 2, "p".repeat(9 * 1024 * 1024))
      );
      await writeRunEnvelope(
        cwd,
        RUN_ID,
        paddedEnvelope("bha_p0", CODE_REVIEW_FINDINGS_FOLD_BUDGET + 1)
      );
      await db.importer.importSession(
        twoRunSession("session-11325-ambiguous", cwd, [oversizeRunId, RUN_ID]),
        "claude"
      );
      const workers = (
        await findingsRows(db, "session-11325-ambiguous")
      ).filter((row) => row.component_key === WORKER_COMPONENT_KEY);
      assert.equal(workers.length, 2);
      for (const worker of workers) {
        assert.equal(worker.findings_emitted, null);
        /* Neither `withheld-byte-gated` nor `withheld-count-capped`: both applied
           to this pass and the envelope names no invocation, so which one covered
           a given row is not recoverable. Naming one would be a sentence that may
           be false for that row. */
        assert.equal(worker.findings_disposition, "withheld-ambiguous-reason");
      }
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
