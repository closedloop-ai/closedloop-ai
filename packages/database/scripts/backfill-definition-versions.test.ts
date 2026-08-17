/**
 * FEA-3290 (F1, Slice 5) — DB-free unit tests for the conservative
 * definition-version backfill.
 *
 * These drive the exported `runBackfill` against a faithful in-memory
 * `BackfillClient` fake (NO database, matching the Slice-3 writer's posture) and
 * prove the three contracts the reviewers flagged:
 *
 *  1. ORG-SCOPING (P0 security/correctness): two orgs with byte-identical
 *     content + identical `(kind, key, contentHash)` each resolve their usage
 *     ONLY to their own org's DefinitionVersion — never the other org's.
 *  2. CONSERVATIVE (AC-8): empty-content coarse rows mint nothing, and usage with
 *     no matching stored revision stays unresolved (link left NULL).
 *  3. IDEMPOTENT: a second run over the already-stamped state touches zero rows.
 */

import { describe, expect, it } from "vitest";
import {
  type BackfillClient,
  type CoarseVersionRow,
  runBackfill,
  type UsageRow,
} from "./backfill-definition-versions";

// ---------------------------------------------------------------------------
// In-memory fake rows (superset of the columns the backfill reads/writes).
// ---------------------------------------------------------------------------

type CoarseRow = CoarseVersionRow;

type UsageRecord = {
  id: string;
  organizationId: string; // owning org (usage -> session -> artifact.org)
  componentKind: string;
  componentKey: string;
  componentVersionHash: string | null;
  definitionVersionId: string | null;
};

type VersionRow = {
  id: string;
  organizationId: string;
  definitionHash: string;
  componentKind: string;
};

type OccurrenceRow = {
  id: string;
  organizationId: string;
  definitionVersionId: string;
  occurrenceType: string;
  computeTargetId: string | null;
  lastSeenAt: Date;
};

/**
 * A tiny, faithful in-memory `BackfillClient`. Models only the query shapes the
 * backfill actually issues — paged id-ordered scans, the org-scoped resolve
 * lookup, null-guarded `updateMany`, and the occurrence find/create/update — so
 * the semantics under test are the real ones, not a rubber stamp.
 */
function makeFakeClient(seed: { coarse: CoarseRow[]; usage: UsageRecord[] }): {
  client: BackfillClient;
  coarse: CoarseRow[];
  usage: UsageRecord[];
  versions: VersionRow[];
  occurrences: OccurrenceRow[];
} {
  const coarse = seed.coarse.map((r) => ({ ...r }));
  const usage = seed.usage.map((r) => ({ ...r }));
  const versions: VersionRow[] = [];
  const occurrences: OccurrenceRow[] = [];
  let versionSeq = 0;
  let occurrenceSeq = 0;

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
        // The Phase-2 resolve lookup: filter by org + (kind, key, contentHash) +
        // a non-null link. When `where` has these keys, serve the resolve path.
        if ("contentHash" in where || "componentKey" in where) {
          const matches = coarse.filter((r) => {
            if (
              "organizationId" in where &&
              r.organizationId !== where.organizationId
            ) {
              return false;
            }
            if (
              "componentKind" in where &&
              r.componentKind !== where.componentKind
            ) {
              return false;
            }
            if (
              "componentKey" in where &&
              r.componentKey !== where.componentKey
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
              // `{ not: null }`
              return false;
            }
            return true;
          });
          const take = args.take ?? matches.length;
          return Promise.resolve(matches.slice(0, take) as CoarseVersionRow[]);
        }
        // Otherwise the Phase-1 full paged scan.
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
          componentKind: string;
        };
        versionSeq += 1;
        const id = `ver-${versionSeq}`;
        versions.push({
          id,
          organizationId: create.organizationId,
          definitionHash: create.definitionHash,
          componentKind: create.componentKind,
        });
        return Promise.resolve({ id });
      },
    },
    sourceOccurrence: {
      findFirst: (args) => {
        const where = args.where as {
          organizationId: string;
          definitionVersionId: string;
        };
        const hit = occurrences.find(
          (o) =>
            o.organizationId === where.organizationId &&
            o.definitionVersionId === where.definitionVersionId
        );
        return Promise.resolve(hit ? { id: hit.id } : null);
      },
      create: (args) => {
        const data = args.data as {
          organizationId: string;
          definitionVersionId: string;
          occurrenceType: string;
          computeTargetId: string | null;
          lastSeenAt: Date;
        };
        occurrenceSeq += 1;
        const id = `occ-${occurrenceSeq}`;
        occurrences.push({
          id,
          organizationId: data.organizationId,
          definitionVersionId: data.definitionVersionId,
          occurrenceType: data.occurrenceType,
          computeTargetId: data.computeTargetId,
          lastSeenAt: data.lastSeenAt,
        });
        return Promise.resolve({ id });
      },
      update: (args) => {
        const hit = occurrences.find((o) => o.id === args.where.id);
        if (hit) {
          hit.lastSeenAt = (args.data as { lastSeenAt: Date }).lastSeenAt;
        }
        return Promise.resolve({ id: args.where.id });
      },
    },
    agentComponentSessionUsage: {
      findMany: (args) => {
        const where = (args.where ?? {}) as Record<string, unknown>;
        // The Phase-2 page scan: componentVersionHash != null AND link == null.
        const eligible = usage.filter((u) => {
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
        const page = pageById(eligible, args);
        // Shape each row with the nested session -> artifact -> org join the
        // backfill selects and reads for org-scoping.
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
        const where = args.where as {
          id: string;
          definitionVersionId: null;
        };
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

  return { client, coarse, usage, versions, occurrences };
}

const SHARED_CONTENT = "You are a careful reviewer.\nBe concise.\n";
const SHARED_HASH = "sha256:identical-across-orgs";

function coarseRow(over: Partial<CoarseRow> & { id: string }): CoarseRow {
  return {
    organizationId: "org-a",
    componentKind: "agent",
    componentKey: "reviewer",
    source: "local",
    contentHash: SHARED_HASH,
    content: SHARED_CONTENT,
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
    componentVersionHash: SHARED_HASH,
    definitionVersionId: null,
    ...over,
  };
}

describe("runBackfill — org-scoped conservative definition-version backfill", () => {
  it("keeps Phase-2 usage links org-isolated when two orgs share identical content + hash", async () => {
    // Two orgs, byte-identical component content, identical (kind, key, contentHash).
    // Each org has one coarse revision and one usage bucket referencing the shared hash.
    const { client, usage, versions } = makeFakeClient({
      coarse: [
        coarseRow({ id: "cv-a", organizationId: "org-a" }),
        coarseRow({ id: "cv-b", organizationId: "org-b" }),
      ],
      usage: [
        usageRow({ id: "u-a", organizationId: "org-a" }),
        usageRow({ id: "u-b", organizationId: "org-b" }),
      ],
    });

    const counts = await runBackfill(client, { log: () => {} });

    // Two distinct orgs with identical content ⇒ two distinct DefinitionVersions.
    expect(versions).toHaveLength(2);
    const verA = versions.find((v) => v.organizationId === "org-a");
    const verB = versions.find((v) => v.organizationId === "org-b");
    expect(verA).toBeDefined();
    expect(verB).toBeDefined();
    expect(verA?.id).not.toBe(verB?.id);

    const usageA = usage.find((u) => u.id === "u-a");
    const usageB = usage.find((u) => u.id === "u-b");

    // THE cross-org isolation assertion: each usage row links to ITS OWN org's
    // version, and NEVER to the other org's version.
    expect(usageA?.definitionVersionId).toBe(verA?.id);
    expect(usageB?.definitionVersionId).toBe(verB?.id);
    expect(usageA?.definitionVersionId).not.toBe(verB?.id);
    expect(usageB?.definitionVersionId).not.toBe(verA?.id);

    expect(counts.usageRowsLinked).toBe(2);
    expect(counts.usageRowsUnresolved).toBe(0);
  });

  it("never links a usage row to a version that exists ONLY in another org", async () => {
    // Only org-b has a stored coarse revision for the shared hash. org-a's usage
    // references the same hash but has NO org-a revision — it must stay NULL,
    // never borrow org-b's version.
    const { client, usage, versions } = makeFakeClient({
      coarse: [coarseRow({ id: "cv-b", organizationId: "org-b" })],
      usage: [
        usageRow({ id: "u-a", organizationId: "org-a" }),
        usageRow({ id: "u-b", organizationId: "org-b" }),
      ],
    });

    const counts = await runBackfill(client, { log: () => {} });

    expect(versions).toHaveLength(1);
    const verB = versions[0];
    expect(verB.organizationId).toBe("org-b");

    const usageA = usage.find((u) => u.id === "u-a");
    const usageB = usage.find((u) => u.id === "u-b");

    // org-a's usage has no same-org version ⇒ unresolved (NOT org-b's version).
    expect(usageA?.definitionVersionId).toBeNull();
    // org-b's usage links to its own version.
    expect(usageB?.definitionVersionId).toBe(verB.id);

    expect(counts.usageRowsLinked).toBe(1);
    expect(counts.usageRowsUnresolved).toBe(1);
  });

  it("is conservative: empty-content coarse rows mint nothing and their usage stays unresolved", async () => {
    const { client, usage, versions, coarse } = makeFakeClient({
      coarse: [coarseRow({ id: "cv-empty", content: "" })],
      usage: [usageRow({ id: "u-empty" })],
    });

    const counts = await runBackfill(client, { log: () => {} });

    expect(versions).toHaveLength(0);
    expect(coarse[0].definitionVersionId).toBeNull();
    expect(usage[0].definitionVersionId).toBeNull();
    expect(counts.versionsUpserted).toBe(0);
    expect(counts.coarseRowsLinked).toBe(0);
    expect(counts.usageRowsLinked).toBe(0);
    expect(counts.usageRowsUnresolved).toBe(1);
  });

  it("is idempotent: a second run over already-stamped state touches zero rows", async () => {
    const fake = makeFakeClient({
      coarse: [
        coarseRow({ id: "cv-a", organizationId: "org-a" }),
        coarseRow({ id: "cv-b", organizationId: "org-b" }),
      ],
      usage: [
        usageRow({ id: "u-a", organizationId: "org-a" }),
        usageRow({ id: "u-b", organizationId: "org-b" }),
      ],
    });

    const first = await runBackfill(fake.client, { log: () => {} });
    expect(first.coarseRowsLinked).toBe(2);
    expect(first.usageRowsLinked).toBe(2);

    const second = await runBackfill(fake.client, { log: () => {} });
    // Idempotency is a NO-MUTATION invariant: no new occurrence created, and no
    // coarse/usage link stamped (the WHERE clauses guard on NULL). `versionsUpserted`
    // counts create-or-touch upserts by design (see BackfillCounts), so it stays 2
    // — the touch just moves `lastSeenAt`, mutating nothing that matters here.
    expect(second.occurrencesCreated).toBe(0);
    expect(second.coarseRowsLinked).toBe(0);
    expect(second.usageRowsLinked).toBe(0);
    // Nothing left to resolve on the second pass (all links already set).
    expect(second.usageRowsUnresolved).toBe(0);
    // The registry is unchanged: still exactly the two org-distinct versions.
    expect(fake.versions).toHaveLength(2);
    expect(fake.occurrences).toHaveLength(2);
  });
});
