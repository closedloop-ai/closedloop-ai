/**
 * Unit tests for GitHub App installation lifecycle events.
 *
 * Tests the installation handler functions which:
 * - Handle installation created/deleted/suspended/unsuspended events
 * - Manage installation status and organization linking
 * - Sync repositories when installation is created
 * - Preserve organization link on installation deletion so same-account
 *   reconnect can reuse the row in-place (see PLN-634)
 * - Preserve/restore status appropriately on suspension/unsuspension
 */

import type {
  InstallationCreatedEvent,
  InstallationDeletedEvent,
  InstallationSuspendEvent,
  InstallationUnsuspendEvent,
} from "@octokit/webhooks-types";
import type { GitHubInstallation } from "@repo/database";
import { GitHubInstallationStatus } from "@repo/database";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

// Mock modules before importing
vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@repo/database", () => ({
  GitHubInstallationStatus: {
    PENDING_CLAIM: "PENDING_CLAIM",
    ACTIVE: "ACTIVE",
    SUSPENDED: "SUSPENDED",
    UNINSTALLED: "UNINSTALLED",
  },
  withDb: vi.fn((callback) => callback(mockDb)),
}));

vi.mock("@/app/integrations/github/service", () => ({
  githubService: {
    findInstallationByInstallationId: vi.fn(),
    upsertInstallation: vi.fn(),
    syncRepositories: vi.fn(),
    updateInstallationStatus: vi.fn(),
  },
}));

// Import after mocking
import { withDb } from "@repo/database";
import { githubService } from "@/app/integrations/github/service";
import {
  handleInstallation,
  handleInstallationCreated,
  handleInstallationDeleted,
  handleInstallationSuspended,
  handleInstallationUnsuspended,
  toRepositoryInput,
} from "@/app/webhooks/github/handlers/installation-handler";

// Type aliases for mocked functions
const mockWithDb = withDb as unknown as Mock;
const mockFindInstallation =
  githubService.findInstallationByInstallationId as Mock;
const mockUpsertInstallation = githubService.upsertInstallation as Mock;
const mockSyncRepositories = githubService.syncRepositories as Mock;
const mockUpdateInstallationStatus =
  githubService.updateInstallationStatus as Mock;

// Mock database client
const mockDb = {
  gitHubInstallation: {
    update: vi.fn(),
  },
};

/**
 * Helper to create minimal installation_created event
 */
function createInstallationCreatedEvent(
  installationId: number,
  accountLogin: string,
  repositories: Array<{
    id: number;
    node_id: string;
    full_name: string;
    name: string;
    private: boolean;
  }> = []
): InstallationCreatedEvent {
  return {
    action: "created",
    installation: {
      id: installationId,
      account: {
        login: accountLogin,
        id: 12_345,
        node_id: "U_12345",
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
      target_type: "Organization",
      permissions: {
        metadata: "read",
      },
      events: ["push", "pull_request"],
      repository_selection: "all",
      access_tokens_url: "",
      repositories_url: "",
      html_url: "",
      app_id: 123,
      app_slug: "test-app",
      target_id: 12_345,
      created_at: "2026-02-06T00:00:00Z",
      updated_at: "2026-02-06T00:00:00Z",
      single_file_name: null,
      has_multiple_single_files: false,
      single_file_paths: [],
      suspended_by: null,
      suspended_at: null,
    },
    repositories,
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
    requester: undefined,
  } as InstallationCreatedEvent;
}

/**
 * Helper to create minimal installation_deleted event
 */
function createInstallationDeletedEvent(
  installationId: number,
  accountLogin: string
): InstallationDeletedEvent {
  return {
    action: "deleted",
    installation: {
      id: installationId,
      account: {
        login: accountLogin,
        id: 12_345,
        node_id: "U_12345",
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
      target_type: "Organization",
      permissions: {
        metadata: "read",
      },
      events: ["push", "pull_request"],
      repository_selection: "all",
      access_tokens_url: "",
      repositories_url: "",
      html_url: "",
      app_id: 123,
      app_slug: "test-app",
      target_id: 12_345,
      created_at: "2026-02-06T00:00:00Z",
      updated_at: "2026-02-06T00:00:00Z",
      single_file_name: null,
      has_multiple_single_files: false,
      single_file_paths: [],
      suspended_by: null,
      suspended_at: null,
    },
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
    repositories: [],
  } as InstallationDeletedEvent;
}

/**
 * Helper to create minimal installation_suspend event
 */
function createInstallationSuspendEvent(
  installationId: number,
  accountLogin: string,
  suspendedBy: string
): InstallationSuspendEvent {
  return {
    action: "suspend",
    installation: {
      id: installationId,
      account: {
        login: accountLogin,
        id: 12_345,
        node_id: "U_12345",
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
      target_type: "Organization",
      permissions: {
        metadata: "read",
      },
      events: ["push", "pull_request"],
      repository_selection: "all",
      access_tokens_url: "",
      repositories_url: "",
      html_url: "",
      app_id: 123,
      app_slug: "test-app",
      target_id: 12_345,
      created_at: "2026-02-06T00:00:00Z",
      updated_at: "2026-02-06T00:00:00Z",
      single_file_name: null,
      has_multiple_single_files: false,
      single_file_paths: [],
      suspended_by: {
        login: suspendedBy,
        id: 999,
        node_id: "U_999",
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
      suspended_at: "2026-02-06T00:00:00Z",
    },
    sender: {
      login: suspendedBy,
      id: 999,
      node_id: "U_999",
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
  } as InstallationSuspendEvent;
}

/**
 * Helper to create minimal installation_unsuspend event
 */
function createInstallationUnsuspendEvent(
  installationId: number,
  accountLogin: string
): InstallationUnsuspendEvent {
  return {
    action: "unsuspend",
    installation: {
      id: installationId,
      account: {
        login: accountLogin,
        id: 12_345,
        node_id: "U_12345",
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
      target_type: "Organization",
      permissions: {
        metadata: "read",
      },
      events: ["push", "pull_request"],
      repository_selection: "all",
      access_tokens_url: "",
      repositories_url: "",
      html_url: "",
      app_id: 123,
      app_slug: "test-app",
      target_id: 12_345,
      created_at: "2026-02-06T00:00:00Z",
      updated_at: "2026-02-06T00:00:00Z",
      single_file_name: null,
      has_multiple_single_files: false,
      single_file_paths: [],
      suspended_by: null,
      suspended_at: null,
    },
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
  } as InstallationUnsuspendEvent;
}

/**
 * Helper to create mock installation record
 */
function createMockInstallation(
  partial: Partial<GitHubInstallation> = {}
): GitHubInstallation {
  return {
    id: "installation-uuid",
    installationId: "123456",
    accountId: "12345",
    accountLogin: "test-org",
    accountType: "Organization",
    senderLogin: "test-user",
    senderId: "1",
    status: GitHubInstallationStatus.ACTIVE,
    permissions: {},
    events: [],
    repositorySelection: "all",
    organizationId: "org-uuid",
    claimedAt: new Date(),
    claimedByUserId: "user-uuid",
    suspendedAt: null,
    suspendedBy: null,
    pendingNewInstallationId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

describe("toRepositoryInput", () => {
  it("extracts repository data correctly", () => {
    const repo = {
      id: 123,
      full_name: "owner/repo",
      name: "repo",
      private: true,
    };

    const result = toRepositoryInput(repo, "fallback-owner");

    expect(result).toEqual({
      githubRepoId: "123",
      fullName: "owner/repo",
      name: "repo",
      owner: "owner",
      private: true,
    });
  });

  it("uses first part of full_name when no slash present", () => {
    const repo = {
      id: 456,
      full_name: "repo",
      name: "repo",
      private: false,
    };

    const result = toRepositoryInput(repo, "fallback-owner");

    // When full_name has no slash, split("/") returns ["repo"]
    // so owner becomes "repo", not the fallback
    expect(result).toEqual({
      githubRepoId: "456",
      fullName: "repo",
      name: "repo",
      owner: "repo",
      private: false,
    });
  });
});

describe("handleInstallationCreated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates new installation record with PENDING_CLAIM status", async () => {
    const event = createInstallationCreatedEvent(123_456, "new-org", [
      {
        id: 1,
        node_id: "R_1",
        full_name: "new-org/repo1",
        name: "repo1",
        private: false,
      },
    ]);

    mockFindInstallation.mockResolvedValue(null);
    mockUpsertInstallation.mockResolvedValue(
      createMockInstallation({
        installationId: "123456",
        status: GitHubInstallationStatus.PENDING_CLAIM,
        organizationId: null,
      })
    );
    mockSyncRepositories.mockResolvedValue([]);

    await handleInstallationCreated(event);

    expect(mockFindInstallation).toHaveBeenCalledWith("123456");
    expect(mockUpsertInstallation).toHaveBeenCalledWith("123456", {
      accountId: "12345",
      accountLogin: "new-org",
      accountType: "Organization",
      senderLogin: "test-user",
      senderId: "1",
      status: "PENDING_CLAIM",
      permissions: { metadata: "read" },
      events: ["push", "pull_request"],
      repositorySelection: "all",
      organizationId: undefined,
    });
    expect(mockSyncRepositories).toHaveBeenCalledWith("installation-uuid", [
      {
        githubRepoId: "1",
        fullName: "new-org/repo1",
        name: "repo1",
        owner: "new-org",
        private: false,
      },
    ]);
  });

  it("preserves organizationId when reinstalling ACTIVE installation", async () => {
    const event = createInstallationCreatedEvent(123_456, "existing-org");

    const existingInstallation = createMockInstallation({
      installationId: "123456",
      status: GitHubInstallationStatus.ACTIVE,
      organizationId: "org-uuid",
    });

    mockFindInstallation.mockResolvedValue(existingInstallation);
    mockUpsertInstallation.mockResolvedValue(existingInstallation);
    mockSyncRepositories.mockResolvedValue([]);

    await handleInstallationCreated(event);

    expect(mockUpsertInstallation).toHaveBeenCalledWith(
      "123456",
      expect.objectContaining({
        status: undefined, // Should not set status when preserving org
        organizationId: "org-uuid",
      })
    );
  });

  it("preserves organizationId when reinstalling SUSPENDED installation", async () => {
    const event = createInstallationCreatedEvent(123_456, "suspended-org");

    const existingInstallation = createMockInstallation({
      installationId: "123456",
      status: GitHubInstallationStatus.SUSPENDED,
      organizationId: "org-uuid",
    });

    mockFindInstallation.mockResolvedValue(existingInstallation);
    mockUpsertInstallation.mockResolvedValue(existingInstallation);
    mockSyncRepositories.mockResolvedValue([]);

    await handleInstallationCreated(event);

    expect(mockUpsertInstallation).toHaveBeenCalledWith(
      "123456",
      expect.objectContaining({
        status: undefined,
        organizationId: "org-uuid",
      })
    );
  });

  it("does not preserve organizationId when reinstalling UNINSTALLED installation", async () => {
    const event = createInstallationCreatedEvent(123_456, "uninstalled-org");

    const existingInstallation = createMockInstallation({
      installationId: "123456",
      status: GitHubInstallationStatus.UNINSTALLED,
      organizationId: null,
    });

    mockFindInstallation.mockResolvedValue(existingInstallation);
    mockUpsertInstallation.mockResolvedValue(
      createMockInstallation({
        status: GitHubInstallationStatus.PENDING_CLAIM,
        organizationId: null,
      })
    );
    mockSyncRepositories.mockResolvedValue([]);

    await handleInstallationCreated(event);

    expect(mockUpsertInstallation).toHaveBeenCalledWith(
      "123456",
      expect.objectContaining({
        status: "PENDING_CLAIM",
        organizationId: undefined,
      })
    );
  });

  it("syncs repositories when present in event", async () => {
    const repositories = [
      {
        id: 1,
        node_id: "R_1",
        full_name: "org/repo1",
        name: "repo1",
        private: false,
      },
      {
        id: 2,
        node_id: "R_2",
        full_name: "org/repo2",
        name: "repo2",
        private: true,
      },
    ];
    const event = createInstallationCreatedEvent(123_456, "org", repositories);

    mockFindInstallation.mockResolvedValue(null);
    const newInstallation = createMockInstallation({
      installationId: "123456",
      status: GitHubInstallationStatus.PENDING_CLAIM,
    });
    mockUpsertInstallation.mockResolvedValue(newInstallation);
    mockSyncRepositories.mockResolvedValue([]);

    await handleInstallationCreated(event);

    expect(mockSyncRepositories).toHaveBeenCalledWith("installation-uuid", [
      {
        githubRepoId: "1",
        fullName: "org/repo1",
        name: "repo1",
        owner: "org",
        private: false,
      },
      {
        githubRepoId: "2",
        fullName: "org/repo2",
        name: "repo2",
        owner: "org",
        private: true,
      },
    ]);
  });

  it("skips repository sync when event has no repositories", async () => {
    const event = createInstallationCreatedEvent(123_456, "org", []);

    mockFindInstallation.mockResolvedValue(null);
    mockUpsertInstallation.mockResolvedValue(
      createMockInstallation({
        installationId: "123456",
      })
    );

    await handleInstallationCreated(event);

    expect(mockSyncRepositories).not.toHaveBeenCalled();
  });
});

describe("handleInstallationDeleted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks installation as UNINSTALLED while preserving organizationId", async () => {
    const event = createInstallationDeletedEvent(123_456, "test-org");
    const existingInstallation = createMockInstallation({
      id: "installation-uuid",
      installationId: "123456",
      status: GitHubInstallationStatus.ACTIVE,
      organizationId: "org-uuid",
    });

    mockFindInstallation.mockResolvedValue(existingInstallation);
    mockDb.gitHubInstallation.update.mockResolvedValue({});

    await handleInstallationDeleted(event);

    expect(mockFindInstallation).toHaveBeenCalledWith("123456");
    expect(mockWithDb).toHaveBeenCalled();
    expect(mockDb.gitHubInstallation.update).toHaveBeenCalledWith({
      where: { id: "installation-uuid" },
      data: {
        status: GitHubInstallationStatus.UNINSTALLED,
      },
    });
  });

  it("handles deletion when installation not found in database", async () => {
    const event = createInstallationDeletedEvent(123_456, "test-org");

    mockFindInstallation.mockResolvedValue(null);

    await handleInstallationDeleted(event);

    expect(mockFindInstallation).toHaveBeenCalledWith("123456");
    expect(mockDb.gitHubInstallation.update).not.toHaveBeenCalled();
  });

  it("preserves organizationId even if installation was already SUSPENDED", async () => {
    const event = createInstallationDeletedEvent(123_456, "test-org");
    const existingInstallation = createMockInstallation({
      id: "installation-uuid",
      installationId: "123456",
      status: GitHubInstallationStatus.SUSPENDED,
      organizationId: "org-uuid",
    });

    mockFindInstallation.mockResolvedValue(existingInstallation);
    mockDb.gitHubInstallation.update.mockResolvedValue({});

    await handleInstallationDeleted(event);

    expect(mockDb.gitHubInstallation.update).toHaveBeenCalledWith({
      where: { id: "installation-uuid" },
      data: {
        status: GitHubInstallationStatus.UNINSTALLED,
      },
    });
  });
});

describe("handleInstallationSuspended", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates status to SUSPENDED with suspension metadata", async () => {
    const event = createInstallationSuspendEvent(
      123_456,
      "test-org",
      "admin-user"
    );
    const existingInstallation = createMockInstallation({
      id: "installation-uuid",
      installationId: "123456",
      status: GitHubInstallationStatus.ACTIVE,
    });

    mockFindInstallation.mockResolvedValue(existingInstallation);
    mockUpdateInstallationStatus.mockResolvedValue(existingInstallation);

    await handleInstallationSuspended(event);

    expect(mockFindInstallation).toHaveBeenCalledWith("123456");
    expect(mockUpdateInstallationStatus).toHaveBeenCalledWith(
      "installation-uuid",
      GitHubInstallationStatus.SUSPENDED,
      {
        suspendedAt: expect.any(Date),
        suspendedBy: "admin-user",
      }
    );
  });

  it("handles suspension when installation not found in database", async () => {
    const event = createInstallationSuspendEvent(
      123_456,
      "test-org",
      "admin-user"
    );

    mockFindInstallation.mockResolvedValue(null);

    await handleInstallationSuspended(event);

    expect(mockFindInstallation).toHaveBeenCalledWith("123456");
    expect(mockUpdateInstallationStatus).not.toHaveBeenCalled();
  });
});

describe("handleInstallationUnsuspended", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("restores ACTIVE status for claimed installation", async () => {
    const event = createInstallationUnsuspendEvent(123_456, "test-org");
    const existingInstallation = createMockInstallation({
      id: "installation-uuid",
      installationId: "123456",
      status: GitHubInstallationStatus.SUSPENDED,
      organizationId: "org-uuid",
    });

    mockFindInstallation.mockResolvedValue(existingInstallation);
    mockUpdateInstallationStatus.mockResolvedValue(existingInstallation);

    await handleInstallationUnsuspended(event);

    expect(mockFindInstallation).toHaveBeenCalledWith("123456");
    expect(mockUpdateInstallationStatus).toHaveBeenCalledWith(
      "installation-uuid",
      GitHubInstallationStatus.ACTIVE,
      {
        suspendedAt: null,
        suspendedBy: null,
      }
    );
  });

  it("restores PENDING_CLAIM status for unclaimed installation", async () => {
    const event = createInstallationUnsuspendEvent(123_456, "test-org");
    const existingInstallation = createMockInstallation({
      id: "installation-uuid",
      installationId: "123456",
      status: GitHubInstallationStatus.SUSPENDED,
      organizationId: null,
    });

    mockFindInstallation.mockResolvedValue(existingInstallation);
    mockUpdateInstallationStatus.mockResolvedValue(existingInstallation);

    await handleInstallationUnsuspended(event);

    expect(mockUpdateInstallationStatus).toHaveBeenCalledWith(
      "installation-uuid",
      GitHubInstallationStatus.PENDING_CLAIM,
      {
        suspendedAt: null,
        suspendedBy: null,
      }
    );
  });

  it("keeps UNINSTALLED status unchanged", async () => {
    const event = createInstallationUnsuspendEvent(123_456, "test-org");
    const existingInstallation = createMockInstallation({
      id: "installation-uuid",
      installationId: "123456",
      status: GitHubInstallationStatus.UNINSTALLED,
      organizationId: null,
    });

    mockFindInstallation.mockResolvedValue(existingInstallation);
    mockUpdateInstallationStatus.mockResolvedValue(existingInstallation);

    await handleInstallationUnsuspended(event);

    expect(mockUpdateInstallationStatus).toHaveBeenCalledWith(
      "installation-uuid",
      GitHubInstallationStatus.UNINSTALLED,
      {
        suspendedAt: null,
        suspendedBy: null,
      }
    );
  });

  it("handles unsuspension when installation not found in database", async () => {
    const event = createInstallationUnsuspendEvent(123_456, "test-org");

    mockFindInstallation.mockResolvedValue(null);

    await handleInstallationUnsuspended(event);

    expect(mockFindInstallation).toHaveBeenCalledWith("123456");
    expect(mockUpdateInstallationStatus).not.toHaveBeenCalled();
  });

  it("clears suspension metadata on unsuspension", async () => {
    const event = createInstallationUnsuspendEvent(123_456, "test-org");
    const existingInstallation = createMockInstallation({
      id: "installation-uuid",
      installationId: "123456",
      status: GitHubInstallationStatus.SUSPENDED,
      organizationId: "org-uuid",
      suspendedAt: new Date(),
      suspendedBy: "admin-user",
    });

    mockFindInstallation.mockResolvedValue(existingInstallation);
    mockUpdateInstallationStatus.mockResolvedValue(existingInstallation);

    await handleInstallationUnsuspended(event);

    expect(mockUpdateInstallationStatus).toHaveBeenCalledWith(
      "installation-uuid",
      GitHubInstallationStatus.ACTIVE,
      {
        suspendedAt: null,
        suspendedBy: null,
      }
    );
  });
});

describe("integration scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles full lifecycle: create -> suspend -> unsuspend -> delete", async () => {
    const installationId = 123_456;
    const accountLogin = "test-org";

    // 1. Installation created
    const createdEvent = createInstallationCreatedEvent(
      installationId,
      accountLogin,
      [
        {
          id: 1,
          node_id: "R_1",
          full_name: "test-org/repo",
          name: "repo",
          private: false,
        },
      ]
    );

    mockFindInstallation.mockResolvedValue(null);
    const newInstallation = createMockInstallation({
      id: "installation-uuid",
      installationId: String(installationId),
      status: GitHubInstallationStatus.PENDING_CLAIM,
      organizationId: null,
    });
    mockUpsertInstallation.mockResolvedValue(newInstallation);
    mockSyncRepositories.mockResolvedValue([]);

    await handleInstallationCreated(createdEvent);

    expect(mockUpsertInstallation).toHaveBeenCalledWith(
      String(installationId),
      expect.objectContaining({
        status: "PENDING_CLAIM",
      })
    );

    vi.clearAllMocks();

    // 2. Installation suspended
    const suspendEvent = createInstallationSuspendEvent(
      installationId,
      accountLogin,
      "admin"
    );

    const activeInstallation = createMockInstallation({
      id: "installation-uuid",
      installationId: String(installationId),
      status: GitHubInstallationStatus.ACTIVE,
      organizationId: "org-uuid",
    });
    mockFindInstallation.mockResolvedValue(activeInstallation);
    mockUpdateInstallationStatus.mockResolvedValue(activeInstallation);

    await handleInstallationSuspended(suspendEvent);

    expect(mockUpdateInstallationStatus).toHaveBeenCalledWith(
      "installation-uuid",
      GitHubInstallationStatus.SUSPENDED,
      expect.objectContaining({
        suspendedBy: "admin",
      })
    );

    vi.clearAllMocks();

    // 3. Installation unsuspended
    const unsuspendEvent = createInstallationUnsuspendEvent(
      installationId,
      accountLogin
    );

    const suspendedInstallation = createMockInstallation({
      id: "installation-uuid",
      installationId: String(installationId),
      status: GitHubInstallationStatus.SUSPENDED,
      organizationId: "org-uuid",
    });
    mockFindInstallation.mockResolvedValue(suspendedInstallation);
    mockUpdateInstallationStatus.mockResolvedValue(suspendedInstallation);

    await handleInstallationUnsuspended(unsuspendEvent);

    expect(mockUpdateInstallationStatus).toHaveBeenCalledWith(
      "installation-uuid",
      GitHubInstallationStatus.ACTIVE,
      {
        suspendedAt: null,
        suspendedBy: null,
      }
    );

    vi.clearAllMocks();

    // 4. Installation deleted
    const deletedEvent = createInstallationDeletedEvent(
      installationId,
      accountLogin
    );

    mockFindInstallation.mockResolvedValue(activeInstallation);
    mockDb.gitHubInstallation.update.mockResolvedValue({});

    await handleInstallationDeleted(deletedEvent);

    expect(mockDb.gitHubInstallation.update).toHaveBeenCalledWith({
      where: { id: "installation-uuid" },
      data: {
        status: GitHubInstallationStatus.UNINSTALLED,
      },
    });
  });

  it("handles reinstall after deletion with fresh PENDING_CLAIM status", async () => {
    const installationId = 123_456;
    const accountLogin = "test-org";

    // First, installation is deleted
    const deletedInstallation = createMockInstallation({
      installationId: String(installationId),
      status: GitHubInstallationStatus.UNINSTALLED,
      organizationId: null,
    });

    // Now user reinstalls - should create with PENDING_CLAIM, not preserve old org
    const reinstallEvent = createInstallationCreatedEvent(
      installationId,
      accountLogin
    );

    mockFindInstallation.mockResolvedValue(deletedInstallation);
    mockUpsertInstallation.mockResolvedValue(
      createMockInstallation({
        installationId: String(installationId),
        status: GitHubInstallationStatus.PENDING_CLAIM,
        organizationId: null,
      })
    );
    mockSyncRepositories.mockResolvedValue([]);

    await handleInstallationCreated(reinstallEvent);

    expect(mockUpsertInstallation).toHaveBeenCalledWith(
      String(installationId),
      expect.objectContaining({
        status: "PENDING_CLAIM",
        organizationId: undefined,
      })
    );
  });
});

describe("handleInstallation (orchestrator)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes 'created' action to handleInstallationCreated", async () => {
    const event = createInstallationCreatedEvent(123_456, "test-org");

    mockFindInstallation.mockResolvedValue(null);
    mockUpsertInstallation.mockResolvedValue(
      createMockInstallation({
        installationId: "123456",
        status: GitHubInstallationStatus.PENDING_CLAIM,
        organizationId: null,
      })
    );

    const response = await handleInstallation(event);
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.message).toBe("Installation created successfully");
    expect(mockUpsertInstallation).toHaveBeenCalled();
  });

  it("routes 'deleted' action to handleInstallationDeleted", async () => {
    const event = createInstallationDeletedEvent(123_456, "test-org");

    mockFindInstallation.mockResolvedValue(
      createMockInstallation({ id: "installation-uuid" })
    );
    mockDb.gitHubInstallation.update.mockResolvedValue({});

    const response = await handleInstallation(event);
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.message).toBe("Installation deleted successfully");
    expect(mockDb.gitHubInstallation.update).toHaveBeenCalled();
  });

  it("routes 'suspend' action to handleInstallationSuspended", async () => {
    const event = createInstallationSuspendEvent(123_456, "test-org", "admin");

    mockFindInstallation.mockResolvedValue(
      createMockInstallation({ id: "installation-uuid" })
    );
    mockUpdateInstallationStatus.mockResolvedValue({});

    const response = await handleInstallation(event);
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.message).toBe("Installation suspended successfully");
    expect(mockUpdateInstallationStatus).toHaveBeenCalled();
  });

  it("routes 'unsuspend' action to handleInstallationUnsuspended", async () => {
    const event = createInstallationUnsuspendEvent(123_456, "test-org");

    mockFindInstallation.mockResolvedValue(
      createMockInstallation({
        id: "installation-uuid",
        organizationId: "org-uuid",
      })
    );
    mockUpdateInstallationStatus.mockResolvedValue({});

    const response = await handleInstallation(event);
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.message).toBe("Installation unsuspended successfully");
    expect(mockUpdateInstallationStatus).toHaveBeenCalled();
  });

  it("acknowledges unknown actions without error", async () => {
    const event = { action: "new_permissions_accepted" };

    const response = await handleInstallation(event);
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.message).toBe(
      "Installation action 'new_permissions_accepted' acknowledged"
    );
  });
});
