/**
 * `handleInstallationSuspended` / `handleInstallationUnsuspended` — the GitHub
 * App suspension lifecycle: writing suspension metadata when an installation is
 * suspended, and restoring the pre-suspension status (ACTIVE for a claimed
 * install, PENDING_CLAIM for an unclaimed one, UNINSTALLED left alone) while
 * clearing that metadata on unsuspension. Split out of
 * `webhook-installation.test.ts`, which owns the create/delete handlers and the
 * `handleInstallation` orchestrator. Payload builders are shared through
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

// The handler module imports `withDb` for the delete path only; the suspension
// handlers route every write through `githubService.updateInstallationStatus`,
// so the stub exists to satisfy module load, not to be called.
vi.mock("@repo/database", () => ({
  GitHubInstallationStatus: {
    PENDING_CLAIM: "PENDING_CLAIM",
    ACTIVE: "ACTIVE",
    SUSPENDED: "SUSPENDED",
    UNINSTALLED: "UNINSTALLED",
  },
  withDb: vi.fn(),
}));

vi.mock("@/app/integrations/github/service", () => ({
  githubService: {
    findInstallationByInstallationId: vi.fn(),
    updateInstallationStatus: vi.fn(),
  },
}));

// Import after mocking
import { githubService } from "@/app/integrations/github/service";
import {
  handleInstallationSuspended,
  handleInstallationUnsuspended,
} from "@/app/webhooks/github/handlers/installation-handler";

// Type aliases for mocked functions
const mockFindInstallation =
  githubService.findInstallationByInstallationId as Mock;
const mockUpdateInstallationStatus =
  githubService.updateInstallationStatus as Mock;

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
