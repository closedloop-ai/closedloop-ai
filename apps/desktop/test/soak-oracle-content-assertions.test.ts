/**
 * @file soak-oracle-content-assertions.test.ts
 * @description Counterfactual coverage for what the mock cloud RETAINED of a
 * payload — ISS-6099, the oracle that never inspected payload CONTENT. The
 * ISS-6100 page-read and ISS-6098 baseline-membership cases live in
 * `soak-oracle-page-read-assertions.test.ts`; shared fixtures live in
 * `soak/soak-oracle-test-support.ts`.
 *
 * This is MEASUREMENT code, so every test here induces the failure the
 * assertion exists to catch and proves the oracle reports it. A soak battery
 * that goes green because its assertions cannot fire is worse than no battery —
 * and an assertion that fires on a legitimate retry is just as useless, so the
 * repeat/idempotency cases are driven in BOTH directions.
 *
 * The cases drive the REAL mock-cloud HTTP entry point
 * (`POST /desktop/agent-sessions/sync`) and the REAL read-back route, not the
 * accounting helpers in isolation, so deleting the wiring inside
 * `recordSyncBatch` would fail these tests rather than leave them green.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { AGENT_SESSION_SYNC_SCHEMA_VERSION } from "@repo/api/src/types/agent-session";
import {
  type MockCloudServer,
  READ_BACK_PATH,
  readBackFromCloud,
  startMockCloudServer,
} from "./soak/mock-cloud-server";
import {
  ContentViolationKind,
  MAX_TRACKED_CHUNK_SEQUENCES,
  READBACK_MAX_VIOLATIONS,
  READBACK_SAMPLE_MAX_BYTES,
  READBACK_SAMPLE_SESSIONS,
} from "./soak/soak-cloud-content";
import {
  buildRecord,
  COMPUTE_TARGET_ID,
  fetchReadBack,
  postBatch,
  postRawBatch,
  REQUIRED_RELATIONS,
  readBackEntry,
  readBackFixture,
  recordFor,
  sessionFixture,
  statsFixture,
  type TestSession,
} from "./soak/soak-oracle-test-support";

describe("ISS-6099: the mock cloud retains and reconciles payload CONTENT", () => {
  let mock: MockCloudServer;

  before(async () => {
    mock = await startMockCloudServer({ computeTargetId: COMPUTE_TARGET_ID });
  });

  after(async () => {
    await mock.close();
  });

  test("an unchunked delivery is retained with per-relation counts and returned by the read-back route", async () => {
    mock.resetStats();
    await postBatch(mock, [sessionFixture()]);

    const readBack = await fetchReadBack(mock);
    assert.equal(readBack.index.length, 1);
    const entry = readBack.index[0];
    assert.equal(entry.externalSessionId, "session-a");
    assert.equal(entry.relations.events, 2);
    assert.equal(entry.relations.agents, 1);
    assert.equal(entry.deliveries, 1);
    assert.ok(entry.contentDigest.length === 64);
    // The read-back sample carries real bodies, bounded.
    assert.equal(readBack.sample.length, 1);
    assert.ok(readBack.sampleBytes > 0);
  });

  test("COUNTERFACTUAL — a session delivered with its events relation dropped is retained as zero, not as a clean delivery", async () => {
    mock.resetStats();
    await postBatch(mock, [sessionFixture({ events: [] })]);

    const readBack = await fetchReadBack(mock);
    assert.equal(readBack.index[0].relations.events, 0);
    // Envelope bookkeeping is UNCHANGED — this is precisely the blindness the
    // ticket describes: the old oracle saw an identical clean delivery.
    assert.deepEqual(mock.stats().syncedSessionIds, ["session-a"]);
  });

  test("COUNTERFACTUAL — a payload missing a required schema field is recorded as a content violation", async () => {
    mock.resetStats();
    const broken = sessionFixture();
    // biome-ignore lint/performance/noDelete: the point is a genuinely absent key.
    delete broken.startedAt;
    await postBatch(mock, [broken]);

    const violations = mock.readBack;
    assert.ok(violations, "readBack accessor is exposed");
    const record = recordFor(mock.stats(), { readBackFrom: mock });
    assert.ok(
      record.content.violationSample.some((entry) =>
        entry.startsWith(ContentViolationKind.MissingRequiredField)
      ),
      `expected a missing-required-field violation, got ${JSON.stringify(record.content.violationSample)}`
    );
    assert.equal(record.invariants.contentIntact, false);
  });

  test("a chunked session assembles on CONTENT: relation counts sum across chunks", async () => {
    mock.resetStats();
    await postBatch(mock, [
      sessionFixture({
        externalSessionId: "chunked",
        events: [{ id: "e1" }],
        chunk: { index: 0, total: 2 },
      }),
    ]);
    await postBatch(
      mock,
      [
        sessionFixture({
          externalSessionId: "chunked",
          events: [{ id: "e2" }, { id: "e3" }],
          chunk: { index: 1, total: 2 },
        }),
      ],
      "batch-2"
    );

    const readBack = await fetchReadBack(mock);
    const entry = readBack.index.find(
      (row) => row.externalSessionId === "chunked"
    );
    assert.ok(entry, "the assembled session is in the read-back corpus");
    assert.equal(entry.relations.events, 3);
    assert.deepEqual(mock.stats().incompleteChunkSessions, []);
  });

  test("COUNTERFACTUAL — relations the producer REPLICATES onto every chunk are counted once, not multiplied by the chunk total", async () => {
    mock.resetStats();
    const total = 3;
    for (let index = 0; index < total; index++) {
      await postBatch(
        mock,
        [
          sessionFixture({
            externalSessionId: "replicated",
            // `chunkOversizedSession` partitions the event stream...
            events: [{ id: `e${index}` }],
            // ...and spreads the rest of the session into EVERY chunk. One
            // agent on a 3-chunk session is one agent, not three.
            agents: [{ id: "a1" }],
            tokenUsageByModel: [{ model: "sonnet" }],
            prs: [{ id: "pr1" }],
            chunk: { index, total },
          }),
        ],
        `batch-${index}`
      );
    }

    const readBack = await fetchReadBack(mock);
    const entry = readBack.index.find(
      (row) => row.externalSessionId === "replicated"
    );
    assert.ok(entry, "the assembled session is in the read-back corpus");
    assert.equal(entry.relations.agents, 1, "agents must not be multiplied");
    assert.equal(entry.relations.tokenUsageByModel, 1);
    assert.equal(entry.relations.prs, 1);
    // The partitioned stream is still summed — the fix must not flatten the
    // fields that genuinely do accumulate across chunks.
    assert.equal(entry.relations.events, total);
    const record = recordFor(mock.stats(), { readBackFrom: mock });
    assert.equal(record.invariants.contentIntact, true);
  });

  test("COUNTERFACTUAL — a replicated relation whose count CHANGES mid-sequence is reported", async () => {
    mock.resetStats();
    const total = 2;
    for (let index = 0; index < total; index++) {
      await postBatch(
        mock,
        [
          sessionFixture({
            externalSessionId: "replicated-divergent",
            events: [{ id: `e${index}` }],
            // The producer spreads the same session into every chunk, so a
            // count that changes underneath is a real inconsistency. Taking the
            // first value must not mean ignoring the disagreement.
            agents: index === 0 ? [{ id: "a1" }] : [{ id: "a1" }, { id: "a2" }],
            chunk: { index, total },
          }),
        ],
        `batch-${index}`
      );
    }

    const record = recordFor(mock.stats(), { readBackFrom: mock });
    assert.ok(
      record.content.violationSample.some((entry) =>
        entry.startsWith(ContentViolationKind.ReplicatedRelationDivergence)
      ),
      `expected a replicated-relation divergence, got ${JSON.stringify(record.content.violationSample)}`
    );
    assert.equal(record.invariants.contentIntact, false);
  });

  test("an appkill-shaped retry that re-sends already-acknowledged chunks IDENTICALLY is not a violation", async () => {
    mock.resetStats();
    const chunkZero = sessionFixture({
      externalSessionId: "retry-chunk",
      events: [{ id: "e1" }],
      chunk: { index: 0, total: 2 },
    });
    // Cycle 1: chunk 0 lands, then the app is killed mid-sequence.
    await postBatch(mock, [chunkZero], "batch-before-kill");
    // Cycle 2: the durable session is still queued, so the relaunched service
    // legitimately restarts the sequence at index 0 with the same content.
    await postBatch(mock, [chunkZero], "batch-after-relaunch");
    await postBatch(
      mock,
      [
        sessionFixture({
          externalSessionId: "retry-chunk",
          events: [{ id: "e2" }, { id: "e3" }],
          chunk: { index: 1, total: 2 },
        }),
      ],
      "batch-after-relaunch-2"
    );

    const record = recordFor(mock.stats(), { readBackFrom: mock });
    assert.deepEqual(
      record.content.violationSample.filter((entry) =>
        entry.startsWith(ContentViolationKind.ChunkDuplicateIndex)
      ),
      [],
      `an idempotent retry must not score as corruption, got ${JSON.stringify(record.content.violationSample)}`
    );
    assert.equal(record.invariants.contentIntact, true);
    // The sequence still assembles, and the replayed chunk is NOT counted twice
    // into the relation totals — suppressing the false positive must not
    // silently inflate the content it was suppressing.
    const readBack = await fetchReadBack(mock);
    const entry = readBack.index.find(
      (row) => row.externalSessionId === "retry-chunk"
    );
    assert.ok(entry, "the retried sequence still assembles");
    assert.equal(entry.relations.events, 3);
    assert.deepEqual(mock.stats().incompleteChunkSessions, []);
  });

  test("COUNTERFACTUAL — the same chunk index re-sent with DIFFERENT content is still reported", async () => {
    mock.resetStats();
    await postBatch(
      mock,
      [
        sessionFixture({
          externalSessionId: "dup-chunk",
          events: [{ id: "e1" }],
          chunk: { index: 0, total: 2 },
        }),
      ],
      "batch-0"
    );
    await postBatch(
      mock,
      [
        sessionFixture({
          externalSessionId: "dup-chunk",
          // Same index, content changed underneath: a real divergence, not a
          // retry. Tolerating repeats by index alone would lose exactly this.
          events: [{ id: "MUTATED" }],
          chunk: { index: 0, total: 2 },
        }),
      ],
      "batch-1"
    );

    const record = recordFor(mock.stats(), { readBackFrom: mock });
    assert.ok(
      record.content.violationSample.some((entry) =>
        entry.startsWith(ContentViolationKind.ChunkDuplicateIndex)
      ),
      `expected a duplicate-index violation, got ${JSON.stringify(record.content.violationSample)}`
    );
    assert.equal(record.invariants.contentIntact, false);
  });

  test("COUNTERFACTUAL — a chunk sequence whose declared total changes mid-flight is reported", async () => {
    mock.resetStats();
    await postBatch(mock, [
      sessionFixture({
        externalSessionId: "total-conflict",
        chunk: { index: 0, total: 3 },
      }),
    ]);
    await postBatch(
      mock,
      [
        sessionFixture({
          externalSessionId: "total-conflict",
          chunk: { index: 1, total: 2 },
        }),
      ],
      "batch-2"
    );

    const record = recordFor(mock.stats(), { readBackFrom: mock });
    assert.ok(
      record.content.violationSample.some((entry) =>
        entry.startsWith(ContentViolationKind.ChunkTotalConflict)
      ),
      `expected a total-conflict violation, got ${JSON.stringify(record.content.violationSample)}`
    );
  });

  test("COUNTERFACTUAL — a chunk index outside its declared total is reported", async () => {
    mock.resetStats();
    await postBatch(mock, [
      sessionFixture({
        externalSessionId: "out-of-range",
        chunk: { index: 5, total: 3 },
      }),
    ]);

    const record = recordFor(mock.stats(), { readBackFrom: mock });
    assert.ok(
      record.content.violationSample.some((entry) =>
        entry.startsWith(ContentViolationKind.ChunkIndexOutOfRange)
      ),
      `expected an out-of-range violation, got ${JSON.stringify(record.content.violationSample)}`
    );
  });

  test("COUNTERFACTUAL — the same session redelivered at the same dataRevision with different content diverges", async () => {
    mock.resetStats();
    await postBatch(mock, [sessionFixture({ externalSessionId: "diverge" })]);
    await postBatch(
      mock,
      [
        sessionFixture({
          externalSessionId: "diverge",
          // The strict-boundary trap: a retry re-emits the unit with a field gone.
          events: [{ id: "e1" }],
        }),
      ],
      "batch-2"
    );

    const record = recordFor(mock.stats(), { readBackFrom: mock });
    assert.ok(
      record.content.violationSample.some((entry) =>
        entry.startsWith(ContentViolationKind.DigestDivergence)
      ),
      `expected a digest-divergence violation, got ${JSON.stringify(record.content.violationSample)}`
    );
  });

  test("the read-back sample stays bounded well below the delivered corpus", async () => {
    mock.resetStats();
    const many = Array.from({ length: 60 }, (_value, index) =>
      sessionFixture({ externalSessionId: `bulk-${index}` })
    );
    await postBatch(mock, many);

    const readBack = await fetchReadBack(mock);
    // Every session is INDEXED (counts + digest, O(1) each)…
    assert.equal(readBack.index.length, 60);
    // …but only a bounded handful retain full bodies.
    assert.ok(
      readBack.sample.length <= 25,
      `sample retained ${readBack.sample.length} bodies`
    );
  });
});

describe("ISS-6099: read-back completeness is an invariant, not an assumption", () => {
  test("COUNTERFACTUAL — a failed read-back scores incomplete rather than clean", () => {
    const record = buildRecord({
      stats: statsFixture({ syncedSessionIds: ["session-a"] }),
      readBack: null,
    });
    assert.equal(record.invariants.readBackComplete, false);
    assert.ok(
      record.failReasons.some((reason) =>
        reason.startsWith("read_back_incomplete")
      ),
      JSON.stringify(record.failReasons)
    );
  });

  test("COUNTERFACTUAL — a failed read-back cannot report contentIntact, having examined no content", () => {
    const record = buildRecord({
      stats: statsFixture({ syncedSessionIds: ["session-a"] }),
      readBack: null,
    });
    // The mock still holds whatever it recorded; those violations just never
    // crossed the wire. Claiming the content was intact on the strength of
    // having looked at none of it is the vacuity this whole PR is about.
    assert.equal(record.invariants.contentIntact, false);
  });

  test("COUNTERFACTUAL — a failed read-back still emits a COMPLETE relationTotals shape, not `{}`", () => {
    const record = buildRecord({
      stats: statsFixture({ syncedSessionIds: ["session-a"] }),
      readBack: null,
    });
    // `{} as RelationCounts` satisfies the compiler and then serializes into the
    // JSONL row as `{}`, so every field the type promises reads back
    // `undefined`. A consumer summing `relationTotals.events` across cycles
    // would get NaN from a single failed read-back.
    assert.deepEqual(record.content.relationTotals, {
      events: 0,
      tokenEvents: 0,
      activitySegmentRows: 0,
      agents: 0,
      tokenUsageByModel: 0,
      activityBuckets: 0,
      prs: 0,
    });
  });

  test("a successful read-back totals every relation from that same complete shape", () => {
    const record = buildRecord({
      stats: statsFixture({ syncedSessionIds: ["session-a", "session-b"] }),
      readBack: readBackFixture([
        readBackEntry("session-a", { events: 2, agents: 1 }),
        readBackEntry("session-b", { events: 3, agents: 1 }),
      ]),
    });
    assert.equal(record.content.relationTotals.events, 5);
    assert.equal(record.content.relationTotals.agents, 2);
    // A relation no entry carried is a real zero, present in the shape.
    assert.equal(record.content.relationTotals.prs, 0);
  });

  test("COUNTERFACTUAL — a session counted as delivered but absent from the read-back corpus fails the cycle", () => {
    const record = buildRecord({
      stats: statsFixture({ syncedSessionIds: ["session-a", "session-b"] }),
      readBack: readBackFixture([readBackEntry("session-a")]),
    });
    assert.equal(record.invariants.readBackComplete, false);
    assert.equal(record.content.readBackSessions, 1);
    assert.ok(
      record.content.violationSample.some((entry) =>
        entry.includes("session-b")
      ),
      JSON.stringify(record.content.violationSample)
    );
  });

  test("COUNTERFACTUAL — a delivered session the local DB says has events, arriving with zero, is a relation drop", () => {
    const record = buildRecord({
      stats: statsFixture({ syncedSessionIds: ["session-a"] }),
      readBack: readBackFixture([readBackEntry("session-a", { events: 0 })]),
      localSessionsWithEvents: ["session-a"],
    });
    assert.deepEqual(record.content.relationDropSessions, ["session-a"]);
    assert.equal(record.invariants.contentIntact, false);
    assert.ok(
      record.failReasons.includes("relation_drop:1"),
      JSON.stringify(record.failReasons)
    );
  });

  test("the same session arriving WITH its events is clean — the cross-check is one-directional, so a producer cap cannot trip it", () => {
    const record = buildRecord({
      stats: statsFixture({ syncedSessionIds: ["session-a"] }),
      // A cap SHRINKS a relation; it never zeroes it. One row still passes.
      readBack: readBackFixture([readBackEntry("session-a", { events: 1 })]),
      localSessionsWithEvents: ["session-a"],
    });
    assert.deepEqual(record.content.relationDropSessions, []);
    assert.equal(record.invariants.contentIntact, true);
    assert.equal(record.invariants.readBackComplete, true);
  });
});

describe("ISS-6099: bounds and version skew are asserted, not assumed", () => {
  let mock: MockCloudServer;

  before(async () => {
    mock = await startMockCloudServer({ computeTargetId: COMPUTE_TARGET_ID });
  });

  after(async () => {
    await mock.close();
  });

  test("COUNTERFACTUAL — tracking more concurrent chunk sequences than the cap is reported, not silently tracked", async () => {
    mock.resetStats();
    // One chunk 0 of 2 per session: every sequence stays open.
    const overflowBy = 3;
    for (
      let batch = 0;
      batch < MAX_TRACKED_CHUNK_SEQUENCES + overflowBy;
      batch += 200
    ) {
      const sessions: TestSession[] = [];
      for (
        let index = batch;
        index < Math.min(batch + 200, MAX_TRACKED_CHUNK_SEQUENCES + overflowBy);
        index++
      ) {
        sessions.push(
          sessionFixture({
            externalSessionId: `overflow-${index}`,
            chunk: { index: 0, total: 2 },
          })
        );
      }
      await postBatch(mock, sessions, `batch-${batch}`);
    }

    const readBack = mock.readBack();
    const overflows = readBack.violations.filter(
      (violation) =>
        violation.kind === ContentViolationKind.ChunkTrackingOverflow
    );
    assert.equal(
      overflows.length,
      overflowBy,
      `expected ${overflowBy} overflow violations, got ${overflows.length}`
    );
  });

  test("COUNTERFACTUAL — a batch declaring an unexpected schemaVersion is RECORDED as a violation, not rejected", async () => {
    mock.resetStats();
    const response = await fetch(
      `${mock.apiOrigin}/desktop/agent-sessions/sync`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // A version-skewed client: the mock stays tolerant like the real cloud.
          schemaVersion: 99,
          batchId: "skewed",
          syncMode: "backfill",
          sessionCount: 1,
          sessions: [sessionFixture()],
        }),
      }
    );
    assert.equal(response.status, 200, "the skewed batch is still accepted");
    assert.deepEqual(mock.stats().unexpectedSchemaVersions, [99]);
    assert.equal(
      mock.stats().batchesMissingSchemaVersion,
      0,
      "a declared-but-wrong version is not counted as an absent one"
    );

    const record = recordFor(mock.stats(), { readBackFrom: mock });
    assert.ok(
      record.content.violationSample.some((entry) =>
        entry.startsWith(ContentViolationKind.SchemaVersionMismatch)
      ),
      `expected a schema-version violation, got ${JSON.stringify(record.content.violationSample)}`
    );
    assert.equal(record.invariants.contentIntact, false);
  });

  test("COUNTERFACTUAL — a batch that omits schemaVersion ENTIRELY is a violation, not a no-op", async () => {
    mock.resetStats();
    // The producer regression the numeric-mismatch check could never see: the
    // field is gone, so there is no number to compare. Production pins it with
    // `z.literal(AGENT_SESSION_SYNC_SCHEMA_VERSION)` and rejects this outright.
    const status = await postRawBatch(mock, {
      batchId: "no-schema-version",
      syncMode: "backfill",
      sessionCount: 1,
      sessions: [sessionFixture()],
    });
    assert.equal(status, 200, "the mock stays version-skew tolerant");
    assert.deepEqual(
      mock.stats().unexpectedSchemaVersions,
      [],
      "there is no numeric mismatch to record — which is why absence needs its own signal"
    );
    assert.equal(mock.stats().batchesMissingSchemaVersion, 1);

    const record = recordFor(mock.stats(), { readBackFrom: mock });
    assert.ok(
      record.content.violationSample.some((entry) =>
        entry.startsWith(ContentViolationKind.SchemaVersionMismatch)
      ),
      `expected a schema-version violation, got ${JSON.stringify(record.content.violationSample)}`
    );
    assert.equal(record.invariants.contentIntact, false);
  });

  test("COUNTERFACTUAL — a non-numeric schemaVersion is a violation, matching the z.literal production pins", async () => {
    mock.resetStats();
    const status = await postRawBatch(mock, {
      schemaVersion: String(AGENT_SESSION_SYNC_SCHEMA_VERSION),
      batchId: "stringly-schema-version",
      syncMode: "backfill",
      sessionCount: 1,
      sessions: [sessionFixture()],
    });
    assert.equal(status, 200);
    assert.equal(mock.stats().batchesMissingSchemaVersion, 1);

    const record = recordFor(mock.stats(), { readBackFrom: mock });
    assert.ok(
      record.content.violationSample.some((entry) =>
        entry.startsWith(ContentViolationKind.SchemaVersionMismatch)
      ),
      `expected a schema-version violation, got ${JSON.stringify(record.content.violationSample)}`
    );
  });

  test("COUNTERFACTUAL — a batch whose sessionCount disagrees with the sessions it carries is a violation", async () => {
    mock.resetStats();
    // Production refines this with `session_count_mismatch` and rejects the
    // batch. The mock ignored the field entirely and drained cleanly.
    const status = await postRawBatch(mock, {
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      batchId: "count-mismatch",
      syncMode: "backfill",
      sessionCount: 5,
      sessions: [sessionFixture()],
    });
    assert.equal(status, 200, "the mock stays tolerant and records instead");

    const record = recordFor(mock.stats(), { readBackFrom: mock });
    assert.ok(
      record.content.violationSample.some((entry) =>
        entry.startsWith(ContentViolationKind.SessionCountMismatch)
      ),
      `expected a session-count violation, got ${JSON.stringify(record.content.violationSample)}`
    );
    assert.equal(record.invariants.contentIntact, false);
  });

  test("COUNTERFACTUAL — a batch that omits sessionCount ENTIRELY is a violation", async () => {
    mock.resetStats();
    // `sessionCount` is a required `z.number().int().nonnegative()` upstream, so
    // absence is a rejection there, not a tolerated omission.
    const status = await postRawBatch(mock, {
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      batchId: "count-absent",
      syncMode: "backfill",
      sessions: [sessionFixture()],
    });
    assert.equal(status, 200);

    const record = recordFor(mock.stats(), { readBackFrom: mock });
    assert.ok(
      record.content.violationSample.some((entry) =>
        entry.startsWith(ContentViolationKind.SessionCountMismatch)
      ),
      `expected a session-count violation, got ${JSON.stringify(record.content.violationSample)}`
    );
  });

  test("a batch whose sessionCount matches its sessions scores clean", async () => {
    mock.resetStats();
    await postBatch(mock, [
      sessionFixture({ externalSessionId: "counted-a" }),
      sessionFixture({ externalSessionId: "counted-b" }),
    ]);

    const record = recordFor(mock.stats(), { readBackFrom: mock });
    assert.deepEqual(
      record.content.violationSample.filter((entry) =>
        entry.startsWith(ContentViolationKind.SessionCountMismatch)
      ),
      [],
      `a matching count must not be flagged, got ${JSON.stringify(record.content.violationSample)}`
    );
    assert.equal(record.invariants.contentIntact, true);
  });

  test("an EMPTY batch declaring sessionCount 0 is legitimate, not a mismatch", async () => {
    mock.resetStats();
    // The other direction for the absent-vs-zero pattern: 0 is a real count.
    const status = await postRawBatch(mock, {
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      batchId: "empty-batch",
      syncMode: "backfill",
      sessionCount: 0,
      sessions: [],
    });
    assert.equal(status, 200);

    const record = recordFor(mock.stats(), { readBackFrom: mock });
    assert.deepEqual(
      record.content.violationSample.filter((entry) =>
        entry.startsWith(ContentViolationKind.SessionCountMismatch)
      ),
      []
    );
  });

  test("a batch declaring the contract schemaVersion scores clean", async () => {
    mock.resetStats();
    await postBatch(mock, [sessionFixture()]);

    const stats = mock.stats();
    assert.deepEqual(stats.unexpectedSchemaVersions, []);
    assert.equal(stats.batchesMissingSchemaVersion, 0);
    const record = recordFor(stats, { readBackFrom: mock });
    assert.equal(record.invariants.contentIntact, true);
  });

  for (const relation of REQUIRED_RELATIONS) {
    test(`COUNTERFACTUAL — a payload with '${relation}' ABSENT is a violation`, async () => {
      mock.resetStats();
      const dropped = sessionFixture({
        agents: [{ id: "a1" }],
        events: [{ id: "e1" }],
        tokenUsageByModel: [{ model: "sonnet" }],
      });
      // biome-ignore lint/performance/noDelete: the point is a genuinely absent key.
      delete dropped[relation];
      await postBatch(mock, [dropped]);

      const record = recordFor(mock.stats(), { readBackFrom: mock });
      assert.ok(
        record.content.violationSample.some((entry) =>
          entry.startsWith(ContentViolationKind.MissingRequiredRelation)
        ),
        `expected a missing-required-relation violation for '${relation}', got ${JSON.stringify(record.content.violationSample)}`
      );
      assert.equal(record.invariants.contentIntact, false);
      // The envelope path is UNCHANGED — the mock still acknowledged and still
      // counts the session as delivered. That is precisely why the count-based
      // check could not see this: `countRelations` folds the absent key to 0,
      // which is indistinguishable from a legitimately empty array.
      assert.deepEqual(mock.stats().syncedSessionIds, ["session-a"]);
    });

    test(`a payload with '${relation}' PRESENT but empty is not a violation`, async () => {
      mock.resetStats();
      await postBatch(mock, [
        sessionFixture({
          agents: [{ id: "a1" }],
          events: [{ id: "e1" }],
          tokenUsageByModel: [{ model: "sonnet" }],
          [relation]: [],
        }),
      ]);

      const record = recordFor(mock.stats(), { readBackFrom: mock });
      assert.deepEqual(
        record.content.violationSample.filter((entry) =>
          entry.startsWith(ContentViolationKind.MissingRequiredRelation)
        ),
        [],
        `an empty '${relation}' is a legitimate session, got ${JSON.stringify(record.content.violationSample)}`
      );
      assert.equal(record.invariants.contentIntact, true);
    });
  }

  test("the optional relation arrays may be absent without scoring a violation", async () => {
    mock.resetStats();
    // `tokenEvents`, `activityBuckets`, `activitySegmentRows` and `prs` are
    // `.optional()`/`.nullish()` upstream, so their absence is contract-legal
    // and must NOT be swept into the required-relation check.
    const lean = sessionFixture({
      agents: [{ id: "a1" }],
      events: [{ id: "e1" }],
      tokenUsageByModel: [{ model: "sonnet" }],
    });
    // biome-ignore lint/performance/noDelete: a genuinely absent key is the point.
    delete lean.tokenEvents;
    await postBatch(mock, [lean]);

    const record = recordFor(mock.stats(), { readBackFrom: mock });
    assert.equal(record.invariants.contentIntact, true);
  });

  test("the read-back sample fills to exactly the cap and reports itself truncated", async () => {
    mock.resetStats();
    const many = Array.from(
      { length: READBACK_SAMPLE_SESSIONS + 20 },
      (_value, index) => sessionFixture({ externalSessionId: `bulk-${index}` })
    );
    await postBatch(mock, many);

    const readBack = mock.readBack();
    assert.equal(readBack.index.length, READBACK_SAMPLE_SESSIONS + 20);
    // Sampling ACTUALLY happened and stopped exactly at the cap — an upper
    // bound alone would also pass if sampling were broken and retained nothing.
    assert.equal(readBack.sample.length, READBACK_SAMPLE_SESSIONS);
    assert.equal(readBack.sampleTruncated, true);
    assert.ok(readBack.sampleBytes <= READBACK_SAMPLE_MAX_BYTES);
  });

  test("COUNTERFACTUAL — a non-2xx read-back returns null instead of throwing, so the cycle is still scored", async () => {
    const notes: string[] = [];
    const result = await readBackFromCloud(
      {
        apiOrigin: mock.apiOrigin,
        // A path the mock 404s: the real failure mode of a version-skewed mock.
        readBackPath: "/desktop/agent-sessions/no-such-readback",
      } as unknown as MockCloudServer,
      notes
    );
    assert.equal(result, null);
    assert.ok(
      notes.some((note) => note.startsWith("read-back failed: HTTP 404")),
      JSON.stringify(notes)
    );
  });

  test("COUNTERFACTUAL — an unreachable cloud returns null and notes the failure rather than hanging", async () => {
    const notes: string[] = [];
    const result = await readBackFromCloud(
      {
        // Port 1 is reserved and refuses immediately.
        apiOrigin: "http://127.0.0.1:1",
        readBackPath: READ_BACK_PATH,
      } as unknown as MockCloudServer,
      notes
    );
    assert.equal(result, null);
    assert.ok(
      notes.some((note) => note.startsWith("read-back failed:")),
      JSON.stringify(notes)
    );
  });

  test("COUNTERFACTUAL — a violation storm is capped as it is RECORDED, not just as it is serialized", async () => {
    mock.resetStats();
    // A retry storm records violations for the whole cycle. If the cap only
    // bound at serialization, every one of these would already be resident in
    // the mock's memory by the time the read-back trimmed the list.
    const storm = READBACK_MAX_VIOLATIONS + 60;
    for (let index = 0; index < storm; index += 20) {
      const batch: TestSession[] = [];
      for (let offset = 0; offset < Math.min(20, storm - index); offset++) {
        const broken = sessionFixture({
          externalSessionId: `storm-${index + offset}`,
        });
        // biome-ignore lint/performance/noDelete: the point is a genuinely absent key.
        delete broken.startedAt;
        batch.push(broken);
      }
      await postBatch(mock, batch, `storm-${index}`);
    }

    const readBack = mock.readBack();
    // Truncating the detail must not make the cycle look cleaner: the exact
    // total is still reported, and still fails the cycle.
    assert.equal(readBack.violationCount, storm);
    assert.ok(readBack.violations.length <= READBACK_MAX_VIOLATIONS);
    const record = recordFor(mock.stats(), { readBackFrom: mock });
    assert.equal(record.content.violationCount, storm);
    assert.equal(record.invariants.contentIntact, false);
  });

  test("COUNTERFACTUAL — a TRUNCATED violation list still reports the exact count", () => {
    // The read-back caps its violation list but always reports the true total.
    // Scoring must use the total, or a violation storm would look cleaner than
    // a handful of violations.
    const record = buildRecord({
      stats: statsFixture({ syncedSessionIds: ["session-a"] }),
      readBack: readBackFixture([readBackEntry("session-a")], {
        violations: [
          {
            externalSessionId: "session-a",
            kind: ContentViolationKind.DigestDivergence,
            detail: "sample of many",
          },
        ],
        violationCount: 617,
      }),
    });
    assert.equal(record.content.violationCount, 617);
    assert.ok(
      record.failReasons.includes("content_violations:617"),
      JSON.stringify(record.failReasons)
    );
  });

  test("COUNTERFACTUAL — a cycle that synced NOTHING does not score a vacuously complete read-back", () => {
    const record = buildRecord({
      stats: statsFixture({ syncedSessionIds: [] }),
      readBack: readBackFixture([]),
      baseline: [],
      localSessionIds: [],
    });
    // Nothing is "missing" from an empty set, so without the non-empty guard
    // this would report a complete read-back of a corpus that never moved.
    assert.equal(record.invariants.readBackComplete, false);
    assert.ok(
      record.failReasons.some((reason) =>
        reason.startsWith("read_back_incomplete")
      ),
      JSON.stringify(record.failReasons)
    );
  });
});
