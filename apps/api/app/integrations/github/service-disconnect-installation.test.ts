/**
 * `githubService.disconnectInstallation`: the idempotent no-op, the org-scoped
 * GitHub uninstall on success and failure, and the local UNINSTALLED write.
 * Split out of `service.test.ts`, which owns the rest of the service surface.
 */

import type * as GitHubModule from "@repo/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbAll } from "../../../__tests__/utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  // Minimal `Prisma.sql`/`Prisma.join` so the set-based bulk-upsert path the
  // service module pulls in builds its statement without the real client.
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (parts: unknown[]) => ({ strings: [], values: parts }),
  },
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
  GitHubInstallationStatus: {
    PENDING_CLAIM: "PENDING_CLAIM",
    ACTIVE: "ACTIVE",
    SUSPENDED: "SUSPENDED",
    UNINSTALLED: "UNINSTALLED",
  },
}));

vi.mock("@repo/github", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubModule>();
  return {
    deleteInstallation: vi.fn(),
    getRepositoryBranches: vi.fn(),
    getRepositoryPullRequestsWithMetadata: vi.fn(),
    GitHubProviderResultStatus: actual.GitHubProviderResultStatus,
  };
});

vi.mock("@repo/github/installation-auth", () => ({
  getInstallationOctokit: vi.fn(),
}));

vi.mock("@repo/github/keys", () => ({
  keys: vi.fn(() => ({
    GITHUB_APP_CLIENT_ID: "test-client-id",
    GITHUB_APP_CLIENT_SECRET: "test-client-secret",
  })),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: vi.fn(),
}));

vi.mock("@repo/observability/error", () => ({
  parseError: vi.fn((err: unknown) => String(err)),
}));

vi.mock("@/app/integrations/github/public-repositories/service", () => ({
  publicRepositoryService: { getBranches: vi.fn() },
}));

// Import after mocks are set up
import { GitHubInstallationStatus } from "@repo/database";
import { deleteInstallation } from "@repo/github";
import {
  GITHUB_INSTALLATION_ID,
  ORG_ID,
} from "@/__tests__/support/integrations/github/repository-lookup.test-fixtures";
import { githubService } from "@/app/integrations/github/service";

const mockDeleteInstallation = deleteInstallation as ReturnType<typeof vi.fn>;
const INSTALLATION_ID = "install-1";

describe("githubService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("disconnectInstallation", () => {
    it("is a no-op when no installation is found for the organization", async () => {
      const mockDb = {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue(null),
          updateMany: vi.fn(),
        },
      };
      mockWithDbAll(mockDb);

      await expect(
        githubService.disconnectInstallation(ORG_ID)
      ).resolves.toBeUndefined();

      expect(mockDb.gitHubInstallation.findFirst).toHaveBeenCalledTimes(1);
      expect(mockDeleteInstallation).not.toHaveBeenCalled();
      expect(mockDb.gitHubInstallation.updateMany).not.toHaveBeenCalled();
    });

    it("does not uninstall an org-less installation from an unrelated org context", async () => {
      const mockDb = {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue(null),
          updateMany: vi.fn(),
        },
      };
      mockWithDbAll(mockDb);

      await githubService.disconnectInstallation(ORG_ID);

      expect(mockDb.gitHubInstallation.findFirst).toHaveBeenCalledWith({
        where: { organizationId: ORG_ID },
        select: { id: true, installationId: true },
      });
      expect(mockDeleteInstallation).not.toHaveBeenCalled();
      expect(mockDb.gitHubInstallation.updateMany).not.toHaveBeenCalled();
    });

    it("still marks UNINSTALLED locally even when GitHub API uninstall fails", async () => {
      const installation = {
        id: INSTALLATION_ID,
        installationId: GITHUB_INSTALLATION_ID,
        organizationId: ORG_ID,
      };
      const mockDb = {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue(installation),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      mockWithDbAll(mockDb);
      mockDeleteInstallation.mockResolvedValue({
        success: false,
        error: "GitHub API error",
      });

      await githubService.disconnectInstallation(ORG_ID);

      // Single write — only the UNINSTALLED status flip. orgId is preserved
      // so a same-account reconnect can reuse this row in-place.
      expect(mockDb.gitHubInstallation.updateMany).toHaveBeenCalledTimes(1);
      expect(mockDb.gitHubInstallation.updateMany).toHaveBeenCalledWith({
        where: { id: INSTALLATION_ID, organizationId: ORG_ID },
        data: { status: GitHubInstallationStatus.UNINSTALLED },
      });
    });

    it("marks installation as UNINSTALLED but preserves orgId on successful disconnect", async () => {
      const installation = {
        id: INSTALLATION_ID,
        installationId: GITHUB_INSTALLATION_ID,
        organizationId: ORG_ID,
      };
      const mockDb = {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue(installation),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      mockWithDbAll(mockDb);
      mockDeleteInstallation.mockResolvedValue({ success: true });

      await githubService.disconnectInstallation(ORG_ID);

      expect(mockDeleteInstallation).toHaveBeenCalledWith(
        GITHUB_INSTALLATION_ID
      );
      expect(mockDb.gitHubInstallation.updateMany).toHaveBeenCalledTimes(1);
      expect(mockDb.gitHubInstallation.updateMany).toHaveBeenCalledWith({
        where: { id: INSTALLATION_ID, organizationId: ORG_ID },
        data: { status: GitHubInstallationStatus.UNINSTALLED },
      });
    });

    it("does not uninstall remotely or clear local state when ownership changes during disconnect", async () => {
      const installation = {
        id: INSTALLATION_ID,
        installationId: GITHUB_INSTALLATION_ID,
        organizationId: ORG_ID,
      };
      const mockDb = {
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue(installation),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      };
      mockWithDbAll(mockDb);
      mockDeleteInstallation.mockResolvedValue({ success: true });

      await githubService.disconnectInstallation(ORG_ID);

      expect(mockDb.gitHubInstallation.updateMany).toHaveBeenCalledWith({
        where: { id: INSTALLATION_ID, organizationId: ORG_ID },
        data: { status: GitHubInstallationStatus.UNINSTALLED },
      });
      expect(mockDb.gitHubInstallation.updateMany).toHaveBeenCalledTimes(1);
      expect(mockDeleteInstallation).not.toHaveBeenCalled();
    });
  });
});
