import assert from "node:assert/strict";
import { test } from "vitest";
import { getSharedBranchesPageData } from "../src/main/branch/shared-branches-api.js";
import { createBranchCanonicalActivityReadMethods } from "../src/main/database/branch-activity-read.js";
import { createBranchMetricEventEvidenceMethods } from "../src/main/database/branch-metric-event-provenance.js";
import {
  readDistinctBranchKeyRows,
  readLocalBranchLinkRows,
} from "../src/main/database/branch-reads.js";
import { BRANCH_WRITE_METHOD_VALUES } from "../src/main/database/db-constants.js";
import {
  type AcDb,
  seeder,
  spyOnBoundParameters,
  withAcDb,
} from "./branch-reads-ac-test-helpers.js";

/**
 * ISS-10324: the Branches page died on a real profile with
 * "The query parameter limit supported by your database is exceeded".
 *
 * The list reads selected nested relations. On SQLite, Prisma resolves a nested
 * select with a SECOND statement that binds one parameter per parent row, so the
 * bind count scaled with the corpus -- not with anything in the query text. Past
 * SQLITE_MAX_VARIABLE_NUMBER (999 on older builds) the read threw, and
 * `getSharedBranchesPageData` treats these reads as fatal, so the whole screen
 * lost its data instead of degrading.
 *
 * ROW COUNT ALONE CANNOT FAIL HERE (ISS-10324 review). The runtime these tests
 * run on carries the modern 32,766-variable ceiling, so the retired delegate
 * ALSO returns 1,200 rows -- a passing row-count assertion proves nothing about
 * the defect. What the fix actually guarantees is a parameter count that does
 * not scale at all, so every case below asserts the read binds ZERO host
 * parameters, which the delegate could never satisfy, and pairs it with the row
 * count as the positive control that the spy saw a real, non-empty read.
 */

/** Seed `count` branches, each written by its own session. */
async function seedWideBranchCorpus(db: AcDb, count: number): Promise<void> {
  const seed = seeder(db);
  for (let index = 0; index < count; index++) {
    const sessionId = `session-wide-${index}`;
    await seed.session(sessionId);
    const artifactId = await seed.branch({
      branch: `feature/bind-limit-${index}`,
      firstPushedAt: "2026-06-01T00:00:00.000Z",
    });
    await seed.link({
      session: sessionId,
      artifactId,
      method: BRANCH_WRITE_METHOD_VALUES[0],
    });
  }
}

// Comfortably past the 999 floor so the failure is the limit, not the edge.
const WIDE_BRANCH_COUNT = 1200;

test("the list link read binds no host parameters at any corpus width", async () => {
  await withAcDb(async (db) => {
    await seedWideBranchCorpus(db, WIDE_BRANCH_COUNT);
    const spy = spyOnBoundParameters(db.prisma);

    const rows = await readLocalBranchLinkRows(spy.prisma);

    assert.equal(rows.length, WIDE_BRANCH_COUNT);
    assert.ok(
      spy.boundParameterCounts.length > 0,
      "the spy must have observed the read"
    );
    assert.deepEqual(
      spy.boundParameterCounts.filter((count) => count !== 0),
      []
    );
  });
});

test("the distinct-key read binds no host parameters at any corpus width", async () => {
  await withAcDb(async (db) => {
    await seedWideBranchCorpus(db, WIDE_BRANCH_COUNT);
    const spy = spyOnBoundParameters(db.prisma);

    const keys = await readDistinctBranchKeyRows(spy.prisma);

    assert.equal(keys.length, WIDE_BRANCH_COUNT);
    assert.ok(
      spy.boundParameterCounts.length > 0,
      "the spy must have observed the read"
    );
    assert.deepEqual(
      spy.boundParameterCounts.filter((count) => count !== 0),
      []
    );
  });
});

/**
 * The reads above are the unit; this is the SERVING path that actually broke
 * (ISS-10324 review). `getSharedBranchesPageData` treats a list-source read
 * failure as fatal, so a bind overflow there is not a degraded row -- it is the
 * whole screen losing its data. Driving the real op against the same wide
 * corpus proves the page still renders rows rather than an error.
 */
test("the Branches page data read survives a corpus past the bind limit", async () => {
  await withAcDb(async (db) => {
    await seedWideBranchCorpus(db, WIDE_BRANCH_COUNT);
    const source = {
      prisma: db.prisma,
      ...createBranchCanonicalActivityReadMethods(db.prisma),
      ...createBranchMetricEventEvidenceMethods(db.prisma),
    };

    const page = await getSharedBranchesPageData(source, {});

    assert.ok(
      page.list.items.length > 0,
      "the wide corpus must still render branch rows"
    );
    // The page is bounded, the COUNT is not: `total` must still report the
    // whole corpus, not the size of the page that came back. A bound that
    // silently truncates the total is the same class of defect as the read
    // that threw -- the number is computable either way.
    assert.equal(page.list.total, WIDE_BRANCH_COUNT);
  });
});
