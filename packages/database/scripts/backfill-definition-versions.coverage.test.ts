/**
 * ISS-11298 — coverage-recovery unit tests for the definition-version backfill.
 *
 * These target branches the existing `backfill-definition-versions.test.ts`
 * suite does not exercise: multi-page cursors in both scan phases, the
 * within-scan content-group dedup skip, the defensive `hash == null` guard in
 * Phase 2, and the default `log` sink. `toBackfillClient` is not exported by
 * the source, so its delegate-binding wiring is out of reach for a unit test
 * (tested through the public API only, per repo convention) and stays
 * uncovered here. Pins current behavior exactly; no source changes.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type BackfillClient,
  type CoarseVersionRow,
  runBackfill,
  type UsageRow,
} from "./backfill-definition-versions";

type CoarseRow = CoarseVersionRow;

type UsageRecord = {
  id: string;
  organizationId: string;
  componentKind: string;
  componentKey: string;
  componentVersionHash: string | null;
  definitionVersionId: string | null;
};

/**
 * A minimal faithful in-memory `BackfillClient`, matching the pagination
 * semantics of the existing suite's fake (cursor/skip/take over an id-sorted
 * array) so a small `pageSize` genuinely forces multiple pages.
 */
function makeFakeClient(seed: { coarse: CoarseRow[]; usage: UsageRecord[] }): {
  client: BackfillClient;
  coarse: CoarseRow[];
  usage: UsageRecord[];
  versions: { id: string; organizationId: string; definitionHash: string }[];
} {
  const coarse = seed.coarse.map((r) => ({ ...r }));
  const usage = seed.usage.map((r) => ({ ...r }));
  const versions: {
    id: string;
    organizationId: string;
    definitionHash: string;
  }[] = [];
  let versionSeq = 0;

  function pageById<T extends { id: string }>(
    rows: T[],
    args: { take?: number; cursor?: { id: string }; skip?: number }
  ): T[] {
    const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
    let start = 0;
    if (args.cursor) {
      const idx = sorted.findIndex((r) => r.id === args.cursor?.id);
      start = idx === -1 ? sorted.length : idx + (args.skip ?? 0);
    }
    return sorted.slice(start, start + (args.take ?? sorted.length));
  }

  const client: BackfillClient = {
    agentComponentVersion: {
      findMany: (args) => {
        const where = (args.where ?? {}) as Record<string, unknown>;
        if ("contentHash" in where || "componentKey" in where) {
          const matches = coarse.filter((r) => {
            if (
              "organizationId" in where &&
              r.organizationId !== where.organizationId
            ) {
              return false;
            }
            if ("contentHash" in where && r.contentHash !== where.contentHash) {
              return false;
            }
            if (
              "definitionVersionId" in where &&
              r.definitionVersionId === null
            ) {
              return false;
            }
            return true;
          });
          return Promise.resolve(
            matches.slice(0, args.take ?? matches.length) as CoarseVersionRow[]
          );
        }
        return Promise.resolve(pageById(coarse, args) as CoarseVersionRow[]);
      },
      updateMany: (args) => {
        const where = args.where as Record<string, unknown>;
        const data = args.data as { definitionVersionId: string };
        let count = 0;
        for (const row of coarse) {
          if (
            row.organizationId === where.organizationId &&
            row.componentKind === where.componentKind &&
            row.contentHash === where.contentHash &&
            row.definitionVersionId === null
          ) {
            row.definitionVersionId = data.definitionVersionId;
            count += 1;
          }
        }
        return Promise.resolve({ count });
      },
    },
    definitionVersion: {
      upsert: (args) => {
        const key = (
          args.where as {
            organizationId_definitionHash: {
              organizationId: string;
              definitionHash: string;
            };
          }
        ).organizationId_definitionHash;
        const existing = versions.find(
          (v) =>
            v.organizationId === key.organizationId &&
            v.definitionHash === key.definitionHash
        );
        if (existing) {
          return Promise.resolve({ id: existing.id });
        }
        const create = args.create as {
          organizationId: string;
          definitionHash: string;
        };
        versionSeq += 1;
        const id = `ver-${versionSeq}`;
        versions.push({
          id,
          organizationId: create.organizationId,
          definitionHash: create.definitionHash,
        });
        return Promise.resolve({ id });
      },
    },
    sourceOccurrence: {
      findFirst: () => Promise.resolve(null),
      create: () => Promise.resolve({ id: "occ-1" }),
      update: (args) => Promise.resolve({ id: args.where.id }),
    },
    agentComponentSessionUsage: {
      findMany: (args) => {
        const where = (args.where ?? {}) as Record<string, unknown>;
        // Mirror real cursor-pagination semantics: the cursor anchors a
        // position in the FULL id-ordered set (a PK lookup, independent of
        // WHERE), and the WHERE filter is applied to what comes after it — not
        // to the set the cursor is located within. A filter-then-locate
        // fake would lose its anchor the moment this run's own mutation
        // (linking the cursor row) makes that row no longer match the WHERE.
        const sortedAll = [...usage].sort((a, b) => (a.id < b.id ? -1 : 1));
        let start = 0;
        if (args.cursor) {
          const idx = sortedAll.findIndex((u) => u.id === args.cursor?.id);
          start = idx === -1 ? sortedAll.length : idx + (args.skip ?? 0);
        }
        const eligible = sortedAll.slice(start).filter((u) => {
          if (
            "componentVersionHash" in where &&
            u.componentVersionHash === null
          ) {
            return false;
          }
          if (
            "definitionVersionId" in where &&
            u.definitionVersionId !== null
          ) {
            return false;
          }
          return true;
        });
        const page = eligible.slice(0, args.take ?? eligible.length);
        const rows: UsageRow[] = page.map((u) => ({
          id: u.id,
          componentKind: u.componentKind,
          componentKey: u.componentKey,
          componentVersionHash: u.componentVersionHash,
          definitionVersionId: u.definitionVersionId,
          session: { artifact: { organizationId: u.organizationId } },
        }));
        return Promise.resolve(rows);
      },
      updateMany: (args) => {
        const where = args.where as { id: string; definitionVersionId: null };
        const data = args.data as { definitionVersionId: string };
        const hit = usage.find(
          (u) => u.id === where.id && u.definitionVersionId === null
        );
        if (!hit) {
          return Promise.resolve({ count: 0 });
        }
        hit.definitionVersionId = data.definitionVersionId;
        return Promise.resolve({ count: 1 });
      },
    },
  };

  return { client, coarse, usage, versions };
}

function coarseRow(over: Partial<CoarseRow> & { id: string }): CoarseRow {
  return {
    organizationId: "org-a",
    componentKind: "agent",
    componentKey: "reviewer",
    source: "local",
    contentHash: "hash-default",
    content: "content",
    format: null,
    definitionVersionId: null,
    ...over,
  };
}

function usageRow(over: Partial<UsageRecord> & { id: string }): UsageRecord {
  return {
    organizationId: "org-a",
    componentKind: "agent",
    componentKey: "reviewer",
    componentVersionHash: "hash-default",
    definitionVersionId: null,
    ...over,
  };
}

describe("runBackfill — coverage recovery", () => {
  it("mints and links nothing when both scans start empty", async () => {
    const { client, versions } = makeFakeClient({ coarse: [], usage: [] });

    const counts = await runBackfill(client, { log: () => {} });

    expect(versions).toHaveLength(0);
    expect(counts).toEqual({
      contentGroupsScanned: 0,
      versionsUpserted: 0,
      occurrencesCreated: 0,
      coarseRowsLinked: 0,
      usageRowsLinked: 0,
      usageRowsUnresolved: 0,
    });
  });

  it("pages both scans across multiple full pages and dedupes a repeated content group within one scan", async () => {
    // Two coarse rows share identical org+content (a within-scan dedup, not the
    // cross-org isolation the existing suite already covers); a third row is a
    // distinct content group. pageSize=1 forces every page but the terminal one
    // to be exactly full, so the loop must consult its cursor to keep going.
    const sharedContent = "shared body";
    const { client, versions } = makeFakeClient({
      coarse: [
        coarseRow({
          id: "cv-1",
          contentHash: "hash-shared",
          content: sharedContent,
        }),
        coarseRow({
          id: "cv-2",
          contentHash: "hash-shared",
          content: sharedContent,
        }),
        coarseRow({ id: "cv-3", contentHash: "hash-other", content: "other" }),
      ],
      usage: [
        usageRow({ id: "u-1", componentVersionHash: "hash-shared" }),
        usageRow({ id: "u-2", componentVersionHash: "hash-other" }),
      ],
    });

    const counts = await runBackfill(client, { pageSize: 1, log: () => {} });

    // cv-1 and cv-2 land in the SAME content group, so only one version is
    // minted for them; cv-3 is a second, distinct group.
    expect(versions).toHaveLength(2);
    expect(counts.contentGroupsScanned).toBe(2);
    expect(counts.versionsUpserted).toBe(2);
    // All three coarse rows are stamped, including the two that shared a mint.
    expect(counts.coarseRowsLinked).toBe(3);
    expect(counts.usageRowsLinked).toBe(2);
    expect(counts.usageRowsUnresolved).toBe(0);
  });

  it("leaves a usage row unresolved when its componentVersionHash is null", async () => {
    // Production's own WHERE clause (`componentVersionHash: { not: null }`)
    // already excludes this row; this test bypasses that filter to prove the
    // defensive `hash == null` branch inside the loop body still resolves to
    // "unresolved" rather than throwing or silently dropping the row.
    const nullHashUsage: UsageRow = {
      id: "u-null-hash",
      componentKind: "agent",
      componentKey: "reviewer",
      componentVersionHash: null,
      definitionVersionId: null,
      session: { artifact: { organizationId: "org-a" } },
    };
    const client: BackfillClient = {
      agentComponentVersion: {
        findMany: () => Promise.resolve([]),
        updateMany: () => Promise.resolve({ count: 0 }),
      },
      definitionVersion: {
        upsert: () => Promise.resolve({ id: "ver-unused" }),
      },
      sourceOccurrence: {
        findFirst: () => Promise.resolve(null),
        create: () => Promise.resolve({ id: "occ-unused" }),
        update: (args) => Promise.resolve({ id: args.where.id }),
      },
      agentComponentSessionUsage: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([nullHashUsage])
          .mockResolvedValueOnce([]),
        updateMany: () => Promise.resolve({ count: 0 }),
      },
    };

    const counts = await runBackfill(client, { log: () => {} });

    expect(counts.usageRowsUnresolved).toBe(1);
    expect(counts.usageRowsLinked).toBe(0);
  });

  it("defaults to console.info when no log sink is provided", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {
      // silence real console output
    });
    try {
      const { client } = makeFakeClient({ coarse: [], usage: [] });

      await runBackfill(client);

      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("[backfill-definition-versions] done:")
      );
    } finally {
      infoSpy.mockRestore();
    }
  });
});
