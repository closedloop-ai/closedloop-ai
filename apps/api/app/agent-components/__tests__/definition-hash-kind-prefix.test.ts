/**
 * ISS-7273: `resolveInventoryDefinitionHashes` filtered `agent_component_versions`
 * on `organization_id` + `content_hash IN (...)` and omitted `component_kind` —
 * the MIDDLE column of `agent_component_versions_org_kind_content_hash_idx`, the
 * only index built for this lookup. Postgres has no skip-scan, so a leading-column
 * -only predicate cannot seek the hash list; every Agents catalog request walked
 * the org's whole version partition instead. ISS-5516 removed the row cap that
 * used to keep that partition small, so the scan grows with the org.
 *
 * WHY THE ASSERTION IS ON THE EMITTED `where`, NOT ON THE RETURNED MAP. The fix
 * is deliberately behaviour-identical: the fold keys on the full
 * `(kind, key, contentHash)` identity and already discarded every row of a kind no
 * identity asked for, so a result-only test passes just as well against the
 * defect — it cannot fail under the mutation it claims to prevent. The index
 * prefix is only observable in the predicate the read actually issues, read off a
 * `findMany` double, so that is what is asserted. The result assertion rides along
 * to prove the narrowing did not also change the answer.
 */
import { describe, expect, it, vi } from "vitest";

// The module imports `@repo/database` only for a `typeof withDb` type and is
// called with a caller-supplied `db`; mock it so the module loads without a real
// client.
vi.mock("@repo/database", () => ({
  Prisma: {},
  withDb: vi.fn(),
}));

import {
  inventoryVersionIdentityKey,
  resolveInventoryDefinitionHashes,
} from "../definition-hash-resolution";

const ORG = "org-1";

type FindManyArgs = {
  where: {
    organizationId: string;
    componentKind?: { in: string[] };
    contentHash: { in: string[] };
  };
};

type VersionRow = {
  componentKind: string;
  componentKey: string | null;
  contentHash: string;
  definitionVersion: { definitionHash: string } | null;
};

/**
 * An `agentComponentVersion.findMany` double that records every emitted `where`
 * and answers with the rows the recorded predicate actually selects — so a
 * predicate that narrows wrongly shows up in the returned map too, rather than
 * being masked by a double that answers unconditionally.
 */
function makeFakeDb(rows: readonly VersionRow[]) {
  const findMany = vi.fn((args: FindManyArgs) => {
    const kinds = args.where.componentKind?.in;
    return Promise.resolve(
      rows.filter(
        (row) =>
          args.where.contentHash.in.includes(row.contentHash) &&
          (kinds === undefined || kinds.includes(row.componentKind))
      )
    );
  });
  return {
    db: {
      agentComponentVersion: { findMany },
    } as unknown as Parameters<typeof resolveInventoryDefinitionHashes>[0],
    findMany,
  };
}

const SKILL_ROW: VersionRow = {
  componentKind: "skill",
  componentKey: "review",
  contentHash: "hash-a",
  definitionVersion: { definitionHash: "def-skill" },
};

/**
 * Same `contentHash` as `SKILL_ROW`, different kind — the whitlockk collision
 * FEA-4098 documents. It shares the hash `IN` list, so it is exactly the row the
 * unnarrowed read used to drag back and then throw away.
 */
const COMMAND_ROW: VersionRow = {
  componentKind: "command",
  componentKey: "review",
  contentHash: "hash-a",
  definitionVersion: { definitionHash: "def-command" },
};

describe("resolveInventoryDefinitionHashes index prefix (ISS-7273)", () => {
  it("names the distinct kinds so the read seeks the (org, kind, content_hash) index", async () => {
    const { db, findMany } = makeFakeDb([SKILL_ROW, COMMAND_ROW]);

    await resolveInventoryDefinitionHashes(db, ORG, [
      { componentKind: "skill", componentKey: "review", contentHash: "hash-a" },
      { componentKind: "skill", componentKey: "lint", contentHash: "hash-b" },
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
    const where = emittedWhere(findMany);
    expect(where.organizationId).toBe(ORG);
    // The middle index column has to be present AND deduped — a repeated kind
    // would still seek, but it would bind one parameter per inventory row.
    expect(where.componentKind).toEqual({ in: ["skill"] });
    expect([...where.contentHash.in].sort()).toEqual(["hash-a", "hash-b"]);
  });

  it("keeps every kind an identity asked for, so the narrowing changes no answer", async () => {
    const { db, findMany } = makeFakeDb([SKILL_ROW, COMMAND_ROW]);

    const { byIdentity } = await resolveInventoryDefinitionHashes(db, ORG, [
      { componentKind: "skill", componentKey: "review", contentHash: "hash-a" },
      {
        componentKind: "command",
        componentKey: "review",
        contentHash: "hash-a",
      },
    ]);

    const where = emittedWhere(findMany);
    expect([...(where.componentKind?.in ?? [])].sort()).toEqual([
      "command",
      "skill",
    ]);
    // Both identities still resolve to their OWN fingerprint: the collision the
    // composite key exists to keep apart survives the narrowing.
    expect(
      byIdentity.get(inventoryVersionIdentityKey("skill", "review", "hash-a"))
    ).toBe("def-skill");
    expect(
      byIdentity.get(inventoryVersionIdentityKey("command", "review", "hash-a"))
    ).toBe("def-command");
  });

  it("draws the kind list only from identities that carry a content hash", async () => {
    const { db, findMany } = makeFakeDb([SKILL_ROW]);

    await resolveInventoryDefinitionHashes(db, ORG, [
      { componentKind: "skill", componentKey: "review", contentHash: "hash-a" },
      // No hash, so this row cannot match anything the read returns; binding its
      // kind would only widen the seek back out.
      { componentKind: "hook", componentKey: "pre-commit", contentHash: null },
    ]);

    const where = emittedWhere(findMany);
    expect(where.componentKind).toEqual({ in: ["skill"] });
  });

  it("issues no read at all when no identity carries a content hash", async () => {
    const { db, findMany } = makeFakeDb([SKILL_ROW]);

    const { byIdentity } = await resolveInventoryDefinitionHashes(db, ORG, [
      { componentKind: "hook", componentKey: "pre-commit", contentHash: null },
    ]);

    expect(findMany).not.toHaveBeenCalled();
    expect(byIdentity.size).toBe(0);
  });
});

/**
 * The `where` the read actually emitted. Failing here names the missing read,
 * rather than letting an absent call surface as a property access on undefined.
 */
function emittedWhere(findMany: ReturnType<typeof makeFakeDb>["findMany"]) {
  const [call] = findMany.mock.calls;
  if (!call) {
    throw new Error("resolveInventoryDefinitionHashes issued no read");
  }
  return call[0].where;
}
