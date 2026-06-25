/**
 * Unit tests for teamsService team-repository methods.
 *
 * Mocks `@repo/database` so we can assert the transactional logic that enforces
 * the exactly-one-primary invariant and primary-requires-default rule without
 * needing a real database.
 */

import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddRepositoryError, teamsService } from "@/app/teams/service";
import { mockWithDbCall, mockWithDbTx } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

const repoSummary = {
  id: "repo-id",
  installationId: "inst-id",
  githubRepoId: "gh-1",
  fullName: "acme/repo",
  name: "repo",
  owner: "acme",
  private: false,
};

describe("teamsService.addRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects with REPO_NOT_AVAILABLE when repo is not in org installations", async () => {
    const mockTx = {
      gitHubInstallationRepository: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      teamRepository: {
        findUnique: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    };
    mockWithDbTx(mockTx);

    const result = await teamsService.addRepository("team-1", "org-1", {
      installationRepositoryId: "repo-id",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(AddRepositoryError.RepoNotAvailable);
    }
    expect(mockTx.teamRepository.create).not.toHaveBeenCalled();
  });

  it("rejects with ALREADY_ADDED when team already has the repo", async () => {
    const mockTx = {
      gitHubInstallationRepository: {
        findFirst: vi.fn().mockResolvedValue({ id: "repo-id" }),
      },
      teamRepository: {
        findUnique: vi.fn().mockResolvedValue({ id: "existing" }),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    };
    mockWithDbTx(mockTx);

    const result = await teamsService.addRepository("team-1", "org-1", {
      installationRepositoryId: "repo-id",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(AddRepositoryError.AlreadyAdded);
    }
    expect(mockTx.teamRepository.create).not.toHaveBeenCalled();
  });

  it("forces isDefaultSelected when isPrimary is requested and clears prior primary", async () => {
    const created = {
      id: "new-team-repo",
      teamId: "team-1",
      installationRepositoryId: "repo-id",
      isDefaultSelected: true,
      isPrimary: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      repository: repoSummary,
    };
    const mockTx = {
      gitHubInstallationRepository: {
        findFirst: vi.fn().mockResolvedValue({ id: "repo-id" }),
      },
      teamRepository: {
        findUnique: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue(created),
      },
    };
    mockWithDbTx(mockTx);

    const result = await teamsService.addRepository("team-1", "org-1", {
      installationRepositoryId: "repo-id",
      isPrimary: true,
      isDefaultSelected: false,
    });

    expect(result.ok).toBe(true);
    expect(mockTx.teamRepository.updateMany).toHaveBeenCalledWith({
      where: { teamId: "team-1", isPrimary: true },
      data: { isPrimary: false },
    });
    expect(mockTx.teamRepository.create).toHaveBeenCalledWith({
      data: {
        teamId: "team-1",
        installationRepositoryId: "repo-id",
        isDefaultSelected: true,
        isPrimary: true,
      },
      include: expect.any(Object),
    });
  });

  it("does not clear primary when adding a non-primary repo", async () => {
    const mockTx = {
      gitHubInstallationRepository: {
        findFirst: vi.fn().mockResolvedValue({ id: "repo-id" }),
      },
      teamRepository: {
        findUnique: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "new",
          teamId: "team-1",
          installationRepositoryId: "repo-id",
          isDefaultSelected: false,
          isPrimary: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          repository: repoSummary,
        }),
      },
    };
    mockWithDbTx(mockTx);

    await teamsService.addRepository("team-1", "org-1", {
      installationRepositoryId: "repo-id",
    });

    expect(mockTx.teamRepository.updateMany).not.toHaveBeenCalled();
  });
});

describe("teamsService.updateRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns NOT_FOUND when team-repo doesn't belong to team", async () => {
    const mockTx = {
      teamRepository: {
        findFirst: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn(),
        update: vi.fn(),
      },
    };
    mockWithDbTx(mockTx);

    const result = await teamsService.updateRepository("team-1", "tr-1", {
      isPrimary: true,
    });

    expect(result).toEqual({ ok: false, error: Status.NotFound });
    expect(mockTx.teamRepository.update).not.toHaveBeenCalled();
  });

  it("clears isPrimary when caller un-defaults the primary repo", async () => {
    const updated = {
      id: "tr-1",
      teamId: "team-1",
      installationRepositoryId: "repo-id",
      isDefaultSelected: false,
      isPrimary: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      repository: repoSummary,
    };
    const mockTx = {
      teamRepository: {
        findFirst: vi.fn().mockResolvedValue({
          id: "tr-1",
          isDefaultSelected: true,
          isPrimary: true,
        }),
        updateMany: vi.fn(),
        update: vi.fn().mockResolvedValue(updated),
      },
    };
    mockWithDbTx(mockTx);

    const result = await teamsService.updateRepository("team-1", "tr-1", {
      isDefaultSelected: false,
    });

    expect(result.ok).toBe(true);
    expect(mockTx.teamRepository.update).toHaveBeenCalledWith({
      where: { id: "tr-1" },
      data: { isDefaultSelected: false, isPrimary: false },
      include: expect.any(Object),
    });
  });

  it("auto-promotes isDefaultSelected when caller sets isPrimary on a non-default repo", async () => {
    // Symmetric with addRepository: requesting isPrimary forces isDefaultSelected
    // to true rather than silently demoting isPrimary.
    const updated = {
      id: "tr-1",
      teamId: "team-1",
      installationRepositoryId: "repo-id",
      isDefaultSelected: true,
      isPrimary: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      repository: repoSummary,
    };
    const mockTx = {
      teamRepository: {
        findFirst: vi.fn().mockResolvedValue({
          id: "tr-1",
          isDefaultSelected: false,
          isPrimary: false,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        update: vi.fn().mockResolvedValue(updated),
      },
    };
    mockWithDbTx(mockTx);

    const result = await teamsService.updateRepository("team-1", "tr-1", {
      isPrimary: true,
    });

    expect(result.ok).toBe(true);
    expect(mockTx.teamRepository.update).toHaveBeenCalledWith({
      where: { id: "tr-1" },
      data: { isDefaultSelected: true, isPrimary: true },
      include: expect.any(Object),
    });
  });

  it("honors isPrimary=true when caller contradicts with isDefaultSelected=false", async () => {
    // The caller's request to make the repo primary wins; isDefaultSelected
    // is forced to true so the resulting state is internally consistent.
    const updated = {
      id: "tr-1",
      teamId: "team-1",
      installationRepositoryId: "repo-id",
      isDefaultSelected: true,
      isPrimary: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      repository: repoSummary,
    };
    const mockTx = {
      teamRepository: {
        findFirst: vi.fn().mockResolvedValue({
          id: "tr-1",
          isDefaultSelected: false,
          isPrimary: false,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        update: vi.fn().mockResolvedValue(updated),
      },
    };
    mockWithDbTx(mockTx);

    await teamsService.updateRepository("team-1", "tr-1", {
      isPrimary: true,
      isDefaultSelected: false,
    });

    expect(mockTx.teamRepository.update).toHaveBeenCalledWith({
      where: { id: "tr-1" },
      data: { isDefaultSelected: true, isPrimary: true },
      include: expect.any(Object),
    });
  });

  it("clears prior primary when designating a new primary", async () => {
    const updated = {
      id: "tr-1",
      teamId: "team-1",
      installationRepositoryId: "repo-id",
      isDefaultSelected: true,
      isPrimary: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      repository: repoSummary,
    };
    const mockTx = {
      teamRepository: {
        findFirst: vi.fn().mockResolvedValue({
          id: "tr-1",
          isDefaultSelected: true,
          isPrimary: false,
        }),
        updateMany: vi.fn(),
        update: vi.fn().mockResolvedValue(updated),
      },
    };
    mockWithDbTx(mockTx);

    await teamsService.updateRepository("team-1", "tr-1", { isPrimary: true });

    expect(mockTx.teamRepository.updateMany).toHaveBeenCalledWith({
      where: { teamId: "team-1", isPrimary: true, NOT: { id: "tr-1" } },
      data: { isPrimary: false },
    });
  });
});

describe("teamsService.removeRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok=true when a row was deleted", async () => {
    const mockDb = {
      teamRepository: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockWithDbCall(mockDb);

    const result = await teamsService.removeRepository("team-1", "tr-1");

    expect(result).toEqual({ ok: true, value: true });
    expect(mockDb.teamRepository.deleteMany).toHaveBeenCalledWith({
      where: { id: "tr-1", teamId: "team-1" },
    });
  });

  it("returns NotFound when no row was deleted", async () => {
    const mockDb = {
      teamRepository: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    mockWithDbCall(mockDb);

    const result = await teamsService.removeRepository("team-1", "tr-1");

    expect(result).toEqual({ ok: false, error: Status.NotFound });
  });
});
