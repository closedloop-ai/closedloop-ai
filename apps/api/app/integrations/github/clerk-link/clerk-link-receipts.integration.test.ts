import { randomUUID } from "node:crypto";
import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyRouteRequest,
  countReceipts,
  createReceiptRouteHarness,
  failReceiptInserts,
  forcedReceiptFailures,
  readReceipts,
  receiptRouteParams,
  turnAttributionFlagOff,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
import { useSessionCaller } from "@/__tests__/support/lib/session-caller.test-helpers";
import { countTransactions } from "@/__tests__/support/lib/transaction-count.test-helpers";

const github = vi.hoisted(() => ({ userId: 0, login: "", unlinked: false }));

vi.mock("@/lib/attribution-evidence-policy-feature", async (importOriginal) =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteFlagMock(await importOriginal())
);
vi.mock("@/lib/auth/with-any-auth", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteAuthMock()
);
vi.mock("@vercel/functions", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteWaitUntilMock()
);
vi.mock(
  "@/lib/operation-receipts/operation-receipt-writer",
  async (importOriginal) =>
    (
      await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
    ).failingReceiptWriterMock(await importOriginal())
);
vi.mock("@/lib/github/clerk-github-credential", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/github/clerk-github-credential")
  >()),
  resolveClerkGitHubCredential: async () =>
    github.unlinked
      ? { ok: false, reason: GitHubAccessDenialReason.NotConnected }
      : {
          ok: true,
          credential: {
            token: "receipt-token",
            scopes: ["repo"],
            externalAccountId: "receipt-external",
          },
        },
}));
vi.mock("@repo/github/user-token-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/github/user-token-auth")>()),
  getUserTokenOctokit: () => ({
    rest: {
      users: {
        getAuthenticated: async () => ({
          data: { id: github.userId, login: github.login },
        }),
      },
    },
  }),
}));
vi.mock("@/app/integrations/github/post-connect-sync-service", () => ({
  runPostConnectObservedSync: async () => undefined,
}));
vi.mock(
  "@/app/branches/branch-owner-seed/branch-owner-seed",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/app/branches/branch-owner-seed/branch-owner-seed")
    >()),
    seedBranchOwnersForLogin: async () => undefined,
  })
);

import { POST as clerkLink } from "@/app/integrations/github/clerk-link/route";

const harness = createReceiptRouteHarness();
const ROUTE = "/integrations/github/clerk-link";
const STALE = new Date("2020-01-01T00:00:00.000Z");

/**
 * ISS-12552: an API-key Clerk link records an organization
 * write receipt in the registry row's own transaction, after the Clerk and
 * GitHub reads.
 */
describe.skipIf(!keys().DATABASE_URL)("ISS-12552 clerk-link receipts", () => {
  afterEach(async () => {
    github.unlinked = false;
    await harness.cleanup();
  });

  it("POST /integrations/github/clerk-link records one organization write for a new registry row", async () => {
    const world = await harness.seedWorld();
    useGitHubAccount();

    const response = await clerkLink(linkRequest(), receiptRouteParams({}));

    expect(response.status).toBe(200);
    expect(await readConnection(world)).not.toBeNull();
    expect(await readReceipts(world.organizationId)).toEqual([
      {
        operationKind: OperationKind.OrganizationWrite,
        outcome: OperationReceiptOutcome.Committed,
        source: OperationSource.Api,
        targetArtifactId: null,
        createdArtifactId: null,
        changedFields: [],
        route: ROUTE,
      },
    ]);
  });

  it("POST /integrations/github/clerk-link creates no registry row when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    useGitHubAccount();
    failReceiptInserts();

    await expect(
      clerkLink(linkRequest(), receiptRouteParams({}))
    ).rejects.toThrow();

    expect(forcedReceiptFailures()).toBe(1);
    expect(await readConnection(world)).toBeNull();
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("POST /integrations/github/clerk-link keeps a stale registry row unrefreshed when its receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    useGitHubAccount();
    await seedStaleConnection(world);
    failReceiptInserts();

    await expect(
      clerkLink(linkRequest(), receiptRouteParams({}))
    ).rejects.toThrow();

    expect(forcedReceiptFailures()).toBe(1);
    expect(await readConnection(world)).toEqual({
      scopes: [],
      lastUsedAt: STALE,
    });
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("POST /integrations/github/clerk-link writes no receipt with attribution-evidence-policy off", async () => {
    const world = await harness.seedWorld();
    useGitHubAccount();
    turnAttributionFlagOff();

    const response = await clerkLink(linkRequest(), receiptRouteParams({}));

    expect(response.status).toBe(200);
    expect(await readConnection(world)).not.toBeNull();
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("POST /integrations/github/clerk-link records one organization write when it marks the registry row unlinked", async () => {
    const world = await harness.seedWorld();
    useGitHubAccount();
    await seedStaleConnection(world);
    github.unlinked = true;

    const response = await clerkLink(linkRequest(), receiptRouteParams({}));

    expect(response.status).toBe(200);
    expect(await readRevokedAt(world)).not.toBeNull();
    expect(await readReceipts(world.organizationId)).toEqual([
      unlinkReceipt(OperationReceiptOutcome.Committed),
    ]);
  });

  it("POST /integrations/github/clerk-link leaves the registry row linked when the unlink receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    useGitHubAccount();
    await seedStaleConnection(world);
    github.unlinked = true;
    failReceiptInserts();

    await expect(
      clerkLink(linkRequest(), receiptRouteParams({}))
    ).rejects.toThrow();

    expect(forcedReceiptFailures()).toBe(1);
    expect(await readRevokedAt(world)).toBeNull();
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("POST /integrations/github/clerk-link records an already-unlinked registry row as a no-op", async () => {
    const world = await harness.seedWorld();
    useGitHubAccount();
    await seedStaleConnection(world, STALE);
    github.unlinked = true;

    const response = await clerkLink(linkRequest(), receiptRouteParams({}));

    expect(response.status).toBe(200);
    expect(await readRevokedAt(world)).toEqual(STALE);
    expect(await readReceipts(world.organizationId)).toEqual([
      unlinkReceipt(OperationReceiptOutcome.NoOp),
    ]);
  });

  it("POST /integrations/github/clerk-link marks the row unlinked and writes no receipt with attribution-evidence-policy off", async () => {
    const world = await harness.seedWorld();
    useGitHubAccount();
    await seedStaleConnection(world);
    github.unlinked = true;
    turnAttributionFlagOff();

    const response = await clerkLink(linkRequest(), receiptRouteParams({}));

    expect(response.status).toBe(200);
    expect(await readRevokedAt(world)).not.toBeNull();
    expect(await countReceipts(world.organizationId)).toBe(0);
  });
});

/**
 * ISS-12552: flag-off behavior equals main for the Clerk link. With
 * `attribution-evidence-policy` off, or for a session caller, it creates the
 * registry row as main does, with one autocommit insert and no transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 clerk-link writes match main with attribution evidence off",
  () => {
    afterEach(async () => {
      vi.restoreAllMocks();
      await harness.cleanup();
    });

    it("a new registry row is created outside any transaction, for an API-key caller", async () => {
      const world = await harness.seedWorld();
      useGitHubAccount();
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await clerkLink(linkRequest(), receiptRouteParams({}));

      expect(response.status).toBe(200);
      expect((await response.json()).data).not.toHaveProperty(
        "operationReceipt"
      );
      expect(transactions.opened).toBe(0);
      expect(await readConnection(world)).not.toBeNull();
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("a new registry row is created outside any transaction, for a session caller", async () => {
      const world = await harness.seedWorld();
      useGitHubAccount();
      useSessionCaller();
      const transactions = countTransactions();

      const response = await clerkLink(linkRequest(), receiptRouteParams({}));

      expect(response.status).toBe(200);
      expect(transactions.opened).toBe(0);
      expect(await readConnection(world)).not.toBeNull();
    });
  }
);

function unlinkReceipt(outcome: string) {
  return {
    operationKind: OperationKind.OrganizationWrite,
    outcome,
    source: OperationSource.Api,
    targetArtifactId: null,
    createdArtifactId: null,
    changedFields: [],
    route: ROUTE,
  };
}

async function readRevokedAt(world: {
  organizationId: string;
  userId: string;
}): Promise<Date | null | undefined> {
  const row = await withDb((db) =>
    db.gitHubUserConnection.findUnique({
      where: {
        organizationId_userId: {
          organizationId: world.organizationId,
          userId: world.userId,
        },
      },
      select: { revokedAt: true },
    })
  );
  return row?.revokedAt;
}

function linkRequest() {
  return apiKeyRouteRequest("POST", ROUTE);
}

function useGitHubAccount(): void {
  github.userId = Math.floor(Math.random() * 1_000_000_000);
  github.login = `receipt-${randomUUID().slice(0, 8)}`;
}

function readConnection(world: { organizationId: string; userId: string }) {
  return withDb((db) =>
    db.gitHubUserConnection.findUnique({
      where: {
        organizationId_userId: {
          organizationId: world.organizationId,
          userId: world.userId,
        },
      },
      select: { scopes: true, lastUsedAt: true },
    })
  );
}

async function seedStaleConnection(
  world: { organizationId: string; userId: string },
  revokedAt: Date | null = null
): Promise<void> {
  await withDb((db) =>
    db.gitHubUserConnection.create({
      data: {
        organizationId: world.organizationId,
        userId: world.userId,
        githubUserId: String(github.userId),
        login: github.login,
        normalizedLogin: github.login.toLowerCase(),
        scopes: [],
        lastUsedAt: STALE,
        revokedAt,
      },
    })
  );
}
