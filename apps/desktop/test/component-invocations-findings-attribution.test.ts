/**
 * @file component-invocations-findings-attribution.test.ts
 * @description ISS-11238: the code-review findings funnel must reach the
 * PERSISTED invocation row, through the production importer.
 *
 * Every case here drives `db.importer.importSession` — the same entry point the
 * live collector uses, which runs `materializeAgentComponentInvocations` and its
 * real insert — and then reads `agent_component_invocations` back out of SQLite.
 * The attributor is already covered in isolation by
 * `packages/lib/code-review/findings-funnel-attribution.test.ts`; what was
 * missing, and what these cases pin, is the stamp between it and the insert.
 * Deleting that stamp call turns the first case red.
 *
 * Imports from `vitest`, not `node:test`: `apps/desktop/test/AGENTS.md` requires
 * it of every new suite, and the `node:test` alias in `vitest.node.config.ts`
 * exists only to keep grandfathered files running. A new file importing only the
 * shimmed names runs and fails no ratchet, so review is the only thing that
 * catches it (tamsinb and codex on #7978).
 *
 * The AC2 cases all assert POSITIVELY that the candidate persisted — a row
 * count and a read-back component key — as well as that its funnel columns are
 * NULL. "It did not throw" is equally satisfied by a collector that returned
 * early having written nothing, which is the failure they exist to catch.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CODE_REVIEW_FINDINGS_FOLD_BUDGET } from "@repo/lib/code-review/findings-funnel-ingest";
import { describe, test } from "vitest";
import {
  envelopeNaming,
  envelopeWithConfirmedCount,
  findingsRows,
  importWithEnvelope,
  NOW,
  openDb,
  paddedEnvelope,
  twoRunSession,
  WORKER_COMPONENT_KEY,
  writeRunEnvelope,
} from "./helpers/code-review-findings-locator.js";
import { makeSession } from "./normalized-session-test-utils.js";

describe("ISS-11238 desktop code-review findings attribution", () => {
  test("a run naming a producing component persists its funnel on the row", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss11238-stamp-"));
    const db = await openDb(dir);
    try {
      const rows = await importWithEnvelope(
        dir,
        db,
        "session-11238-attributed",
        envelopeNaming("auditor")
      );
      const worker = rows.find(
        (row) => row.component_key === WORKER_COMPONENT_KEY
      );
      assert.ok(worker, "the reviewer's invocation row must persist");
      // Both cells must be WRITTEN, checked before the numeric compare: a NULL
      // coerces to 0 through Number(), so a value assertion alone would let an
      // unattributed row satisfy a "measured zero" expectation.
      assert.notEqual(worker.findings_emitted, null);
      assert.notEqual(worker.findings_invalidated, null);
      // Two adjudicated findings (CONFIRMED + REJECTED); the verdict-less one is
      // in NEITHER count, so emitted is 2 and not 3.
      assert.equal(Number(worker.findings_emitted), 2);
      assert.equal(Number(worker.findings_invalidated), 1);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an absent envelope still persists the candidate, unattributed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss11238-absent-"));
    const db = await openDb(dir);
    try {
      const rows = await importWithEnvelope(
        dir,
        db,
        "session-11238-absent",
        null
      );
      const worker = rows.find(
        (row) => row.component_key === WORKER_COMPONENT_KEY
      );
      assert.ok(worker, "the candidate must persist with no envelope on disk");
      assert.equal(worker.findings_emitted, null);
      assert.equal(worker.findings_invalidated, null);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an unreadable envelope still persists the candidate, unattributed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss11238-corrupt-"));
    const db = await openDb(dir);
    try {
      // Truncated JSON — the shape a killed run leaves behind.
      const rows = await importWithEnvelope(
        dir,
        db,
        "session-11238-corrupt",
        '{"verified": [{"reviewer": "auditor"'
      );
      const worker = rows.find(
        (row) => row.component_key === WORKER_COMPONENT_KEY
      );
      assert.ok(worker, "the candidate must persist past a corrupt envelope");
      assert.equal(worker.findings_emitted, null);
      assert.equal(worker.findings_invalidated, null);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a reviewer this build cannot place persists the candidate, unattributed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss11238-unknown-"));
    const db = await openDb(dir);
    try {
      const rows = await importWithEnvelope(
        dir,
        db,
        "session-11238-unknown",
        envelopeNaming("reviewer_from_a_newer_plugin")
      );
      const worker = rows.find(
        (row) => row.component_key === WORKER_COMPONENT_KEY
      );
      assert.ok(worker, "the candidate must persist for an unknown producer");
      // Never fabricated onto the only component in sight: an unmatched
      // reviewer is a producer we could not place, not this one's funnel.
      assert.equal(worker.findings_emitted, null);
      assert.equal(worker.findings_invalidated, null);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("two producers of one component take their own funnels, in sequence order", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss11238-two-"));
    const db = await openDb(dir);
    try {
      // `auditor` and `bha_p0` BOTH resolve to code-review:code-review-worker,
      // which is why ISS-10724 calls the association ambiguous. Two invocations
      // of that component must take two DIFFERENT funnels, not one funnel twice:
      // dropping the claim bookkeeping doubles the component's emitted total.
      const rows = await importWithEnvelope(
        dir,
        db,
        "session-11238-two-producers",
        envelopeNaming("auditor", "bha_p0"),
        [WORKER_COMPONENT_KEY, WORKER_COMPONENT_KEY]
      );
      const workers = rows.filter(
        (row) => row.component_key === WORKER_COMPONENT_KEY
      );
      assert.equal(workers.length, 2, "both invocations must persist");
      // Rows come back ORDER BY sequence, and the attributor orders producers by
      // reviewer id, so `auditor` (2 emitted) precedes `bha_p0` (3 emitted).
      assert.deepEqual(
        workers.map((row) => [
          Number(row.findings_emitted),
          Number(row.findings_invalidated),
        ]),
        [
          [2, 1],
          [3, 1],
        ]
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a surplus producer leaves the one invocation with a single funnel", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss11238-surplus-"));
    const db = await openDb(dir);
    try {
      // Two producers, one derived invocation. The funnel with nowhere to sit is
      // refused rather than summed onto, or overwriting, the row that is there.
      const rows = await importWithEnvelope(
        dir,
        db,
        "session-11238-surplus",
        envelopeNaming("auditor", "bha_p0"),
        [WORKER_COMPONENT_KEY]
      );
      const workers = rows.filter(
        (row) => row.component_key === WORKER_COMPONENT_KEY
      );
      assert.equal(workers.length, 1);
      const worker = workers[0];
      assert.ok(worker);
      assert.equal(Number(worker.findings_emitted), 2);
      assert.equal(Number(worker.findings_invalidated), 1);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a graph-role producer falls back to the default worker key", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss11238-graph-"));
    const db = await openDb(dir);
    try {
      // `bhb` is spawned as code-review:code-review-worker-graph today and as the
      // DEFAULT worker in runs predating that split, so the attributor carries
      // both keys. Honoring only the first would silently unmatch an older run.
      const rows = await importWithEnvelope(
        dir,
        db,
        "session-11238-graph-role",
        envelopeNaming("bhb"),
        [WORKER_COMPONENT_KEY]
      );
      const worker = rows.find(
        (row) => row.component_key === WORKER_COMPONENT_KEY
      );
      assert.ok(worker);
      assert.equal(Number(worker.findings_emitted), 2);
      assert.equal(Number(worker.findings_invalidated), 1);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a run past the first read batch is still read", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss11238-batched-"));
    const db = await openDb(dir);
    try {
      // The envelope reads are bounded to a fixed number in flight at a time, so
      // a session naming more runs than that width spans several batches. The
      // one real envelope sits in the LAST directory by path: reading only the
      // first batch leaves the row unattributed.
      const cwd = path.join(dir, "repo");
      const runIds = Array.from(
        { length: 12 },
        (_unused, index) => `cr-${String(index + 1).padStart(3, "0")}`
      );
      const lastRunId = runIds.at(-1);
      assert.ok(lastRunId);
      for (const runId of runIds) {
        await mkdir(path.join(cwd, ".closedloop-ai", "code-review", runId), {
          recursive: true,
        });
      }
      await writeFile(
        path.join(
          cwd,
          ".closedloop-ai",
          "code-review",
          lastRunId,
          "review_result.json"
        ),
        envelopeNaming("auditor"),
        "utf8"
      );
      const session = makeSession({
        sessionId: "session-11238-batched",
        cwd,
        startedAt: NOW,
        endedAt: "2026-09-26T12:30:00.000Z",
        toolUses: runIds.map((runId) => ({
          id: `toolu_${runId}`,
          providerToolUseId: `toolu_${runId}`,
          name: "Read",
          kind: "builtin" as const,
          timestamp: NOW,
          input: {
            file_path: path.join(
              cwd,
              ".closedloop-ai",
              "code-review",
              runId,
              "review_result.json"
            ),
          },
        })),
        subagents: [
          {
            id: "sub-reviewer-1",
            name: WORKER_COMPONENT_KEY,
            type: WORKER_COMPONENT_KEY,
            normalizedName: WORKER_COMPONENT_KEY,
            rawName: WORKER_COMPONENT_KEY,
            startedAt: NOW,
          },
        ],
      });
      await db.importer.importSession(session, "claude");
      const worker = (await findingsRows(db, "session-11238-batched")).find(
        (row) => row.component_key === WORKER_COMPONENT_KEY
      );
      assert.ok(worker);
      assert.equal(Number(worker.findings_emitted), 2);
      assert.equal(Number(worker.findings_invalidated), 1);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("a re-import whose earlier envelope is gone keeps that row's carried funnel and re-places the readable one", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss11238-reimport-"));
    const db = await openDb(dir);
    const cwd = path.join(dir, "repo");
    const sessionId = "session-11238-reimport";
    /* Ordered by resolved envelope path, so `cr-a100` is attributed first and
       its funnel lands on the first invocation in sequence order. */
    const firstRunId = "cr-a100";
    const secondRunId = "cr-b200";
    try {
      await mkdir(cwd, { recursive: true });
      await writeRunEnvelope(
        cwd,
        firstRunId,
        envelopeWithConfirmedCount("auditor", 2)
      );
      await writeRunEnvelope(
        cwd,
        secondRunId,
        envelopeWithConfirmedCount("bha_p0", 4)
      );
      const session = twoRunSession(sessionId, cwd, [firstRunId, secondRunId]);
      await db.importer.importSession(session, "claude");
      const seeded = (await findingsRows(db, sessionId)).filter(
        (row) => row.component_key === WORKER_COMPONENT_KEY
      );
      assert.deepEqual(
        seeded.map((row) => [
          Number(row.findings_emitted),
          Number(row.findings_invalidated),
        ]),
        [
          [3, 1],
          [5, 1],
        ],
        "the first import must seat two DIFFERENT funnels, or this case proves nothing"
      );

      /* The first run's directory is cleaned up; the second is still on disk.
         `preserveMeasuredFindings` has already carried BOTH prior pairs onto the
         re-derived candidates by the time the stamp runs, so a placement that
         takes the first unclaimed row writes the surviving run's funnel over the
         cleaned-up run's — counting one twice and losing the other. */
      await rm(path.join(cwd, ".closedloop-ai", "code-review", firstRunId), {
        recursive: true,
        force: true,
      });
      await db.importer.importSession(session, "claude");
      const reimported = (await findingsRows(db, sessionId)).filter(
        (row) => row.component_key === WORKER_COMPONENT_KEY
      );
      assert.deepEqual(
        reimported.map((row) => [
          Number(row.findings_emitted),
          Number(row.findings_invalidated),
        ]),
        [
          [3, 1],
          [5, 1],
        ]
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * ISS-11310 AC4, the count-capped third of the three states this locator pins.
   *
   * The envelope is small in BYTES — it clears the 8 MiB gate the case below
   * exercises — and large in ENTRIES: `envelopeWithConfirmedCount("auditor", 2)`
   * would attribute {3, 1}, and it is padded past the fold budget with
   * verdict-less filler the attributor would count and never fold. So the case
   * fails in both directions it has to: delete the count bound and the row reads
   * {3, 1}; truncate instead of withholding and the row reads a number smaller
   * than the run's real one. Sized FROM the exported budget rather than from a
   * literal, so raising the budget cannot quietly stop this corpus from
   * exceeding it — which is the way an "equals N" bound assertion goes vacuous.
   */
  test("an envelope past the findings-count budget persists the candidate unattributed rather than folding a prefix", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss11310-countcap-"));
    const logged: string[] = [];
    const db = await openDb(dir, (message) => logged.push(message));
    try {
      const rows = await importWithEnvelope(
        dir,
        db,
        "session-11310-count-capped",
        JSON.stringify({
          review_id: "review-11310",
          verified: [
            { reviewer: "auditor", verifier_verdict: "CONFIRMED" },
            { reviewer: "auditor", verifier_verdict: "CONFIRMED" },
          ],
          rejected: [{ reviewer: "auditor", verifier_verdict: "REJECTED" }],
          pending_verification: Array.from(
            { length: CODE_REVIEW_FINDINGS_FOLD_BUDGET },
            () => 0
          ),
        })
      );
      const worker = rows.find(
        (row) => row.component_key === WORKER_COMPONENT_KEY
      );
      assert.ok(
        worker,
        "the candidate must persist past a count-capped envelope"
      );
      assert.equal(worker.findings_emitted, null);
      assert.equal(worker.findings_invalidated, null);
      /* AC2: withholding is only honest if the shortfall is SAID, so the
         absence above pairs with a disclosure carrying the run's exact size and
         the budget it exceeded. Asserted through the production log sink, not a
         hand-built stamp, so deleting the report call turns this red too. */
      const disclosure = logged.filter((message) =>
        message.includes(`${CODE_REVIEW_FINDINGS_FOLD_BUDGET}-finding`)
      );
      assert.equal(disclosure.length, 2, logged.join("\n"));
      assert.ok(
        (disclosure[0] ?? "").includes(
          `the ${CODE_REVIEW_FINDINGS_FOLD_BUDGET}-finding fold budget withheld 1 code-review run envelope(s) carrying ${CODE_REVIEW_FINDINGS_FOLD_BUDGET + 3} finding(s) in total`
        ),
        disclosure[0]
      );
      assert.ok(
        (disclosure[0] ?? "").includes("absent, not zero and not truncated"),
        disclosure[0]
      );
      /* And this run really is the pathological one, so the second line says so.
         A run withheld because EARLIER runs spent the budget gets the first line
         and not this one — otherwise the disclosure would send a reader off to
         inspect an envelope that is perfectly fine. */
      assert.ok(
        (disclosure[1] ?? "").includes(
          `1 of those envelope(s) exceed the ${CODE_REVIEW_FINDINGS_FOLD_BUDGET}-finding budget on their own rather than having run it out`
        ),
        disclosure.join("\n")
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The starved half of the count cap, which the single-run case above cannot
   * reach: `cr-b200` fits the budget on its own and is withheld only because
   * `cr-a100` had already spent it.
   *
   * The disclosure has to name BOTH — the withheld run and the run that spent
   * the budget — because a line carrying only the withheld one points an operator
   * at an envelope that is perfectly fine and leaves the one worth opening in no
   * list at all (tamsinb on #7993). Asserted through the production log sink, so
   * deleting either report call turns this red.
   */
  test("a run starved by an earlier one discloses the envelope that spent the budget", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss11310-starved-"));
    const logged: string[] = [];
    const db = await openDb(dir, (message) => logged.push(message));
    const cwd = path.join(dir, "repo");
    const spenderRunId = "cr-a100";
    const starvedRunId = "cr-b200";
    /* Each clears the budget alone; together they do not. Sized FROM the export
       so raising the budget cannot quietly stop this pair from exceeding it. */
    const spenderEntries = Math.floor(CODE_REVIEW_FINDINGS_FOLD_BUDGET * 0.9);
    const starvedEntries =
      CODE_REVIEW_FINDINGS_FOLD_BUDGET - spenderEntries + 1;
    try {
      await mkdir(cwd, { recursive: true });
      await writeRunEnvelope(
        cwd,
        spenderRunId,
        paddedEnvelope("auditor", spenderEntries)
      );
      await writeRunEnvelope(
        cwd,
        starvedRunId,
        paddedEnvelope("bha_p0", starvedEntries)
      );
      await db.importer.importSession(
        twoRunSession("session-11310-starved", cwd, [
          spenderRunId,
          starvedRunId,
        ]),
        "claude"
      );
      const budgetLines = logged.filter((message) =>
        message.includes(`${CODE_REVIEW_FINDINGS_FOLD_BUDGET}-finding`)
      );
      assert.equal(budgetLines.length, 2, logged.join("\n"));
      /* The victim line, naming the victim and its exact size — and NOT the
         spender, which is the whole gap: on its own this line points an operator
         at `cr-b200`, an envelope that is perfectly fine. */
      const victimLine = budgetLines[0] ?? "";
      assert.ok(
        victimLine.includes(
          `withheld 1 code-review run envelope(s) carrying ${starvedEntries} finding(s) in total`
        ),
        victimLine
      );
      assert.ok(victimLine.includes(starvedRunId), victimLine);
      assert.ok(!victimLine.includes(spenderRunId), victimLine);
      /* Neither run exceeds the whole budget, so the pathological line must NOT
         fire — it would send a reader to inspect a fine envelope — and the
         starved line must, naming the spender and what it cost. */
      assert.ok(
        !budgetLines.some((message) =>
          message.includes("on their own rather than having run it out")
        ),
        budgetLines.join("\n")
      );
      const spenderLine = budgetLines[1] ?? "";
      assert.ok(
        spenderLine.includes(
          `1 of those envelope(s) fit the ${CODE_REVIEW_FINDINGS_FOLD_BUDGET}-finding budget on their own and were withheld because it was already spent by`
        ),
        spenderLine
      );
      // The spender, BY NAME and with what it cost — not merely "something did".
      assert.ok(spenderLine.includes(spenderRunId), spenderLine);
      assert.ok(spenderLine.includes(`(${spenderEntries})`), spenderLine);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an envelope inside the findings-count budget still attributes its funnel", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss11310-undercap-"));
    const logged: string[] = [];
    const db = await openDb(dir, (message) => logged.push(message));
    try {
      /* The PRESENCE half: the same envelope shape one entry short of the
         budget. Without it, the absence assertion above is equally satisfied by
         a bound that refuses every run. */
      const rows = await importWithEnvelope(
        dir,
        db,
        "session-11310-under-cap",
        JSON.stringify({
          review_id: "review-11310-under",
          verified: [
            { reviewer: "auditor", verifier_verdict: "CONFIRMED" },
            { reviewer: "auditor", verifier_verdict: "CONFIRMED" },
          ],
          rejected: [{ reviewer: "auditor", verifier_verdict: "REJECTED" }],
          pending_verification: Array.from(
            { length: CODE_REVIEW_FINDINGS_FOLD_BUDGET - 3 },
            () => 0
          ),
        })
      );
      const worker = rows.find(
        (row) => row.component_key === WORKER_COMPONENT_KEY
      );
      assert.ok(worker, "the candidate must persist");
      assert.equal(Number(worker.findings_emitted), 3);
      assert.equal(Number(worker.findings_invalidated), 1);
      /* And the disclosure is NOT unconditional decoration: an uncapped run
         says nothing about a cap it never hit. */
      assert.deepEqual(
        logged.filter((message) =>
          message.includes(`${CODE_REVIEW_FINDINGS_FOLD_BUDGET}-finding`)
        ),
        []
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an envelope past the size gate persists the candidate unattributed rather than parsing it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss11238-oversize-"));
    const logged: string[] = [];
    const db = await openDb(dir, (message) => logged.push(message));
    try {
      /* VALID JSON that would attribute a real funnel if it were read — padded
         past the 8 MiB gate. Invalid JSON would fail the parse either way and
         the case would stay green with the gate deleted. */
      const rows = await importWithEnvelope(
        dir,
        db,
        "session-11238-oversize",
        envelopeWithConfirmedCount("auditor", 2, "p".repeat(9 * 1024 * 1024))
      );
      const worker = rows.find(
        (row) => row.component_key === WORKER_COMPONENT_KEY
      );
      assert.ok(worker, "the candidate must persist past an oversize envelope");
      assert.equal(worker.findings_emitted, null);
      assert.equal(worker.findings_invalidated, null);
      /* AC3: the row is null/null here and null/null for a count-capped run, so
         the two states are told apart by their DISCLOSURE and nowhere else
         (tamsinb on #7993). Pinned in both directions on the same locator: the
         byte gate says bytes, and it must not borrow the count gate's sentence
         for a run that never reached the fold at all. */
      const byteDisclosure = logged.filter((message) =>
        message.includes("bytes and were not parsed")
      );
      assert.equal(byteDisclosure.length, 1, logged.join("\n"));
      assert.ok(
        (byteDisclosure[0] ?? "").includes(
          "absent, not zero and not truncated"
        ),
        byteDisclosure[0]
      );
      assert.deepEqual(
        logged.filter((message) =>
          message.includes(`${CODE_REVIEW_FINDINGS_FOLD_BUDGET}-finding`)
        ),
        []
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
