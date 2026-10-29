/**
 * @file component-invocation-stored-projection.test.ts
 * @description ISS-10720: `readStoredInvocationRows`' SELECT must hand every
 * column back under its OWN name.
 *
 * WHY THIS EXISTS. Merging ISS-10720 into a `main` that had just taken
 * ISS-10725's findings funnel spliced the two sides' column TAILS together and
 * dropped the comma between them, so the projection read
 * `findings_invalidated  footprint_tokens` — valid SQL, in which
 * `findings_invalidated` is a bare ALIAS for `footprint_tokens`. The findings
 * count then came back on the wrong key, `storedFindingsFunnel` read
 * `undefined` and silently dropped the funnel from every sync item, and
 * `footprint_tokens` carried a confident wrong measurement.
 *
 * NOTHING CAUGHT IT. `tsc` could not: `StoredInvocationRow` still DECLARES
 * `findings_invalidated`, and a `$queryRawUnsafe` generic is an assertion, not
 * a check. The findings unit test builds `StoredInvocationRow` object literals
 * and never executes the SQL. The one test that did run this query asserted
 * only model/tokens/`usage_measurement` — neither of the two columns the splice
 * corrupted. So this case seeds a DISTINCT value per column and reads them all
 * back: an aliased column fails on the name it went missing from AND on the
 * name that swallowed it.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { readStoredInvocationRows } from "../src/main/database/component-invocation-sync-item.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const SESSION_ID = "iss10720-stored-projection";
const STAMP = "2026-09-26T00:00:00.000Z";

/* Deliberately all different, and none of them 0/1, so a column that lands on
   a neighbour's key is caught by the VALUE as well as by the name. */
const FOOTPRINT_TOKENS = 910n;
const FINDINGS_EMITTED = 920n;
const FINDINGS_INVALIDATED = 930n;

test("the stored projection returns every column under its own name", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await prisma.write((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO sessions (id, name, status, started_at, updated_at, harness, cwd)
         VALUES ($1, $1, 'inactive', $2, $2, 'claude', '/repo')`,
        SESSION_ID,
        STAMP
      )
    );
    await prisma.write((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO agent_component_invocations
           (id, session_id, external_invocation_id, component_kind, component_key,
            relationship, invoked_at, sequence, anchor_kind, anchor_value,
            attribution_status, evidence_class, footprint_tokens,
            usage_measurement, lines_added, lines_removed, succeeded,
            findings_emitted, findings_invalidated, attribution_source,
            created_at, updated_at)
         VALUES ($1, $2, $1, 'subagent', 'reviewer', 'direct', $3, 0, 'session',
                 $2, 'exact', 'transcript', $4, 'measured', 7, 3, 1, $5, $6,
                 'harnessOtel', $3, $3)`,
        `${SESSION_ID}-inv-0`,
        SESSION_ID,
        STAMP,
        FOOTPRINT_TOKENS,
        FINDINGS_EMITTED,
        FINDINGS_INVALIDATED
      )
    );

    const rows = await prisma.read((tx) =>
      readStoredInvocationRows(tx, SESSION_ID)
    );

    assert.equal(rows.length, 1);
    const row = rows[0];
    // The two the splice actually corrupted.
    assert.equal(BigInt(row.findings_invalidated ?? -1n), FINDINGS_INVALIDATED);
    assert.equal(BigInt(row.footprint_tokens ?? -1n), FOOTPRINT_TOKENS);
    // Their neighbours, so a shift of any width is caught rather than only the
    // one alias this file was written for.
    assert.equal(BigInt(row.findings_emitted ?? -1n), FINDINGS_EMITTED);
    assert.equal(row.usage_measurement, "measured");
    assert.equal(Number(row.lines_added), 7);
    assert.equal(Number(row.lines_removed), 3);
    assert.equal(row.attribution_source, "harnessOtel");
  } finally {
    await close();
  }
});
