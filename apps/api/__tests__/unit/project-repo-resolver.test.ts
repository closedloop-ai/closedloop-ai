/**
 * Unit tests for the pure repository resolution chain in
 * `@repo/api/src/types/project`. Covers project override (with stale-id
 * filtering), single-team inheritance, legacy `defaultRepository` fallback,
 * and the multi-team must-pick null result.
 */

import {
  getProjectSettings,
  type ResolverTeamRepo,
  resolveProjectRepoDefaults,
} from "@repo/api/src/types/project";

function teamRepo(
  installationRepositoryId: string,
  flags: { isPrimary?: boolean; isDefaultSelected?: boolean } = {}
): ResolverTeamRepo {
  return {
    installationRepositoryId,
    isPrimary: flags.isPrimary ?? false,
    isDefaultSelected: flags.isDefaultSelected ?? false,
  };
}

describe("resolveProjectRepoDefaults", () => {
  it("returns the override when every id is still in the team pool", () => {
    const result = resolveProjectRepoDefaults({
      projectSettings: {
        repositoryOverrides: {
          selectedRepoIds: ["a", "b"],
          primaryRepoId: "a",
        },
      },
      teamRepos: [
        teamRepo("a", { isPrimary: true, isDefaultSelected: true }),
        teamRepo("b", { isDefaultSelected: true }),
        teamRepo("c"),
      ],
      teamCount: 1,
    });

    expect(result).toEqual({
      selectedRepoIds: ["a", "b"],
      primaryRepoId: "a",
    });
  });

  it("filters stale ids out of the override's selected list", () => {
    const result = resolveProjectRepoDefaults({
      projectSettings: {
        repositoryOverrides: {
          selectedRepoIds: ["a", "stale"],
          primaryRepoId: "a",
        },
      },
      teamRepos: [teamRepo("a", { isPrimary: true })],
      teamCount: 1,
    });

    expect(result).toEqual({
      selectedRepoIds: ["a"],
      primaryRepoId: "a",
    });
  });

  it("drops the override when its primary is no longer in the team pool", () => {
    const result = resolveProjectRepoDefaults({
      projectSettings: {
        repositoryOverrides: {
          selectedRepoIds: ["stale", "b"],
          primaryRepoId: "stale",
        },
      },
      teamRepos: [teamRepo("b", { isPrimary: true, isDefaultSelected: true })],
      teamCount: 1,
    });

    // Override's primary stale, but single-team inheritance still applies.
    expect(result).toEqual({
      selectedRepoIds: ["b"],
      primaryRepoId: "b",
    });
  });

  it("inherits the team's defaults for a single-team project with no override", () => {
    const result = resolveProjectRepoDefaults({
      projectSettings: {},
      teamRepos: [
        teamRepo("primary", { isPrimary: true, isDefaultSelected: true }),
        teamRepo("default-only", { isDefaultSelected: true }),
        teamRepo("not-default"),
      ],
      teamCount: 1,
    });

    expect(result).toEqual({
      selectedRepoIds: ["primary", "default-only"],
      primaryRepoId: "primary",
    });
  });

  it("includes a primary that has isDefaultSelected=false in the inherited selection", () => {
    // The team picker's "primary forces default" rule is enforced UI-side,
    // not in the schema, so the resolver must independently guarantee that
    // the primary is always present in the inherited selection. Without the
    // `|| primaryId` branch in inheritFromSingleTeam, this case would drop
    // the primary from selectedRepoIds.
    const result = resolveProjectRepoDefaults({
      projectSettings: {},
      teamRepos: [
        teamRepo("primary", { isPrimary: true, isDefaultSelected: false }),
        teamRepo("default-only", { isDefaultSelected: true }),
      ],
      teamCount: 1,
    });

    expect(result).toEqual({
      selectedRepoIds: ["primary", "default-only"],
      primaryRepoId: "primary",
    });
  });

  it("returns null for a single-team project with no primary configured", () => {
    const result = resolveProjectRepoDefaults({
      projectSettings: {},
      teamRepos: [teamRepo("a", { isDefaultSelected: true })],
      teamCount: 1,
    });

    expect(result).toBeNull();
  });

  it("returns null for a multi-team project with no override and no legacy", () => {
    const result = resolveProjectRepoDefaults({
      projectSettings: {},
      teamRepos: [
        teamRepo("a", { isPrimary: true }),
        teamRepo("b", { isPrimary: true }),
      ],
      teamCount: 2,
    });

    expect(result).toBeNull();
  });

  it("falls back to legacy defaultRepository when its repoId is in the team pool", () => {
    const result = resolveProjectRepoDefaults({
      projectSettings: {
        defaultRepository: {
          repoId: "legacy",
          repoFullName: "acme/legacy",
          branch: "main",
        },
      },
      teamRepos: [
        teamRepo("legacy"),
        teamRepo("other", { isPrimary: true, isDefaultSelected: true }),
      ],
      teamCount: 2,
    });

    // Multi-team with no override — legacy fallback wins because the legacy
    // repoId is in the pool.
    expect(result).toEqual({
      selectedRepoIds: ["legacy"],
      primaryRepoId: "legacy",
    });
  });

  it("falls back to legacy defaultRepository even when team pool is empty", () => {
    const result = resolveProjectRepoDefaults({
      projectSettings: {
        defaultRepository: {
          repoId: "legacy",
          repoFullName: "acme/legacy",
          branch: "main",
        },
      },
      teamRepos: [],
      teamCount: 0,
    });

    expect(result).toEqual({
      selectedRepoIds: ["legacy"],
      primaryRepoId: "legacy",
    });
  });

  it("ignores legacy defaultRepository when its repoId is not in a non-empty team pool", () => {
    const result = resolveProjectRepoDefaults({
      projectSettings: {
        defaultRepository: {
          repoId: "legacy",
          repoFullName: "acme/legacy",
          branch: "main",
        },
      },
      teamRepos: [
        teamRepo("a", { isPrimary: true }),
        teamRepo("b", { isPrimary: true }),
      ],
      teamCount: 2,
    });

    expect(result).toBeNull();
  });
});

describe("getProjectSettings", () => {
  it("parses both repositoryOverrides and legacy defaultRepository", () => {
    const settings = getProjectSettings({
      defaultRepository: {
        repoId: "legacy",
        repoFullName: "acme/legacy",
        branch: "main",
      },
      repositoryOverrides: {
        selectedRepoIds: ["a", "b"],
        primaryRepoId: "a",
      },
    });

    expect(settings.defaultRepository).toEqual({
      repoId: "legacy",
      repoFullName: "acme/legacy",
      branch: "main",
    });
    expect(settings.repositoryOverrides).toEqual({
      selectedRepoIds: ["a", "b"],
      primaryRepoId: "a",
    });
  });

  it("drops repositoryOverrides when primaryRepoId is not in selectedRepoIds", () => {
    const settings = getProjectSettings({
      repositoryOverrides: {
        selectedRepoIds: ["a"],
        primaryRepoId: "b",
      },
      defaultRepository: {
        repoId: "legacy",
        repoFullName: "acme/legacy",
        branch: "main",
      },
    });

    // Override refine fails, but legacy is independent and remains valid.
    expect(settings.repositoryOverrides).toBeUndefined();
    expect(settings.defaultRepository).toEqual({
      repoId: "legacy",
      repoFullName: "acme/legacy",
      branch: "main",
    });
  });

  it("ignores unknown keys without erroring", () => {
    const settings = getProjectSettings({
      unknownKey: "value",
      repositoryOverrides: {
        selectedRepoIds: ["a"],
        primaryRepoId: "a",
      },
    });

    expect(settings.repositoryOverrides).toEqual({
      selectedRepoIds: ["a"],
      primaryRepoId: "a",
    });
  });
});
