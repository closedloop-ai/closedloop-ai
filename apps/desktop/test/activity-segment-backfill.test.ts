/**
 * @file activity-segment-backfill.test.ts
 * @description FEA-2267 backfill tests against a real libSQL store: a session is
 * re-tiled from its transcript; the mtime + version high-water mark skips an
 * unchanged, current scan; a stale classifier_version forces a full re-derive
 * (the version-bump path, FR-11); and a transcript whose session row does not
 * exist yet is skipped (left unseen) rather than tiled against a missing parent.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backfillActivitySegmentsFromTranscripts } from "../src/main/collectors/parsing/activity-segment-backfill.js";
import { ACTIVITY_CLASSIFIER_VERSION } from "../src/main/collectors/parsing/activity-segment-classifier.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { sweepExpiredSessions } from "../src/main/database/session-maintenance.js";
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
         VALUES ($1, $1, 'completed', '2026-06-07T00:00:00.000Z', '2026-06-07T00:25:00.000Z', 'claude')`,
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
           VALUES ('expired', 'expired', 'completed', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 'claude')`
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

    const deleted = await sweepExpiredSessions(
      prisma,
      "2026-06-29T00:00:00.000Z"
    );

    assert.ok(deleted >= 1, "the expired session was purged");
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
