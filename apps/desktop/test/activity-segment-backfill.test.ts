/**
 * @file activity-segment-backfill.test.ts
 * @description FEA-2267 backfill tests against a real libSQL store: a session is
 * re-tiled from its transcript; the mtime + version high-water mark skips an
 * unchanged, current scan; a stale classifier_version forces a full re-derive
 * (the version-bump path, FR-11); and a transcript whose session row does not
 * exist yet is skipped (left unseen) rather than tiled against a missing parent.
 */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { backfillActivitySegmentsFromTranscripts } from "../src/main/collectors/parsing/activity-segment-backfill.js";
import { ACTIVITY_CLASSIFIER_VERSION } from "../src/main/collectors/parsing/activity-segment-classifier.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { sweepExpiredSessions } from "../src/main/database/session-maintenance.js";
import { createSqliteSessionSyncSource } from "../src/main/database/sync-source.js";
import { readActivityMetrics } from "../src/main/database/sync-source-rollup-reads.js";
import { makeSession } from "./normalized-session-test-utils.js";
import { openTestPrisma } from "./prisma-test-utils.js";

function sessionFixture(sessionId: string): NormalizedSession {
  return makeSession({
    sessionId,
    startedAt: "2026-06-07T00:00:00.000Z",
    endedAt: "2026-06-07T00:25:00.000Z",
    tokenSeries: [
      {
        timestamp: "2026-06-07T00:01:00.000Z",
        model: "claude-sonnet-4-5",
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
      },
      {
        timestamp: "2026-06-07T00:20:00.000Z",
        model: "claude-sonnet-4-5",
        input: 60,
        output: 30,
        cacheRead: 5,
        cacheWrite: 2,
      },
    ],
  });
}

async function insertSession(
  prisma: DesktopPrisma,
  sessionId: string
): Promise<void> {
  await prisma.write((client) =>
    client.$transaction((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
         VALUES ($1, $1, 'inactive', '2026-06-07T00:00:00.000Z', '2026-06-07T00:25:00.000Z', 'claude')`,
        sessionId
      )
    )
  );
}

async function countSegments(
  prisma: DesktopPrisma,
  sessionId: string
): Promise<number> {
  const rows = await prisma.client.$queryRawUnsafe<{ cnt: number | bigint }[]>(
    "SELECT COUNT(*) AS cnt FROM session_activity_segments WHERE session_id = $1",
    sessionId
  );
  return Number(rows[0]?.cnt ?? 0);
}

async function readMarker(
  prisma: DesktopPrisma,
  sessionId: string
): Promise<{ classifierVersion: number; mtime: number } | null> {
  const rows = await prisma.client.$queryRawUnsafe<
    { classifier_version: number; file_mtime_ms: number | bigint }[]
  >(
    "SELECT classifier_version, file_mtime_ms FROM activity_segment_backfill_seen WHERE session_id = $1",
    sessionId
  );
  const row = rows[0];
  return row
    ? {
        classifierVersion: Number(row.classifier_version),
        mtime: Number(row.file_mtime_ms),
      }
    : null;
}

async function readSessionUpdatedAt(
  prisma: DesktopPrisma,
  sessionId: string
): Promise<string> {
  const rows = await prisma.client.$queryRawUnsafe<{ updated_at: string }[]>(
    "SELECT updated_at FROM sessions WHERE id = $1",
    sessionId
  );
  return rows[0]?.updated_at ?? "";
}

function writeTranscript(dir: string, sessionId: string): string {
  const filePath = join(dir, `${sessionId}.jsonl`);
  writeFileSync(filePath, "{}\n");
  return filePath;
}

test("backfill tiles an imported session and records the version marker", async () => {
  const { prisma, close } = await openTestPrisma();
  const dir = mkdtempSync(join(tmpdir(), "fea2267-backfill-"));
  try {
    await insertSession(prisma, "bf-1");
    const filePath = writeTranscript(dir, "bf-1");

    const result = await backfillActivitySegmentsFromTranscripts(prisma, {
      listTranscriptFiles: () => [filePath],
      sessionIdFromPath: () => "bf-1",
      parseSessionFile: () => Promise.resolve(sessionFixture("bf-1")),
    });

    assert.equal(result.scanned, 1);
    assert.equal(result.captured, 1);
    assert.equal(result.errors, 0);
    assert.ok(
      (await countSegments(prisma, "bf-1")) >= 3,
      "idle session tiles into ≥3 segments"
    );
    const marker = await readMarker(prisma, "bf-1");
    assert.equal(marker?.classifierVersion, ACTIVITY_CLASSIFIER_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await close();
  }
});

test("FEA-3568: a re-tile bumps the session updated_at so the metadata sync lane re-enqueues it", async () => {
  const { prisma, close } = await openTestPrisma();
  const dir = mkdtempSync(join(tmpdir(), "fea3568-backfill-dirty-"));
  try {
    await insertSession(prisma, "bf-dirty");
    const before = await readSessionUpdatedAt(prisma, "bf-dirty");
    const filePath = writeTranscript(dir, "bf-dirty");

    const result = await backfillActivitySegmentsFromTranscripts(prisma, {
      listTranscriptFiles: () => [filePath],
      sessionIdFromPath: () => "bf-dirty",
      parseSessionFile: () => Promise.resolve(sessionFixture("bf-dirty")),
    });
    assert.equal(result.captured, 1);

    // The re-tile writes only segment rows, which don't touch the session row;
    // the FEA-3568 dirty-mark must advance updated_at so the incremental sync lane
    // (keyed on the updated_at watermark cursor) re-syncs the re-derived tiling to
    // the cloud. Without it a classifier-version bump never propagates.
    const after = await readSessionUpdatedAt(prisma, "bf-dirty");
    assert.ok(
      after > before,
      `expected updated_at to advance after re-tile (before=${before} after=${after})`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await close();
  }
});

test("mtime + version high-water mark skips an unchanged, current scan", async () => {
  const { prisma, close } = await openTestPrisma();
  const dir = mkdtempSync(join(tmpdir(), "fea2267-backfill-skip-"));
  try {
    await insertSession(prisma, "bf-skip");
    const filePath = writeTranscript(dir, "bf-skip");
    const options = {
      listTranscriptFiles: () => [filePath],
      sessionIdFromPath: () => "bf-skip",
      parseSessionFile: () => Promise.resolve(sessionFixture("bf-skip")),
    };

    const first = await backfillActivitySegmentsFromTranscripts(
      prisma,
      options
    );
    assert.equal(first.scanned, 1);

    // Same file (unchanged mtime), marker already at current version → skipped.
    const second = await backfillActivitySegmentsFromTranscripts(
      prisma,
      options
    );
    assert.equal(second.scanned, 0, "no re-parse when nothing changed");
    assert.equal(second.skipped, 1);
    assert.equal(second.captured, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await close();
  }
});

test("a stale classifier_version forces a full re-derive (version-bump path)", async () => {
  const { prisma, close } = await openTestPrisma();
  const dir = mkdtempSync(join(tmpdir(), "fea2267-backfill-bump-"));
  try {
    await insertSession(prisma, "bf-bump");
    const filePath = writeTranscript(dir, "bf-bump");
    const mtime = Math.floor(statSync(filePath).mtimeMs);

    // Simulate a marker written by an OLDER classifier version at the current
    // mtime: only the version is stale, so the mtime guard alone would skip it.
    await prisma.write((client) =>
      client.$transaction((tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO activity_segment_backfill_seen
             (session_id, file_path, file_mtime_ms, classifier_version, scanned_at)
           VALUES ($1, $2, $3, $4, '2026-06-07T00:00:00.000Z')`,
          "bf-bump",
          filePath,
          mtime,
          ACTIVITY_CLASSIFIER_VERSION - 1
        )
      )
    );

    const result = await backfillActivitySegmentsFromTranscripts(prisma, {
      listTranscriptFiles: () => [filePath],
      sessionIdFromPath: () => "bf-bump",
      parseSessionFile: () => Promise.resolve(sessionFixture("bf-bump")),
    });

    assert.equal(result.scanned, 1, "stale version is re-scanned, not skipped");
    assert.equal(result.captured, 1);
    assert.ok((await countSegments(prisma, "bf-bump")) >= 1);
    const marker = await readMarker(prisma, "bf-bump");
    assert.equal(
      marker?.classifierVersion,
      ACTIVITY_CLASSIFIER_VERSION,
      "marker advanced to the current version"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await close();
  }
});

test("skips a transcript whose session row does not exist yet", async () => {
  const { prisma, close } = await openTestPrisma();
  const dir = mkdtempSync(join(tmpdir(), "fea2267-backfill-missing-"));
  let parseCalls = 0;
  try {
    const filePath = writeTranscript(dir, "bf-missing");
    // sessions table is empty — no FK parent for the segments.
    const result = await backfillActivitySegmentsFromTranscripts(prisma, {
      listTranscriptFiles: () => [filePath],
      sessionIdFromPath: () => "bf-missing",
      parseSessionFile: () => {
        parseCalls += 1;
        return Promise.resolve(sessionFixture("bf-missing"));
      },
    });

    assert.equal(result.skipped, 1);
    assert.equal(result.scanned, 0);
    assert.equal(parseCalls, 0, "no parse for an unimported session");
    assert.equal(await countSegments(prisma, "bf-missing"), 0);
    assert.equal(
      await readMarker(prisma, "bf-missing"),
      null,
      "left unseen for retry"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await close();
  }
});

test("retention purge removes activity segments and the backfill marker", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // A terminal session well past the 90-day retention cutoff.
    await prisma.write((client) =>
      client.$transaction((tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO sessions (id, name, status, started_at, updated_at, last_activity_at, harness)
           VALUES ('expired', 'expired', 'inactive', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 'claude')`
        )
      )
    );
    await prisma.write((client) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO session_activity_segments
             (id, session_id, phase, start_ms, end_ms, confidence, evidence_layers, version, work_item_ref, observed_at)
           VALUES ('seg-expired', 'expired', 'other', 1000, 2000, 1, '[]', 1, NULL, '2020-01-01T00:00:00.000Z')`
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO activity_segment_backfill_seen
             (session_id, file_path, file_mtime_ms, classifier_version, scanned_at)
           VALUES ('expired', '/tmp/expired.jsonl', 1, 1, '2020-01-01T00:00:00.000Z')`
        );
      })
    );

    const { purged } = await sweepExpiredSessions(
      prisma,
      "2026-06-29T00:00:00.000Z"
    );

    assert.ok(purged >= 1, "the expired session was purged");
    assert.equal(
      await countSegments(prisma, "expired"),
      0,
      "activity segments are purged with the session (no orphan timing rows)"
    );
    const markerRows = await prisma.client.$queryRawUnsafe<
      { cnt: number | bigint }[]
    >(
      "SELECT COUNT(*) AS cnt FROM activity_segment_backfill_seen WHERE session_id = $1",
      "expired"
    );
    assert.equal(Number(markerRows[0]?.cnt ?? 0), 0, "backfill marker purged");
  } finally {
    await close();
  }
});

/**
 * ISS-11088 harness. A re-tile is two transactions: the segment write, then the
 * publish (rollup + seen marker + sync watermark). These helpers let a test
 * observe or fault the store exactly BETWEEN them — the interleaving the defect
 * lives in, which no end-state assertion can see.
 */
type WriteHooks = {
  /** Runs after the Nth `prisma.write` COMMITS (1 = the re-tile transaction). */
  afterWrite?: (call: number) => Promise<void>;
  /** Fails the Nth `prisma.write` instead of running it. */
  failWrite?: number;
};

function withWriteHooks(
  prisma: DesktopPrisma,
  hooks: WriteHooks
): DesktopPrisma {
  let calls = 0;
  return {
    client: prisma.client,
    async write(fn, token, opts) {
      calls += 1;
      if (hooks.failWrite === calls) {
        throw new Error("injected publish-transaction failure");
      }
      const value = await prisma.write(fn, token, opts);
      await hooks.afterWrite?.(calls);
      return value;
    },
    read: (fn) => prisma.read(fn),
    readWalProbeHealth: () => prisma.readWalProbeHealth(),
    readStorageExhaustionHealth: () => prisma.readStorageExhaustionHealth(),
    shrinkMemory: () => prisma.shrinkMemory(),
    disconnect: () => prisma.disconnect(),
  };
}

/**
 * What the metadata sync lane would upload right now. Both halves go through
 * production code rather than a copy of it: `listUpdatedSessionCursorRows` is
 * the real incremental cursor (including its PRD-536 E1 tied-top disjunct, with
 * this session in the observed set because the lane already uploaded it at
 * `sinceUpdatedAt`), and `readActivityMetrics` is the projection that fills the
 * payload's rollup field.
 */
async function hydrationProbe(
  prisma: DesktopPrisma,
  sessionId: string,
  sinceUpdatedAt: string
): Promise<{ advertised: boolean; segmentCount: number | null }> {
  const cursorRows = await createSqliteSessionSyncSource(
    prisma
  ).listUpdatedSessionCursorRows(sinceUpdatedAt, [sessionId]);
  const selected = cursorRows.filter((row) => row.id === sessionId);
  const rows = await prisma.read((client) =>
    readActivityMetrics(client, [sessionId])
  );
  const segmentCount = rows[0]?.segment_count;
  return {
    advertised: selected.length > 0,
    segmentCount: segmentCount == null ? null : Number(segmentCount),
  };
}

async function insertSessionAnalytics(
  prisma: DesktopPrisma,
  sessionId: string
): Promise<void> {
  await prisma.write((client) =>
    client.$transaction((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO session_analytics
           (session_id, started_at, started_day, status, harness, human_turns, agent_turns, runtime_ms, updated_at)
         VALUES ($1, '2026-06-07T00:00:00.000Z', '2026-06-07', 'inactive', 'claude', 2, 3, 1500000, '2026-06-07T00:25:00.000Z')`,
        sessionId
      )
    )
  );
}

/** A second tiling shape for the same session: more, differently-spaced spend. */
function retiledFixture(sessionId: string): NormalizedSession {
  return makeSession({
    sessionId,
    startedAt: "2026-06-07T00:00:00.000Z",
    endedAt: "2026-06-07T02:00:00.000Z",
    tokenSeries: [
      {
        timestamp: "2026-06-07T00:01:00.000Z",
        model: "claude-sonnet-4-5",
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
      },
      {
        timestamp: "2026-06-07T00:40:00.000Z",
        model: "claude-sonnet-4-5",
        input: 70,
        output: 40,
        cacheRead: 8,
        cacheWrite: 3,
      },
      {
        timestamp: "2026-06-07T01:20:00.000Z",
        model: "claude-sonnet-4-5",
        input: 90,
        output: 20,
        cacheRead: 4,
        cacheWrite: 1,
      },
      {
        timestamp: "2026-06-07T01:55:00.000Z",
        model: "claude-sonnet-4-5",
        input: 60,
        output: 30,
        cacheRead: 5,
        cacheWrite: 2,
      },
    ],
  });
}

async function readRollupSegmentCount(
  prisma: DesktopPrisma,
  sessionId: string
): Promise<number | null> {
  const rows = await prisma.client.$queryRawUnsafe<
    { segment_count: number | bigint }[]
  >(
    "SELECT segment_count FROM session_activity_metrics WHERE session_id = $1",
    sessionId
  );
  const value = rows[0]?.segment_count;
  return value == null ? null : Number(value);
}

/** Force a strictly-newer mtime so the high-water mark re-scans the transcript. */
function touchNewer(filePath: string): void {
  const next = new Date(statSync(filePath).mtimeMs + 5000);
  utimesSync(filePath, next, next);
}

test("ISS-11088: a hydration read served between the re-tile and the rollup commit never sees the session advertised with its pre-re-tile rollup", async () => {
  const { prisma, close } = await openTestPrisma();
  const dir = mkdtempSync(join(tmpdir(), "iss11088-interleave-"));
  try {
    await insertSession(prisma, "bf-race");
    await insertSessionAnalytics(prisma, "bf-race");
    const filePath = writeTranscript(dir, "bf-race");

    // First pass: the session is tiled, rolled up and published.
    await backfillActivitySegmentsFromTranscripts(prisma, {
      listTranscriptFiles: () => [filePath],
      sessionIdFromPath: () => "bf-race",
      parseSessionFile: () => Promise.resolve(sessionFixture("bf-race")),
    });
    const publishedRollup = await readRollupSegmentCount(prisma, "bf-race");
    assert.ok(
      publishedRollup !== null && publishedRollup > 0,
      "first pass published a rollup"
    );
    // Where a sync lane that has already uploaded this session leaves its cursor.
    const cursor = await readSessionUpdatedAt(prisma, "bf-race");

    // Second pass re-tiles to a DIFFERENT shape, with a hydration read served in
    // the gap between the two transactions.
    touchNewer(filePath);
    let gapObservation: {
      advertised: boolean;
      segmentCount: number | null;
    } | null = null;
    const hooked = withWriteHooks(prisma, {
      afterWrite: async (call) => {
        if (call === 1) {
          gapObservation = await hydrationProbe(prisma, "bf-race", cursor);
        }
      },
    });
    const result = await backfillActivitySegmentsFromTranscripts(hooked, {
      listTranscriptFiles: () => [filePath],
      sessionIdFromPath: () => "bf-race",
      parseSessionFile: () => Promise.resolve(retiledFixture("bf-race")),
    });
    assert.equal(result.captured, 1, "the second pass re-tiled the session");
    assert.equal(result.errors, 0);

    const retiledRollup = await readRollupSegmentCount(prisma, "bf-race");
    assert.notEqual(
      retiledRollup,
      publishedRollup,
      "the re-tile must actually change the rollup, or this test proves nothing"
    );

    const observed = gapObservation as {
      advertised: boolean;
      segmentCount: number | null;
    } | null;
    assert.ok(observed, "a hydration read was served between the transactions");
    // The ISS-11088 contract: the gap read never sees the OLD rollup beside the
    // NEW segments. Asserted on the ROLLUP itself rather than through the
    // "not advertised yet" escape, because an id already sitting on the sync
    // lane's incremental or backfill queue is hydrated WITHOUT re-consulting
    // `updated_at` (whitlockk on #7865) — for that entry path "not advertised" buys
    // nothing, and only the atomic segments+rollup commit holds.
    assert.equal(
      observed.segmentCount,
      retiledRollup,
      `gap read published a stale rollup: advertised=${observed.advertised} rollup=${observed.segmentCount} (old=${publishedRollup}, new=${retiledRollup})`
    );

    // And the watermark does advance once the rollup lands, so the corrected pair
    // is re-enqueued rather than stranded.
    const after = await readSessionUpdatedAt(prisma, "bf-race");
    assert.ok(
      after > cursor,
      `expected updated_at to advance (${cursor} -> ${after})`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await close();
  }
});

test("ISS-11088: a failed publish transaction keeps the committed re-tile and leaves it to be advertised on the next sweep", async () => {
  const { prisma, close } = await openTestPrisma();
  const dir = mkdtempSync(join(tmpdir(), "iss11088-publish-fail-"));
  try {
    await insertSession(prisma, "bf-fail");
    await insertSessionAnalytics(prisma, "bf-fail");
    const filePath = writeTranscript(dir, "bf-fail");

    await backfillActivitySegmentsFromTranscripts(prisma, {
      listTranscriptFiles: () => [filePath],
      sessionIdFromPath: () => "bf-fail",
      parseSessionFile: () => Promise.resolve(sessionFixture("bf-fail")),
    });
    const publishedRollup = await readRollupSegmentCount(prisma, "bf-fail");
    const cursor = await readSessionUpdatedAt(prisma, "bf-fail");
    const firstSegmentCount = await countSegments(prisma, "bf-fail");
    const firstMarker = await readMarker(prisma, "bf-fail");

    // Re-tile with the publish transaction (write #2) failing.
    touchNewer(filePath);
    const faulted = withWriteHooks(prisma, { failWrite: 2 });
    const failedRun = await backfillActivitySegmentsFromTranscripts(faulted, {
      listTranscriptFiles: () => [filePath],
      sessionIdFromPath: () => "bf-fail",
      parseSessionFile: () => Promise.resolve(retiledFixture("bf-fail")),
    });

    // Property 1 — the metrics failure did NOT roll the committed re-tile back.
    assert.equal(failedRun.captured, 1, "the re-tile committed");
    const retiledSegmentCount = await countSegments(prisma, "bf-fail");
    assert.notEqual(
      retiledSegmentCount,
      firstSegmentCount,
      "the new tiling is on disk"
    );
    // Property 2 — the rollup moved WITH the segments (it rides the re-tile
    // transaction since whitlockk's #7865 review), so the committed pair is
    // internally consistent even though the publish failed; and nothing
    // advertised the row, because the watermark rode the failed transaction.
    assert.notEqual(
      await readRollupSegmentCount(prisma, "bf-fail"),
      publishedRollup,
      "the rollup committed with the segments it summarises"
    );
    assert.equal(
      await readRollupSegmentCount(prisma, "bf-fail"),
      retiledSegmentCount,
      "and it summarises the NEW tiling, not the old one"
    );
    assert.equal(
      await readSessionUpdatedAt(prisma, "bf-fail"),
      cursor,
      "a re-tile whose publish failed is not advertised"
    );
    assert.equal(failedRun.errors, 1, "the failed publish is reported");

    // Property 3 — not stranded: the marker was not advanced either, so the very
    // next sweep re-tiles and retries the publish, with no classifier bump and no
    // dependency on the separate metrics boot backfill.
    assert.deepEqual(
      await readMarker(prisma, "bf-fail"),
      firstMarker,
      "the seen marker still holds the pre-re-tile mtime, so the high-water mark re-selects this transcript"
    );
    const retry = await backfillActivitySegmentsFromTranscripts(prisma, {
      listTranscriptFiles: () => [filePath],
      sessionIdFromPath: () => "bf-fail",
      parseSessionFile: () => Promise.resolve(retiledFixture("bf-fail")),
    });
    assert.equal(
      retry.scanned,
      1,
      "the next sweep re-scans rather than skipping"
    );
    assert.equal(retry.captured, 1);
    assert.equal(retry.errors, 0);
    const advertisedAt = await readSessionUpdatedAt(prisma, "bf-fail");
    assert.ok(
      advertisedAt > cursor,
      `expected the retry to advertise the session (${cursor} -> ${advertisedAt})`
    );
    assert.equal(
      await readRollupSegmentCount(prisma, "bf-fail"),
      retiledSegmentCount,
      "and to publish the post-re-tile rollup"
    );
    assert.equal(
      (await readMarker(prisma, "bf-fail"))?.classifierVersion,
      ACTIVITY_CLASSIFIER_VERSION
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await close();
  }
});

test("ISS-11088: a write that lands between the two transactions is not dragged backwards by the re-tile's watermark", async () => {
  const { prisma, close } = await openTestPrisma();
  const dir = mkdtempSync(join(tmpdir(), "iss11088-forward-"));
  try {
    await insertSession(prisma, "bf-forward");
    await insertSessionAnalytics(prisma, "bf-forward");
    const filePath = writeTranscript(dir, "bf-forward");

    // The publish transaction opens AFTER the re-tile committed, so an import
    // can move the row to a later stamp in that gap. A blind `SET updated_at`
    // would move it back below a cursor that has already read it.
    const interleavedStamp = "2099-01-01T00:00:00.000Z";
    const hooked = withWriteHooks(prisma, {
      afterWrite: async (call) => {
        if (call === 1) {
          await prisma.write((client) =>
            client.$transaction((tx) =>
              tx.$executeRawUnsafe(
                "UPDATE sessions SET updated_at = $1 WHERE id = $2",
                interleavedStamp,
                "bf-forward"
              )
            )
          );
        }
      },
    });

    const result = await backfillActivitySegmentsFromTranscripts(hooked, {
      listTranscriptFiles: () => [filePath],
      sessionIdFromPath: () => "bf-forward",
      parseSessionFile: () => Promise.resolve(sessionFixture("bf-forward")),
    });
    assert.equal(result.captured, 1);
    assert.equal(result.errors, 0);

    const after = await readSessionUpdatedAt(prisma, "bf-forward");
    assert.ok(
      after > interleavedStamp,
      `the watermark must advance PAST the interleaved write, not below it (interleaved=${interleavedStamp} after=${after})`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await close();
  }
});

test("ISS-11088: a watermark advance the column cannot represent is committed and reported, not retried forever", async () => {
  const { prisma, close } = await openTestPrisma();
  const dir = mkdtempSync(join(tmpdir(), "iss11088-decline-"));
  try {
    await insertSession(prisma, "bf-decline");
    await insertSessionAnalytics(prisma, "bf-decline");
    const filePath = writeTranscript(dir, "bf-decline");

    // The one value `toISOString` can express that has no orderable successor:
    // its millisecond-after leaves the four-digit-year form and would sort BELOW
    // it, so `advanceSessionSyncWatermark` declines the write without throwing.
    const ceiling = "9999-12-31T23:59:59.999Z";
    await prisma.write((client) =>
      client.$transaction((tx) =>
        tx.$executeRawUnsafe(
          "UPDATE sessions SET updated_at = $1 WHERE id = $2",
          ceiling,
          "bf-decline"
        )
      )
    );

    const result = await backfillActivitySegmentsFromTranscripts(prisma, {
      listTranscriptFiles: () => [filePath],
      sessionIdFromPath: () => "bf-decline",
      parseSessionFile: () => Promise.resolve(sessionFixture("bf-decline")),
    });

    // The re-tile is committed and kept, and its rollup committed with it, so the
    // stored pair is internally consistent.
    assert.equal(result.captured, 1);
    const segmentCount = await countSegments(prisma, "bf-decline");
    assert.ok(segmentCount >= 1);
    assert.equal(
      await readRollupSegmentCount(prisma, "bf-decline"),
      segmentCount,
      "the rollup summarises the committed tiling"
    );
    // The decline is reported, so the run does not call itself complete.
    assert.equal(result.errors, 1, "the declined advance is reported");
    // The column is unchanged: no representation of it sorts after the ceiling,
    // so nothing was written there.
    assert.equal(await readSessionUpdatedAt(prisma, "bf-decline"), ceiling);

    // BOUNDED (tamsinb on #7865). The decline is a pure function of the stored
    // `updated_at`, so a retry recomputes it: the marker is committed and the
    // NEXT sweep skips the session instead of re-parsing and re-tiling it
    // forever. This second sweep is the half the rollback contract never ran.
    assert.equal(
      (await readMarker(prisma, "bf-decline"))?.classifierVersion,
      ACTIVITY_CLASSIFIER_VERSION,
      "the seen marker is committed so the high-water mark bounds the sweep"
    );
    const second = await backfillActivitySegmentsFromTranscripts(prisma, {
      listTranscriptFiles: () => [filePath],
      sessionIdFromPath: () => "bf-decline",
      parseSessionFile: () =>
        Promise.reject(new Error("the second sweep must not re-parse")),
    });
    // `scanned` counts only what got past the high-water check, so a bounded
    // sweep is skipped=1 / scanned=0: the transcript was never re-parsed (the
    // injected parse would have rejected) and nothing was re-tiled.
    assert.equal(second.skipped, 1, "the second sweep skipped the transcript");
    assert.equal(second.scanned, 0, "without re-parsing it");
    assert.equal(second.captured, 0, "so it did not re-tile");
    assert.equal(second.errors, 0, "and reported no further work left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await close();
  }
});

test("ISS-11088: a re-tile published after the lane cursor moved mid-sweep is still selectable by that cursor", async () => {
  const { prisma, close } = await openTestPrisma();
  const dir = mkdtempSync(join(tmpdir(), "iss11088-stale-base-"));
  try {
    await insertSession(prisma, "bf-base");
    await insertSessionAnalytics(prisma, "bf-base");
    const filePath = writeTranscript(dir, "bf-base");

    // A version-bump full re-scan parses every transcript, which takes real time.
    // A live import stamping the wall clock in that window carries the metadata
    // sync lane's cursor PAST the pass's start, so a watermark derived from the
    // pass's base `now` lands below `updated_at > $1` and the re-tile is never
    // selected again (tamsinb on #7865). The parse is where that time is spent,
    // so the cursor is moved from inside it.
    let cursorAfterLiveImport = "";
    const result = await backfillActivitySegmentsFromTranscripts(prisma, {
      listTranscriptFiles: () => [filePath],
      sessionIdFromPath: () => "bf-base",
      parseSessionFile: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        cursorAfterLiveImport = new Date().toISOString();
        return sessionFixture("bf-base");
      },
    });
    assert.equal(result.captured, 1);
    assert.equal(result.errors, 0);
    assert.notEqual(cursorAfterLiveImport, "", "the parse ran");

    // Production cursor code, at the position the lane reached mid-sweep.
    const observed = await hydrationProbe(
      prisma,
      "bf-base",
      cursorAfterLiveImport
    );
    assert.ok(
      observed.advertised,
      `the re-tile must sit above a cursor that moved after the pass started (cursor=${cursorAfterLiveImport} updated_at=${await readSessionUpdatedAt(prisma, "bf-base")})`
    );
    // And it carries the rollup, so the selection is worth something.
    assert.equal(
      observed.segmentCount,
      await countSegments(prisma, "bf-base"),
      "the advertised session carries the post-re-tile rollup"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await close();
  }
});
