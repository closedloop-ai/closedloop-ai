import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type VibeCorpusTimeMap,
  vibeCorpusTimeMapPath,
} from "@repo/api/src/vibe-seed-corpus-time";
import { vibeCorpusTranscriptText } from "@repo/api/src/vibe-seed-corpus-transcript";
import { afterEach, describe, expect, it } from "vitest";
import { writeSeededTranscripts } from "../scripts/vibe-profile/write-session-transcripts";
import {
  openSqliteAgentDatabase,
  type SqliteAgentDatabase,
} from "../src/main/database/sqlite.js";
import {
  TRANSCRIPT_MAIN_FILE_KEY,
  TranscriptSourceHarness,
} from "../src/main/transcript-sync/transcript-sync-types.js";

const TIME_MAP: VibeCorpusTimeMap = {
  shiftMs: 3_600_000,
  importStartedAt: "2026-10-07T00:00:00.000Z",
  idleGaps: [],
};
const RAW = `{"timestamp":"2026-08-01T10:00:00.000Z","cwd":"closedloop-ai/closedloop-ai"}\n`;
const OTHER_HARNESS = "cursor";
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

type Row = { id: string; harness: string; sourcePath: string };

async function buildStore(
  dir: string,
  rows: readonly Row[],
  sessionIds: readonly string[]
): Promise<string> {
  const storePath = path.join(dir, "store");
  const db = await openSqliteAgentDatabase({
    dataDir: storePath,
    detectBillingMode: () => "api",
  });
  try {
    for (const row of rows) {
      await db.prisma.write((client) =>
        client.transcriptSyncState.create({
          data: {
            externalSessionId: row.id,
            fileKey: TRANSCRIPT_MAIN_FILE_KEY,
            sourceHarness: row.harness,
            sourcePath: row.sourcePath,
            sourcePathHash: row.id,
            createdAt: TIME_MAP.importStartedAt,
            updatedAt: TIME_MAP.importStartedAt,
          },
        })
      );
    }
    if (sessionIds.length > 0) {
      await db.prisma.write((client) =>
        client.session.createMany({ data: sessionIds.map((id) => ({ id })) })
      );
    }
  } finally {
    await db.close();
  }
  writeFileSync(vibeCorpusTimeMapPath(storePath), JSON.stringify(TIME_MAP));
  return storePath;
}

function corpusFile(corpusDir: string, sessionId: string, name: string): void {
  const rawDir = path.join(corpusDir, sessionId, "raw");
  mkdirSync(rawDir, { recursive: true });
  writeFileSync(path.join(rawDir, name), RAW);
}

async function withStore<T>(
  storePath: string,
  read: (db: SqliteAgentDatabase) => Promise<T>
): Promise<T> {
  const db = await openSqliteAgentDatabase({
    dataDir: storePath,
    detectBillingMode: () => "api",
  });
  try {
    return await read(db);
  } finally {
    await db.close();
  }
}

describe("writeSeededTranscripts edge rows", () => {
  it("drops a row whose corpus raw dir holds no main transcript, writes an unimported or other-harness row without markers, and records only the harnesses that wrote", async () => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), "vibe-transcripts-12394-")
    );
    dirs.push(dir);
    const corpusDir = path.join(dir, "corpus");
    const imported = path.join(dir, "CLAUDE_HOME/projects/vibe/imported.jsonl");
    const unimported = path.join(
      dir,
      "CLAUDE_HOME/projects/vibe/unimported.jsonl"
    );
    const other = path.join(dir, "OTHER_HOME/other.jsonl");
    const unmatched = path.join(dir, "CLAUDE_HOME/projects/vibe/nomatch.jsonl");
    corpusFile(corpusDir, "imported", "imported.jsonl");
    corpusFile(corpusDir, "unimported", "unimported.jsonl");
    corpusFile(corpusDir, "other", "other.jsonl");
    corpusFile(corpusDir, "nomatch", "notes.txt");
    const storePath = await buildStore(
      dir,
      [
        {
          id: "imported",
          harness: TranscriptSourceHarness.Claude,
          sourcePath: imported,
        },
        {
          id: "unimported",
          harness: TranscriptSourceHarness.Claude,
          sourcePath: unimported,
        },
        { id: "other", harness: OTHER_HARNESS, sourcePath: other },
        {
          id: "nomatch",
          harness: TranscriptSourceHarness.Claude,
          sourcePath: unmatched,
        },
      ],
      ["imported", "other"]
    );

    const result = await writeSeededTranscripts(
      storePath,
      corpusDir,
      () => undefined
    );

    expect(result).toEqual({ written: 3, dropped: 1 });
    const expected = vibeCorpusTranscriptText(RAW, TIME_MAP);
    expect(readFileSync(imported, "utf8")).toBe(expected);
    expect(readFileSync(unimported, "utf8")).toBe(expected);
    expect(readFileSync(other, "utf8")).toBe(expected);
    expect(existsSync(unmatched)).toBe(false);
    await withStore(storePath, async (db) => {
      const rows = await db.prisma.client.transcriptSyncState.findMany({
        select: { externalSessionId: true },
        orderBy: { externalSessionId: "asc" },
      });
      expect(rows.map((row) => row.externalSessionId)).toEqual([
        "imported",
        "other",
        "unimported",
      ]);
      const caches = await db.prisma.client.collectorIngestStore.findMany({
        select: { storeKey: true, payload: true },
        orderBy: { storeKey: "asc" },
      });
      expect(caches.map((row) => row.storeKey)).toEqual([
        "catchup-cache:claude",
      ]);
      expect(
        Object.keys(JSON.parse(caches[0]?.payload ?? "{}")).sort()
      ).toEqual([imported, unimported].sort());
      const linkMarkers =
        await db.prisma.client.artifactLinkBackfillSeen.findMany({
          select: { sessionId: true },
        });
      const segmentMarkers =
        await db.prisma.client.activitySegmentBackfillSeen.findMany({
          select: { sessionId: true },
        });
      expect(linkMarkers).toEqual([{ sessionId: "imported" }]);
      expect(segmentMarkers).toEqual([{ sessionId: "imported" }]);
    });
  });

  it("keeps every row when each one has a corpus transcript", async () => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), "vibe-transcripts-12394-")
    );
    dirs.push(dir);
    const corpusDir = path.join(dir, "corpus");
    const target = path.join(dir, "CODEX_HOME/sessions/rollout-codex-1.jsonl");
    corpusFile(
      corpusDir,
      "codex-1",
      "rollout-2026-08-01T10-00-00-codex-1.jsonl"
    );
    const storePath = await buildStore(
      dir,
      [
        {
          id: "codex-1",
          harness: TranscriptSourceHarness.Codex,
          sourcePath: target,
        },
      ],
      []
    );

    const result = await writeSeededTranscripts(
      storePath,
      corpusDir,
      () => undefined
    );

    expect(result).toEqual({ written: 1, dropped: 0 });
    await withStore(storePath, async (db) => {
      expect(
        await db.prisma.client.transcriptSyncState.count({
          where: { fileKey: TRANSCRIPT_MAIN_FILE_KEY },
        })
      ).toBe(1);
    });
  });
});
