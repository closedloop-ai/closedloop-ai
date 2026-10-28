import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type VibeCorpusTimeMap,
  vibeCorpusTimeMapPath,
  vibeCorpusTimeMapSchema,
} from "@repo/api/src/vibe-seed-corpus-time";
import {
  pickVibeCorpusMainTranscript,
  vibeCorpusTranscriptText,
} from "@repo/api/src/vibe-seed-corpus-transcript";
import { sessionIdFromTranscriptPath } from "../../src/main/collectors/claude/claude-home.js";
import { sessionIdFromRolloutPath } from "../../src/main/collectors/codex/codex-home.js";
import { createCatchupCache } from "../../src/main/collectors/engine/catchup-cache.js";
import type { IngestStorePort } from "../../src/main/collectors/engine/ingest-store-port.js";
import { ACTIVITY_CLASSIFIER_VERSION } from "../../src/main/collectors/parsing/activity-segment-classifier.js";
import { EXTRACTOR_VERSION } from "../../src/main/collectors/parsing/artifact-ref-extractor-version.js";
import { resolveIngestStoreProvider } from "../../src/main/dashboard/ingest-store-provider.js";
import {
  openSqliteAgentDatabase,
  type SqliteAgentDatabase,
} from "../../src/main/database/sqlite.js";
import {
  TRANSCRIPT_MAIN_FILE_KEY,
  TranscriptSourceHarness,
} from "../../src/main/transcript-sync/transcript-sync-types.js";

/** The frozen golden corpus the vibe store is built from. */
export const VIBE_GOLDEN_CORPUS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "packages",
  "golden-sessions"
);

export type WrittenTranscripts = {
  readonly written: number;
  /** Rows dropped because the corpus holds no main transcript for them. */
  readonly dropped: number;
};

/**
 * ISS-12135 bug 55: put each kept session's main transcript where its
 * transcript sync row says it lives (`seedTranscriptSyncRows` in
 * `seed-local-activity.ts`), so Desktop's local trace reads it. The content is
 * the corpus file relabeled and moved onto the store's clock, exactly what the
 * web seed uploads (`vibeCorpusTranscriptText`). A row whose session has no
 * corpus JSONL is deleted rather than left pointing at a file that cannot
 * exist. Run after `keepSessionsOf`, so no teammate's transcript is written.
 *
 * The store's sessions, links and segments were derived from the corpus file
 * and then shifted and relabeled in place; the file written here is that same
 * corpus file, shifted and relabeled. So each written file is recorded where
 * the boot passes check for an unchanged source: its collector's catchup cache
 * (otherwise the first launch re-imports it and reopens the sessions
 * `closeIdleSessions` closed) and the artifact-link and activity-segment
 * backfill markers (otherwise the first launch re-derives the kept sessions'
 * links and segments from the relabeled text, which does not reproduce them).
 */
export async function writeSeededTranscripts(
  storePath: string,
  corpusDir: string,
  log: (message: string) => void
): Promise<WrittenTranscripts> {
  const timeMap = readTimeMap(storePath);
  const db = await openSqliteAgentDatabase({
    dataDir: storePath,
    detectBillingMode: () => "metered_api",
    log,
  });
  try {
    const rows = await db.prisma.client.transcriptSyncState.findMany({
      where: { fileKey: TRANSCRIPT_MAIN_FILE_KEY },
      select: {
        externalSessionId: true,
        sourceHarness: true,
        sourcePath: true,
      },
      orderBy: { externalSessionId: "asc" },
    });
    const unsourced: string[] = [];
    const written: WrittenFile[] = [];
    for (const row of rows) {
      const source = mainTranscriptSource(corpusDir, row.externalSessionId);
      if (source === null) {
        unsourced.push(row.externalSessionId);
        continue;
      }
      mkdirSync(path.dirname(row.sourcePath), { recursive: true });
      writeFileSync(
        row.sourcePath,
        vibeCorpusTranscriptText(readFileSync(source, "utf8"), timeMap)
      );
      written.push({ harness: row.sourceHarness, filePath: row.sourcePath });
    }
    await recordInCatchupCaches(db, written, log);
    await markWrittenFilesSeen(db, written);
    if (unsourced.length > 0) {
      await db.prisma.write((client) =>
        client.transcriptSyncState.deleteMany({
          where: {
            fileKey: TRANSCRIPT_MAIN_FILE_KEY,
            externalSessionId: { in: unsourced },
          },
        })
      );
    }
    return { written: written.length, dropped: unsourced.length };
  } finally {
    await db.close();
  }
}

function mainTranscriptSource(
  corpusDir: string,
  externalSessionId: string
): string | null {
  const rawDir = path.join(corpusDir, externalSessionId, "raw");
  if (!existsSync(rawDir)) {
    return null;
  }
  const match = pickVibeCorpusMainTranscript(
    readdirSync(rawDir),
    externalSessionId
  );
  return match === null ? null : path.join(rawDir, match);
}

function readTimeMap(storePath: string): VibeCorpusTimeMap {
  return vibeCorpusTimeMapSchema.parse(
    JSON.parse(readFileSync(vibeCorpusTimeMapPath(storePath), "utf8"))
  );
}

/**
 * The importer's own cache, written through its own constructor and the
 * app's own store provider, keyed by the collector's `cacheName`, which is
 * its harness (`claude`, `codex`).
 */
async function recordInCatchupCaches(
  db: SqliteAgentDatabase,
  written: readonly WrittenFile[],
  log: (message: string) => void
): Promise<void> {
  const provider = await resolveIngestStoreProvider({ database: db, log });
  for (const harness of SESSION_ID_FROM_PATH.keys()) {
    const paths = written
      .filter((file) => file.harness === harness)
      .map((file) => file.filePath);
    if (paths.length === 0) {
      continue;
    }
    const port = provider.catchupCache(harness);
    let saved: Promise<boolean> = Promise.resolve(true);
    const recording: IngestStorePort = {
      get hydrated() {
        return port.hydrated;
      },
      save: (snapshot) => {
        saved = port.save(snapshot);
        return saved;
      },
    };
    const cache = createCatchupCache({ store: recording });
    for (const filePath of paths) {
      cache.markSeen(filePath);
    }
    cache.flush();
    if (!(await saved)) {
      throw new Error(`could not record the ${harness} catchup cache`);
    }
  }
}

/**
 * Mark each written session as derived from the written file in both boot
 * backfills (`artifact-link-backfill.ts`, `activity-segment-backfill.ts`),
 * which skip a session whose marker holds the file's floored mtime at a
 * current version, keyed by the id the collector derives from the path. The
 * marker is created when the build left none: the link pass leaves a session
 * unmarked while its repo is not in `repos`, which never happens for the
 * corpus's relabeled repos, so it would re-derive that session's links from
 * the relabeled text on every launch and replace what the build derived.
 */
async function markWrittenFilesSeen(
  db: SqliteAgentDatabase,
  written: readonly WrittenFile[]
): Promise<void> {
  const markers = written.flatMap(({ harness, filePath }) => {
    const sessionIdFromPath = SESSION_ID_FROM_PATH.get(harness);
    return sessionIdFromPath === undefined
      ? []
      : [
          {
            sessionId: sessionIdFromPath(filePath),
            filePath,
            fileMtimeMs: BigInt(Math.floor(statSync(filePath).mtimeMs)),
          },
        ];
  });
  const imported = new Set(
    (
      await db.prisma.client.session.findMany({
        where: { id: { in: markers.map((marker) => marker.sessionId) } },
        select: { id: true },
      })
    ).map((session) => session.id)
  );
  const scannedAt = new Date().toISOString();
  for (const { sessionId, ...seen } of markers) {
    if (!imported.has(sessionId)) {
      continue;
    }
    const select = { sessionId: true };
    await db.prisma.write((client) =>
      client.$transaction([
        client.artifactLinkBackfillSeen.upsert({
          where: { sessionId },
          create: {
            sessionId,
            ...seen,
            extractorVersion: EXTRACTOR_VERSION,
            scannedAt,
          },
          update: seen,
          select,
        }),
        client.activitySegmentBackfillSeen.upsert({
          where: { sessionId },
          create: {
            sessionId,
            ...seen,
            classifierVersion: ACTIVITY_CLASSIFIER_VERSION,
            scannedAt,
          },
          update: seen,
          select,
        }),
      ])
    );
  }
}

type WrittenFile = {
  readonly harness: string;
  readonly filePath: string;
};

/** The harnesses whose collectors read the profile's harness homes. */
const SESSION_ID_FROM_PATH: ReadonlyMap<string, (filePath: string) => string> =
  new Map([
    [TranscriptSourceHarness.Claude, sessionIdFromTranscriptPath],
    [TranscriptSourceHarness.Codex, sessionIdFromRolloutPath],
  ]);
