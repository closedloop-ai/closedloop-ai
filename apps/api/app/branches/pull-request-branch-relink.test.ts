import {
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
} from "@repo/api/src/types/branch-activity";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./branch-detail-signal", () => ({
  emitBranchDetailChanged: vi.fn(),
}));

vi.mock("./branch-activity-aggregate", () => ({
  recomputeBranchActivityAggregatesInTransaction: vi.fn(),
}));

vi.mock("@/app/comments/service/github/relink-pull-request-comments", () => ({
  relinkPullRequestComments: vi.fn(),
}));

vi.mock("./pull-request-provider-lock", () => ({
  acquirePullRequestProviderIdentityLockInTransaction: vi.fn(),
}));

vi.mock("./pull-request-session-link-relink", () => ({
  relinkPullRequestSessionLinksInTransaction: vi.fn(),
}));

import { relinkPullRequestComments } from "@/app/comments/service/github/relink-pull-request-comments";
import { recomputeBranchActivityAggregatesInTransaction } from "./branch-activity-aggregate";
import {
  lockPullRequestBranchAttributionsInTransaction,
  relinkPullRequestBranchInTransaction,
} from "./pull-request-branch-relink";
import { relinkPullRequestSessionLinksInTransaction } from "./pull-request-session-link-relink";

const recomputeAggregates = vi.mocked(
  recomputeBranchActivityAggregatesInTransaction
);
const moveCommentProjectionOwner = vi.mocked(relinkPullRequestComments);
const relinkSessionLinks = vi.mocked(
  relinkPullRequestSessionLinksInTransaction
);

const organizationId = "org-1";
const branchA = "aaaaaaaa-1111-4111-8111-111111111111";
const branchB = "bbbbbbbb-2222-4222-8222-222222222222";
const pullRequestDetailId = "pr-detail-1";
const pullRequestNumber = 42;
const repositoryFullName = "closedloop-ai/closedloop-ai";

type RelinkInput = Parameters<typeof relinkPullRequestBranchInTransaction>[1];

type PrRowLike = {
  branchArtifactId: string;
  organizationId: string;
  repositoryFullName: string | null;
  number: number;
};

type AtomLike = {
  id: string;
  version: number;
  source: string;
  sourceEventId: string;
  occurredAt: Date;
  activityKind: string | null;
  attributionKind: string;
  pullRequestDetailId: string | null;
  completeness: string;
  createdAt: Date;
  branchArtifactId: string;
};

beforeEach(() => {
  vi.clearAllMocks();
  moveCommentProjectionOwner.mockResolvedValue(undefined);
  relinkSessionLinks.mockResolvedValue(false);
  recomputeAggregates.mockResolvedValue(undefined);
});

describe("lockPullRequestBranchAttributionsInTransaction", () => {
  it("returns an empty map without touching the database for an empty id list", async () => {
    const tx = { $executeRaw: vi.fn(), $queryRaw: vi.fn() };

    const result = await lockPullRequestBranchAttributionsInTransaction(tx, {
      organizationId,
      pullRequestDetailIds: [],
    });

    expect(result).toEqual(new Map());
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("relinkPullRequestBranchInTransaction", () => {
  it("throws when the pull request row is not found under FOR UPDATE", async () => {
    const { tx } = createTx({ pullRequestRow: undefined });

    await expect(
      relinkPullRequestBranchInTransaction(tx, baseInput())
    ).rejects.toThrow("pull request branch relink target was not found");
  });

  it("throws when the locked pull request's provider identity no longer matches the request", async () => {
    const { tx } = createTx({
      pullRequestRow: prRow({ number: pullRequestNumber + 1 }),
    });

    await expect(
      relinkPullRequestBranchInTransaction(tx, baseInput())
    ).rejects.toThrow("pull request branch relink provider identity changed");
  });

  it("throws when a branch row backing an involved branch artifact cannot be locked", async () => {
    const { tx } = createTx({
      pullRequestRow: prRow({ branchArtifactId: branchA }),
      missingBranchArtifactIds: [branchA],
    });

    await expect(
      relinkPullRequestBranchInTransaction(
        tx,
        baseInput({ branchArtifactId: branchB })
      )
    ).rejects.toThrow("pull request branch relink ownership check failed");
  });

  it("throws when duplicate-identity activity atoms carry conflicting evidence on their last field", async () => {
    const shared = {
      version: 1,
      source: "git_head",
      sourceEventId: "evt-1",
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      activityKind: null,
      attributionKind: BranchActivityAttributionKind.PullRequest,
      completeness: BranchActivityEvidenceCompleteness.Complete,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const atomOnSource = makeAtom({
      ...shared,
      id: "atom-source",
      branchArtifactId: branchA,
      pullRequestDetailId,
    });
    const atomOnTarget = makeAtom({
      ...shared,
      id: "atom-target",
      branchArtifactId: branchB,
      pullRequestDetailId: "a-different-pull-request-detail-id",
    });
    const { tx } = createTx({
      pullRequestRow: prRow({ branchArtifactId: branchA }),
      activityAtoms: [atomOnSource, atomOnTarget],
    });

    await expect(
      relinkPullRequestBranchInTransaction(
        tx,
        baseInput({ branchArtifactId: branchB })
      )
    ).rejects.toThrow("pull request branch relink activity conflict");
  });

  it("is a no-op when relinking to the branch the pull request is already on with no evidence to reconcile", async () => {
    const { tx, branchActivityAtom, branchDetail } = createTx({
      pullRequestRow: prRow({ branchArtifactId: branchA }),
      activityAtoms: [],
    });
    relinkSessionLinks.mockResolvedValue(false);

    const changed = await relinkPullRequestBranchInTransaction(
      tx,
      baseInput({ branchArtifactId: branchA })
    );

    expect(changed).toBe(false);
    expect(branchActivityAtom.deleteMany).not.toHaveBeenCalled();
    expect(branchActivityAtom.updateMany).not.toHaveBeenCalled();
    expect(branchDetail.updateMany).not.toHaveBeenCalled();
    expect(recomputeAggregates).not.toHaveBeenCalled();
  });

  it("takes the Branch ownership lock as NO KEY UPDATE so a concurrent atom writer's FK KEY SHARE does not deadlock it", async () => {
    const { tx, queryRaw } = createTx({
      pullRequestRow: prRow({ branchArtifactId: branchA }),
      activityAtoms: [],
    });

    await relinkPullRequestBranchInTransaction(
      tx,
      baseInput({ branchArtifactId: branchA })
    );

    const branchLocks = queryRaw.mock.calls
      .map((call) => call[0].join("?"))
      .filter((text) => text.includes("FROM branch_detail"));
    expect(branchLocks.length).toBeGreaterThan(0);
    for (const text of branchLocks) {
      expect(text).toContain("FOR NO KEY UPDATE");
    }
  });

  it("reports a change driven solely by the session-link relink when nothing else moved", async () => {
    const { tx } = createTx({
      pullRequestRow: prRow({ branchArtifactId: branchA }),
      activityAtoms: [],
    });
    relinkSessionLinks.mockResolvedValue(true);

    const changed = await relinkPullRequestBranchInTransaction(
      tx,
      baseInput({ branchArtifactId: branchA })
    );

    expect(changed).toBe(true);
    // activityChanged and associationChanged are both false here, so the
    // aggregate recompute — gated on either of those, not on session links —
    // must not run even though the overall result reports a change.
    expect(recomputeAggregates).not.toHaveBeenCalled();
  });

  it("dedupes a duplicate source atom already mirrored on the target branch, keeping the target atom canonical", async () => {
    const occurredAt = new Date("2026-02-01T00:00:00.000Z");
    const shared = {
      version: 1,
      source: "git_head",
      sourceEventId: "evt-2",
      occurredAt,
      activityKind: null,
      attributionKind: BranchActivityAttributionKind.PullRequest,
      pullRequestDetailId,
    };
    const sourceAtom = makeAtom({
      ...shared,
      id: "atom-source",
      branchArtifactId: branchA,
      completeness: BranchActivityEvidenceCompleteness.Complete,
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    const targetAtom = makeAtom({
      ...shared,
      id: "atom-target",
      branchArtifactId: branchB,
      completeness: BranchActivityEvidenceCompleteness.Complete,
      createdAt: new Date("2026-02-02T00:00:00.000Z"),
    });
    const { tx, branchActivityAtom } = createTx({
      pullRequestRow: prRow({ branchArtifactId: branchA }),
      activityAtoms: [sourceAtom, targetAtom],
    });

    const changed = await relinkPullRequestBranchInTransaction(
      tx,
      baseInput({ branchArtifactId: branchB })
    );

    expect(changed).toBe(true);
    expect(branchActivityAtom.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["atom-source"] }, organizationId },
    });
    expect(branchActivityAtom.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ branchArtifactId: branchB }),
      })
    );
    expect(branchActivityAtom.updateMany).toHaveBeenCalledWith({
      where: { id: "atom-target", organizationId },
      data: {
        createdAt: sourceAtom.createdAt,
        completeness: BranchActivityEvidenceCompleteness.Complete,
      },
    });
    expect(recomputeAggregates).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        exactReplacementBranchArtifactIds: [branchA],
      })
    );
  });

  it("canonicalizes duplicate source-only activity onto its earliest occurrence and moves it to the target branch", async () => {
    const shared = {
      version: 1,
      source: "git_head",
      sourceEventId: "evt-3",
      occurredAt: new Date("2026-03-01T00:00:00.000Z"),
      activityKind: null,
      attributionKind: BranchActivityAttributionKind.PullRequest,
      pullRequestDetailId,
      completeness: BranchActivityEvidenceCompleteness.Complete,
    };
    const laterAtom = makeAtom({
      ...shared,
      id: "atom-later",
      branchArtifactId: branchA,
      createdAt: new Date("2026-03-02T00:00:00.000Z"),
    });
    const earlierAtom = makeAtom({
      ...shared,
      id: "atom-earlier",
      branchArtifactId: branchA,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
    });
    const { tx, branchActivityAtom } = createTx({
      pullRequestRow: prRow({ branchArtifactId: branchA }),
      activityAtoms: [laterAtom, earlierAtom],
    });

    const changed = await relinkPullRequestBranchInTransaction(
      tx,
      baseInput({ branchArtifactId: branchB })
    );

    expect(changed).toBe(true);
    expect(branchActivityAtom.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["atom-later"] }, organizationId },
    });
    expect(branchActivityAtom.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["atom-earlier"] }, organizationId },
      data: { branchArtifactId: branchB },
    });
  });

  it("tie-breaks canonicalization by atom id when duplicate source-only atoms share the same occurrence timestamp", async () => {
    const sameCreatedAt = new Date("2026-04-01T00:00:00.000Z");
    const shared = {
      version: 1,
      source: "git_head",
      sourceEventId: "evt-4",
      occurredAt: sameCreatedAt,
      activityKind: null,
      attributionKind: BranchActivityAttributionKind.PullRequest,
      pullRequestDetailId,
      completeness: BranchActivityEvidenceCompleteness.Complete,
      createdAt: sameCreatedAt,
    };
    const atomZ = makeAtom({
      ...shared,
      id: "atom-z",
      branchArtifactId: branchA,
    });
    const atomA = makeAtom({
      ...shared,
      id: "atom-a",
      branchArtifactId: branchA,
    });
    const { tx, branchActivityAtom } = createTx({
      pullRequestRow: prRow({ branchArtifactId: branchA }),
      activityAtoms: [atomZ, atomA],
    });

    const changed = await relinkPullRequestBranchInTransaction(
      tx,
      baseInput({ branchArtifactId: branchB })
    );

    expect(changed).toBe(true);
    // "atom-a" sorts before "atom-z", so it is the tie-broken canonical atom
    // that moves; "atom-z" is the duplicate that gets deleted.
    expect(branchActivityAtom.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["atom-z"] }, organizationId },
    });
    expect(branchActivityAtom.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["atom-a"] }, organizationId },
      data: { branchArtifactId: branchB },
    });
    // No canonicalUpdates write: the tie-broken canonical atom's createdAt
    // already equals the group's earliest, and neither atom is Partial.
    expect(branchActivityAtom.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ completeness: expect.anything() }),
      })
    );
  });

  it("propagates partial completeness across a canonicalized group when any duplicate carries partial evidence", async () => {
    const occurredAt = new Date("2026-05-01T00:00:00.000Z");
    const shared = {
      version: 1,
      source: "git_head",
      sourceEventId: "evt-5",
      occurredAt,
      activityKind: null,
      attributionKind: BranchActivityAttributionKind.PullRequest,
      pullRequestDetailId,
      createdAt: occurredAt,
    };
    const targetAtom = makeAtom({
      ...shared,
      id: "atom-target",
      branchArtifactId: branchB,
      completeness: BranchActivityEvidenceCompleteness.Complete,
    });
    const partialSourceAtom = makeAtom({
      ...shared,
      id: "atom-source-partial",
      branchArtifactId: branchA,
      completeness: BranchActivityEvidenceCompleteness.Partial,
    });
    const { tx, branchActivityAtom } = createTx({
      pullRequestRow: prRow({ branchArtifactId: branchA }),
      activityAtoms: [partialSourceAtom, targetAtom],
    });

    await relinkPullRequestBranchInTransaction(
      tx,
      baseInput({ branchArtifactId: branchB })
    );

    expect(branchActivityAtom.updateMany).toHaveBeenCalledWith({
      where: { id: "atom-target", organizationId },
      data: {
        createdAt: occurredAt,
        completeness: BranchActivityEvidenceCompleteness.Partial,
      },
    });
  });

  it("throws when the pull request association changes concurrently during relink", async () => {
    const { tx, pullRequestDetail } = createTx({
      pullRequestRow: prRow({ branchArtifactId: branchA }),
      activityAtoms: [],
    });
    pullRequestDetail.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      relinkPullRequestBranchInTransaction(
        tx,
        baseInput({ branchArtifactId: branchB })
      )
    ).rejects.toThrow("pull request branch relink association changed");
  });

  it("signals the comment move on the hop into the staging row only", async () => {
    const { tx, pullRequestDetail } = createTx({
      pullRequestRow: prRow({ branchArtifactId: branchA }),
      activityAtoms: [],
    });
    pullRequestDetail.updateMany.mockResolvedValue({ count: 1 });
    pullRequestDetail.deleteMany.mockResolvedValue({ count: 1 });

    await relinkPullRequestBranchInTransaction(
      tx,
      baseInput({ branchArtifactId: branchB })
    );

    const hops = moveCommentProjectionOwner.mock.calls.map(
      ([, input]) => input
    );
    expect(hops).toHaveLength(2);
    expect(hops[0]).not.toHaveProperty("signalMoves");
    expect(hops[0]?.sourcePullRequestDetailId).toBe(pullRequestDetailId);
    expect(hops[1]).toEqual(
      expect.objectContaining({
        targetPullRequestDetailId: pullRequestDetailId,
        signalMoves: false,
      })
    );
  });

  it("throws when the staging pull request row is removed or altered concurrently", async () => {
    const { tx, pullRequestDetail } = createTx({
      pullRequestRow: prRow({ branchArtifactId: branchA }),
      activityAtoms: [],
    });
    pullRequestDetail.updateMany.mockResolvedValue({ count: 1 });
    pullRequestDetail.deleteMany.mockResolvedValue({ count: 0 });

    await expect(
      relinkPullRequestBranchInTransaction(
        tx,
        baseInput({ branchArtifactId: branchB })
      )
    ).rejects.toThrow("pull request branch relink staging row changed");
  });
});

function baseInput(overrides: Partial<RelinkInput> = {}): RelinkInput {
  return {
    organizationId,
    pullRequestDetailId,
    branchArtifactId: branchB,
    repositoryFullName,
    pullRequestNumber,
    ...overrides,
  };
}

function prRow(overrides: Partial<PrRowLike> = {}): PrRowLike {
  return {
    branchArtifactId: branchA,
    organizationId,
    repositoryFullName,
    number: pullRequestNumber,
    ...overrides,
  };
}

function makeAtom(overrides: Partial<AtomLike> & { id: string }): AtomLike {
  return {
    version: 1,
    source: "git_head",
    sourceEventId: "evt-default",
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    activityKind: null,
    attributionKind: BranchActivityAttributionKind.PullRequest,
    pullRequestDetailId,
    completeness: BranchActivityEvidenceCompleteness.Complete,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    branchArtifactId: branchA,
    ...overrides,
  };
}

function createTx(config: {
  pullRequestRow: PrRowLike | undefined;
  atomBranchRows?: { branchArtifactId: string }[];
  missingBranchArtifactIds?: string[];
  activityAtoms?: AtomLike[];
}) {
  const branchActivityAtom = {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  const branchDetail = {
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  const pullRequestDetail = {
    create: vi.fn().mockResolvedValue({ id: "staging-pull-request" }),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const queryRaw = vi.fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("FROM pull_request_detail AS pr")) {
        return config.pullRequestRow ? [config.pullRequestRow] : [];
      }
      if (text.includes("DISTINCT branch_artifact_id")) {
        return config.atomBranchRows ?? [];
      }
      if (text.includes("WITH source_keys AS")) {
        return config.activityAtoms ?? [];
      }
      if (text.includes("FROM branch_detail")) {
        const artifactId = values.at(-1) as string;
        if (config.missingBranchArtifactIds?.includes(artifactId)) {
          return [];
        }
        return [{ artifactId }];
      }
      throw new Error(`unexpected $queryRaw call: ${text.slice(0, 120)}`);
    }
  );
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $queryRaw: queryRaw,
    artifactLink: {},
    branchActivityAtom,
    branchDetail,
    commentThread: {},
    gitHubCommentProjection: {},
    gitHubCommentThreadProjection: {},
    pullRequestDetail,
  };
  return {
    tx: tx as unknown as Parameters<
      typeof relinkPullRequestBranchInTransaction
    >[0],
    branchActivityAtom,
    branchDetail,
    pullRequestDetail,
    queryRaw,
  };
}
