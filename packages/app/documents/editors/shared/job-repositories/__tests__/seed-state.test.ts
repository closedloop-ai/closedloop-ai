import {
  computeSeedKey,
  computeSeedState,
} from "@repo/app/documents/editors/shared/job-repositories/seed-state";
import {
  RepoSource,
  type ResolvedRepo,
} from "@repo/app/documents/editors/shared/job-repositories/use-resolved-job-repos";
import { describe, expect, it } from "vitest";

function makeResolved(
  id: string,
  fullName: string,
  overrides: Partial<ResolvedRepo> = {}
): ResolvedRepo {
  return {
    id,
    fullName,
    source: RepoSource.TeamDefault,
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
  });

  it("includes the primary and records its source", () => {
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

  it("includes additional repos and records their sources per repo", () => {
    const seed = computeSeedState({
      seedPrimary: null,
      seedAdditional: [
        makeResolved("repo-b", "org/repo-b", {
          source: RepoSource.ProjectOverride,
        }),
        makeResolved("repo-c", "org/repo-c", {
          source: RepoSource.TeamDefault,
        }),
      ],
    });
    expect(seed.ids.has("repo-b")).toBe(true);
    expect(seed.ids.has("repo-c")).toBe(true);
    expect(seed.sources["repo-b"]).toBe(RepoSource.ProjectOverride);
    expect(seed.sources["repo-c"]).toBe(RepoSource.TeamDefault);
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
