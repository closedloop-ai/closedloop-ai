import {
  type ArtifactRepositorySnapshot,
  RepositoryRole,
  SnapshotSource,
} from "@repo/api/src/types/document";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSnapshotFromLoopSelection,
  buildSnapshotFromProjectDefaults,
  inheritSnapshotFromParent,
  parseStoredSnapshot,
} from "@/app/documents/repository-snapshot-helpers";
import { loadProjectRepoDefaults } from "@/app/projects/repository-resolver";

vi.mock("@/app/projects/repository-resolver", () => ({
  loadProjectRepoDefaults: vi.fn(),
}));

describe("buildSnapshotFromLoopSelection", () => {
  it("marks the primary repo as role=primary at position 0", () => {
    const snapshot = buildSnapshotFromLoopSelection({
      primary: { fullName: "acme/api", branch: "main" },
    });

    expect(snapshot.source).toBe(SnapshotSource.LoopSelection);
    expect(snapshot.repositories).toHaveLength(1);
    expect(snapshot.repositories[0]).toMatchObject({
      fullName: "acme/api",
      role: RepositoryRole.Primary,
      position: 0,
      branch: "main",
    });
  });

  it("orders additional repos starting at position 1 in input order", () => {
    const snapshot = buildSnapshotFromLoopSelection({
      primary: { fullName: "acme/api" },
      additional: [
        { fullName: "acme/web", branch: "develop" },
        { fullName: "acme/shared" },
      ],
    });

    expect(snapshot.repositories).toHaveLength(3);
    expect(snapshot.repositories[1]).toMatchObject({
      fullName: "acme/web",
      role: RepositoryRole.Additional,
      position: 1,
      branch: "develop",
    });
    expect(snapshot.repositories[2]).toMatchObject({
      fullName: "acme/shared",
      role: RepositoryRole.Additional,
      position: 2,
    });
    expect(snapshot.repositories[2]).not.toHaveProperty("branch");
  });

  it("omits the branch field entirely when not supplied", () => {
    const snapshot = buildSnapshotFromLoopSelection({
      primary: { fullName: "acme/api" },
    });
    expect(snapshot.repositories[0]).not.toHaveProperty("branch");
  });

  it("treats a null branch as absent", () => {
    const snapshot = buildSnapshotFromLoopSelection({
      primary: { fullName: "acme/api", branch: null },
    });
    expect(snapshot.repositories[0]).not.toHaveProperty("branch");
  });
});

describe("inheritSnapshotFromParent", () => {
  it("preserves repositories and rewrites source to parent_artifact", () => {
    const parent: ArtifactRepositorySnapshot = {
      repositories: [
        {
          fullName: "acme/api",
          role: RepositoryRole.Primary,
          position: 0,
          branch: "main",
        },
        {
          fullName: "acme/web",
          role: RepositoryRole.Additional,
          position: 1,
        },
      ],
      source: SnapshotSource.LoopSelection,
    };

    const inherited = inheritSnapshotFromParent(parent);

    expect(inherited.source).toBe(SnapshotSource.ParentArtifact);
    expect(inherited.repositories).toEqual(parent.repositories);
  });

  it("retains parent source even if it was already parent_artifact (chain)", () => {
    const parent: ArtifactRepositorySnapshot = {
      repositories: [
        {
          fullName: "acme/api",
          role: RepositoryRole.Primary,
          position: 0,
        },
      ],
      source: SnapshotSource.ParentArtifact,
    };
    const inherited = inheritSnapshotFromParent(parent);
    expect(inherited.source).toBe(SnapshotSource.ParentArtifact);
  });
});

describe("parseStoredSnapshot", () => {
  it("returns the parsed snapshot when shape is valid", () => {
    const stored = {
      repositories: [
        {
          fullName: "acme/api",
          role: "primary",
          position: 0,
        },
      ],
      source: "project_defaults",
    };
    const parsed = parseStoredSnapshot(stored);
    expect(parsed).not.toBeNull();
    expect(parsed?.source).toBe(SnapshotSource.ProjectDefaults);
    expect(parsed?.repositories[0]?.fullName).toBe("acme/api");
  });

  it("returns null for null input", () => {
    expect(parseStoredSnapshot(null)).toBeNull();
  });

  it("returns null when repositories field is missing", () => {
    expect(parseStoredSnapshot({ source: "none" })).toBeNull();
  });

  it("returns null when source is not a valid enum value", () => {
    expect(
      parseStoredSnapshot({ repositories: [], source: "bogus" })
    ).toBeNull();
  });

  it("returns null when a repo entry is missing required fields", () => {
    expect(
      parseStoredSnapshot({
        repositories: [{ role: "primary", position: 0 }],
        source: "none",
      })
    ).toBeNull();
  });

  it("accepts an empty repositories array with source=none", () => {
    const parsed = parseStoredSnapshot({
      repositories: [],
      source: "none",
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.repositories).toEqual([]);
    expect(parsed?.source).toBe(SnapshotSource.None);
  });
});

function teamRepo(installationRepositoryId: string, fullName: string) {
  return {
    installationRepositoryId,
    repository: { fullName },
  };
}

describe("buildSnapshotFromProjectDefaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty 'none' snapshot when the project has no resolved defaults", async () => {
    vi.mocked(loadProjectRepoDefaults).mockResolvedValue(null);

    const snapshot = await buildSnapshotFromProjectDefaults(
      "project-1",
      "org-1",
      {}
    );

    expect(snapshot.source).toBe(SnapshotSource.None);
    expect(snapshot.repositories).toEqual([]);
  });

  it("builds a single-repo snapshot when override has only a primary", async () => {
    vi.mocked(loadProjectRepoDefaults).mockResolvedValue({
      override: {
        primaryRepoId: "repo-1",
        selectedRepoIds: ["repo-1"],
      },
      primary: {
        installationRepositoryId: "repo-1",
        fullName: "acme/api",
      },
      teamRepos: [teamRepo("repo-1", "acme/api")] as any,
    });

    const snapshot = await buildSnapshotFromProjectDefaults(
      "project-1",
      "org-1",
      {}
    );

    expect(snapshot.source).toBe(SnapshotSource.ProjectDefaults);
    expect(snapshot.repositories).toHaveLength(1);
    expect(snapshot.repositories[0]).toMatchObject({
      fullName: "acme/api",
      role: RepositoryRole.Primary,
      position: 0,
    });
    expect(snapshot.repositories[0]).not.toHaveProperty("branch");
  });

  it("includes additional repos with role=additional starting at position 1", async () => {
    vi.mocked(loadProjectRepoDefaults).mockResolvedValue({
      override: {
        primaryRepoId: "repo-1",
        selectedRepoIds: ["repo-1", "repo-2", "repo-3"],
      },
      primary: {
        installationRepositoryId: "repo-1",
        fullName: "acme/api",
      },
      teamRepos: [
        teamRepo("repo-1", "acme/api"),
        teamRepo("repo-2", "acme/web"),
        teamRepo("repo-3", "acme/shared"),
      ] as any,
    });

    const snapshot = await buildSnapshotFromProjectDefaults(
      "project-1",
      "org-1",
      {}
    );

    expect(snapshot.repositories).toHaveLength(3);
    expect(snapshot.repositories[0]).toMatchObject({
      fullName: "acme/api",
      role: RepositoryRole.Primary,
      position: 0,
    });
    expect(snapshot.repositories[1]).toMatchObject({
      fullName: "acme/web",
      role: RepositoryRole.Additional,
      position: 1,
    });
    expect(snapshot.repositories[2]).toMatchObject({
      fullName: "acme/shared",
      role: RepositoryRole.Additional,
      position: 2,
    });
  });

  it("skips unknown additional repo ids and reassigns contiguous positions", async () => {
    vi.mocked(loadProjectRepoDefaults).mockResolvedValue({
      override: {
        primaryRepoId: "repo-1",
        selectedRepoIds: ["repo-1", "ghost-repo", "repo-2"],
      },
      primary: {
        installationRepositoryId: "repo-1",
        fullName: "acme/api",
      },
      teamRepos: [
        teamRepo("repo-1", "acme/api"),
        teamRepo("repo-2", "acme/web"),
      ] as any,
    });

    const snapshot = await buildSnapshotFromProjectDefaults(
      "project-1",
      "org-1",
      {}
    );

    expect(snapshot.repositories).toHaveLength(2);
    expect(snapshot.repositories[0]).toMatchObject({
      fullName: "acme/api",
      role: RepositoryRole.Primary,
      position: 0,
    });
    // After filtering out the unknown id, the surviving additional repo gets
    // position 1 (contiguous) — not position 2 (which would leave a gap).
    expect(snapshot.repositories[1]).toMatchObject({
      fullName: "acme/web",
      role: RepositoryRole.Additional,
      position: 1,
    });
  });

  it("falls back to legacy primary fullName when override.primary points outside the team pool", async () => {
    vi.mocked(loadProjectRepoDefaults).mockResolvedValue({
      override: {
        primaryRepoId: "legacy-repo",
        selectedRepoIds: ["legacy-repo"],
      },
      primary: {
        installationRepositoryId: "legacy-repo",
        fullName: "acme/legacy",
      },
      teamRepos: [] as any,
    });

    const snapshot = await buildSnapshotFromProjectDefaults(
      "project-1",
      "org-1",
      {}
    );

    expect(snapshot.source).toBe(SnapshotSource.ProjectDefaults);
    expect(snapshot.repositories[0]?.fullName).toBe("acme/legacy");
  });
});
