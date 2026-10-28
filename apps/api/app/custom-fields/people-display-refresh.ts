import { CustomFieldType } from "@repo/api/src/types/custom-field";
import type { BasicUser } from "@repo/api/src/types/user";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { bindParameterChunkSize } from "@/app/agent-sessions/service/write-chunking";
import { formatPeopleSortKey } from "./display-value";
import { resolvePeopleMap } from "./people-resolution";

/**
 * Re-derives the cached PEOPLE sort key (`custom_field_values.display_value`)
 * for every value row in `organizationId` that names `userId`, after that
 * user's name changed (ISS-8970).
 *
 * PEOPLE is `ResolvedOnRead` for the RENDER (ISS-7215) but the cached column is
 * still what `GET /documents?customFieldSortId` orders by, and it held the name
 * as of the row's last custom-field write. Deriving the key live inside the
 * paginated ORDER BY was measured at 295–4,495 ms against 28 ms at the
 * 20,000-candidate cap, so the column stays the sort key and this refresh keeps
 * it true instead.
 *
 * Shape:
 *  - Keyset-paged read (`id gt`, ascending), filtered through the field's type
 *    and org so a malformed non-PEOPLE row or a cross-org row holding the id is
 *    never rewritten — that is a QUERY guarantee, not a storage invariant.
 *  - The page's distinct person ids are chunked to the bind ceiling before the
 *    org-scoped user lookup: a page bounds ROWS, not people per row.
 *  - Diffed: a row whose recomputed key equals the stored one is not written,
 *    so a replayed webhook or a same-name rename issues zero UPDATEs.
 *  - One set-based UPDATE per page (`writeNumberDisplayValues` shape) whose
 *    predicate is a compare-and-set on BOTH the id array the key was computed
 *    from and the display string that was read: a `setValueForEntity` or a
 *    second refresh that lands between the read and the write leaves the row
 *    unmatched, so this refresh can never clobber a newer array or a newer key.
 *  - A missed row is re-read and recomputed from live users, a bounded number
 *    of times, so a refresh whose CAS lost to an OLDER refresh still lands
 *    the newer key instead of returning success over a stale one. Exhausting
 *    that bound THROWS rather than returning: the row is known-stale and this
 *    refresh could not make it true, so the caller's delivery must retry.
 *    It cannot HEAL every interleaving (a value write that read names before
 *    the rename and lands after it keeps a one-rename-old key until the next
 *    write of either kind); that is bounded, self-healing cache maintenance.
 *
 * Throws on failure. The caller decides the blast radius; every writer in
 * `users/service.ts` lets it propagate so a Clerk redelivery repairs the column.
 *
 * `withDb` holds no connection and joins an enclosing `withDb.tx` through
 * AsyncLocalStorage, so callers just call this after their own write; the
 * `WithDb` variant below exists for tests that need to interleave a write
 * between the read and the UPDATE, mirroring `resolveExternalGitHubAuthorWithDb`.
 *
 * @returns the number of rows rewritten
 */
export function refreshPeopleDisplayValuesForUser(
  userId: string,
  organizationId: string
): Promise<number> {
  return withDb((db) =>
    refreshPeopleDisplayValuesForUserWithDb(db, userId, organizationId)
  );
}

export async function refreshPeopleDisplayValuesForUserWithDb(
  db: TransactionClient,
  userId: string,
  organizationId: string
): Promise<number> {
  let rewritten = 0;
  let lastSeenId: string | undefined;
  for (;;) {
    const page = await db.customFieldValue.findMany({
      where: {
        organizationId,
        peopleValueIds: { has: userId },
        customField: { fieldType: CustomFieldType.People, organizationId },
        ...(lastSeenId === undefined ? {} : { id: { gt: lastSeenId } }),
      },
      orderBy: { id: "asc" },
      take: PEOPLE_DISPLAY_REFRESH_PAGE_SIZE,
      select: { id: true, peopleValueIds: true, displayValue: true },
    });
    if (page.length === 0) {
      break;
    }
    rewritten += await rewritePage(db, organizationId, page);
    if (page.length < PEOPLE_DISPLAY_REFRESH_PAGE_SIZE) {
      break;
    }
    lastSeenId = page.at(-1)?.id;
  }
  return rewritten;
}

/** Value rows read per statement; bounds rows, not people per row. */
export const PEOPLE_DISPLAY_REFRESH_PAGE_SIZE = 1000;

/**
 * Person ids per `resolvePeopleMap` call: one bind per id, plus the single
 * `organizationId` bind as the statement's own fixed cost. Prisma's implicit
 * binds are reserved inside the helper, not here.
 */
const PEOPLE_LOOKUP_CHUNK_SIZE = bindParameterChunkSize(1, 1);

type PeopleValueRow = {
  id: string;
  peopleValueIds: string[];
  displayValue: string | null;
};

async function resolvePeopleInChunks(
  ids: string[],
  organizationId: string
): Promise<Map<string, BasicUser>> {
  const byId = new Map<string, BasicUser>();
  for (
    let offset = 0;
    offset < ids.length;
    offset += PEOPLE_LOOKUP_CHUNK_SIZE
  ) {
    const chunk = ids.slice(offset, offset + PEOPLE_LOOKUP_CHUNK_SIZE);
    for (const [id, user] of await resolvePeopleMap(chunk, organizationId)) {
      byId.set(id, user);
    }
  }
  return byId;
}

/**
 * Re-reads of a page after a compare-and-set miss. A miss means another writer
 * moved the row between this refresh's read and its UPDATE; the retry re-reads
 * the row AND the users, so it either writes the now-current key or finds the
 * row already holds it. Bounded because two refreshes for the same user can
 * keep missing each other only as long as renames keep arriving faster than
 * either can land. Past the bound this refresh KNOWS the row is still stale
 * and could not make it true, so it takes the module's one failure policy
 * rather than returning success over it: log the contended ids, then throw so
 * the caller's delivery is retried and the redelivery repairs the column.
 */
export const PEOPLE_DISPLAY_REFRESH_MAX_RETRIES = 2;

async function rewritePage(
  db: TransactionClient,
  organizationId: string,
  page: PeopleValueRow[],
  attempt = 0
): Promise<number> {
  const distinctIds = [...new Set(page.flatMap((row) => row.peopleValueIds))];
  const byId = await resolvePeopleInChunks(distinctIds, organizationId);
  const changed = page.flatMap((row) => {
    const next = formatPeopleSortKey(row.peopleValueIds, byId);
    // `display_value` is nullable; a NULL column and an all-nameless key are
    // the same "nothing to show", not a change to write on every call.
    return (row.displayValue ?? "") === next
      ? []
      : [
          {
            id: row.id,
            idsKey: row.peopleValueIds.join(","),
            previous: row.displayValue,
            next,
          },
        ];
  });
  if (changed.length === 0) {
    return 0;
  }
  const written = await compareAndSetDisplayValues(db, organizationId, changed);
  const missed = changed.map((row) => row.id).filter((id) => !written.has(id));
  if (missed.length === 0) {
    return written.size;
  }
  if (attempt >= PEOPLE_DISPLAY_REFRESH_MAX_RETRIES) {
    // The ids go in the log, where the context is richest and the payload is
    // unbounded; the throw carries only the count.
    log.error(
      "[custom-fields] PEOPLE sort-key refresh gave up on contended rows",
      {
        organizationId,
        rowIds: missed,
        attempts: attempt + 1,
      }
    );
    throw new Error(
      `PEOPLE sort-key refresh left ${missed.length} row(s) stale after ${attempt + 1} attempts in organization ${organizationId}`
    );
  }
  // Narrower than the page read on purpose: the ids came from a page already
  // filtered to PEOPLE rows in this org, and a row a concurrent write emptied
  // of the user is still recomputed from its CURRENT ids, which is the same
  // idempotent repair.
  const reread = await db.customFieldValue.findMany({
    where: { id: { in: missed }, organizationId },
    select: { id: true, peopleValueIds: true, displayValue: true },
  });
  return (
    written.size + (await rewritePage(db, organizationId, reread, attempt + 1))
  );
}

type ChangedRow = {
  id: string;
  idsKey: string;
  previous: string | null;
  next: string;
};

/**
 * One set-based UPDATE whose predicate is a compare-and-set on BOTH columns
 * the key was derived from and written to. The id array guards against a
 * concurrent value write; the previous display string guards against a
 * concurrent REFRESH, so the one that read the users earlier can never land
 * its older key over a newer one. Returns the ids that matched; a caller
 * re-reads the rest.
 */
async function compareAndSetDisplayValues(
  db: TransactionClient,
  organizationId: string,
  changed: ChangedRow[]
): Promise<Set<string>> {
  // Same clock rule as `writeNumberDisplayValues`: Prisma stamps `@updatedAt`
  // from the client clock, so this write stays monotonic against it.
  const updatedAt = new Date();
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    UPDATE "custom_field_values" AS cfv
    SET "display_value" = data.display_value,
        "updated_at" = ${updatedAt}::timestamp
    FROM unnest(
           ${changed.map((row) => row.id)}::uuid[],
           ${changed.map((row) => row.idsKey)}::text[],
           ${changed.map((row) => row.previous)}::text[],
           ${changed.map((row) => row.next)}::text[]
         ) AS data(id, ids_key, previous_display, display_value)
    WHERE cfv."id" = data.id
      AND cfv."organization_id" = ${organizationId}::uuid
      AND array_to_string(cfv."people_value_ids", ',') = data.ids_key
      AND cfv."display_value" IS NOT DISTINCT FROM data.previous_display
    RETURNING cfv."id"
  `);
  return new Set(rows.map((row) => row.id));
}
