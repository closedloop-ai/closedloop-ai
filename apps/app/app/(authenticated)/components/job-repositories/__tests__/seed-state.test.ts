import {
  RepoSource,
  type ResolvedRepo,
} from "@repo/app/loops/hooks/use-resolved-job-repos";
import { describe, expect, it } from "vitest";
import { computeSeedKey, computeSeedState } from "../seed-state";

function makeResolved(
  id: string,
  fullName: string,
  overrides: Partial<ResolvedRepo> = {}
): ResolvedRepo {
  return {
    id,
    fullName,
    source: RepoSource.TeamDefault,
    inPool: true,
    ...overrides,
  };
}

describe("computeSeedState", () => {
  it("returns an empty seed when there is no primary and no additional", () => {
    const seed = computeSeedState({
      seedPrimary: null,
      seedAdditional: [],
    });
    expect(seed.primaryId).toBeNull();
    expect(seed.ids.size).toBe(0);
    expect(seed.sources).toEqual({});
    expect(seed.branches).toEqual({});
  });

  it("includes an inPool primary and records its source", () => {
    const seedPrimary = makeResolved("repo-a", "org/repo-a", {
      source: RepoSource.ProjectOverride,
    });
    const seed = computeSeedState({
      seedPrimary,
      seedAdditional: [],
    });
    expect(seed.primaryId).toBe("repo-a");
    expect(seed.ids.has("repo-a")).toBe(true);
    expect(seed.sources["repo-a"]).toBe(RepoSource.ProjectOverride);
  });

  it("drops a non-pool primary", () => {
    const seedPrimary = makeResolved("out-1", "org/out", {
      inPool: false,
    });
    const seed = computeSeedState({
      seedPrimary,
      seedAdditional: [],
    });
    expect(seed.primaryId).toBeNull();
    expect(seed.ids.size).toBe(0);
  });

  it("records a primary's pre-resolved branch when present", () => {
    const seedPrimary = makeResolved("repo-a", "org/repo-a", {
      branch: "feature/x",
    });
    const seed = computeSeedState({
      seedPrimary,
      seedAdditional: [],
    });
    expect(seed.branches["repo-a"]).toBe("feature/x");
  });

  it("omits the primary from the branches map when no branch is provided", () => {
    const seedPrimary = makeResolved("repo-a", "org/repo-a");
    const seed = computeSeedState({
      seedPrimary,
      seedAdditional: [],
    });
    expect(seed.branches["repo-a"]).toBeUndefined();
  });

  it("includes inPool additional repos and records their sources + branches", () => {
    const seed = computeSeedState({
      seedPrimary: null,
      seedAdditional: [
        makeResolved("repo-b", "org/repo-b", {
          source: RepoSource.PriorLoop,
          branch: "feature/keep",
        }),
        makeResolved("repo-c", "org/repo-c", {
          source: RepoSource.TeamDefault,
        }),
      ],
    });
    expect(seed.ids.has("repo-b")).toBe(true);
    expect(seed.ids.has("repo-c")).toBe(true);
    expect(seed.sources["repo-b"]).toBe(RepoSource.PriorLoop);
    expect(seed.branches["repo-b"]).toBe("feature/keep");
    expect(seed.branches["repo-c"]).toBeUndefined();
  });

  it("skips non-pool additional repos", () => {
    const seed = computeSeedState({
      seedPrimary: null,
      seedAdditional: [makeResolved("repo-b", "org/repo-b", { inPool: false })],
    });
    expect(seed.ids.size).toBe(0);
    expect(seed.sources).toEqual({});
  });
});

describe("computeSeedKey", () => {
  it("produces a stable key for the same inputs", () => {
    const primary = makeResolved("repo-a", "org/repo-a");
    const additional = [makeResolved("repo-b", "org/repo-b")];
    const k1 = computeSeedKey(primary, additional);
    const k2 = computeSeedKey(primary, additional);
    expect(k1).toBe(k2);
  });

  it("changes when the primary id changes", () => {
    const additional = [makeResolved("repo-b", "org/repo-b")];
    const k1 = computeSeedKey(makeResolved("repo-a", "org/repo-a"), additional);
    const k2 = computeSeedKey(makeResolved("repo-x", "org/repo-x"), additional);
    expect(k1).not.toBe(k2);
  });

  it("changes when the additional set changes", () => {
    const primary = makeResolved("repo-a", "org/repo-a");
    const k1 = computeSeedKey(primary, []);
    const k2 = computeSeedKey(primary, [makeResolved("repo-b", "org/repo-b")]);
    expect(k1).not.toBe(k2);
  });

  it("is independent of the order of additional repos", () => {
    const primary = makeResolved("repo-a", "org/repo-a");
    const repoB = makeResolved("repo-b", "org/repo-b");
    const repoC = makeResolved("repo-c", "org/repo-c");
    const k1 = computeSeedKey(primary, [repoB, repoC]);
    const k2 = computeSeedKey(primary, [repoC, repoB]);
    expect(k1).toBe(k2);
  });

  it("handles a null primary", () => {
    const k = computeSeedKey(null, []);
    expect(k).toContain("_none");
  });
});
