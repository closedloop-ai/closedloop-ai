import { describe, expect, it } from "vitest";
import {
  getProjectSettings,
  type ResolverTeamRepo,
  resolveProjectRepoDefaults,
} from "./project.ts";

describe("getProjectSettings", () => {
  it("keeps a valid repository override", () => {
    expect(
      getProjectSettings({
        repositoryOverrides: {
          selectedRepoIds: ["primary", "secondary"],
          primaryRepoId: "primary",
        },
      })
    ).toEqual({
      repositoryOverrides: {
        selectedRepoIds: ["primary", "secondary"],
        primaryRepoId: "primary",
      },
    });
  });

  it("drops an override whose primary is not selected", () => {
    expect(
      getProjectSettings({
        repositoryOverrides: {
          selectedRepoIds: ["secondary"],
          primaryRepoId: "primary",
        },
      })
    ).toEqual({});
  });
});

describe("resolveProjectRepoDefaults", () => {
  it("uses a project override and filters repository ids outside the team pool", () => {
    expect(
      resolveProjectRepoDefaults({
        projectSettings: {
          repositoryOverrides: {
            selectedRepoIds: ["primary", "stale"],
            primaryRepoId: "primary",
          },
        },
        teamRepos: [teamRepo("primary", { isPrimary: true })],
        teamCount: 1,
      })
    ).toEqual({
      selectedRepoIds: ["primary"],
      primaryRepoId: "primary",
    });
  });

  it("falls back to single-team defaults when an override primary is stale", () => {
    expect(
      resolveProjectRepoDefaults({
        projectSettings: {
          repositoryOverrides: {
            selectedRepoIds: ["stale", "default"],
            primaryRepoId: "stale",
          },
        },
        teamRepos: [
          teamRepo("primary", { isPrimary: true }),
          teamRepo("default", { isDefaultSelected: true }),
        ],
        teamCount: 1,
      })
    ).toEqual({
      selectedRepoIds: ["primary", "default"],
      primaryRepoId: "primary",
    });
  });

  it("returns null for a single-team project without a primary repository", () => {
    expect(
      resolveProjectRepoDefaults({
        projectSettings: {},
        teamRepos: [teamRepo("default", { isDefaultSelected: true })],
        teamCount: 1,
      })
    ).toBeNull();
  });

  it("returns null for a multi-team project without an override", () => {
    expect(
      resolveProjectRepoDefaults({
        projectSettings: {},
        teamRepos: [teamRepo("primary", { isPrimary: true })],
        teamCount: 2,
      })
    ).toBeNull();
  });
});

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
