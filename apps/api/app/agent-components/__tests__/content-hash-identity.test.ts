/**
 * Unit tests for `resolveContentHashIdentity` (FEA-4335).
 *
 * `resolveContentHashIdentity` maps a content-hash route fingerprint back to the
 * name-level identity it covers. The security-relevant contract (shafty023, PR
 * #3907) is that the EXACT server-derived `definitionHash` namespace is never
 * unioned with the coarse, content-derived `contentHash` namespace: an exact
 * `definitionHash` route must resolve to definition-linked rows ONLY, and the
 * coarse `contentHash` match is a strict fallback used only when NO exact match
 * exists. This prevents a row whose coarse hash equals another component's exact
 * route fingerprint from masquerading as that route.
 *
 * `resolveContentHashIdentity` takes the Prisma delegate directly (no `withDb`),
 * so these tests drive it with a lightweight fake whose
 * `agentComponentVersion.findMany` returns per-`where` results.
 */

import { describe, expect, it, vi } from "vitest";
import { resolveContentHashIdentity } from "../content-hash-identity";

const ORG = "org-chi-1111";
const KIND = "subagent";
// Two distinct 64-hex fingerprints (the resolver only branches on the presence
// of a `definitionVersion.definitionHash` predicate, so the exact hex values
// only need to be well-formed and distinct).
const FINGERPRINT = "a".repeat(64);
const SPOOFED_COARSE_HASH = "b".repeat(64);

type VersionRow = { componentKey: string | null; contentHash: string };

/**
 * A fake `agentComponentVersion.findMany` that returns `exactRows` when the
 * `where` carries the exact `definitionVersion.definitionHash` predicate, and
 * `coarseRows` when it carries the coarse `contentHash` predicate. Lets a test
 * prove which query path resolved the identity without unioning the other.
 */
function makeDb(exactRows: VersionRow[], coarseRows: VersionRow[]) {
  const findMany = vi.fn((args: { where: Record<string, unknown> }) => {
    const where = args.where;
    if (where.definitionVersion) {
      return Promise.resolve(exactRows);
    }
    return Promise.resolve(coarseRows);
  });
  return {
    db: { agentComponentVersion: { findMany } } as never,
    findMany,
  };
}

describe("resolveContentHashIdentity (FEA-4335)", () => {
  it("resolves an exact definitionHash route WITHOUT unioning coarse-hash rows", async () => {
    // A legitimate exact-hash row AND a spoofed row whose COARSE contentHash
    // equals the same fingerprint. The exact query returns only the legitimate
    // row; the coarse query (which would surface the spoofed row) must never run.
    const legitimate: VersionRow = {
      componentKey: "reviewer",
      contentHash: "c".repeat(64),
    };
    const spoofed: VersionRow = {
      componentKey: "attacker-injected",
      contentHash: FINGERPRINT,
    };
    const { db, findMany } = makeDb([legitimate], [spoofed]);

    const identity = await resolveContentHashIdentity(
      db,
      ORG,
      KIND,
      FINGERPRINT
    );

    // Only the exact-hash row resolved; the spoofed coarse-hash row is absent.
    expect(identity).not.toBeNull();
    expect(identity?.keys).toEqual(["reviewer"]);
    expect(identity?.keys).not.toContain("attacker-injected");
    expect(identity?.contentHashes).toEqual([legitimate.contentHash]);
    // The coarse fallback query was never issued because an exact match existed.
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("falls back to the coarse contentHash match only when no exact match exists", async () => {
    // No exact definitionHash row (pre-F1 / coarse-hash route): the coarse
    // fallback resolves the identity.
    const coarse: VersionRow = {
      componentKey: "legacy-tool",
      contentHash: SPOOFED_COARSE_HASH,
    };
    const { db, findMany } = makeDb([], [coarse]);

    const identity = await resolveContentHashIdentity(
      db,
      ORG,
      KIND,
      SPOOFED_COARSE_HASH
    );

    expect(identity?.keys).toEqual(["legacy-tool"]);
    expect(identity?.contentHashes).toEqual([SPOOFED_COARSE_HASH]);
    // Two queries: the exact probe (empty) then the coarse fallback.
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("returns null when neither an exact nor a coarse row matches", async () => {
    const { db } = makeDb([], []);
    const identity = await resolveContentHashIdentity(
      db,
      ORG,
      KIND,
      FINGERPRINT
    );
    expect(identity).toBeNull();
  });

  it("returns the COMPLETE normalized key set when content is installed under multiple names", async () => {
    // Same exact content under two names → one identity, both keys.
    const rowA: VersionRow = {
      componentKey: "Reviewer",
      contentHash: "d".repeat(64),
    };
    const rowB: VersionRow = {
      componentKey: "code-review",
      contentHash: "d".repeat(64),
    };
    const { db } = makeDb([rowA, rowB], []);

    const identity = await resolveContentHashIdentity(
      db,
      ORG,
      KIND,
      FINGERPRINT
    );

    // Lowercased + deduped; both names present so no data is omitted downstream.
    expect(new Set(identity?.keys)).toEqual(
      new Set(["reviewer", "code-review"])
    );
    expect(identity?.contentHashes).toEqual([rowA.contentHash]);
  });
});
