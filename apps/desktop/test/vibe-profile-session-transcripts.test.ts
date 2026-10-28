import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type VibeCorpusTimeMap,
  vibeCorpusTimeMapPath,
} from "@repo/api/src/vibe-seed-corpus-time";
import { vibeCorpusTranscriptText } from "@repo/api/src/vibe-seed-corpus-transcript";
import { afterEach, describe, it } from "vitest";
import { writeSeededTranscripts } from "../scripts/vibe-profile/write-session-transcripts";
import { ACTIVITY_CLASSIFIER_VERSION } from "../src/main/collectors/parsing/activity-segment-classifier.js";
import { EXTRACTOR_VERSION } from "../src/main/collectors/parsing/artifact-ref-extractor-version.js";
import {
  openSqliteAgentDatabase,
  type SqliteAgentDatabase,
} from "../src/main/database/sqlite.js";
import {
  TRANSCRIPT_MAIN_FILE_KEY,
  TranscriptSourceHarness,
} from "../src/main/transcript-sync/transcript-sync-types.js";

/**
 * ISS-12135 bug 55: a vibe profile's transcript sync rows named files nobody
 * wrote, so Desktop's local trace refused every corpus session.
 */

const TIME_MAP: VibeCorpusTimeMap = {
  shiftMs: 3_600_000,
  importStartedAt: "2026-10-07T00:00:00.000Z",
  idleGaps: [],
};
const RAW = `{"timestamp":"2026-08-01T10:00:00.000Z","cwd":"closedloop-ai/closedloop-ai"}\n`;
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("writeSeededTranscripts", () => {
  it("writes each sourced row's transcript where the row says it lives, records it as unchanged for the boot passes, and drops a row with no corpus file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vibe-transcripts-"));
    dirs.push(dir);
    const storePath = path.join(dir, "store");
    const corpusDir = path.join(dir, "corpus");
    const claudePath = path.join(
      dir,
      "CLAUDE_HOME/projects/vibe/claude-1.jsonl"
    );
    const codexPath = path.join(
      dir,
      "CODEX_HOME/sessions/rollout-codex-1.jsonl"
    );
    const orphanPath = path.join(dir, "CLAUDE_HOME/projects/vibe/orphan.jsonl");
    corpusFile(corpusDir, "claude-1", "claude-1.jsonl");
    corpusFile(
      corpusDir,
      "codex-1",
      "rollout-2026-08-01T10-00-00-codex-1.jsonl"
    );

    const db = await openSqliteAgentDatabase({
      dataDir: storePath,
      detectBillingMode: () => "api",
    });
    try {
      for (const [id, harness, sourcePath] of [
        ["claude-1", TranscriptSourceHarness.Claude, claudePath],
        ["codex-1", TranscriptSourceHarness.Codex, codexPath],
        ["orphan", TranscriptSourceHarness.Claude, orphanPath],
      ] as const) {
        await db.prisma.write((client) =>
          client.transcriptSyncState.create({
            data: {
              externalSessionId: id,
              fileKey: TRANSCRIPT_MAIN_FILE_KEY,
              sourceHarness: harness,
              sourcePath,
              sourcePathHash: id,
              createdAt: TIME_MAP.importStartedAt,
              updatedAt: TIME_MAP.importStartedAt,
            },
          })
        );
      }
      // codex-1 is imported with no markers, as the link pass leaves a session
      // whose repo never resolves; claude-1 and other carry the build's.
      await seedSessions(db, ["claude-1", "codex-1", "other"]);
      await seedBackfillMarkers(db, ["claude-1", "other"]);
    } finally {
      await db.close();
    }
    writeFileSync(vibeCorpusTimeMapPath(storePath), JSON.stringify(TIME_MAP));

    const result = await writeSeededTranscripts(storePath, corpusDir, () => {
      // quiet
    });

    assert.deepEqual(result, { written: 2, dropped: 1 });
    const expected = vibeCorpusTranscriptText(RAW, TIME_MAP);
    assert.notEqual(expected, RAW);
    assert.equal(readFileSync(claudePath, "utf8"), expected);
    assert.equal(readFileSync(codexPath, "utf8"), expected);
    assert.equal(existsSync(orphanPath), false);
    const reopened = await openSqliteAgentDatabase({
      dataDir: storePath,
      detectBillingMode: () => "api",
    });
    try {
      const rows = await reopened.prisma.client.transcriptSyncState.findMany({
        select: { externalSessionId: true },
        orderBy: { externalSessionId: "asc" },
      });
      assert.deepEqual(
        rows.map((row) => row.externalSessionId),
        ["claude-1", "codex-1"]
      );
      assert.deepEqual(await readCatchupCache(reopened, "claude"), {
        [claudePath]: fingerprint(claudePath),
      });
      assert.deepEqual(await readCatchupCache(reopened, "codex"), {
        [codexPath]: fingerprint(codexPath),
      });
      const expectedMarkers = [
        {
          sessionId: "claude-1",
          filePath: claudePath,
          fileMtimeMs: mtime(claudePath),
        },
        {
          sessionId: "codex-1",
          filePath: codexPath,
          fileMtimeMs: mtime(codexPath),
        },
        { sessionId: "other", filePath: STALE_PATH, fileMtimeMs: STALE_MTIME },
      ];
      const orderBy = { sessionId: "asc" } as const;
      assert.deepEqual(
        await reopened.prisma.client.artifactLinkBackfillSeen.findMany({
          select: {
            sessionId: true,
            filePath: true,
            fileMtimeMs: true,
            extractorVersion: true,
          },
          orderBy,
        }),
        expectedMarkers.map((marker) => ({
          ...marker,
          extractorVersion: EXTRACTOR_VERSION,
        }))
      );
      assert.deepEqual(
        await reopened.prisma.client.activitySegmentBackfillSeen.findMany({
          select: {
            sessionId: true,
            filePath: true,
            fileMtimeMs: true,
            classifierVersion: true,
          },
          orderBy,
        }),
        expectedMarkers.map((marker) => ({
          ...marker,
          classifierVersion: ACTIVITY_CLASSIFIER_VERSION,
        }))
      );
    } finally {
      await reopened.close();
    }
  });
});

function corpusFile(corpusDir: string, sessionId: string, name: string): void {
  const rawDir = path.join(corpusDir, sessionId, "raw");
  mkdirSync(rawDir, { recursive: true });
  writeFileSync(path.join(rawDir, name), RAW);
}

const STALE_PATH = "staging/stale.jsonl";
const STALE_MTIME = 1n;

async function seedSessions(
  db: SqliteAgentDatabase,
  sessionIds: readonly string[]
): Promise<void> {
  await db.prisma.write((client) =>
    client.session.createMany({ data: sessionIds.map((id) => ({ id })) })
  );
}

async function seedBackfillMarkers(
  db: SqliteAgentDatabase,
  sessionIds: readonly string[]
): Promise<void> {
  const markers = sessionIds.map((sessionId) => ({
    sessionId,
    filePath: STALE_PATH,
    fileMtimeMs: STALE_MTIME,
    scannedAt: TIME_MAP.importStartedAt,
  }));
  await db.prisma.write(async (client) => {
    await client.artifactLinkBackfillSeen.createMany({
      data: markers.map((marker) => ({
        ...marker,
        extractorVersion: EXTRACTOR_VERSION,
      })),
    });
    await client.activitySegmentBackfillSeen.createMany({
      data: markers.map((marker) => ({
        ...marker,
        classifierVersion: ACTIVITY_CLASSIFIER_VERSION,
      })),
    });
  });
}

async function readCatchupCache(
  db: SqliteAgentDatabase,
  cacheName: string
): Promise<unknown> {
  const row = await db.prisma.client.collectorIngestStore.findUnique({
    where: { storeKey: `catchup-cache:${cacheName}` },
  });
  return row === null ? null : JSON.parse(row.payload);
}

function fingerprint(filePath: string): { mtimeMs: number; size: number } {
  const stat = statSync(filePath);
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}

function mtime(filePath: string): bigint {
  return BigInt(Math.floor(statSync(filePath).mtimeMs));
}
