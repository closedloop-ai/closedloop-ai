/**
 * @file component-authors-lineage-walk.test.ts
 * @description ISS-9867: the detail's authors lineage is no longer capped at
 * the 5,000-row inventory ceiling. Two contracts that removal put at risk are
 * pinned here.
 *
 * `loadLineageDefinitionHashes` walks `agentComponentVersion` on the immutable
 * `id` key — `lastSeenAt` is rewritten by sync between pages, so a keyset on it
 * can skip or revisit a row — and then orders the COMPLETE set newest-first in
 * memory. The double rewrites a row's `lastSeenAt` between pages, which a
 * `lastSeenAt`-keyed walk would lose.
 *
 * `resolveCollaboratorsByDefinitionHash` reads the editor lineage in
 * `LINEAGE_HASH_CHUNK_SIZE` slices: an uncapped lineage hands it more distinct
 * hashes than one `in` predicate may bind, and every hash must still resolve —
 * a dropped chunk would silently shrink the Collaborators set rather than fail.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({ withDb: vi.fn() }));

import { POSTGRES_MAX_BIND_PARAMETERS } from "@/lib/postgres-bind-parameters";
import {
  LINEAGE_HASH_CHUNK_SIZE,
  loadLineageDefinitionHashes,
  resolveCollaboratorsByDefinitionHash,
} from "../component-authors";

const ORG = "org-1";
const PAGE_SIZE = 3;

type VersionRow = {
  id: string;
  lastSeenAt: Date | null;
  definitionVersion: { definitionHash: string } | null;
};

type VersionFindManyArgs = {
  orderBy: unknown;
  take: number;
  skip?: number;
  cursor?: { id: string };
};

function byIdAsc(a: VersionRow, b: VersionRow): number {
  return a.id.localeCompare(b.id);
}

/** `lastSeenAt` DESC nulls last, `id` ASC — the pre-ISS-9867 walk order. */
function byLastSeenDesc(a: VersionRow, b: VersionRow): number {
  const aSeen = a.lastSeenAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bSeen = b.lastSeenAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (aSeen !== bSeen) {
    return bSeen - aSeen;
  }
  return byIdAsc(a, b);
}

/**
 * An `agentComponentVersion.findMany` double over an in-memory table that
 * honours `orderBy`, `take`, `cursor` and `skip` the way Prisma does — the
 * cursor row is located in the ORDER the statement asked for, which is what
 * makes a mutable sort key lose rows. `mutateAfterPage` runs after each page is
 * served, so a test can move a row's `lastSeenAt` mid-walk the way
 * `widenVersionObservationWindows` does in production.
 */
function makeVersionDb(
  rows: VersionRow[],
  mutateAfterPage?: (page: number) => void
) {
  let pages = 0;
  const findMany = vi.fn((args: VersionFindManyArgs) => {
    const onLastSeen = JSON.stringify(args.orderBy).includes("lastSeenAt");
    const ordered = [...rows].sort(onLastSeen ? byLastSeenDesc : byIdAsc);
    let start = 0;
    if (args.cursor) {
      const at = ordered.findIndex((row) => row.id === args.cursor?.id);
      start = at + (args.skip ?? 0);
    }
    const page = ordered.slice(start, start + args.take).map((row) => ({
      id: row.id,
      lastSeenAt: row.lastSeenAt,
      definitionVersion: row.definitionVersion,
    }));
    pages += 1;
    mutateAfterPage?.(pages);
    return Promise.resolve(page);
  });
  const db = {
    agentComponentVersion: { findMany },
  } as unknown as Parameters<typeof loadLineageDefinitionHashes>[0];
  return { db, findMany };
}

function version(
  id: string,
  seenAt: string | null,
  hash: string | null
): VersionRow {
  return {
    id,
    lastSeenAt: seenAt ? new Date(seenAt) : null,
    definitionVersion: hash ? { definitionHash: hash } : null,
  };
}

describe("loadLineageDefinitionHashes", () => {
  it("walks every page on the id key and orders the whole set newest-first", async () => {
    const rows = [
      version("v1", "2026-01-01T00:00:00Z", "h-old"),
      version("v2", "2026-01-05T00:00:00Z", "h-newest"),
      version("v3", "2026-01-03T00:00:00Z", "h-mid"),
      version("v4", null, "h-never-seen"),
      version("v5", "2026-01-03T00:00:00Z", "h-mid-tie"),
      version("v6", "2026-01-02T00:00:00Z", "h-old"),
      version("v7", "2026-01-04T00:00:00Z", null),
    ];
    const { db, findMany } = makeVersionDb(rows);

    const hashes = await loadLineageDefinitionHashes(
      db,
      ORG,
      "skill",
      "deploy",
      PAGE_SIZE
    );

    // 7 rows at 3 per page: three statements, the last one short.
    expect(findMany).toHaveBeenCalledTimes(3);
    for (const [args] of findMany.mock.calls) {
      expect(args.orderBy).toEqual({ id: "asc" });
      expect(args.take).toBe(PAGE_SIZE);
    }
    expect(findMany.mock.calls[0][0].cursor).toBeUndefined();
    expect(findMany.mock.calls[0][0].skip).toBeUndefined();
    expect(findMany.mock.calls[1][0].cursor).toEqual({ id: "v3" });
    expect(findMany.mock.calls[1][0].skip).toBe(1);
    expect(findMany.mock.calls[2][0].cursor).toEqual({ id: "v6" });
    expect(findMany.mock.calls[2][0].skip).toBe(1);
    // Newest-first, `id` breaking the 01-03 tie, nulls last, deduped on the
    // hash's FIRST (newest) appearance, unlinked rows skipped.
    expect(hashes).toEqual([
      "h-newest",
      "h-mid",
      "h-mid-tie",
      "h-old",
      "h-never-seen",
    ]);
  });

  it("reaches a row whose lastSeenAt moves past the walk between pages", async () => {
    const rows = [
      version("v1", "2026-01-09T00:00:00Z", "h-1"),
      version("v2", "2026-01-08T00:00:00Z", "h-2"),
      version("v3", "2026-01-07T00:00:00Z", "h-3"),
      version("v4", "2026-01-06T00:00:00Z", "h-4"),
      version("v5", "2026-01-05T00:00:00Z", "h-5"),
    ];
    // After the first page, sync re-observes v5 and makes it the newest row —
    // under a lastSeenAt-DESC keyset it would now sort AHEAD of the cursor and
    // never be visited. On the id walk it is still ahead of the cursor.
    const { db } = makeVersionDb(rows, (page) => {
      if (page === 1) {
        rows[4].lastSeenAt = new Date("2026-01-10T00:00:00Z");
      }
    });

    const hashes = await loadLineageDefinitionHashes(
      db,
      ORG,
      "skill",
      "deploy",
      PAGE_SIZE
    );

    expect(hashes).toEqual(["h-5", "h-1", "h-2", "h-3", "h-4"]);
  });

  it("issues one statement when the population fits in a page", async () => {
    const { db, findMany } = makeVersionDb([
      version("v1", "2026-01-01T00:00:00Z", "h-1"),
    ]);

    const hashes = await loadLineageDefinitionHashes(
      db,
      ORG,
      "skill",
      "deploy",
      PAGE_SIZE
    );

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].cursor).toBeUndefined();
    expect(hashes).toEqual(["h-1"]);
  });
});

type EditorFindManyArgs = {
  where: {
    definitionVersion: {
      organizationId: string;
      definitionHash: { in: string[] };
    };
  };
};

/**
 * A `definitionVersionEditor.findMany` double answering each chunk with one
 * lineage row per requested hash, so a hash that never reaches a statement
 * shows up as a missing key rather than passing unnoticed.
 */
function makeEditorDb() {
  const findMany = vi.fn((args: EditorFindManyArgs) =>
    Promise.resolve(
      args.where.definitionVersion.definitionHash.in.map((hash, index) => ({
        userId: `u-${hash}`,
        firstEditedAt: new Date(index),
        definitionVersion: { definitionHash: hash },
        user: {
          id: `u-${hash}`,
          firstName: "Ada",
          lastName: hash,
          email: `${hash}@example.test`,
        },
      }))
    )
  );
  const db = {
    definitionVersionEditor: { findMany },
  } as unknown as Parameters<typeof resolveCollaboratorsByDefinitionHash>[0];
  return { db, findMany };
}

describe("resolveCollaboratorsByDefinitionHash", () => {
  it("keeps every in-predicate under the bind ceiling", () => {
    expect(LINEAGE_HASH_CHUNK_SIZE).toBeLessThan(POSTGRES_MAX_BIND_PARAMETERS);
  });

  it("chunks a lineage wider than one statement and resolves every hash", async () => {
    const count = LINEAGE_HASH_CHUNK_SIZE * 2 + 1;
    const hashes = Array.from({ length: count }, (_, i) => `h-${i}`);
    const { db, findMany } = makeEditorDb();

    const byHash = await resolveCollaboratorsByDefinitionHash(db, ORG, hashes);

    expect(findMany).toHaveBeenCalledTimes(3);
    for (const [args] of findMany.mock.calls) {
      expect(args.where.definitionVersion.organizationId).toBe(ORG);
      expect(
        args.where.definitionVersion.definitionHash.in.length
      ).toBeLessThanOrEqual(LINEAGE_HASH_CHUNK_SIZE);
    }
    expect(byHash.size).toBe(count);
    expect(byHash.get(`h-${count - 1}`)).toEqual([
      { userId: `u-h-${count - 1}`, name: `Ada h-${count - 1}` },
    ]);
  });

  it("issues one statement for a lineage that fits a chunk", async () => {
    const { db, findMany } = makeEditorDb();

    const byHash = await resolveCollaboratorsByDefinitionHash(db, ORG, [
      "h-a",
      null,
      "h-a",
      "h-b",
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(
      findMany.mock.calls[0][0].where.definitionVersion.definitionHash.in
    ).toEqual(["h-a", "h-b"]);
    expect([...byHash.keys()]).toEqual(["h-a", "h-b"]);
  });
});
