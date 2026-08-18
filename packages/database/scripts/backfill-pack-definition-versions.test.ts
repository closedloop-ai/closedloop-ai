/**
 * FEA-3909 / PRD-527 F4 — DB-free unit tests for the conservative
 * pack-membership → definition-version backfill.
 *
 * These drive the exported `runPackBackfill` against a faithful in-memory
 * `PackBackfillClient` fake (NO database, matching the Slice-3 writer + Slice-5
 * backfill posture) and prove the F4 contracts:
 *
 *  1. LINK: a content-bearing pack member is linked to an exact `DefinitionVersion`
 *     and gets a `pack` `SourceOccurrence(packId = <top-level pack id>)`.
 *  2. MANY-TO-MANY (PD3): the SAME body in two packs mints ONE version and one
 *     `pack` occurrence per distinct pack id — the version is referenced, never
 *     copied.
 *  3. CONSERVATIVE (PD5): a member with no stored body (null/empty content), and an
 *     org-less global/curated member, stay `definitionVersionId = NULL` — never a
 *     minted/invented version.
 *  4. IDEMPOTENT: a second run over already-linked state links nothing and creates
 *     no new occurrences.
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
import { describe, expect, it } from "vitest";
import {
  type PackBackfillClient,
  type PackMemberVersionRow,
  runPackBackfill,
} from "./backfill-pack-definition-versions";

const SCRIPT_PATH = fileURLToPath(
  new URL("./backfill-pack-definition-versions.ts", import.meta.url)
);
const TSX_BIN = fileURLToPath(
  new URL("../node_modules/.bin/tsx", import.meta.url)
);

// ---------------------------------------------------------------------------
// In-memory fake rows (superset of the columns the backfill reads/writes).
// ---------------------------------------------------------------------------

type MemberRow = {
  id: string;
  content: string | null;
  definitionVersionId: string | null;
  organizationId: string | null;
  targetKind: string;
  parentPackId: string | null;
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
  packId: string;
  lastSeenAt: Date;
};

/**
 * A tiny, faithful in-memory `PackBackfillClient`. Models only the query shapes
 * the backfill issues — the paged id-ordered member scan (filtered to pack members
 * with a still-NULL link), the `(org, definitionHash)` version upsert, the
 * NULL-target `pack` occurrence find/create/update, and the null-guarded member
 * `updateMany` — so the semantics under test are the real ones.
 */
function makeFakeClient(seed: { members: MemberRow[] }): {
  client: PackBackfillClient;
  members: MemberRow[];
  versions: VersionRow[];
  occurrences: OccurrenceRow[];
} {
  const members = seed.members.map((r) => ({ ...r }));
  const versions: VersionRow[] = [];
  const occurrences: OccurrenceRow[] = [];
  let versionSeq = 0;
  let occurrenceSeq = 0;

  function pageById(
    rows: MemberRow[],
    args: { take?: number; cursor?: { id: string }; skip?: number }
  ): MemberRow[] {
    const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
    let start = 0;
    if (args.cursor) {
      const idx = sorted.findIndex((r) => r.id === args.cursor?.id);
      start = idx === -1 ? sorted.length : idx + (args.skip ?? 0);
    }
    return sorted.slice(start, start + (args.take ?? sorted.length));
  }

  const client: PackBackfillClient = {
    catalogItemVersion: {
      findMany: (args) => {
        // The scan filter mirrors production's `where`: pack members
        // (`parentPackId != null`) ONLY. It deliberately does NOT filter on
        // `definitionVersionId == null`, because the scan stamps that column as it
        // pages — filtering on it would shrink the result set mid-sweep and drop a
        // member per page boundary (the bug this fake now proves is fixed).
        // Idempotency lives in the null-guarded `updateMany` below instead.
        const scoped = members.filter((m) => m.parentPackId != null);
        const page = pageById(scoped, args);
        const rows: PackMemberVersionRow[] = page.map((m) => ({
          id: m.id,
          content: m.content,
          definitionVersionId: m.definitionVersionId,
          catalogItem: {
            organizationId: m.organizationId,
            targetKind: m.targetKind,
            parentPackId: m.parentPackId,
          },
        }));
        return Promise.resolve(rows);
      },
      updateMany: (args) => {
        const where = args.where as {
          id: string;
          definitionVersionId: null;
        };
        const hit = members.find(
          (m) => m.id === where.id && m.definitionVersionId == null
        );
        if (!hit) {
          return Promise.resolve({ count: 0 });
        }
        hit.definitionVersionId = (
          args.data as { definitionVersionId: string }
        ).definitionVersionId;
        return Promise.resolve({ count: 1 });
      },
    },
    definitionVersion: {
      upsert: (args) => {
        const where = args.where.organizationId_definitionHash as {
          organizationId: string;
          definitionHash: string;
        };
        const existing = versions.find(
          (v) =>
            v.organizationId === where.organizationId &&
            v.definitionHash === where.definitionHash
        );
        if (existing) {
          return Promise.resolve({ id: existing.id });
        }
        versionSeq += 1;
        const created: VersionRow = {
          id: `dv-${versionSeq}`,
          organizationId: where.organizationId,
          definitionHash: where.definitionHash,
          componentKind: (args.create as { componentKind: string })
            .componentKind,
        };
        versions.push(created);
        return Promise.resolve({ id: created.id });
      },
    },
    sourceOccurrence: {
      findFirst: (args) => {
        const where = args.where as {
          definitionVersionId: string;
          occurrenceType: string;
          packId: string;
          computeTargetId: string | null;
        };
        const hit = occurrences.find(
          (o) =>
            o.definitionVersionId === where.definitionVersionId &&
            o.occurrenceType === where.occurrenceType &&
            o.packId === where.packId &&
            o.computeTargetId === (where.computeTargetId ?? null)
        );
        return Promise.resolve(hit ? { id: hit.id } : null);
      },
      create: (args) => {
        const data = args.data as {
          organizationId: string;
          definitionVersionId: string;
          occurrenceType: string;
          packId: string;
          lastSeenAt: Date;
        };
        occurrenceSeq += 1;
        const created: OccurrenceRow = {
          id: `so-${occurrenceSeq}`,
          organizationId: data.organizationId,
          definitionVersionId: data.definitionVersionId,
          occurrenceType: data.occurrenceType,
          computeTargetId: null,
          packId: data.packId,
          lastSeenAt: data.lastSeenAt,
        };
        occurrences.push(created);
        return Promise.resolve({ id: created.id });
      },
      update: (args) => {
        const hit = occurrences.find((o) => o.id === args.where.id);
        if (hit) {
          hit.lastSeenAt = (args.data as { lastSeenAt: Date }).lastSeenAt;
        }
        return Promise.resolve({ id: args.where.id });
      },
    },
  };

  return { client, members, versions, occurrences };
}

const ORG_A = "org-a";
const KIND = "skill";
const NO_LOG = () => {
  // silence progress logs in tests
};

// ---------------------------------------------------------------------------

describe("runPackBackfill (FEA-3909 / F4)", () => {
  it("links a content-bearing pack member to an exact DefinitionVersion and writes a pack SourceOccurrence (packId = top-level pack id)", async () => {
    const content = "# Pack Skill\n\nreusable body.\n";
    const { client, members, versions, occurrences } = makeFakeClient({
      members: [
        {
          id: "civ-1",
          content,
          definitionVersionId: null,
          organizationId: ORG_A,
          targetKind: KIND,
          parentPackId: "pack-1",
        },
      ],
    });

    const counts = await runPackBackfill(client, { log: NO_LOG });

    expect(counts.membersLinked).toBe(1);
    expect(counts.versionsUpserted).toBe(1);
    expect(counts.packOccurrencesCreated).toBe(1);

    // The version's hash is the SSOT provenance-free fingerprint of the body.
    const { definitionHash } = computeDefinitionHash({
      frontmatter: "",
      body: content,
      kind: KIND as never,
    });
    expect(versions).toHaveLength(1);
    expect(versions[0].definitionHash).toBe(definitionHash);

    // The member row is stamped with the link.
    expect(members[0].definitionVersionId).toBe(versions[0].id);

    // A `pack` occurrence carrying the top-level pack id, null compute target.
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].occurrenceType).toBe("pack");
    expect(occurrences[0].packId).toBe("pack-1");
    expect(occurrences[0].computeTargetId).toBeNull();
    expect(occurrences[0].definitionVersionId).toBe(versions[0].id);
  });

  it("many-to-many (PD3): the SAME body in two packs mints ONE DefinitionVersion and one pack occurrence per pack — never a copy", async () => {
    const content = "# Shared\n\nlives in two packs.\n";
    const { client, versions, occurrences } = makeFakeClient({
      members: [
        {
          id: "civ-1",
          content,
          definitionVersionId: null,
          organizationId: ORG_A,
          targetKind: KIND,
          parentPackId: "pack-A",
        },
        {
          id: "civ-2",
          content,
          definitionVersionId: null,
          organizationId: ORG_A,
          targetKind: KIND,
          parentPackId: "pack-B",
        },
      ],
    });

    const counts = await runPackBackfill(client, { log: NO_LOG });

    expect(counts.membersLinked).toBe(2);
    // ONE version referenced by both packs.
    expect(counts.versionsUpserted).toBe(1);
    expect(versions).toHaveLength(1);
    // Two distinct pack occurrences, one per pack id.
    expect(counts.packOccurrencesCreated).toBe(2);
    expect(occurrences).toHaveLength(2);
    const packIds = occurrences.map((o) => o.packId).sort();
    expect(packIds).toEqual(["pack-A", "pack-B"]);
    for (const occ of occurrences) {
      expect(occ.definitionVersionId).toBe(versions[0].id);
    }
  });

  it("conservative (PD5): a member with no stored body (null / empty content) and an org-less member stay definitionVersionId = NULL — never minted", async () => {
    const { client, members, versions, occurrences } = makeFakeClient({
      members: [
        {
          id: "civ-null",
          content: null,
          definitionVersionId: null,
          organizationId: ORG_A,
          targetKind: KIND,
          parentPackId: "pack-1",
        },
        {
          id: "civ-empty",
          content: "",
          definitionVersionId: null,
          organizationId: ORG_A,
          targetKind: KIND,
          parentPackId: "pack-1",
        },
        {
          id: "civ-global",
          content: "# Global\n",
          definitionVersionId: null,
          organizationId: null, // global/curated — no org to key a version under
          targetKind: KIND,
          parentPackId: "pack-1",
        },
      ],
    });

    const counts = await runPackBackfill(client, { log: NO_LOG });

    expect(counts.membersLinked).toBe(0);
    expect(counts.versionsUpserted).toBe(0);
    expect(counts.packOccurrencesCreated).toBe(0);
    expect(counts.membersUnresolved).toBe(3);
    expect(versions).toHaveLength(0);
    expect(occurrences).toHaveLength(0);
    for (const m of members) {
      expect(m.definitionVersionId).toBeNull();
    }
  });

  it("is idempotent: a second run over already-linked state links nothing and creates no new occurrences", async () => {
    const content = "# Idem\n";
    const { client, versions, occurrences } = makeFakeClient({
      members: [
        {
          id: "civ-1",
          content,
          definitionVersionId: null,
          organizationId: ORG_A,
          targetKind: KIND,
          parentPackId: "pack-1",
        },
      ],
    });

    const first = await runPackBackfill(client, { log: NO_LOG });
    expect(first.membersLinked).toBe(1);
    expect(occurrences).toHaveLength(1);
    const firstOccurrenceLastSeen = occurrences[0].lastSeenAt;

    const second = await runPackBackfill(client, { log: NO_LOG });
    // The scan no longer filters on the link column (that would drop a member per
    // page boundary), so a re-run DOES re-scan the already-linked member — but it
    // is SKIPPED in-code before any upsert: counted as already-linked (not
    // unresolved), never re-touched.
    expect(second.membersAlreadyLinked).toBe(1);
    expect(second.membersScanned).toBe(0);
    expect(second.membersLinked).toBe(0);
    expect(second.membersUnresolved).toBe(0);
    expect(second.versionsUpserted).toBe(0);
    expect(second.packOccurrencesCreated).toBe(0);
    // Still exactly one version + one occurrence — no duplication...
    expect(versions).toHaveLength(1);
    expect(occurrences).toHaveLength(1);
    // ...and the existing occurrence's freshness was NOT bumped on the clean
    // re-run (the already-linked member is skipped before the occurrence upsert).
    expect(occurrences[0].lastSeenAt).toEqual(firstOccurrenceLastSeen);
  });

  it("commits each page in its own transaction (per-page runPageTransaction), so lock windows stay bounded", async () => {
    const { client } = makeFakeClient({
      members: [
        {
          id: "civ-1",
          content: "# One\n",
          definitionVersionId: null,
          organizationId: ORG_A,
          targetKind: KIND,
          parentPackId: "pack-1",
        },
        {
          id: "civ-2",
          content: "# Two\n",
          definitionVersionId: null,
          organizationId: ORG_A,
          targetKind: KIND,
          parentPackId: "pack-1",
        },
      ],
    });

    // One transaction opened PER PAGE (pageSize=1 ⇒ two content pages), proving
    // the sweep no longer runs inside a single long-lived transaction.
    let pageTransactions = 0;
    const counts = await runPackBackfill(client, {
      log: NO_LOG,
      pageSize: 1,
      runPageTransaction: (body) => {
        pageTransactions += 1;
        return body(client);
      },
    });

    expect(pageTransactions).toBe(2);
    expect(counts.membersLinked).toBe(2);
  });

  it("dedupes byte-identical content ACROSS pages via the DB upsert (per-page cache is cleared, so memory stays O(pageSize))", async () => {
    const content = "# Same Body Across Pages\n";
    const { client, versions, occurrences } = makeFakeClient({
      members: [
        {
          id: "civ-1",
          content,
          definitionVersionId: null,
          organizationId: ORG_A,
          targetKind: KIND,
          parentPackId: "pack-A",
        },
        {
          id: "civ-2",
          content, // identical body, but forced onto a SEPARATE page
          definitionVersionId: null,
          organizationId: ORG_A,
          targetKind: KIND,
          parentPackId: "pack-B",
        },
      ],
    });

    // pageSize=1 puts the two identical-content members on different pages, so the
    // per-page cache is cleared between them — cross-page dedupe is proven to come
    // from the `(org, definitionHash)` DB upsert, not an unbounded in-memory cache.
    const counts = await runPackBackfill(client, { log: NO_LOG, pageSize: 1 });

    expect(counts.membersLinked).toBe(2);
    // ONE version despite the cleared cache (DB upsert dedupes across pages)...
    expect(versions).toHaveLength(1);
    // ...but two distinct pack occurrences, one per pack id.
    expect(occurrences).toHaveLength(2);
  });

  it("does not drop a member at a page boundary: paging with pageSize=1 links every content-bearing member (FEA-3909 F4 regression)", async () => {
    // Three distinct-content members across two packs, forced onto separate pages
    // (pageSize=1). The scan stamps `definitionVersionId` as it goes; if the scan
    // `where` also filtered on `definitionVersionId: null` (the bug), the
    // `cursor + skip:1` paging would silently skip one still-unlinked member per
    // boundary and leave it NULL. With the filter removed, every member links.
    const { client, members, versions } = makeFakeClient({
      members: [
        {
          id: "civ-1",
          content: "# One\n",
          definitionVersionId: null,
          organizationId: ORG_A,
          targetKind: KIND,
          parentPackId: "pack-1",
        },
        {
          id: "civ-2",
          content: "# Two\n",
          definitionVersionId: null,
          organizationId: ORG_A,
          targetKind: KIND,
          parentPackId: "pack-1",
        },
        {
          id: "civ-3",
          content: "# Three\n",
          definitionVersionId: null,
          organizationId: ORG_A,
          targetKind: KIND,
          parentPackId: "pack-2",
        },
      ],
    });

    const counts = await runPackBackfill(client, { log: NO_LOG, pageSize: 1 });

    // All three members linked — none dropped at a page boundary.
    expect(counts.membersLinked).toBe(3);
    expect(counts.membersUnresolved).toBe(0);
    expect(versions).toHaveLength(3);
    for (const m of members) {
      expect(m.definitionVersionId).not.toBeNull();
    }
  });
});

/**
 * The Vitest suite above aliases `server-only` to an empty stub, so it CANNOT
 * catch a top-level `import "server-only"` (whose real default export throws on
 * import) breaking the CLI. This runs the script through the SAME `tsx` runner
 * the package script uses (`backfill:pack-definition-versions`) in a child
 * process — the real Node module-resolution path — and asserts the module
 * imports without throwing. It imports (not invokes `main`), so no database is
 * touched: `main`'s `import.meta.url === process.argv[1]` gate is false under
 * `--eval`, and the heavy `@repo/database` graph stays deferred inside `main`.
 */
describe("CLI entrypoint resolution (real tsx runner, no server-only mask)", () => {
  function importUnderTsx(): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        TSX_BIN,
        ["--eval", `import(${JSON.stringify(SCRIPT_PATH)}).then(() => {});`],
        { timeout: 60_000 },
        (error, _stdout, stderr) => {
          // A non-zero exit is reported via `error.code`; surface it as data, not
          // a rejection, so the assertion can inspect the stderr.
          const code =
            error && typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : 0;
          resolve({ code, stderr: stderr ?? "" });
        }
      );
      // Spawn failure (e.g. tsx missing) must fail the test, not hang it.
      child.on("error", reject);
    });
  }

  it("imports the script through tsx without throwing (server-only marker removed)", async () => {
    const { code, stderr } = await importUnderTsx();
    expect(stderr).not.toContain("cannot be imported from a Client Component");
    expect(code).toBe(0);
  }, 60_000);
});
