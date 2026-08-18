import type { PushEvent } from "@octokit/webhooks-types";
import { RepositoryDefaultSource } from "@repo/api/src/types/repository-default-identity";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockWithDb, mockWithDbTx, mockBulkUpsertInstallationRepositories } =
  vi.hoisted(() => ({
    mockWithDb: vi.fn(),
    mockWithDbTx: vi.fn(),
    mockBulkUpsertInstallationRepositories: vi.fn(),
  }));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(mockWithDb, { tx: mockWithDbTx }),
  Prisma: {
    join: vi.fn(),
    sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    })),
  },
  ArtifactType: { BRANCH: "BRANCH", DOCUMENT: "DOCUMENT" },
  GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
}));
vi.mock("@repo/observability/log", () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@repo/github/artifact-reference-parser", () => ({
  parseArtifactReferences: vi.fn(),
}));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/app/branches/branch-service", () => ({
  branchService: { upsertBranchArtifact: vi.fn() },
}));
vi.mock("@/app/branches/file-cache-service", () => ({
  refreshBranchFileChangeCache: vi.fn(),
}));
vi.mock("@/app/commits/commit-service", () => ({
  commitService: { recordWebhookCommits: vi.fn() },
}));
vi.mock("@/app/webhooks/github/handlers/dirty-scope-publisher", () => ({
  publishGitHubDirtyScopes: vi.fn(),
}));
vi.mock("@/app/integrations/github/service/repository-sync", () => ({
  bulkUpsertInstallationRepositories: mockBulkUpsertInstallationRepositories,
}));

import { handlePush } from "@/app/webhooks/github/handlers/push-handler";
import { persistedGitHubRepositoryAuthority } from "../fixtures/repository-default-authority";

const mockDb = {
  $queryRaw: vi.fn(),
  gitHubInstallationRepository: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  publicRepository: { findMany: vi.fn() },
  repositoryDefaultObservationReceipt: { createMany: vi.fn() },
};

describe("push repository authority receipt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    mockWithDbTx.mockImplementation((callback) => callback(mockDb));
    mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
      id: "00000000-0000-0000-0000-000000000001",
      installationId: "00000000-0000-0000-0000-000000000002",
      ...persistedGitHubRepositoryAuthority({
        githubRepoId: "456",
        fullName: "owner/repo",
      }),
      installation: {
        organizationId: "00000000-0000-0000-0000-000000000003",
      },
    });
    mockDb.gitHubInstallationRepository.updateMany.mockResolvedValue({
      count: 1,
    });
    mockDb.gitHubInstallationRepository.findMany.mockResolvedValue([
      persistedGitHubRepositoryAuthority({
        githubRepoId: "456",
        fullName: "owner/repo",
      }),
    ]);
    mockDb.$queryRaw.mockResolvedValue([
      persistedGitHubRepositoryAuthority({
        githubRepoId: "456",
        fullName: "owner/repo",
      }),
    ]);
    mockDb.publicRepository.findMany.mockResolvedValue([]);
  });

  it("makes D1/D2/D1 a durable no-op with the exact delivery ID", async () => {
    const claimed = new Set<string>();
    mockDb.repositoryDefaultObservationReceipt.createMany.mockImplementation(
      ({ data }: { data: Array<{ observationKey: string }> }) => {
        const observationKey = data[0]?.observationKey ?? "";
        if (claimed.has(observationKey)) {
          return Promise.resolve({ count: 0 });
        }
        claimed.add(observationKey);
        return Promise.resolve({ count: 1 });
      }
    );
    const event = createDefaultBranchPush();

    await handlePush(event, observation("delivery-1", 10));
    await handlePush(event, observation("delivery-2", 11));
    const replay = await handlePush(event, observation("delivery-1", 12));

    expect(await replay.json()).toEqual({
      message: "Default branch push ignored",
      ok: true,
    });
    expect(
      mockDb.gitHubInstallationRepository.updateMany
    ).toHaveBeenCalledTimes(2);
    expect(mockBulkUpsertInstallationRepositories).toHaveBeenCalledTimes(2);
    expect(
      mockDb.repositoryDefaultObservationReceipt.createMany
    ).toHaveBeenNthCalledWith(1, {
      data: [
        expect.objectContaining({
          source: RepositoryDefaultSource.PushWebhook,
          observationKey: "delivery-1",
        }),
      ],
      skipDuplicates: true,
    });
  });
});

function observation(deliveryId: string, hour: number) {
  return {
    deliveryId,
    observedAt: new Date(`2026-08-10T${hour}:00:00.000Z`),
  };
}

function createDefaultBranchPush(): PushEvent {
  const event = {} as PushEvent;
  return Object.assign(event, {
    ref: "refs/heads/main",
    before: "before",
    after: "after",
    commits: [],
    created: false,
    deleted: false,
    installation: { id: 123 },
    repository: {
      id: 456,
      full_name: "owner/repo",
      name: "repo",
      owner: { login: "owner" },
      private: false,
      default_branch: "main",
      pushed_at: "2026-08-10T09:00:00.000Z",
    },
  });
}
