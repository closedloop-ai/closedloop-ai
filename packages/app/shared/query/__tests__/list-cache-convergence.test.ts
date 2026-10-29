import { describe, expect, it } from "vitest";
import {
  CacheConvergence,
  type CacheConvergenceContract,
  type CacheConvergenceRule,
  convergingPrefixes,
  coveringPrefixes,
  excludedFamilies,
  isQueryKeyPrefixOf,
} from "../list-cache-convergence";

const LIST_FAMILY_NAME_PATTERN = /"list"/;
const COVERED_BY_CHAIN_PATTERN = /is not a prefix family/;
const COVERED_BY_ROOT_PATTERN = /namespace root/;

const sampleKeys = {
  all: ["sample"] as const,
  lists: () => ["sample", "list"] as const,
  list: (scope: string) => ["sample", "list", scope] as const,
  details: () => ["sample", "detail"] as const,
  archiveRoot: () => ["sample", "archive"] as const,
};

const sampleContract: CacheConvergenceContract<typeof sampleKeys> = {
  all: { prefix: CacheConvergence.Root },
  lists: { prefix: CacheConvergence.Always },
  list: { coveredBy: "lists" },
  details: { prefix: CacheConvergence.BroadOnly },
  archiveRoot: {
    prefix: CacheConvergence.Excluded,
    reason: "immutable once written",
  },
};

describe("isQueryKeyPrefixOf", () => {
  it("matches a key that begins with the prefix", () => {
    expect(isQueryKeyPrefixOf(["a", "b"], ["a", "b", "c"])).toBe(true);
  });

  it("matches a key equal to the prefix", () => {
    expect(isQueryKeyPrefixOf(["a", "b"], ["a", "b"])).toBe(true);
  });

  it("rejects a key whose segments diverge from the prefix", () => {
    expect(isQueryKeyPrefixOf(["a", "b"], ["a", "z", "b"])).toBe(false);
  });

  it("rejects a key shorter than the prefix", () => {
    expect(isQueryKeyPrefixOf(["a", "b"], ["a"])).toBe(false);
  });

  it("rejects a reordered key that still holds every segment", () => {
    // The exact drift the prefix check exists to catch: hoisting a segment
    // ahead of the read-type prefix keeps both key factories well-typed while
    // severing every invalidation aimed at the family.
    expect(isQueryKeyPrefixOf(["sample", "list"], ["list", "sample"])).toBe(
      false
    );
  });
});

describe("convergingPrefixes", () => {
  it("returns only the families classified as always converging", () => {
    expect(
      convergingPrefixes(sampleKeys, sampleContract, CacheConvergence.Always)
    ).toEqual([["sample", "list"]]);
  });

  it("returns only the families classified as broad-only", () => {
    expect(
      convergingPrefixes(sampleKeys, sampleContract, CacheConvergence.BroadOnly)
    ).toEqual([["sample", "detail"]]);
  });

  it("omits root, excluded, and covered-by families from both sets", () => {
    const always = convergingPrefixes(
      sampleKeys,
      sampleContract,
      CacheConvergence.Always
    );
    const broad = convergingPrefixes(
      sampleKeys,
      sampleContract,
      CacheConvergence.BroadOnly
    );
    const emitted = [...always, ...broad];

    // The namespace root would sweep the deliberately excluded families with it.
    expect(emitted).not.toContainEqual(["sample"]);
    expect(emitted).not.toContainEqual(["sample", "archive"]);
  });

  it("returns a stable resolution for a repeated call", () => {
    // Memoized, so the invalidation path does not re-walk the contract on every
    // flush. Identity is the observable proof the cache was used.
    const first = convergingPrefixes(
      sampleKeys,
      sampleContract,
      CacheConvergence.Always
    );

    expect(
      convergingPrefixes(sampleKeys, sampleContract, CacheConvergence.Always)
    ).toBe(first);
  });

  it("keeps each disposition's resolution separate under one contract", () => {
    // One cache entry per contract holds both dispositions; this pins that the
    // second lookup does not serve the first's answer.
    const always = convergingPrefixes(
      sampleKeys,
      sampleContract,
      CacheConvergence.Always
    );
    const broad = convergingPrefixes(
      sampleKeys,
      sampleContract,
      CacheConvergence.BroadOnly
    );

    expect(always).toEqual([["sample", "list"]]);
    expect(broad).toEqual([["sample", "detail"]]);
  });

  it("caches nothing when a family fails to resolve, so every call fails alike", () => {
    const badKeys = { lists: (scope: string) => ["k", scope] as const };
    const badContract: CacheConvergenceContract<typeof badKeys> = {
      lists: { prefix: CacheConvergence.Always },
    };

    expect(() =>
      convergingPrefixes(badKeys, badContract, CacheConvergence.Always)
    ).toThrow();
    // The second call must behave like the first rather than serve a
    // half-built set that the throw left behind.
    expect(() =>
      convergingPrefixes(badKeys, badContract, CacheConvergence.Always)
    ).toThrow();
  });

  it("resolves a raw key array as well as a zero-argument factory", () => {
    const rawKeys = { rootArray: ["raw"] as const };
    const rawContract: CacheConvergenceContract<typeof rawKeys> = {
      rootArray: { prefix: CacheConvergence.Always },
    };

    expect(
      convergingPrefixes(rawKeys, rawContract, CacheConvergence.Always)
    ).toEqual([["raw"]]);
  });

  it("throws naming the family when a prefix classification cannot address a subtree", () => {
    // An entity-keyed factory needs arguments, so it can never be a prefix.
    // Classifying one as `always` must fail loudly rather than resolve to an
    // `undefined` key that invalidates nothing.
    const badContract = {
      ...sampleContract,
      list: { prefix: CacheConvergence.Always },
    } as CacheConvergenceContract<typeof sampleKeys>;

    expect(() =>
      convergingPrefixes(sampleKeys, badContract, CacheConvergence.Always)
    ).toThrow(LIST_FAMILY_NAME_PATTERN);
  });
});

describe("coveringPrefixes", () => {
  it("resolves each covered family to the prefix its rule names", () => {
    expect([...coveringPrefixes(sampleKeys, sampleContract)]).toEqual([
      ["list", ["sample", "list"]],
    ]);
  });

  it("throws when a coveredBy names a family that is not a prefix", () => {
    // The types stop a name that does not exist; they do not stop a chain onto
    // another `coveredBy`, which would leave BOTH families invalidated by
    // nothing while still type-checking.
    const chained = {
      ...sampleContract,
      details: { coveredBy: "list" },
    } as unknown as Record<string, CacheConvergenceRule>;

    expect(() => coveringPrefixes(sampleKeys, chained)).toThrow(
      COVERED_BY_CHAIN_PATTERN
    );
  });

  it("throws when a coveredBy names the namespace root", () => {
    // davetho review: `all` IS a prefix family, so the "not a prefix" guard
    // above lets it through — and it is the one target that converges on
    // nothing, because the root is deliberately never invalidated. A new exact
    // family aimed there type-checks AND satisfies the prefix-geometry check
    // (its key really does begin with the root) while staying stale forever.
    const ontoRoot = {
      ...sampleContract,
      list: { coveredBy: "all" },
    } as unknown as Record<string, CacheConvergenceRule>;

    expect(() => coveringPrefixes(sampleKeys, ontoRoot)).toThrow(
      COVERED_BY_ROOT_PATTERN
    );
  });

  it("accepts a coveredBy that names an excluded family", () => {
    // Pointing at an exclusion is the same defect wearing a different hat: the
    // named family is deliberately never invalidated, so nothing reaches either.
    const ontoExcluded = {
      ...sampleContract,
      list: { coveredBy: "archiveRoot" },
    } as unknown as Record<string, CacheConvergenceRule>;

    expect(() => coveringPrefixes(sampleKeys, ontoExcluded)).not.toThrow();
    // `archiveRoot` IS a prefix family, so this resolves — the exclusion is a
    // deliberate disposition, not a broken reference. Pin the resolved target so
    // the distinction from the chain case above stays visible.
    expect(coveringPrefixes(sampleKeys, ontoExcluded).get("list")).toEqual([
      "sample",
      "archive",
    ]);
  });
});

describe("excludedFamilies", () => {
  it("reports each excluded family with its recorded reason", () => {
    expect([...excludedFamilies(sampleContract)]).toEqual([
      ["archiveRoot", "immutable once written"],
    ]);
  });

  it("reports nothing when no family is excluded", () => {
    const keys = { lists: () => ["k", "list"] as const };
    const contract: CacheConvergenceContract<typeof keys> = {
      lists: { prefix: CacheConvergence.Always },
    };

    expect(excludedFamilies(contract).size).toBe(0);
  });
});
