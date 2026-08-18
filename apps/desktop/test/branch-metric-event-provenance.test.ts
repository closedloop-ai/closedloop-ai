import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ArtifactRefRelation } from "@repo/api/src/types/session-artifact-link";
import { readCanonicalBranchMetricEventRows } from "../src/main/branch/branch-metric-event-read.js";
import {
  BranchMetricOutsideEventSide,
  createBranchMetricEventEvidenceMethods,
} from "../src/main/database/branch-metric-event-provenance.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { seeder, withAcDb } from "./branch-reads-ac-test-helpers.js";

describe("Desktop Branch metric outside-event provenance", () => {
  test("uses a parameterized, capped per-segment and per-side SQL aggregate", async () => {
    let capturedSql = "";
    let capturedParameters: unknown[] = [];
    const prisma = makePrisma((sql, parameters) => {
      capturedSql = sql;
      capturedParameters = parameters;
      return [];
    });

    await createBranchMetricEventEvidenceMethods(
      prisma
    ).readBranchMetricEventEvidence({
      bounds: { startIso: START_ISO, endIso: END_ISO },
      branchKeys: [{ repoFullName: "acme/web", branchName: "feature/x" }],
    });

    assert.deepEqual(capturedParameters, [
      "acme/web",
      "feature/x",
      START_ISO,
      END_ISO,
    ]);
    assert.match(capturedSql, ACTIVITY_SEGMENT_SOURCE_PATTERN);
    assert.match(capturedSql, ACTIVITY_SEGMENT_CAP_PATTERN);
    assert.match(capturedSql, STRICT_BEFORE_PATTERN);
    assert.match(capturedSql, STRICT_AFTER_PATTERN);
    assert.doesNotMatch(capturedSql, INCLUSIVE_AFTER_PATTERN);
    assert.match(capturedSql, DETERMINISTIC_SEGMENT_ORDER_PATTERN);
    assert.match(capturedSql, CORRELATED_SEGMENT_WINNER_PATTERN);
    assert.doesNotMatch(capturedSql, ROW_NUMBER_PATTERN);
    assert.match(capturedSql, PER_EVENT_MICRO_CENT_ROUND_PATTERN);
    assert.match(capturedSql, SEGMENT_SIDE_GROUP_PATTERN);
    assert.match(capturedSql, CANONICAL_ROUND_TRIP_PATTERN);
  });

  test("maps zero-cost presence and aggregate overflow signals without coercing them away", async () => {
    const prisma = makePrisma(() => [
      segmentRawRow(),
      {
        row_kind: "provenance",
        segment_id: "segment-1",
        session_id: "session-1",
        phase: "implement",
        start_ms: "100",
        end_ms: "200",
        confidence: 0.9,
        event_side: BranchMetricOutsideEventSide.After,
        representative_occurred_at: "2026-07-01T00:00:00.000Z",
        source_event_count: 2,
        valid_cost_event_count: 1,
        positive_cost_event_count: 0,
        invalid_cost_value_present: 0,
        cost_micro_cents: "0",
        input_tokens: "9007199254740992",
        output_tokens: "2",
        cache_read_tokens: "3",
        cache_write_tokens: "4",
        token_counts_invalid: 0,
        candidate_count: null,
      },
    ]);

    const { outsideProvenance } = await createBranchMetricEventEvidenceMethods(
      prisma
    ).readBranchMetricEventEvidence({ bounds: { endIso: END_ISO } });
    const [row] = outsideProvenance;

    assert.equal(row?.sourceEventCount, 2);
    assert.equal(row?.validCostEventCount, 1);
    assert.equal(row?.positiveCostEventCount, 0);
    assert.equal(row?.costMicroCents, 0);
    assert.equal(row?.inputTokens, 9_007_199_254_740_992);
    assert.equal(row?.tokenCountsInvalid, false);
  });

  test("aggregates only canonical outside events from the admitted exact cohort", async () => {
    await withAcDb(async (db) => {
      const seed = seeder(db);
      const selectedBranch = await seed.branch({ branch: "feature/x" });
      const excludedBranch = await seed.branch({ branch: "feature/y" });
      await seed.session("selected-session");
      await seed.session("excluded-session");
      await seed.link({
        session: "selected-session",
        artifactId: selectedBranch,
        method: "git_push",
        relation: ArtifactRefRelation.Created,
      });
      await seed.link({
        session: "excluded-session",
        artifactId: excludedBranch,
        method: "git_push",
        relation: ArtifactRefRelation.Created,
      });
      await insertSegment(
        db,
        "selected-segment",
        "selected-session",
        "implement",
        "2026-05-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z"
      );
      await insertSegment(
        db,
        "excluded-segment",
        "excluded-session",
        "review",
        "2026-05-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z"
      );

      await insertEvent(db, "selected-session", "2026-05-20T00:00:00.000Z", {
        cost: 0,
        input: 2,
        output: 1,
      });
      await insertEvent(db, "selected-session", START_ISO, {
        cost: 1,
        input: 100,
      });
      await insertEvent(db, "selected-session", END_ISO, {
        cost: 1,
        input: 100,
      });
      await insertEvent(db, "selected-session", "2026-07-05T00:00:00.000Z", {
        cost: 0.123_456_7,
        input: 3,
        output: 4,
        cacheRead: 5,
        cacheWrite: 6,
      });
      await insertEvent(db, "selected-session", "2026-07-06T00:00:00.000Z", {
        cost: -0.1,
        input: -5,
      });
      await insertEvent(db, "selected-session", "not-a-timestamp", {
        cost: 5,
        input: 500,
      });
      await insertEvent(db, "excluded-session", "2026-07-05T00:00:00.000Z", {
        cost: 9,
        input: 900,
      });

      const { outsideProvenance: rows } =
        await db.readBranchMetricEventEvidence({
          bounds: { startIso: START_ISO, endIso: END_ISO },
          branchKeys: [{ repoFullName: "acme/web", branchName: "feature/x" }],
        });
      assert.equal(rows.length, 2);
      const before = rows.find(
        (row) => row.side === BranchMetricOutsideEventSide.Before
      );
      const after = rows.find(
        (row) => row.side === BranchMetricOutsideEventSide.After
      );
      assert.deepEqual(before, {
        segmentId: "selected-segment",
        sessionId: "selected-session",
        phase: "implement",
        startMs: Date.parse("2026-05-01T00:00:00.000Z"),
        endMs: Date.parse("2026-08-01T00:00:00.000Z"),
        confidence: 1,
        side: BranchMetricOutsideEventSide.Before,
        representativeOccurredAt: "2026-05-20T00:00:00.000Z",
        sourceEventCount: 1,
        validCostEventCount: 1,
        positiveCostEventCount: 0,
        invalidCostValuePresent: false,
        costMicroCents: 0,
        inputTokens: 2,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        tokenCountsInvalid: false,
      });
      assert.equal(after?.sourceEventCount, 2);
      assert.equal(after?.validCostEventCount, 1);
      assert.equal(after?.positiveCostEventCount, 1);
      assert.equal(after?.invalidCostValuePresent, true);
      assert.equal(after?.costMicroCents, 123_457);
      assert.equal(after?.inputTokens, 3);
      assert.equal(after?.outputTokens, 4);
      assert.equal(after?.cacheReadTokens, 5);
      assert.equal(after?.cacheWriteTokens, 6);
      assert.equal(after?.tokenCountsInvalid, true);

      const { outsideProvenance: allRows } =
        await db.readBranchMetricEventEvidence({
          bounds: { endIso: END_ISO },
          branchKeys: [{ repoFullName: "acme/web", branchName: "feature/x" }],
        });
      assert.deepEqual(
        allRows.map((row) => row.side),
        [BranchMetricOutsideEventSide.After]
      );
    });
  });

  test("distinguishes an outside known-zero cost from an unpriced null", async () => {
    await withSingleBranchSegment(async (db) => {
      await insertEvent(db, "selected-session", "2026-07-05T00:00:00.000Z", {
        cost: 0,
        input: 2,
      });
      await insertEvent(db, "selected-session", "2026-07-06T00:00:00.000Z", {
        cost: null,
        input: 3,
      });

      const { outsideProvenance } = await db.readBranchMetricEventEvidence({
        bounds: { endIso: END_ISO },
      });

      assert.equal(outsideProvenance[0]?.sourceEventCount, 2);
      assert.equal(outsideProvenance[0]?.validCostEventCount, 1);
      assert.equal(outsideProvenance[0]?.positiveCostEventCount, 0);
      assert.equal(outsideProvenance[0]?.invalidCostValuePresent, false);
      assert.equal(outsideProvenance[0]?.costMicroCents, 0);
    });
  });

  test("retains a valid token aggregate above the JavaScript safe-integer boundary", async () => {
    await withSingleBranchSegment(async (db) => {
      await insertEvent(db, "selected-session", "2026-07-05T00:00:00.000Z", {
        cost: 1,
        input: 5_000_000_000_000_000,
      });
      await insertEvent(db, "selected-session", "2026-07-06T00:00:00.000Z", {
        cost: 1,
        input: 5_000_000_000_000_000,
      });

      const { outsideProvenance } = await db.readBranchMetricEventEvidence({
        bounds: { endIso: END_ISO },
      });

      assert.equal(outsideProvenance[0]?.inputTokens, 10_000_000_000_000_000);
      assert.equal(outsideProvenance[0]?.tokenCountsInvalid, false);
    });
  });

  test("maps an event to one deterministic winner when admitted spans overlap", async () => {
    await withSingleBranchSegment(async (db) => {
      await insertSegment(
        db,
        "selected-segment-2",
        "selected-session",
        "review",
        "2026-05-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z"
      );
      await insertEvent(db, "selected-session", "2026-07-05T00:00:00.000Z", {
        cost: 1,
        input: 2,
      });

      const { outsideProvenance } = await db.readBranchMetricEventEvidence({
        bounds: { endIso: END_ISO },
      });

      assert.equal(
        outsideProvenance.reduce(
          (total, row) => total + row.sourceEventCount,
          0
        ),
        1
      );
      assert.equal(outsideProvenance[0]?.segmentId, "selected-segment");
    });
  });

  test("retains unsegmented events through the pinned boundary for a start-only request", async () => {
    await withAcDb(async (db) => {
      const seed = seeder(db);
      const branch = await seed.branch({ branch: "feature/x" });
      await seed.session("unsegmented-session");
      await seed.link({
        session: "unsegmented-session",
        artifactId: branch,
        method: "git_push",
        relation: ArtifactRefRelation.Created,
      });
      await insertEvent(db, "unsegmented-session", "2026-08-03T00:00:00.500Z", {
        cost: 1,
        input: 2,
      });
      await insertEvent(db, "unsegmented-session", "2026-08-03T00:00:01.500Z", {
        cost: 2,
        input: 3,
      });

      const result = await readCanonicalBranchMetricEventRows(
        db,
        { startDate: "2026-07-27T00:00:00.000Z" },
        new Date("2026-08-03T00:00:01.000Z")
      );

      assert.deepEqual(
        result.rows.map((row) => row.createdAt),
        ["2026-08-03T00:00:00.500Z"]
      );
    });
  });
});

async function withSingleBranchSegment(
  run: (db: Parameters<Parameters<typeof withAcDb>[0]>[0]) => Promise<void>
): Promise<void> {
  await withAcDb(async (db) => {
    const seed = seeder(db);
    const branch = await seed.branch({ branch: "feature/x" });
    await seed.session("selected-session");
    await seed.link({
      session: "selected-session",
      artifactId: branch,
      method: "git_push",
      relation: ArtifactRefRelation.Created,
    });
    await insertSegment(
      db,
      "selected-segment",
      "selected-session",
      "implement",
      "2026-05-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z"
    );
    await run(db);
  });
}

function makePrisma(
  query: (sql: string, parameters: unknown[]) => unknown[]
): DesktopPrisma {
  const client = {
    $queryRawUnsafe: (sql: string, ...parameters: unknown[]) =>
      Promise.resolve(query(sql, parameters)),
  };
  return {
    client,
    read: (read: (reader: typeof client) => Promise<unknown>) => read(client),
  } as unknown as DesktopPrisma;
}

function segmentRawRow() {
  return {
    row_kind: "segment",
    segment_id: "segment-1",
    session_id: "session-1",
    phase: "implement",
    start_ms: "100",
    end_ms: "200",
    confidence: 0.9,
    event_side: null,
    representative_occurred_at: null,
    source_event_count: null,
    valid_cost_event_count: null,
    positive_cost_event_count: null,
    invalid_cost_value_present: null,
    cost_micro_cents: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    token_counts_invalid: null,
    candidate_count: 1,
  };
}

async function insertSegment(
  db: Parameters<Parameters<typeof withAcDb>[0]>[0],
  id: string,
  sessionId: string,
  phase: string,
  startIso: string,
  endIso: string
): Promise<void> {
  await db.run(
    `INSERT INTO session_activity_segments
       (id, session_id, phase, start_ms, end_ms, confidence,
        evidence_layers, version, observed_at)
     VALUES ($1, $2, $3, $4, $5, 1, '[]', 1, $6)`,
    id,
    sessionId,
    phase,
    Date.parse(startIso),
    Date.parse(endIso),
    startIso
  );
}

async function insertEvent(
  db: Parameters<Parameters<typeof withAcDb>[0]>[0],
  sessionId: string,
  createdAt: string,
  values: {
    cost: number | null;
    input: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO token_events
       (session_id, model, created_at, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_usd_estimated)
     VALUES ($1, 'm1', $2, $3, $4, $5, $6, $7)`,
    sessionId,
    createdAt,
    values.input,
    values.output ?? 0,
    values.cacheRead ?? 0,
    values.cacheWrite ?? 0,
    values.cost
  );
}

const START_ISO = "2026-06-01T00:00:00.000Z";
const END_ISO = "2026-06-30T00:00:00.000Z";
const ACTIVITY_SEGMENT_SOURCE_PATTERN = /FROM session_activity_segments/;
const ACTIVITY_SEGMENT_CAP_PATTERN =
  /ORDER BY session_id ASC, start_ms ASC, id ASC\s+LIMIT 50001/;
const STRICT_BEFORE_PATTERN = /te\.created_at < metric_bounds\.start_iso/;
const STRICT_AFTER_PATTERN = /te\.created_at > metric_bounds\.end_iso/;
const INCLUSIVE_AFTER_PATTERN = /te\.created_at >= metric_bounds\.end_iso/;
const ROW_NUMBER_PATTERN = /ROW_NUMBER\(\) OVER/;
const DETERMINISTIC_SEGMENT_ORDER_PATTERN =
  /ORDER BY session_id ASC, start_ms ASC, id ASC/;
const CORRELATED_SEGMENT_WINNER_PATTERN =
  /segments\.id = \(\s+SELECT candidate\.id/;
const PER_EVENT_MICRO_CENT_ROUND_PATTERN =
  /ROUND\(cost_usd_estimated \* 1000000\)/;
const SEGMENT_SIDE_GROUP_PATTERN =
  /GROUP BY\s+segment_id, session_id, phase, start_ms, end_ms, confidence, event_side/;
const CANONICAL_ROUND_TRIP_PATTERN = /strftime\('%Y-%m-%dT%H:%M:%fZ'/;
