/**
 * ISS-10815: the detail route's identity ladder for a fingerprint that NO
 * `AgentComponentVersion` and NO `AgentComponent` row records.
 *
 * That is not an edge case — it is how the catalog list addresses a large share
 * of its rows. `collapseToCanonicalFamilies` links a family at its
 * REPRESENTATIVE version's routable key, and the representative is the most
 * recently invoked version bucket, which for a usage-only bucket
 * (`foldOrphanUsageIntoMerged`) is a `componentVersionHash` a session carried and
 * nothing else stores. Before this ladder rung existed, that bare-hash link
 * resolved to `orphanOnly` with an EMPTY name: a confident, unnamed,
 * one-invocation record where the named family belonged.
 *
 * The fixture deliberately carries TWO families whose usage rows differ only in
 * the fingerprint they carry, so "resolved the right one" is distinguishable
 * from "resolved the only one", and the fake honours the `where` it is given so
 * a resolution that ignored the fingerprint could not pass.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDetailIdentityScope } from "../content-hash-identity";
import {
  DETAIL_IDENTITY_AMBIGUOUS_USAGE_FINGERPRINT_EVENT,
  detailIdentityAmbiguityThrottle,
} from "../detail-identity-telemetry";

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock("@repo/observability/log", () => ({
  log: { error: logError, warn: vi.fn(), info: vi.fn() },
}));

const ORG = "org-iss-10815";
const KIND = "skill";
/** The representative version of the `portfolio-rebalance` family. */
const USAGE_ONLY_FINGERPRINT = "b".repeat(64);
/** A DIFFERENT family's usage-only fingerprint — the wrong answer. */
const OTHER_FAMILY_FINGERPRINT = "c".repeat(64);
/** Carried by usage rows under two different names: unresolvable by design. */
const AMBIGUOUS_FINGERPRINT = "d".repeat(64);
/** Recorded nowhere at all. */
const UNKNOWN_FINGERPRINT = "e".repeat(64);
/** Carried only by rows whose normalized key is still the `''` column default. */
const NAMELESS_FINGERPRINT = "f".repeat(64);
/** One nameless row beside one real-named row for the SAME family. */
const MIXED_NAMELESS_FINGERPRINT = "a".repeat(64);

/** Two instance-unique subagent aliases of ONE rolled-up identity. */
const SUBAGENT_KIND = "subagent";
const SUBAGENT_ALIAS_FINGERPRINT = "1".repeat(64);
/** A single surviving alias — the "resolves to a name no list shows" case. */
const SUBAGENT_SOLO_FINGERPRINT = "2".repeat(64);
/** Reached only through the linked `definitionVersion` arm, never the carried one. */
const LINKED_ONLY_FINGERPRINT = "3".repeat(64);
/** A legacy component whose own name ends in `@<64 hex>`. */
const COMPOUND_LEGACY_NAME = `notify@${"9".repeat(64)}`;

const USAGE_ROWS: {
  fingerprint: string;
  componentKeyNormalized: string;
  kind?: string;
  /** Carried only by the linked-version arm, not by `componentVersionHash`. */
  linkedOnly?: boolean;
}[] = [
  {
    fingerprint: SUBAGENT_ALIAS_FINGERPRINT,
    componentKeyNormalized: "claude subagent a1b2c3d4",
    kind: SUBAGENT_KIND,
  },
  {
    fingerprint: SUBAGENT_ALIAS_FINGERPRINT,
    componentKeyNormalized: "claude subagent deadbeef",
    kind: SUBAGENT_KIND,
  },
  {
    fingerprint: SUBAGENT_SOLO_FINGERPRINT,
    componentKeyNormalized: "claude subagent feedface",
    kind: SUBAGENT_KIND,
  },
  {
    fingerprint: LINKED_ONLY_FINGERPRINT,
    componentKeyNormalized: "linked-family",
    linkedOnly: true,
  },
  {
    fingerprint: USAGE_ONLY_FINGERPRINT,
    componentKeyNormalized: "portfolio-rebalance",
  },
  {
    fingerprint: OTHER_FAMILY_FINGERPRINT,
    componentKeyNormalized: "cl-produce",
  },
  { fingerprint: AMBIGUOUS_FINGERPRINT, componentKeyNormalized: "deploy" },
  { fingerprint: AMBIGUOUS_FINGERPRINT, componentKeyNormalized: "release" },
  { fingerprint: NAMELESS_FINGERPRINT, componentKeyNormalized: "" },
  { fingerprint: MIXED_NAMELESS_FINGERPRINT, componentKeyNormalized: "" },
  {
    fingerprint: MIXED_NAMELESS_FINGERPRINT,
    componentKeyNormalized: "cl-ci-babysit",
  },
];

/**
 * A fake Prisma client for the three delegates the ladder walks. Every read
 * honours its own `where`, so a resolution that ignored the fingerprint — or
 * dropped the org/kind scope — resolves nothing rather than passing by luck.
 */
function makeDb(kind: string = KIND) {
  /** Which hash arm each grouped usage read bound, in call order. */
  const probedArms: ("carried" | "linked")[] = [];
  const usageGroupBy = vi.fn(
    (args: {
      by: string[];
      where: {
        componentKind: string;
        session: { artifact: { organizationId: string } };
        componentVersionHash?: string;
        definitionVersion?: { organizationId: string; definitionHash: string };
      };
    }) => {
      const { where } = args;
      if (
        where.componentKind !== kind ||
        where.session.artifact.organizationId !== ORG
      ) {
        return Promise.resolve([]);
      }
      const carried = where.componentVersionHash;
      const linked =
        where.definitionVersion?.organizationId === ORG
          ? where.definitionVersion.definitionHash
          : undefined;
      // Recorded, not asserted here: an assertion inside a mock is only as good
      // as the mock being reached. The test body reads `probedArms` instead.
      probedArms.push(carried === undefined ? "linked" : "carried");
      const wanted = carried ?? linked;
      const distinct = new Set(
        USAGE_ROWS.filter(
          (r) =>
            r.fingerprint === wanted &&
            (r.kind ?? KIND) === kind &&
            Boolean(r.linkedOnly) === (linked !== undefined)
        ).map((r) => r.componentKeyNormalized)
      );
      return Promise.resolve(
        [...distinct].map((componentKeyNormalized) => ({
          componentKeyNormalized,
        }))
      );
    }
  );
  const componentFindFirst = vi.fn(
    (args: {
      where: {
        organizationId: string;
        componentKind: string;
        OR: { componentKey?: { equals: string } }[];
      };
    }) => {
      const probed = args.where.OR.map((arm) => arm.componentKey?.equals).find(
        (v): v is string => typeof v === "string"
      );
      // Only the compound legacy name is installed; every other name probe
      // misses, exactly as before this rung existed.
      return Promise.resolve(
        probed === COMPOUND_LEGACY_NAME ? { id: "component-legacy" } : null
      );
    }
  );
  return {
    db: {
      // No version row and no inventory row carries any of these fingerprints —
      // that is the whole premise of this ladder rung.
      agentComponentVersion: { findMany: () => Promise.resolve([]) },
      agentComponent: {
        findMany: () => Promise.resolve([]),
        findFirst: componentFindFirst,
      },
      agentComponentSessionUsage: { groupBy: usageGroupBy },
    } as never,
    usageGroupBy,
    componentFindFirst,
    probedArms,
  };
}

const scopeFor = (
  fingerprint: string,
  legacyKey: string | null = null,
  kind: string = KIND
) =>
  resolveDetailIdentityScope(
    makeDb(kind).db,
    ORG,
    kind,
    fingerprint,
    legacyKey
  );

describe("detail identity for a usage-only fingerprint (ISS-10815)", () => {
  beforeEach(() => {
    logError.mockClear();
    detailIdentityAmbiguityThrottle.clear();
  });

  it("resolves the bare-hash route to the family its usage rows name", async () => {
    const scope = await scopeFor(USAGE_ONLY_FINGERPRINT);

    expect(scope.key).toBe("portfolio-rebalance");
    expect(scope.keys).toEqual(["portfolio-rebalance"]);
    expect(scope.orphanOnly).toBe(false);
    // ISS-10341: the fingerprint ADDRESSES the family, it does not narrow it, so
    // every aggregate on the page sums one population.
    expect(scope.usageContentScope).toBeNull();
  });

  it("resolves a DIFFERENT fingerprint to its own family, not the first one", async () => {
    const scope = await scopeFor(OTHER_FAMILY_FINGERPRINT);

    expect(scope.key).toBe("cl-produce");
    expect(scope.orphanOnly).toBe(false);
  });

  it("refuses to pick an arm when one fingerprint names two families, and counts it", async () => {
    const scope = await scopeFor(AMBIGUOUS_FINGERPRINT);

    // Neither `deploy` nor `release` — answering with either would be the very
    // defect this route is being fixed for.
    expect(scope.key).toBe("");
    expect(scope.orphanOnly).toBe(true);
    expect(logError).toHaveBeenCalledWith(
      DETAIL_IDENTITY_AMBIGUOUS_USAGE_FINGERPRINT_EVENT,
      expect.objectContaining({
        organizationId: ORG,
        kind: KIND,
        fingerprint: AMBIGUOUS_FINGERPRINT,
        matchedKeyCount: 2,
      })
    );
  });

  it("counts nothing when the fingerprint resolves cleanly", async () => {
    await scopeFor(USAGE_ONLY_FINGERPRINT);

    expect(logError).not.toHaveBeenCalled();
  });

  it("keeps the used-only fallback for a fingerprint nothing names", async () => {
    const scope = await scopeFor(UNKNOWN_FINGERPRINT);

    expect(scope.key).toBe("");
    expect(scope.keys).toEqual([]);
    expect(scope.orphanOnly).toBe(true);
    expect(scope.usageContentScope).toEqual({
      fingerprint: UNKNOWN_FINGERPRINT,
      contentHashes: [UNKNOWN_FINGERPRINT],
    });
    expect(logError).not.toHaveBeenCalled();
  });

  it("does not resolve a route from the normalized-key column default", async () => {
    const scope = await scopeFor(NAMELESS_FINGERPRINT);

    expect(scope.key).toBe("");
    expect(scope.orphanOnly).toBe(true);
  });

  it("does not let a nameless row make its own family look ambiguous", async () => {
    // This, not the case above, is what the `''` filter is load-bearing for. The
    // empty default is falsy, so dropping the filter still bottoms out in the
    // used-only path there; here it would count as a SECOND family, and a page
    // that resolves cleanly today would lose its name and its counts.
    const scope = await scopeFor(MIXED_NAMELESS_FINGERPRINT);

    expect(scope.key).toBe("cl-ci-babysit");
    expect(scope.orphanOnly).toBe(false);
    expect(logError).not.toHaveBeenCalled();
  });

  it("refuses a name-qualified id whose name is NOT one of the ambiguous families", async () => {
    // The name segment is request input, not evidence about the fingerprint. The
    // hash names `deploy` and `release`; a URL asserting `portfolio-rebalance`
    // describes a component this fingerprint does not address, and answering
    // with it would re-commit the very defect — through the URL this time.
    const scope = await scopeFor(AMBIGUOUS_FINGERPRINT, "portfolio-rebalance");

    expect(scope.key).toBe("");
    expect(scope.orphanOnly).toBe(true);
    expect(logError).toHaveBeenCalledWith(
      DETAIL_IDENTITY_AMBIGUOUS_USAGE_FINGERPRINT_EVENT,
      expect.objectContaining({ fingerprint: AMBIGUOUS_FINGERPRINT })
    );
  });

  it("resolves a name-qualified id whose name IS one of the ambiguous families", async () => {
    // Case-insensitively, and to the STORED family value rather than the
    // caller's spelling, so the scope never carries unvalidated request text.
    const scope = await scopeFor(AMBIGUOUS_FINGERPRINT, "  ReLeAsE  ");

    expect(scope.key).toBe("release");
    expect(scope.orphanOnly).toBe(false);
  });

  it("falls back to a name-qualified id's own name when the fingerprint proves nothing", async () => {
    const scope = await scopeFor(UNKNOWN_FINGERPRINT, "portfolio-rebalance");

    expect(scope.key).toBe("portfolio-rebalance");
    expect(scope.orphanOnly).toBe(false);
    expect(scope.usageContentScope).toBeNull();
  });

  it("lets the fingerprint outrank a name-qualified id's name when they disagree", async () => {
    const scope = await scopeFor(
      OTHER_FAMILY_FINGERPRINT,
      "portfolio-rebalance"
    );

    expect(scope.key).toBe("cl-produce");
  });

  it("stays silent when a name-qualified id resolves an ambiguous fingerprint", async () => {
    // The ambiguity decided nothing here — the caller's own name rendered the
    // right page — and an error-level event on a correct render is the noise
    // that gets a monitor ignored.
    const scope = await scopeFor(AMBIGUOUS_FINGERPRINT, "deploy");

    expect(scope.key).toBe("deploy");
    expect(scope.orphanOnly).toBe(false);
    expect(logError).not.toHaveBeenCalled();
  });

  it("never probes usage for a fingerprint that resolved version rows", async () => {
    const { usageGroupBy, db } = makeDb();
    const versioned = {
      ...(db as object),
      agentComponentVersion: {
        findMany: () =>
          Promise.resolve([
            {
              componentKey: "portfolio-rebalance",
              contentHash: "a".repeat(64),
            },
          ]),
      },
    } as never;

    const scope = await resolveDetailIdentityScope(
      versioned,
      ORG,
      KIND,
      USAGE_ONLY_FINGERPRINT,
      null
    );

    expect(scope.inventoryWhere).toEqual({
      contentHash: { in: ["a".repeat(64)] },
    });
    expect(usageGroupBy).not.toHaveBeenCalled();
  });

  it("probes BOTH hash arms, so a linked-version-only fingerprint still resolves", async () => {
    // The carried-`componentVersionHash` arm knows nothing about this hash; only
    // the `definitionVersion.definitionHash` join does. Splitting the `OR` into
    // two reads must not drop that arm — the fake asserts each call carries
    // exactly one, so a fused read fails rather than silently re-widening.
    const { db, usageGroupBy, probedArms } = makeDb();
    const scope = await resolveDetailIdentityScope(
      db,
      ORG,
      KIND,
      LINKED_ONLY_FINGERPRINT,
      null
    );

    expect(scope.key).toBe("linked-family");
    expect(scope.orphanOnly).toBe(false);
    expect(usageGroupBy).toHaveBeenCalledTimes(2);
    // Each read bound exactly one arm — a re-fused `OR` would record one call
    // carrying both, which is the plan regression the new index cannot survive.
    expect([...probedArms].sort()).toEqual(["carried", "linked"]);
  });

  it("folds instance-unique subagent aliases into the one identity the list publishes", async () => {
    // `foldOrphanUsageIntoMerged` minted this bare-hash slug from keys it had
    // ALREADY run through `normalizeSubagentIdentity`, so the list names one
    // `general-purpose` row. Counting the raw stored keys here would read two
    // aliases of that same component as an ambiguity and lose the page to the
    // used-only path — a "no component by that hash" answer for a component the
    // list just described.
    const scope = await scopeFor(
      SUBAGENT_ALIAS_FINGERPRINT,
      null,
      SUBAGENT_KIND
    );

    expect(scope.key).toBe("general-purpose");
    expect(scope.keys).toEqual(["general-purpose"]);
    expect(scope.orphanOnly).toBe(false);
    expect(logError).not.toHaveBeenCalled();
  });

  it("resolves a lone subagent alias to the rolled-up name, not the raw instance", async () => {
    // The other half of the same fold: one surviving alias resolved cleanly
    // before, but to `claude subagent feedface` — a per-instance name that
    // appears on no list and whose page sums one spawn instead of the family.
    const scope = await scopeFor(
      SUBAGENT_SOLO_FINGERPRINT,
      null,
      SUBAGENT_KIND
    );

    expect(scope.key).toBe("general-purpose");
  });

  it("resolves a legacy component NAMED `<name>@<64 hex>` as itself, not as a split", async () => {
    // `${kind}::${name}@${fingerprint}` is a spelling, not a reserved encoding:
    // `componentKey` is unconstrained against this shape. Without the compound
    // probe the qualified decoder's split stands, and the page resolves the
    // truncated `notify` family — or whichever component owns that hash.
    const { db, componentFindFirst, usageGroupBy } = makeDb();
    const scope = await resolveDetailIdentityScope(
      db,
      ORG,
      KIND,
      "9".repeat(64),
      "notify"
    );

    expect(scope.key).toBe(COMPOUND_LEGACY_NAME);
    expect(scope.keys).toEqual([COMPOUND_LEGACY_NAME]);
    expect(scope.orphanOnly).toBe(false);
    expect(scope.usageContentScope).toBeNull();
    expect(componentFindFirst).toHaveBeenCalled();
    // Settled before any rung believed the split, so no fingerprint work ran.
    expect(usageGroupBy).not.toHaveBeenCalled();
  });

  it("falls through to the fingerprint ladder when no such compound name is installed", async () => {
    // The probe must not capture the ordinary qualified route, which is the
    // spelling the list actually publishes.
    const scope = await scopeFor(USAGE_ONLY_FINGERPRINT, "portfolio-rebalance");

    expect(scope.key).toBe("portfolio-rebalance");
    expect(scope.orphanOnly).toBe(false);
  });
});
