/**
 * FEA-3930 (parent FEA-3800, PLN-1456) — one-shot, idempotent backfill that
 * indexes existing AI session transcript CONTENT into the `search_document`
 * projection for orgs that have opted into transcript search
 * (`Organization.searchIncludeTranscripts = true`).
 *
 * The live path indexes a transcript at ARCHIVE/FINALIZE time (the
 * transcripts/complete route); this reconciles transcripts uploaded BEFORE an
 * org flipped the gate on. It reuses `transcriptSearchIndexService.index()` — the
 * exact same gated flow the live path uses — so the two cannot diverge: the
 * indexer re-checks the org gate, reads the bounded S3 prefix, extracts text,
 * and upserts. This script only enumerates candidate (org, session) identities.
 *
 * ORG-GATED: only orgs with the gate on are scanned; the indexer double-checks
 * the gate per session, so a flip-off mid-run stops indexing.
 *
 * PAGINATED UNTIL EXHAUSTED + BOUNDED FAN-OUT: uploaded MAIN transcript rows are
 * paged by ascending id; each page is indexed through a bounded concurrency
 * limiter so the S3 reads and DB upserts never fan out unbounded.
 *
 * Usage:
 *   cd apps/api
 *   DATABASE_URL=<url> AWS_… npx tsx scripts/backfill-transcript-search.ts
 */
import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import { withDb } from "@repo/database";
import { MAIN_FILE_KEY } from "@/app/agent-sessions/transcript-availability";
import { transcriptSearchIndexService } from "@/app/search/transcript-search-indexer";
import { mapWithDbConcurrency } from "@/lib/db-fanout";

const PAGE_SIZE = 200;

type TranscriptIdentityRow = {
  id: string;
  organizationId: string;
  computeTargetId: string;
  externalSessionId: string;
};

/**
 * Page all `uploaded` MAIN transcript rows for opted-in orgs by ascending id,
 * indexing each through the shared indexer under a bounded concurrency cap.
 * Returns the count of sessions for which a projection row was written.
 */
async function runBackfill(): Promise<{ scanned: number; indexed: number }> {
  let scanned = 0;
  let indexed = 0;
  let cursorId: string | null = null;

  for (;;) {
    const page = await readPage(cursorId);
    if (page.length === 0) {
      break;
    }
    scanned += page.length;

    // Per-row tolerance: a single unreadable transcript (deleted S3 object,
    // transient error) must not abort the whole sweep, so index() is wrapped and
    // a failure counts as "not indexed" rather than throwing out of the fan-out.
    const results = await mapWithDbConcurrency(page, (row) => indexOne(row));
    indexed += results.filter(Boolean).length;

    if (page.length < PAGE_SIZE) {
      break;
    }
    cursorId = page.at(-1)?.id ?? null;
    if (cursorId === null) {
      break;
    }
  }

  return { scanned, indexed };
}

/** Index one transcript, treating any failure as "not indexed" (logged). */
async function indexOne(row: TranscriptIdentityRow): Promise<boolean> {
  try {
    return await transcriptSearchIndexService.index({
      organizationId: row.organizationId,
      computeTargetId: row.computeTargetId,
      externalSessionId: row.externalSessionId,
      fileKey: MAIN_FILE_KEY,
    });
  } catch (error) {
    console.error(
      `[backfill-transcript-search] failed to index transcript ${row.id}:`,
      error
    );
    return false;
  }
}

/** Read one keyset page of uploaded MAIN transcripts for opted-in orgs. */
function readPage(cursorId: string | null): Promise<TranscriptIdentityRow[]> {
  return withDb((db) =>
    db.sessionTranscript.findMany({
      where: {
        fileKey: MAIN_FILE_KEY,
        uploadStatus: TranscriptUploadStatus.Uploaded,
        organization: { is: { searchIncludeTranscripts: true } },
      },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      ...(cursorId === null ? {} : { cursor: { id: cursorId }, skip: 1 }),
      select: {
        id: true,
        organizationId: true,
        computeTargetId: true,
        externalSessionId: true,
      },
    })
  );
}

async function main(): Promise<void> {
  const { scanned, indexed } = await runBackfill();
  console.info(
    `[backfill-transcript-search] done: scanned ${scanned} uploaded main transcript(s), indexed ${indexed} session(s).`
  );
}

if (
  typeof process !== "undefined" &&
  import.meta.url === `file://${process.argv[1]}`
) {
  main().catch((error) => {
    console.error("[backfill-transcript-search] failed:", error);
    process.exitCode = 1;
  });
}
