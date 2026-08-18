/**
 * Unit tests for GitHub App installation lifecycle events.
 *
 * Tests the installation handler functions which:
 * - Handle installation created/deleted/suspended/unsuspended events
 * - Manage installation status and organization linking
 * - Sync repositories when installation is created
 * - Preserve organization link on installation deletion so same-account
 *   reconnect can reuse the row in-place (see PLN-634)
 *
 * The suspend/unsuspend handlers have their own suite in
 * `webhook-installation-suspension.test.ts`; the lifecycle scenarios below
 * still drive them end to end. Payload builders are shared through
 * `@/__tests__/support/webhooks/github/installation-handler.test-fixtures`.
 */

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
import {
  createInstallationCreatedEvent,
  createInstallationDeletedEvent,
  createInstallationSuspendEvent,
  createInstallationUnsuspendEvent,
  createMockInstallation,
} from "@/__tests__/support/webhooks/github/installation-handler.test-fixtures";

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
      select: { id: true },
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
      select: { id: true },
    });
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
      select: { id: true },
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
