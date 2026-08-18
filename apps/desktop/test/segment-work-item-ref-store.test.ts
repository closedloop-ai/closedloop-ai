/**
 * @file segment-work-item-ref-store.test.ts
 * @description FEA-2272 (PLN-1197) end-to-end store tests: the REAL importer and
 * both backfills stamp `session_activity_segments.work_item_ref` from a session's
 * persisted artifact links WITHOUT altering the tiling. Proves the core FR-9
 * contract (a linked and an unlinked session tile identically — only the optional
 * column differs), idempotency, stale-ref clearing on link re-derivation, and
 * re-stamping during the activity-segment backfill.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { backfillActivitySegmentsFromTranscripts } from "../src/main/collectors/parsing/activity-segment-backfill.js";
import { ACTIVITY_PHASE } from "../src/main/collectors/parsing/activity-taxonomy.js";
import { backfillArtifactLinksFromTranscripts } from "../src/main/collectors/parsing/artifact-link-backfill.js";
import type {
  NormalizedSession,
  NormalizedTokenRecord,
} from "../src/main/collectors/types.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { makeSession } from "./normalized-session-test-utils.js";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;
type SegmentRow = {
  id: string;
  phase: string;
  startMs: number;
  endMs: number;
  version: number;
  workItemRef: string | null;
};

function turn(timestamp: string, input: number): NormalizedTokenRecord {
  return {
    timestamp,
    model: "claude-sonnet-4-5",
    input,
    output: Math.round(input / 2),
    cacheRead: 10,
    cacheWrite: 5,
  };
}

/** A session with a 19-minute idle gap → tiles into ["other","idle","other"]. */
function gappedSession(
  sessionId: string,
  overrides: Partial<NormalizedSession> = {}
): NormalizedSession {
  return makeSession({
    sessionId,
    startedAt: "2026-06-07T00:00:00.000Z",
    endedAt: "2026-06-07T00:25:00.000Z",
    tokenSeries: [
      turn("2026-06-07T00:01:00.000Z", 100),
      turn("2026-06-07T00:20:00.000Z", 60),
    ],
    ...overrides,
  });
}

async function openDb(): Promise<{ db: Db; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2272-store-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });
  return {
    db,
    cleanup: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function readSegments(db: Db, sessionId: string): Promise<SegmentRow[]> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    {
      id: string;
      phase: string;
      start_ms: bigint | number;
      end_ms: bigint | number;
      version: number | bigint;
      work_item_ref: string | null;
    }[]
  >(
    `SELECT id, phase, start_ms, end_ms, version, work_item_ref
       FROM session_activity_segments WHERE session_id = $1 ORDER BY start_ms ASC`,
    sessionId
  );
  return rows.map((r) => ({
    id: r.id,
    phase: r.phase,
    startMs: Number(r.start_ms),
    endMs: Number(r.end_ms),
    version: Number(r.version),
    workItemRef: r.work_item_ref,
  }));
}

/**
 * The ref each segment is EXPECTED to carry for a session-level label: `value` on
 * every active segment, `null` on every idle one.
 *
 * FEA-4010 (AA-10) supersedes AC-006.3's "the detected slug labels every segment
 * (idle included)". The audit's complaint about this column quotes that criterion
 * verbatim — labelling a multi-hour gap asserts work that did not happen — and the
 * rule is about what a segment can honestly claim, not about how its label was
 * derived, so it binds the session-level fan-out exactly as it binds the
 * occurrence path. Geometry is untouched either way (PLN-1196): the idle segment
 * still exists, it just names no work item.
 */
function expectedRefs(
  segments: SegmentRow[],
  value: string | null
): (string | null)[] {
  return segments.map((s) => (s.phase === ACTIVITY_PHASE.Idle ? null : value));
}

/** The tiling shape only — phase + span, ignoring the optional ref column. */
function geometry(segments: SegmentRow[]): string[] {
  return segments.map((s) => `${s.phase}:${s.startMs}-${s.endMs}`);
}

async function readSessionUpdatedAt(
  db: Db,
  sessionId: string
): Promise<string> {
  const rows = await db.prisma.client.$queryRawUnsafe<{ updated_at: string }[]>(
    "SELECT updated_at FROM sessions WHERE id = $1",
    sessionId
  );
  return rows[0]?.updated_at ?? "";
}

async function writeDummyTranscript(sessionId: string): Promise<{
  filePath: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2272-transcript-"));
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  await writeFile(filePath, "{}\n");
  return {
    filePath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("FR-9: a linked and an unlinked session tile identically — only work_item_ref differs", async () => {
  const { db, cleanup } = await openDb();
  try {
    // Identical activity; one session's branch carries a ClosedLoop slug, the
    // other's does not. The slug link is the ONLY difference.
    await db.importer.importSession(
      gappedSession("wir-linked", { gitBranch: "feature/FEA-4242" }),
      "claude"
    );
    await db.importer.importSession(
      gappedSession("wir-unlinked", { gitBranch: "main" }),
      "claude"
    );

    const linked = await readSegments(db, "wir-linked");
    const unlinked = await readSegments(db, "wir-unlinked");

    assert.deepEqual(
      geometry(linked),
      geometry(unlinked),
      "segment count, order, and span boundaries are byte-for-byte identical"
    );
    assert.ok(unlinked.length >= 3, "the unlinked session still tiles fully");
    assert.deepEqual(
      unlinked.map((s) => s.workItemRef),
      unlinked.map(() => null),
      "AC-006.2: no artifact ⇒ every segment's work_item_ref is NULL"
    );
    assert.deepEqual(
      linked.map((s) => s.workItemRef),
      expectedRefs(linked, "FEA-4242"),
      "AC-006.3 as revised by AA-10: the slug labels every ACTIVE segment; idle claims nothing"
    );
    assert.ok(
      linked.some((s) => s.phase === ACTIVITY_PHASE.Idle),
      "precondition: this fixture must contain an idle segment for that to mean anything"
    );
  } finally {
    await cleanup();
  }
});

test("AC-006.5: re-import is idempotent — segment rows and refs are unchanged", async () => {
  const { db, cleanup } = await openDb();
  try {
    const session = gappedSession("wir-idem", { gitBranch: "feature/FEA-7" });
    await db.importer.importSession(session, "claude");
    const first = await readSegments(db, "wir-idem");
    await db.importer.importSession(session, "claude");
    const second = await readSegments(db, "wir-idem");

    assert.ok(first.length > 0, "segments were persisted");
    assert.deepEqual(second, first, "re-import reproduces identical rows");
    assert.ok(
      first.every(
        (s) =>
          s.workItemRef === (s.phase === ACTIVITY_PHASE.Idle ? null : "FEA-7")
      ),
      "the ref is present and stable"
    );
  } finally {
    await cleanup();
  }
});

test("AC-006.5: artifact-link re-derivation clears a stale ref back to NULL without moving a boundary", async () => {
  const { db, cleanup } = await openDb();
  const transcript = await writeDummyTranscript("wir-clear");
  try {
    await db.importer.importSession(
      gappedSession("wir-clear", { gitBranch: "feature/FEA-4242" }),
      "claude"
    );
    const before = await readSegments(db, "wir-clear");
    assert.ok(
      before.every(
        (s) =>
          s.workItemRef ===
          (s.phase === ACTIVITY_PHASE.Idle ? null : "FEA-4242")
      ),
      "precondition: the slug is stamped"
    );

    // Re-derive links from a transcript whose session no longer carries the slug
    // (branch is now `main`); the backfill DELETEs the slug link and re-stamps.
    await backfillArtifactLinksFromTranscripts(db.prisma, {
      listTranscriptFiles: () => [transcript.filePath],
      sessionIdFromPath: () => "wir-clear",
      parseSessionFile: () =>
        Promise.resolve(gappedSession("wir-clear", { gitBranch: "main" })),
    });

    const after = await readSegments(db, "wir-clear");
    assert.deepEqual(
      geometry(after),
      geometry(before),
      "segment geometry is untouched by the re-stamp"
    );
    assert.deepEqual(
      after.map((s) => s.workItemRef),
      after.map(() => null),
      "the removed slug clears work_item_ref back to NULL"
    );
  } finally {
    await transcript.cleanup();
    await cleanup();
  }
});

test("the activity-segment backfill re-stamps re-tiled segments from persisted links", async () => {
  const { db, cleanup } = await openDb();
  const transcript = await writeDummyTranscript("wir-restamp");
  try {
    // Import with no slug (branch `main`) → segments exist, work_item_ref NULL.
    await db.importer.importSession(
      gappedSession("wir-restamp", { gitBranch: "main" }),
      "claude"
    );
    const initial = await readSegments(db, "wir-restamp");
    assert.ok(
      initial.every((s) => s.workItemRef === null),
      "precondition: no ref before a link exists"
    );

    // Seed a ClosedLoop-slug link directly (as the artifact-link lane would).
    await db.prisma.write((client) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO artifacts (id, identity_key, kind, slug, created_at, last_seen_at)
           VALUES ('art-restamp', 'closedloop:FEA-99', 'closedloop_artifact', 'FEA-99',
                   '2026-06-07T00:00:00.000Z', '2026-06-07T00:00:00.000Z')`
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO session_artifact_links
             (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
           VALUES ('sal-restamp', 'wir-restamp', 'art-restamp', 'workspace', 'slug_in_branch', '{}', 1,
                   '2026-06-07T00:00:00.000Z', '2026-06-07T00:00:00.000Z')`
        );
      })
    );

    // A classifier-version bump re-tiles segments (work_item_ref → NULL); the
    // backfill must re-stamp them from the now-present link.
    const result = await backfillActivitySegmentsFromTranscripts(db.prisma, {
      listTranscriptFiles: () => [transcript.filePath],
      sessionIdFromPath: () => "wir-restamp",
      parseSessionFile: () =>
        Promise.resolve(gappedSession("wir-restamp", { gitBranch: "main" })),
    });

    assert.equal(result.captured, 1, "the session was re-tiled");
    const after = await readSegments(db, "wir-restamp");
    assert.deepEqual(
      geometry(after),
      geometry(initial),
      "re-tiling reproduces the same geometry"
    );
    assert.ok(
      after.length > 0 &&
        after.every(
          (s) =>
            s.workItemRef ===
            (s.phase === ACTIVITY_PHASE.Idle ? null : "FEA-99")
        ),
      "the seeded slug is stamped onto the re-tiled segments"
    );
  } finally {
    await transcript.cleanup();
    await cleanup();
  }
});

test("FEA-3568: an artifact-link re-derivation that CHANGES work_item_ref dirty-marks the session for cloud re-sync", async () => {
  const { db, cleanup } = await openDb();
  const transcript = await writeDummyTranscript("wir-dirty");
  try {
    await db.importer.importSession(
      gappedSession("wir-dirty", { gitBranch: "feature/FEA-4242" }),
      "claude"
    );
    const before = await readSessionUpdatedAt(db, "wir-dirty");
    assert.ok(
      (await readSegments(db, "wir-dirty")).every(
        (s) =>
          s.workItemRef ===
          (s.phase === ACTIVITY_PHASE.Idle ? null : "FEA-4242")
      ),
      "precondition: the slug is stamped"
    );

    // Re-derive links from a transcript that no longer carries the slug (branch is
    // now `main`): the backfill clears work_item_ref (FEA-4242 → NULL). Because
    // that ref rides the cloud sync wire and this path writes NO session row, the
    // fix must advance sessions.updated_at so the metadata sync lane re-enqueues
    // the session — otherwise the stale cloud ref would persist forever.
    await backfillArtifactLinksFromTranscripts(db.prisma, {
      listTranscriptFiles: () => [transcript.filePath],
      sessionIdFromPath: () => "wir-dirty",
      parseSessionFile: () =>
        Promise.resolve(gappedSession("wir-dirty", { gitBranch: "main" })),
    });

    assert.ok(
      (await readSegments(db, "wir-dirty")).every(
        (s) => s.workItemRef === null
      ),
      "the ref was actually cleared (the change that triggers the dirty-mark)"
    );
    const after = await readSessionUpdatedAt(db, "wir-dirty");
    assert.ok(
      after > before,
      `expected updated_at to advance after the ref changed (before=${before} after=${after})`
    );
  } finally {
    await transcript.cleanup();
    await cleanup();
  }
});

test("FEA-3568: a re-derivation that leaves work_item_ref UNCHANGED does not bump updated_at (no re-sync storm)", async () => {
  const { db, cleanup } = await openDb();
  const transcript = await writeDummyTranscript("wir-stable");
  try {
    await db.importer.importSession(
      gappedSession("wir-stable", { gitBranch: "feature/FEA-4242" }),
      "claude"
    );
    const before = await readSessionUpdatedAt(db, "wir-stable");

    // Re-derive from a transcript carrying the SAME slug: the stamp resolves the
    // identical FEA-4242 for every segment, so no ref actually changes. The
    // dirty-mark must NOT fire — otherwise every artifact-link re-scan would
    // needlessly re-enqueue unchanged sessions to the cloud.
    await backfillArtifactLinksFromTranscripts(db.prisma, {
      listTranscriptFiles: () => [transcript.filePath],
      sessionIdFromPath: () => "wir-stable",
      parseSessionFile: () =>
        Promise.resolve(
          gappedSession("wir-stable", { gitBranch: "feature/FEA-4242" })
        ),
    });

    assert.ok(
      (await readSegments(db, "wir-stable")).every(
        (s) =>
          s.workItemRef ===
          (s.phase === ACTIVITY_PHASE.Idle ? null : "FEA-4242")
      ),
      "precondition: the ref is unchanged by the re-derivation"
    );
    const after = await readSessionUpdatedAt(db, "wir-stable");
    assert.equal(after, before, "updated_at is untouched when no ref changed");
  } finally {
    await transcript.cleanup();
    await cleanup();
  }
});
