/**
 * Unit tests for installation_repositories webhook handlers.
 *
 * Tests the following functions:
 * - handleInstallationRepositoriesAdded: syncs repositories added to an installation
 * - handleInstallationRepositoriesRemoved: removes repositories from an installation
 */

import type {
  InstallationRepositoriesAddedEvent,
  InstallationRepositoriesRemovedEvent,
} from "@octokit/webhooks-types";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// Mock modules before importing
vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/app/integrations/github/service", () => ({
  githubService: {
    findInstallationByInstallationId: vi.fn(),
    addRepositories: vi.fn(),
    removeRepositories: vi.fn(),
  },
}));

// Import after mocking
import { log } from "@repo/observability/log";
import { githubService } from "@/app/integrations/github/service";
import {
  handleInstallationRepositories,
  handleInstallationRepositoriesAdded,
  handleInstallationRepositoriesRemoved,
} from "@/app/webhooks/github/handlers/installation-repositories-handler";

// Type aliases for mocked functions
const mockFindInstallationByInstallationId =
  githubService.findInstallationByInstallationId as Mock;
const mockAddRepositories = githubService.addRepositories as Mock;
const mockRemoveRepositories = githubService.removeRepositories as Mock;

/**
 * Helper to create minimal InstallationRepositoriesAddedEvent
 */
function createInstallationRepositoriesAddedEvent(
  installationId: number,
  repositories: Array<{
    id: number;
    full_name: string;
    name: string;
    private: boolean;
  }>
): InstallationRepositoriesAddedEvent {
  return {
    action: "added",
    installation: {
      id: installationId,
      account: {
        login: "test-owner",
        id: 1,
        node_id: "U_1",
        avatar_url: "",
        gravatar_id: "",
        url: "",
        html_url: "",
        followers_url: "",
        following_url: "",
        gists_url: "",
        starred_url: "",
        subscriptions_url: "",
        organizations_url: "",
        repos_url: "",
        events_url: "",
        received_events_url: "",
        type: "Organization",
        site_admin: false,
      },
      repository_selection: "selected" as const,
      access_tokens_url: "",
      repositories_url: "",
      html_url: "",
      app_id: 123,
      app_slug: "test-app",
      target_id: 1,
      target_type: "Organization",
      permissions: {},
      events: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-02-06T00:00:00Z",
      single_file_name: null,
      has_multiple_single_files: false,
      single_file_paths: [],
      suspended_by: null,
      suspended_at: null,
    },
    repositories_added: repositories.map((repo) => ({
      ...repo,
      node_id: `R_${repo.id}`,
    })),
    repositories_removed: [],
    repository_selection: "selected" as const,
    sender: {
      login: "test-user",
      id: 1,
      node_id: "U_1",
      avatar_url: "",
      gravatar_id: "",
      url: "",
      html_url: "",
      followers_url: "",
      following_url: "",
      gists_url: "",
      starred_url: "",
      subscriptions_url: "",
      organizations_url: "",
      repos_url: "",
      events_url: "",
      received_events_url: "",
      type: "User",
      site_admin: false,
    },
    requester: null,
  };
}

/**
 * Helper to create minimal InstallationRepositoriesRemovedEvent
 */
function createInstallationRepositoriesRemovedEvent(
  installationId: number,
  repositories: Array<{
    id: number;
    full_name: string;
    name: string;
    private: boolean;
  }>
): InstallationRepositoriesRemovedEvent {
  return {
    action: "removed",
    installation: {
      id: installationId,
      account: {
        login: "test-owner",
        id: 1,
        node_id: "U_1",
        avatar_url: "",
        gravatar_id: "",
        url: "",
        html_url: "",
        followers_url: "",
        following_url: "",
        gists_url: "",
        starred_url: "",
        subscriptions_url: "",
        organizations_url: "",
        repos_url: "",
        events_url: "",
        received_events_url: "",
        type: "Organization",
        site_admin: false,
      },
      repository_selection: "selected" as const,
      access_tokens_url: "",
      repositories_url: "",
      html_url: "",
      app_id: 123,
      app_slug: "test-app",
      target_id: 1,
      target_type: "Organization",
      permissions: {},
      events: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-02-06T00:00:00Z",
      single_file_name: null,
      has_multiple_single_files: false,
      single_file_paths: [],
      suspended_by: null,
      suspended_at: null,
    },
    repositories_added: [],
    repositories_removed: repositories.map((repo) => ({
      ...repo,
      node_id: `R_${repo.id}`,
    })),
    repository_selection: "selected" as const,
    sender: {
      login: "test-user",
      id: 1,
      node_id: "U_1",
      avatar_url: "",
      gravatar_id: "",
      url: "",
      html_url: "",
      followers_url: "",
      following_url: "",
      gists_url: "",
      starred_url: "",
      subscriptions_url: "",
      organizations_url: "",
      repos_url: "",
      events_url: "",
      received_events_url: "",
      type: "User",
      site_admin: false,
    },
    requester: null,
  };
}

describe("handleInstallationRepositoriesAdded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns early when no repositories are added", async () => {
    const event = createInstallationRepositoriesAddedEvent(123_456, []);

    await handleInstallationRepositoriesAdded(event);

    expect(log.info).toHaveBeenCalledWith(
      "[handleInstallationRepositoriesAdded] Processing repositories added",
      {
        installationId: 123_456,
        repositoryCount: 0,
      }
    );
    expect(mockFindInstallationByInstallationId).not.toHaveBeenCalled();
    expect(mockAddRepositories).not.toHaveBeenCalled();
  });

  it("logs warning and returns when installation not found", async () => {
    mockFindInstallationByInstallationId.mockResolvedValue(null);

    const event = createInstallationRepositoriesAddedEvent(123_456, [
      { id: 1, full_name: "owner/repo1", name: "repo1", private: false },
    ]);

    await handleInstallationRepositoriesAdded(event);

    expect(mockFindInstallationByInstallationId).toHaveBeenCalledWith("123456");
    expect(log.warn).toHaveBeenCalledWith(
      "[handleInstallationRepositoriesAdded] Installation not found",
      {
        installationId: 123_456,
      }
    );
    expect(mockAddRepositories).not.toHaveBeenCalled();
  });

  it("adds repositories to existing installation", async () => {
    const mockInstallation = {
      id: "inst-uuid-123",
      installationId: 123_456,
      accountLogin: "test-owner",
      accountType: "Organization",
      status: "ACTIVE",
      organizationId: "org-uuid-456",
    };

    mockFindInstallationByInstallationId.mockResolvedValue(mockInstallation);
    mockAddRepositories.mockResolvedValue([]);

    const event = createInstallationRepositoriesAddedEvent(123_456, [
      { id: 101, full_name: "owner/repo1", name: "repo1", private: false },
      { id: 102, full_name: "owner/repo2", name: "repo2", private: true },
    ]);

    await handleInstallationRepositoriesAdded(event);

    expect(mockFindInstallationByInstallationId).toHaveBeenCalledWith("123456");
    expect(mockAddRepositories).toHaveBeenCalledWith("inst-uuid-123", [
      {
        githubRepoId: "101",
        fullName: "owner/repo1",
        name: "repo1",
        owner: "owner",
        private: false,
      },
      {
        githubRepoId: "102",
        fullName: "owner/repo2",
        name: "repo2",
        owner: "owner",
        private: true,
      },
    ]);
    expect(log.info).toHaveBeenCalledWith(
      "[handleInstallationRepositoriesAdded] Processing repositories added",
      {
        installationId: 123_456,
        repositoryCount: 2,
      }
    );
  });

  it("handles repositories with owner extracted from full_name", async () => {
    const mockInstallation = {
      id: "inst-uuid-123",
      installationId: 123_456,
      accountLogin: "test-owner",
      accountType: "Organization",
      status: "ACTIVE",
      organizationId: "org-uuid-456",
    };

    mockFindInstallationByInstallationId.mockResolvedValue(mockInstallation);
    mockAddRepositories.mockResolvedValue([]);

    const event = createInstallationRepositoriesAddedEvent(123_456, [
      {
        id: 201,
        full_name: "different-owner/special-repo",
        name: "special-repo",
        private: true,
      },
    ]);

    await handleInstallationRepositoriesAdded(event);

    expect(mockAddRepositories).toHaveBeenCalledWith("inst-uuid-123", [
      {
        githubRepoId: "201",
        fullName: "different-owner/special-repo",
        name: "special-repo",
        owner: "different-owner",
        private: true,
      },
    ]);
  });

  it("uses fallback owner when full_name has empty owner", async () => {
    const mockInstallation = {
      id: "inst-uuid-123",
      installationId: 123_456,
      accountLogin: "test-owner",
      accountType: "Organization",
      status: "ACTIVE",
      organizationId: "org-uuid-456",
    };

    mockFindInstallationByInstallationId.mockResolvedValue(mockInstallation);
    mockAddRepositories.mockResolvedValue([]);

    // Create an event with a malformed full_name (starts with slash, empty owner)
    const event = createInstallationRepositoriesAddedEvent(123_456, [
      {
        id: 301,
        full_name: "/repo-no-owner",
        name: "repo-no-owner",
        private: false,
      },
    ]);

    await handleInstallationRepositoriesAdded(event);

    // Should use event.installation.account.login as fallback when split results in empty string
    expect(mockAddRepositories).toHaveBeenCalledWith("inst-uuid-123", [
      {
        githubRepoId: "301",
        fullName: "/repo-no-owner",
        name: "repo-no-owner",
        owner: "test-owner",
        private: false,
      },
    ]);
  });

  it("processes multiple repositories with different visibility", async () => {
    const mockInstallation = {
      id: "inst-uuid-123",
      installationId: 789_012,
      accountLogin: "multi-owner",
      accountType: "Organization",
      status: "ACTIVE",
      organizationId: "org-uuid-789",
    };

    mockFindInstallationByInstallationId.mockResolvedValue(mockInstallation);
    mockAddRepositories.mockResolvedValue([]);

    const event = createInstallationRepositoriesAddedEvent(789_012, [
      {
        id: 401,
        full_name: "multi-owner/public-repo",
        name: "public-repo",
        private: false,
      },
      {
        id: 402,
        full_name: "multi-owner/private-repo",
        name: "private-repo",
        private: true,
      },
      {
        id: 403,
        full_name: "multi-owner/another-public",
        name: "another-public",
        private: false,
      },
    ]);

    await handleInstallationRepositoriesAdded(event);

    expect(mockAddRepositories).toHaveBeenCalledWith("inst-uuid-123", [
      {
        githubRepoId: "401",
        fullName: "multi-owner/public-repo",
        name: "public-repo",
        owner: "multi-owner",
        private: false,
      },
      {
        githubRepoId: "402",
        fullName: "multi-owner/private-repo",
        name: "private-repo",
        owner: "multi-owner",
        private: true,
      },
      {
        githubRepoId: "403",
        fullName: "multi-owner/another-public",
        name: "another-public",
        owner: "multi-owner",
        private: false,
      },
    ]);
  });
});

describe("handleInstallationRepositoriesRemoved", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns early when no repositories are removed", async () => {
    const event = createInstallationRepositoriesRemovedEvent(123_456, []);

    await handleInstallationRepositoriesRemoved(event);

    expect(log.info).toHaveBeenCalledWith(
      "[handleInstallationRepositoriesRemoved] Processing repositories removed",
      {
        installationId: 123_456,
        repositoryCount: 0,
      }
    );
    expect(mockFindInstallationByInstallationId).not.toHaveBeenCalled();
    expect(mockRemoveRepositories).not.toHaveBeenCalled();
  });

  it("logs warning and returns when installation not found", async () => {
    mockFindInstallationByInstallationId.mockResolvedValue(null);

    const event = createInstallationRepositoriesRemovedEvent(123_456, [
      { id: 1, full_name: "owner/repo1", name: "repo1", private: false },
    ]);

    await handleInstallationRepositoriesRemoved(event);

    expect(mockFindInstallationByInstallationId).toHaveBeenCalledWith("123456");
    expect(log.warn).toHaveBeenCalledWith(
      "[handleInstallationRepositoriesRemoved] Installation not found",
      {
        installationId: 123_456,
      }
    );
    expect(mockRemoveRepositories).not.toHaveBeenCalled();
  });

  it("removes repositories from existing installation", async () => {
    const mockInstallation = {
      id: "inst-uuid-123",
      installationId: 123_456,
      accountLogin: "test-owner",
      accountType: "Organization",
      status: "ACTIVE",
      organizationId: "org-uuid-456",
    };

    mockFindInstallationByInstallationId.mockResolvedValue(mockInstallation);
    mockRemoveRepositories.mockResolvedValue(undefined);

    const event = createInstallationRepositoriesRemovedEvent(123_456, [
      { id: 101, full_name: "owner/repo1", name: "repo1", private: false },
      { id: 102, full_name: "owner/repo2", name: "repo2", private: true },
    ]);

    await handleInstallationRepositoriesRemoved(event);

    expect(mockFindInstallationByInstallationId).toHaveBeenCalledWith("123456");
    expect(mockRemoveRepositories).toHaveBeenCalledWith("inst-uuid-123", [
      "101",
      "102",
    ]);
    expect(log.info).toHaveBeenCalledWith(
      "[handleInstallationRepositoriesRemoved] Processing repositories removed",
      {
        installationId: 123_456,
        repositoryCount: 2,
      }
    );
  });

  it("extracts only githubRepoId for removal", async () => {
    const mockInstallation = {
      id: "inst-uuid-456",
      installationId: 789_012,
      accountLogin: "removal-owner",
      accountType: "Organization",
      status: "ACTIVE",
      organizationId: "org-uuid-789",
    };

    mockFindInstallationByInstallationId.mockResolvedValue(mockInstallation);
    mockRemoveRepositories.mockResolvedValue(undefined);

    const event = createInstallationRepositoriesRemovedEvent(789_012, [
      {
        id: 201,
        full_name: "removal-owner/repo-a",
        name: "repo-a",
        private: false,
      },
      {
        id: 202,
        full_name: "removal-owner/repo-b",
        name: "repo-b",
        private: true,
      },
      {
        id: 203,
        full_name: "removal-owner/repo-c",
        name: "repo-c",
        private: false,
      },
    ]);

    await handleInstallationRepositoriesRemoved(event);

    // Should pass only IDs, not full repository objects
    expect(mockRemoveRepositories).toHaveBeenCalledWith("inst-uuid-456", [
      "201",
      "202",
      "203",
    ]);
  });

  it("handles single repository removal", async () => {
    const mockInstallation = {
      id: "inst-uuid-789",
      installationId: 555_555,
      accountLogin: "single-owner",
      accountType: "User",
      status: "ACTIVE",
      organizationId: "org-uuid-999",
    };

    mockFindInstallationByInstallationId.mockResolvedValue(mockInstallation);
    mockRemoveRepositories.mockResolvedValue(undefined);

    const event = createInstallationRepositoriesRemovedEvent(555_555, [
      {
        id: 999,
        full_name: "single-owner/lone-repo",
        name: "lone-repo",
        private: true,
      },
    ]);

    await handleInstallationRepositoriesRemoved(event);

    expect(mockRemoveRepositories).toHaveBeenCalledWith("inst-uuid-789", [
      "999",
    ]);
    expect(log.info).toHaveBeenCalledWith(
      "[handleInstallationRepositoriesRemoved] Processing repositories removed",
      {
        installationId: 555_555,
        repositoryCount: 1,
      }
    );
  });
});

describe("integration scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles add and remove operations on same installation", async () => {
    const mockInstallation = {
      id: "inst-uuid-integration",
      installationId: 999_999,
      accountLogin: "integration-owner",
      accountType: "Organization",
      status: "ACTIVE",
      organizationId: "org-uuid-integration",
    };

    mockFindInstallationByInstallationId.mockResolvedValue(mockInstallation);
    mockAddRepositories.mockResolvedValue([]);
    mockRemoveRepositories.mockResolvedValue(undefined);

    // First: add repositories
    const addEvent = createInstallationRepositoriesAddedEvent(999_999, [
      {
        id: 1001,
        full_name: "integration-owner/new-repo-1",
        name: "new-repo-1",
        private: false,
      },
      {
        id: 1002,
        full_name: "integration-owner/new-repo-2",
        name: "new-repo-2",
        private: true,
      },
    ]);

    await handleInstallationRepositoriesAdded(addEvent);

    expect(mockAddRepositories).toHaveBeenCalledWith("inst-uuid-integration", [
      {
        githubRepoId: "1001",
        fullName: "integration-owner/new-repo-1",
        name: "new-repo-1",
        owner: "integration-owner",
        private: false,
      },
      {
        githubRepoId: "1002",
        fullName: "integration-owner/new-repo-2",
        name: "new-repo-2",
        owner: "integration-owner",
        private: true,
      },
    ]);

    vi.clearAllMocks();

    // Then: remove repositories
    const removeEvent = createInstallationRepositoriesRemovedEvent(999_999, [
      {
        id: 1001,
        full_name: "integration-owner/new-repo-1",
        name: "new-repo-1",
        private: false,
      },
    ]);

    await handleInstallationRepositoriesRemoved(removeEvent);

    expect(mockRemoveRepositories).toHaveBeenCalledWith(
      "inst-uuid-integration",
      ["1001"]
    );
  });

  it("handles missing installation consistently across add and remove", async () => {
    mockFindInstallationByInstallationId.mockResolvedValue(null);

    // Add event with missing installation
    const addEvent = createInstallationRepositoriesAddedEvent(111_111, [
      { id: 1, full_name: "owner/repo", name: "repo", private: false },
    ]);

    await handleInstallationRepositoriesAdded(addEvent);

    expect(log.warn).toHaveBeenCalledWith(
      "[handleInstallationRepositoriesAdded] Installation not found",
      { installationId: 111_111 }
    );
    expect(mockAddRepositories).not.toHaveBeenCalled();

    vi.clearAllMocks();

    // Remove event with missing installation
    const removeEvent = createInstallationRepositoriesRemovedEvent(111_111, [
      { id: 1, full_name: "owner/repo", name: "repo", private: false },
    ]);

    await handleInstallationRepositoriesRemoved(removeEvent);

    expect(log.warn).toHaveBeenCalledWith(
      "[handleInstallationRepositoriesRemoved] Installation not found",
      { installationId: 111_111 }
    );
    expect(mockRemoveRepositories).not.toHaveBeenCalled();
  });
});

describe("handleInstallationRepositories (orchestrator)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes 'added' action to handleInstallationRepositoriesAdded", async () => {
    const mockInstallation = {
      id: "inst-uuid-123",
      installationId: 123_456,
      accountLogin: "test-owner",
      status: "ACTIVE",
    };

    mockFindInstallationByInstallationId.mockResolvedValue(mockInstallation);
    mockAddRepositories.mockResolvedValue([]);

    const event = createInstallationRepositoriesAddedEvent(123_456, [
      { id: 101, full_name: "owner/repo1", name: "repo1", private: false },
    ]);

    const response = await handleInstallationRepositories(event);
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.message).toBe("Repositories added successfully");
    expect(mockAddRepositories).toHaveBeenCalled();
  });

  it("routes 'removed' action to handleInstallationRepositoriesRemoved", async () => {
    const mockInstallation = {
      id: "inst-uuid-123",
      installationId: 123_456,
      accountLogin: "test-owner",
      status: "ACTIVE",
    };

    mockFindInstallationByInstallationId.mockResolvedValue(mockInstallation);
    mockRemoveRepositories.mockResolvedValue(undefined);

    const event = createInstallationRepositoriesRemovedEvent(123_456, [
      { id: 101, full_name: "owner/repo1", name: "repo1", private: false },
    ]);

    const response = await handleInstallationRepositories(event);
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.message).toBe("Repositories removed successfully");
    expect(mockRemoveRepositories).toHaveBeenCalled();
  });

  it("acknowledges unknown actions without error", async () => {
    const event = { action: "unknown_action" };

    const response = await handleInstallationRepositories(event);
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.message).toBe(
      "Installation repositories action 'unknown_action' acknowledged"
    );
  });
});
