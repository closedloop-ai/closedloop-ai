import type { TeamRepoWithTeamId } from "@repo/app/teams/hooks/use-team-repositories-union";
import { describe, expect, it } from "vitest";
import { buildSelection, computeIncomplete } from "../selection";

function makeTeamRepo(id: string, fullName: string): TeamRepoWithTeamId {
  const [owner = "", name = ""] = fullName.split("/");
  return {
    id: `team-${id}`,
    teamId: "team-1",
    installationRepositoryId: id,
    isDefaultSelected: false,
    isPrimary: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    repository: {
      id,
      installationId: "install-1",
      githubRepoId: id,
      name,
      owner,
      fullName,
      private: false,
    },
  };
}

describe("computeIncomplete", () => {
  const pool = [
    makeTeamRepo("repo-a", "org/repo-a"),
    makeTeamRepo("repo-b", "org/repo-b"),
  ];
  const branchByRepoId: Record<string, string> = {
    "repo-a": "main",
    "repo-b": "develop",
  };

  it("is never incomplete when requirePrimary is false", () => {
    const result = computeIncomplete({
      requirePrimary: false,
      primaryId: null,
      selectedIds: new Set(),
      pool,
      branchByRepoId,
    });
    expect(result).toBe(false);
  });

  it("is incomplete when requirePrimary is true and no primary is selected", () => {
    const result = computeIncomplete({
      requirePrimary: true,
      primaryId: null,
      selectedIds: new Set(["repo-a"]),
      pool,
      branchByRepoId,
    });
    expect(result).toBe(true);
  });

  it("is incomplete when the primary id is not in the selected set", () => {
    const result = computeIncomplete({
      requirePrimary: true,
      primaryId: "repo-a",
      selectedIds: new Set(["repo-b"]),
      pool,
      branchByRepoId,
    });
    expect(result).toBe(true);
  });

  it("is incomplete when a selected id is not in the effective pool", () => {
    const result = computeIncomplete({
      requirePrimary: true,
      primaryId: "repo-a",
      selectedIds: new Set(["repo-a", "repo-stray"]),
      pool,
      branchByRepoId,
    });
    expect(result).toBe(true);
  });

  it("is incomplete when a selected id is missing a branch (covers in-flight branch fetch)", () => {
    const result = computeIncomplete({
      requirePrimary: true,
      primaryId: "repo-a",
      selectedIds: new Set(["repo-a", "repo-b"]),
      pool,
      branchByRepoId: { "repo-a": "main" },
    });
    expect(result).toBe(true);
  });

  it("is complete when a single primary is selected with its branch resolved", () => {
    const result = computeIncomplete({
      requirePrimary: true,
      primaryId: "repo-a",
      selectedIds: new Set(["repo-a"]),
      pool,
      branchByRepoId,
    });
    expect(result).toBe(false);
  });

  it("is complete with multiple selected repos all in the pool with branches", () => {
    const result = computeIncomplete({
      requirePrimary: true,
      primaryId: "repo-a",
      selectedIds: new Set(["repo-a", "repo-b"]),
      pool,
      branchByRepoId,
    });
    expect(result).toBe(false);
  });
});

describe("buildSelection", () => {
  const pool = [
    makeTeamRepo("repo-a", "org/repo-a"),
    makeTeamRepo("repo-b", "org/repo-b"),
    makeTeamRepo("repo-c", "org/repo-c"),
  ];
  const branchByRepoId: Record<string, string> = {
    "repo-a": "main",
    "repo-b": "develop",
    "repo-c": "trunk",
  };

  it("returns null when no primary id is provided", () => {
    expect(
      buildSelection({
        pool,
        primaryId: null,
        selectedIds: new Set(),
        branchByRepoId,
      })
    ).toBeNull();
  });

  it("returns null when the primary id is not in the pool", () => {
    expect(
      buildSelection({
        pool,
        primaryId: "repo-stray",
        selectedIds: new Set(["repo-stray"]),
        branchByRepoId,
      })
    ).toBeNull();
  });

  it("returns null when the primary id is missing a branch", () => {
    expect(
      buildSelection({
        pool,
        primaryId: "repo-a",
        selectedIds: new Set(["repo-a"]),
        branchByRepoId: {},
      })
    ).toBeNull();
  });

  it("returns the primary with no additional repos when only the primary is selected", () => {
    const result = buildSelection({
      pool,
      primaryId: "repo-a",
      selectedIds: new Set(["repo-a"]),
      branchByRepoId,
    });
    expect(result).toEqual({
      primary: { id: "repo-a", fullName: "org/repo-a", branch: "main" },
      additional: [],
    });
  });

  it("includes additional selected repos with their branches", () => {
    const result = buildSelection({
      pool,
      primaryId: "repo-a",
      selectedIds: new Set(["repo-a", "repo-b", "repo-c"]),
      branchByRepoId,
    });
    expect(result?.primary).toEqual({
      id: "repo-a",
      fullName: "org/repo-a",
      branch: "main",
    });
    expect(result?.additional).toEqual(
      expect.arrayContaining([
        { fullName: "org/repo-b", branch: "develop" },
        { fullName: "org/repo-c", branch: "trunk" },
      ])
    );
    expect(result?.additional).toHaveLength(2);
  });

  it("does not include the primary in the additional list", () => {
    const result = buildSelection({
      pool,
      primaryId: "repo-a",
      selectedIds: new Set(["repo-a", "repo-b"]),
      branchByRepoId,
    });
    expect(result?.additional.some((r) => r.fullName === "org/repo-a")).toBe(
      false
    );
  });

  it("skips additional selected ids that are not in the pool", () => {
    const result = buildSelection({
      pool,
      primaryId: "repo-a",
      selectedIds: new Set(["repo-a", "repo-stray"]),
      branchByRepoId,
    });
    expect(result?.additional).toEqual([]);
  });

  it("skips additional selected ids that are missing a branch", () => {
    const result = buildSelection({
      pool,
      primaryId: "repo-a",
      selectedIds: new Set(["repo-a", "repo-b"]),
      branchByRepoId: { "repo-a": "main" },
    });
    expect(result?.additional).toEqual([]);
  });
});
