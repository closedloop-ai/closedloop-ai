import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivityEvidenceReason,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { type TransactionClient, withDb } from "@repo/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BranchActivityPersistStatus,
  type PersistedBranchActivityAtom,
  persistBranchActivityAtom,
  persistBranchActivityAtomInTransaction,
  projectCanonicalBranchActivityEvidence,
} from "./branch-activity-evidence";

const ORGANIZATION_ID = "019ff6d4-51f8-7ad0-8a95-40d1f06400dc";
const BRANCH_ID = "019ff6d4-9f0b-70df-b07d-aa44ce3a432e";
const PULL_REQUEST_ID = "019ff6d4-c23d-77d9-a3f2-943fef790c95";
const OCCURRED_AT = "2026-08-12T10:00:00.000Z";
const PRIOR_AT = "2026-08-11T10:00:00.000Z";

describe("Branch activity evidence persistence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("owns the transaction at the public production boundary", async () => {
    const client = createClient();
    const transaction = vi
      .spyOn(withDb, "tx")
      .mockImplementation(async (callback) =>
        callback(client.tx as TransactionClient)
      );

    await expect(persistBranchActivityAtom(input())).resolves.toEqual({
      status: BranchActivityPersistStatus.Inserted,
    });
    expect(transaction).toHaveBeenCalledOnce();
  });

  it("rejects malformed input before any durable access", async () => {
    const client = createClient();

    await expect(
      persistBranchActivityAtomInTransaction(client.tx, {
        ...input(),
        atom: { ...branchAtom(), sourceEventId: "" },
      })
    ).resolves.toEqual({ status: BranchActivityPersistStatus.Invalid });
    expect(client.branchFind).not.toHaveBeenCalled();
    expect(client.createMany).not.toHaveBeenCalled();
    expect(client.updateMany).not.toHaveBeenCalled();
  });

  it("persists a Branch atom and advances the compatibility scalar monotonically", async () => {
    const client = createClient();

    await expect(
      persistBranchActivityAtomInTransaction(client.tx, input())
    ).resolves.toEqual({ status: BranchActivityPersistStatus.Inserted });
    expect(client.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          version: BranchActivityAtomVersion.V1,
          organizationId: ORGANIZATION_ID,
          branchArtifactId: BRANCH_ID,
          source: BranchActivitySource.GitHubWebhook,
          sourceEventId: "delivery-1",
          attributionKind: BranchActivityAttributionKind.Branch,
          pullRequestDetailId: null,
          completeness: BranchActivityEvidenceCompleteness.Complete,
        }),
      ],
      skipDuplicates: true,
    });
    expect(client.updateMany).toHaveBeenCalledWith({
      where: {
        artifactId: BRANCH_ID,
        organizationId: ORGANIZATION_ID,
        OR: [
          { lastActivityAt: null },
          { lastActivityAt: { lt: new Date(OCCURRED_AT) } },
        ],
      },
      data: { lastActivityAt: new Date(OCCURRED_AT) },
    });
  });

  it("requires PR attribution to resolve inside the same Branch and organization", async () => {
    const client = createClient({ pullRequest: null });

    await expect(
      persistBranchActivityAtomInTransaction(client.tx, {
        ...input(),
        atom: pullRequestAtom(),
      })
    ).resolves.toEqual({
      status: BranchActivityPersistStatus.InvalidAttribution,
    });
    expect(client.pullRequestFind).toHaveBeenCalledWith({
      where: { id: PULL_REQUEST_ID },
      select: { branchArtifactId: true, id: true, organizationId: true },
    });
    expect(client.createMany).not.toHaveBeenCalled();
    expect(client.updateMany).not.toHaveBeenCalled();
  });

  it("returns not_found for a missing or wrong-organization Branch", async () => {
    const client = createClient({ branch: null });

    await expect(
      persistBranchActivityAtomInTransaction(client.tx, input())
    ).resolves.toEqual({ status: BranchActivityPersistStatus.NotFound });
    expect(client.branchFind).toHaveBeenCalledWith({
      where: {
        organizationId_artifactId: {
          artifactId: BRANCH_ID,
          organizationId: ORGANIZATION_ID,
        },
      },
      select: { artifactId: true },
    });
    expect(client.createMany).not.toHaveBeenCalled();
  });

  it("treats an exact duplicate as replay and heals only from the stored timestamp", async () => {
    const client = createClient({ insertedCount: 0 });

    await expect(
      persistBranchActivityAtomInTransaction(client.tx, input())
    ).resolves.toEqual({ status: BranchActivityPersistStatus.Replayed });
    expect(client.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { lastActivityAt: new Date(OCCURRED_AT) },
      })
    );
  });

  it("rejects a conflicting replay without using the incoming timestamp", async () => {
    const client = createClient({
      insertedCount: 0,
      stored: persistedAtom({ occurredAt: new Date(PRIOR_AT) }),
    });

    await expect(
      persistBranchActivityAtomInTransaction(client.tx, input())
    ).resolves.toEqual({ status: BranchActivityPersistStatus.Conflict });
    expect(client.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["version", { version: 2 }],
    [
      "attribution",
      {
        attributionKind: BranchActivityAttributionKind.PullRequest,
        pullRequestDetailId: PULL_REQUEST_ID,
      },
    ],
  ] satisfies [
    string,
    PersistedOverrides,
  ][])("treats changed durable %s as a conflicting replay", async (_field, stored) => {
    const client = createClient({
      insertedCount: 0,
      stored: persistedAtom(stored),
    });

    await expect(
      persistBranchActivityAtomInTransaction(client.tx, input())
    ).resolves.toEqual({ status: BranchActivityPersistStatus.Conflict });
    expect(client.updateMany).not.toHaveBeenCalled();
  });

  it("replays monitored evidence when only conservative completeness changed", async () => {
    const client = createClient({
      insertedCount: 0,
      stored: persistedAtom({
        source: BranchActivitySource.MonitoredSession,
        sourceEventId: "monitored-session-event",
        completeness: BranchActivityEvidenceCompleteness.Complete,
      }),
    });

    await expect(
      persistBranchActivityAtomInTransaction(client.tx, {
        ...input(),
        atom: {
          ...branchAtom(),
          source: BranchActivitySource.MonitoredSession,
          sourceEventId: "monitored-session-event",
          completeness: BranchActivityEvidenceCompleteness.Partial,
        },
      })
    ).resolves.toEqual({ status: BranchActivityPersistStatus.Replayed });
    expect(client.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { lastActivityAt: new Date(OCCURRED_AT) },
      })
    );
  });

  it("lets distinct older and equal-instant identities persist without weakening the scalar guard", async () => {
    const older = createClient();
    const equal = createClient();

    await expect(
      persistBranchActivityAtomInTransaction(older.tx, {
        ...input(),
        atom: {
          ...branchAtom(),
          sourceEventId: "older-delivery",
          occurredAt: PRIOR_AT,
        },
      })
    ).resolves.toEqual({ status: BranchActivityPersistStatus.Inserted });
    await expect(
      persistBranchActivityAtomInTransaction(equal.tx, {
        ...input(),
        atom: { ...branchAtom(), sourceEventId: "equal-delivery" },
      })
    ).resolves.toEqual({ status: BranchActivityPersistStatus.Inserted });
    expect(older.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { lastActivityAt: null },
            { lastActivityAt: { lt: new Date(PRIOR_AT) } },
          ],
        }),
      })
    );
    expect(equal.createMany).toHaveBeenCalledOnce();
  });

  it("propagates dependency failure so the owning transaction rolls back", async () => {
    const client = createClient();
    client.createMany.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      persistBranchActivityAtomInTransaction(client.tx, input())
    ).rejects.toThrow("database unavailable");
    expect(client.updateMany).not.toHaveBeenCalled();
  });
});

describe("Branch activity evidence projection", () => {
  it("reports known persisted evidence as historically partial", () => {
    expect(projectCanonicalBranchActivityEvidence(persistedAtom())).toEqual({
      completeness: BranchActivityEvidenceCompleteness.Partial,
      latestAtom: branchAtom(),
      reason: BranchActivityEvidenceReason.HistoricalCoverage,
    });
  });

  it("preserves a newer raw source identity and downgrades it", () => {
    expect(
      projectCanonicalBranchActivityEvidence(
        persistedAtom({ source: "future_lane" })
      )
    ).toMatchObject({
      completeness: BranchActivityEvidenceCompleteness.Partial,
      latestAtom: {
        source: BranchActivitySource.Unknown,
        sourceIdentity: "future_lane",
        completeness: BranchActivityEvidenceCompleteness.Partial,
      },
      reason: BranchActivityEvidenceReason.UnknownSource,
    });
  });

  it("distinguishes no evidence from malformed persisted evidence", () => {
    expect(projectCanonicalBranchActivityEvidence(null)).toEqual({
      completeness: BranchActivityEvidenceCompleteness.Unavailable,
      reason: BranchActivityEvidenceReason.NoEvidence,
    });
    expect(
      projectCanonicalBranchActivityEvidence(
        persistedAtom({ attributionKind: "future_attribution" })
      )
    ).toEqual({
      completeness: BranchActivityEvidenceCompleteness.Unavailable,
      reason: BranchActivityEvidenceReason.MalformedEvidence,
    });
    expect(
      projectCanonicalBranchActivityEvidence(persistedAtom({ version: 2 }))
    ).toEqual({
      completeness: BranchActivityEvidenceCompleteness.Unavailable,
      reason: BranchActivityEvidenceReason.MalformedEvidence,
    });
  });
});

type PersistenceClient = Parameters<
  typeof persistBranchActivityAtomInTransaction
>[0];

type PersistedOverrides = Partial<PersistedBranchActivityAtom>;

function input() {
  return {
    organizationId: ORGANIZATION_ID,
    branchArtifactId: BRANCH_ID,
    atom: branchAtom(),
  };
}

function branchAtom() {
  return {
    version: BranchActivityAtomVersion.V1,
    source: BranchActivitySource.GitHubWebhook,
    sourceEventId: "delivery-1",
    occurredAt: OCCURRED_AT,
    attribution: { kind: BranchActivityAttributionKind.Branch },
    completeness: BranchActivityEvidenceCompleteness.Complete,
  } as const;
}

function pullRequestAtom() {
  return {
    ...branchAtom(),
    source: BranchActivitySource.PullRequestLifecycle,
    attribution: {
      kind: BranchActivityAttributionKind.PullRequest,
      pullRequestId: PULL_REQUEST_ID,
    },
  } as const;
}

function persistedAtom(overrides: PersistedOverrides = {}) {
  return {
    version: BranchActivityAtomVersion.V1,
    source: BranchActivitySource.GitHubWebhook,
    sourceEventId: "delivery-1",
    occurredAt: new Date(OCCURRED_AT),
    attributionKind: BranchActivityAttributionKind.Branch,
    pullRequestDetailId: null,
    completeness: BranchActivityEvidenceCompleteness.Complete,
    ...overrides,
  };
}

function createClient(
  options: {
    branch?: { artifactId: string } | null;
    insertedCount?: number;
    pullRequest?: {
      branchArtifactId: string;
      id: string;
      organizationId: string;
    } | null;
    stored?: ReturnType<typeof persistedAtom> | null;
  } = {}
) {
  const branchFind = vi
    .fn()
    .mockResolvedValue(
      options.branch === undefined ? { artifactId: BRANCH_ID } : options.branch
    );
  const pullRequestFind = vi.fn().mockResolvedValue(
    options.pullRequest === undefined
      ? {
          branchArtifactId: BRANCH_ID,
          id: PULL_REQUEST_ID,
          organizationId: ORGANIZATION_ID,
        }
      : options.pullRequest
  );
  const createMany = vi
    .fn()
    .mockResolvedValue({ count: options.insertedCount ?? 1 });
  const atomFind = vi
    .fn()
    .mockResolvedValue(
      options.stored === undefined ? persistedAtom() : options.stored
    );
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const tx = {
    branchActivityAtom: { createMany, findUnique: atomFind },
    branchDetail: { findUnique: branchFind, updateMany },
    pullRequestDetail: { findUnique: pullRequestFind },
  } as unknown as PersistenceClient;
  return {
    atomFind,
    branchFind,
    createMany,
    pullRequestFind,
    tx,
    updateMany,
  };
}
