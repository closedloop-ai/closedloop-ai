import { ArtifactType, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { DOC_SYNC_LIST_DEFAULT_LIMIT } from "@repo/realtime-contract/doc-sync-internal";
import { InternalCallFailure } from "@repo/realtime-server/internal-call";
import pLimit from "p-limit";
import { parseCanonicalDocumentRoom } from "../canonical-room";
import { docSyncInternalClient } from "./internal-client";

export type DocSyncSweepSummary = {
  /** Names doc-sync listed. */
  scanned: number;
  /** Names whose document no longer exists, removed through the delete command. */
  deleted: number;
  /** Names whose document still exists. */
  kept: number;
  /** Names that are not a document room id; never deleted. */
  unparseable: number;
  /** Failed deletes, plus a failed list (which deletes nothing more). */
  failed: number;
  /** The deadline stopped the run before the listing was exhausted. */
  truncated: boolean;
  /** `DOC_SYNC_INTERNAL_URL` or its audience is unset: nothing was listed. */
  notConfigured: boolean;
};

/**
 * PLN-2200 T-6.1 (AC-009): deletes the doc-sync state of every document that
 * no longer exists in the app database. Every removal goes through doc-sync's
 * delete command, so the sweep keeps the command's unload-then-delete order.
 */
export const docSyncSweepService = { run };

async function run({
  deadlineMs,
}: {
  deadlineMs: number;
}): Promise<DocSyncSweepSummary> {
  const deadline = Date.now() + deadlineMs;
  const summary = emptySummary();
  const client = docSyncInternalClient();
  let after: string | undefined;
  do {
    if (Date.now() >= deadline) {
      summary.truncated = true;
      return summary;
    }
    const page = await client.listDocuments({
      after,
      limit: DOC_SYNC_LIST_DEFAULT_LIMIT,
    });
    if (!page.ok) {
      if (page.failure === InternalCallFailure.NotConfigured) {
        summary.notConfigured = true;
      } else {
        summary.failed += 1;
      }
      return summary;
    }
    summary.scanned += page.value.names.length;
    await sweepPage(page.value.names, deadline, summary);
    after = page.value.nextAfter ?? undefined;
  } while (after !== undefined && !summary.truncated);
  return summary;
}

async function sweepPage(
  names: readonly string[],
  deadline: number,
  summary: DocSyncSweepSummary
): Promise<void> {
  const rooms = parseRooms(names, summary);
  if (rooms.length === 0) {
    return;
  }
  const existing = await existingDocumentKeys(rooms);
  const missing = rooms.filter((room) => !existing.has(documentKey(room)));
  summary.kept += rooms.length - missing.length;
  const client = docSyncInternalClient();
  const limit = pLimit(DOC_SYNC_SWEEP_DELETE_CONCURRENCY);
  await Promise.all(
    missing.map((room) =>
      limit(async () => {
        if (Date.now() >= deadline) {
          summary.truncated = true;
          return;
        }
        const result = await client.deleteDocument(room.name);
        if (result.ok) {
          summary.deleted += 1;
        } else {
          summary.failed += 1;
        }
      })
    )
  );
}

type SweptRoom = { name: string; organizationId: string; slug: string };

/**
 * Only canonical room ids: one malformed name in the page's query would fail
 * the whole page.
 */
function parseRooms(
  names: readonly string[],
  summary: DocSyncSweepSummary
): SweptRoom[] {
  const rooms: SweptRoom[] = [];
  for (const name of names) {
    const room = parseCanonicalDocumentRoom(name);
    if (room === null) {
      summary.unparseable += 1;
      log.warn("Doc-sync sweep kept a name that is not a document room id", {
        event: DOC_SYNC_SWEEP_UNPARSEABLE_NAME_EVENT,
        name,
      });
    } else {
      rooms.push({ name, ...room });
    }
  }
  return rooms;
}

/** One query per page, on the `(organizationId, slug)` unique index. */
async function existingDocumentKeys(
  rooms: readonly SweptRoom[]
): Promise<Set<string>> {
  const rows = await withDb((db) =>
    db.artifact.findMany({
      where: {
        OR: rooms.map(({ organizationId, slug }) => ({
          organizationId,
          slug,
          type: ArtifactType.DOCUMENT,
        })),
      },
      select: { organizationId: true, slug: true },
    })
  );
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.slug !== null) {
      keys.add(
        documentKey({ organizationId: row.organizationId, slug: row.slug })
      );
    }
  }
  return keys;
}

function documentKey(room: { organizationId: string; slug: string }): string {
  return `${room.organizationId}\u0000${room.slug}`;
}

function emptySummary(): DocSyncSweepSummary {
  return {
    scanned: 0,
    deleted: 0,
    kept: 0,
    unparseable: 0,
    failed: 0,
    truncated: false,
    notConfigured: false,
  };
}

export const DOC_SYNC_SWEEP_DELETE_CONCURRENCY = 5;
export const DOC_SYNC_SWEEP_UNPARSEABLE_NAME_EVENT =
  "doc_sync.sweep_unparseable_name";
