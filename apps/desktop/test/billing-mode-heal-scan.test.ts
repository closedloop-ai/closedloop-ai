/**
 * @file billing-mode-heal-scan.test.ts
 * @description ISS-5259 review follow-up. Pins the ONE property the behavioural
 * suite structurally cannot see: that the billing-mode heal's per-chunk read
 * plans as an index RANGE once it carries a keyset bound, not as a full index
 * scan.
 *
 * Why this needs its own, mechanical test: `billing-mode-heal.test.ts` proves
 * the SEMANTIC keyset property (a row re-opened behind the bound is not healed
 * again), and that assertion is green under a correct keyset AND under a broken
 * one. It is bookkeeping, not planning. SQLite decides the plan at PREPARE time,
 * before any parameter binds, so a keyset written as `($n IS NULL OR id > $n)`
 * — the shipped form of the first ISS-5259 revision — references no column the
 * planner can range over, degrades to a residual filter, and plans IDENTICALLY
 * to having no keyset at all. Every behavioural test stayed green while the
 * O(N^2) full-index restart the keyset exists to remove was still there.
 * `EXPLAIN QUERY PLAN` is the only honest witness.
 *
 * The statement under test is the production builder's own output — not a
 * paraphrase — so a future edit that reintroduces a non-sargable form fails
 * here.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { billingModeHealChunkSelectSql } from "../src/main/database/billing-mode-heal.js";
import { openTestDb } from "./agent-db-test-utils.js";

type QueryPlanRow = { detail: string };

const PASS_START = "2026-06-02T00:00:00.000Z";
const KEYSET_BOUND = "s-a";
const CHUNK_SIZE = 25;
const HARNESS = "copilot";

/** `SEARCH … (id>?)` — the planner is using `id` as a range constraint. */
const ID_RANGE_SEARCH_RE = /SEARCH .*\(id>\?\)/;
/** `SCAN …` — the planner is walking the whole index and filtering. */
const FULL_SCAN_RE = /\bSCAN\b/;

async function explain(
  db: Awaited<ReturnType<typeof openTestDb>>,
  sql: string,
  ...params: unknown[]
): Promise<string> {
  const rows = await db.prisma.client.$queryRawUnsafe<QueryPlanRow[]>(
    `EXPLAIN QUERY PLAN ${sql}`,
    ...params
  );
  return rows.map((row) => row.detail).join(" | ");
}

test("ISS-5259: the bounded chunk read plans as an id range, not a full scan", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "billing-heal-eqp-"));
  const db = await openTestDb(dir);
  try {
    const boundedPlan = await explain(
      db,
      billingModeHealChunkSelectSql(true),
      HARNESS,
      KEYSET_BOUND,
      PASS_START,
      CHUNK_SIZE
    );

    assert.match(
      boundedPlan,
      ID_RANGE_SEARCH_RE,
      `chunk 1+ must SEARCH by id range, got: ${boundedPlan}`
    );
    assert.doesNotMatch(
      boundedPlan,
      FULL_SCAN_RE,
      `chunk 1+ must not fall back to a full scan, got: ${boundedPlan}`
    );

    // The contrast that makes the assertion above non-vacuous: chunk 0 carries
    // no bound and legitimately scans, so `SEARCH` is genuinely earned by the
    // keyset term rather than by anything else in the predicate. This is also
    // the exact plan the broken `($n IS NULL OR id > $n)` form produced.
    const unboundedPlan = await explain(
      db,
      billingModeHealChunkSelectSql(false),
      HARNESS,
      PASS_START,
      CHUNK_SIZE
    );
    assert.match(
      unboundedPlan,
      FULL_SCAN_RE,
      `chunk 0 has no bound to range over, got: ${unboundedPlan}`
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
