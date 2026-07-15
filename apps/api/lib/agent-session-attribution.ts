import type {
  AgentSessionUsageByBranch,
  AgentSessionUsageByPr,
} from "@repo/api/src/types/agent-session";
import type {
  ArtifactSessionUsageByModel,
  ArtifactSessionUsageSummary,
  SessionPrPurpose,
} from "@repo/api/src/types/session-artifact-link";
import {
  deriveSessionPrPurposeFromMetadata,
  parseSessionPrLinkMetadata,
  SESSION_PR_PURPOSE_LABELS,
  SessionPrPurpose as SessionPrPurposeValues,
} from "@repo/api/src/types/session-artifact-link";
import { type Prisma, withDb } from "@repo/database";
import { toNumber } from "./prisma-number";
import {
  hasMatchingSessionPrLinks,
  SESSION_PR_LINK_WHERE,
  visitSessionDetailPages,
} from "./session-pr-links";

const attributionLensSelect = {
  artifactId: true,
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  estimatedCost: true,
  artifact: {
    select: {
      organizationId: true,
      sourceLinks: {
        where: SESSION_PR_LINK_WHERE,
        orderBy: { createdAt: "asc" as const },
        select: {
          metadata: true,
          targetId: true,
          target: {
            select: {
              organizationId: true,
              branch: {
                select: {
                  branchName: true,
                  repository: {
                    select: {
                      fullName: true,
                    },
                  },
                  currentPullRequestDetail: {
                    select: {
                      number: true,
                      title: true,
                      isCurrent: true,
                      lastVerifiedAt: true,
                      repository: {
                        select: {
                          fullName: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.SessionDetailSelect;

type AttributionLensRecord = Prisma.SessionDetailGetPayload<{
  select: typeof attributionLensSelect;
}>;

type AttributionAccumulator = {
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
};

type ArtifactUsageTargetShare = Omit<AttributionAccumulator, "sessionCount"> & {
  denominator: number;
};

type ArtifactUsageTokenRow = {
  agentSessionId: string;
  model: string;
  inputTokens: bigint | number;
  outputTokens: bigint | number;
  cacheReadTokens: bigint | number;
  cacheWriteTokens: bigint | number;
  estimatedCost: Prisma.Decimal | number;
};

type BranchAttributionAccumulator = AttributionAccumulator & {
  repositoryFullName: string | null;
  branchName: string | null;
};

type PrAttributionAccumulator = AttributionAccumulator & {
  repositoryFullName: string;
  prNumber: number;
  prTitle: string | null;
  branchArtifactId: string;
  purpose: SessionPrPurpose;
};

/** Aggregated branch and PR cost lenses derived from the same session rows. */
export type AttributionLenses = {
  byBranch: AgentSessionUsageByBranch[];
  byPr: AgentSessionUsageByPr[];
};

/**
 * Builds the PR/branch attribution lenses from bounded session pages. Callers
 * receive only the aggregate lenses, so dashboard reads do not materialize the
 * full historical attribution row set in service memory.
 */
export async function aggregateSessionAttributionLenses(
  where: Prisma.SessionDetailWhereInput
): Promise<AttributionLenses> {
  if (!(await hasMatchingSessionPrLinks(where))) {
    return { byBranch: [], byPr: [] };
  }

  const branchMap = new Map<string, BranchAttributionAccumulator>();
  const prMap = new Map<string, PrAttributionAccumulator>();

  await visitSessionDetailPages(
    where,
    attributionLensSelect,
    (sessions: AttributionLensRecord[]) => {
      for (const session of sessions) {
        accumulateAttributionLensSession({ branchMap, prMap, session });
      }
    }
  );

  return formatAttributionLenses(branchMap, prMap);
}

/**
 * Splits a branch artifact usage summary by each session's distinct PR/branch
 * targets. The helper owns attribution-row paging and denominator calculation
 * so callers cannot accidentally double-count N-target sessions.
 */
export async function aggregateArtifactUsageByTargetShare(input: {
  artifactId: string;
  artifactSlug: string | null;
  organizationId: string;
  sessionArtifactIds: string[];
  targetArtifactId: string;
}): Promise<ArtifactSessionUsageSummary> {
  const sessionShares = new Map<string, ArtifactUsageTargetShare>();
  const totals: AttributionAccumulator = createAttributionAccumulator();

  await visitSessionDetailPages(
    {
      artifactId: { in: input.sessionArtifactIds },
      artifact: { organizationId: input.organizationId },
    },
    attributionLensSelect,
    (sessions: AttributionLensRecord[]) => {
      for (const session of sessions) {
        accumulateArtifactUsageSession({
          session,
          sessionShares,
          targetArtifactId: input.targetArtifactId,
          totals,
        });
      }
    }
  );

  const tokenRows = await findArtifactUsageTokenRows({
    organizationId: input.organizationId,
    sessionArtifactIds: input.sessionArtifactIds,
  });

  return {
    artifactId: input.artifactId,
    artifactSlug: input.artifactSlug,
    sessionCount: totals.sessionCount,
    inputTokens: Math.round(totals.inputTokens),
    outputTokens: Math.round(totals.outputTokens),
    cacheReadTokens: Math.round(totals.cacheReadTokens),
    cacheWriteTokens: Math.round(totals.cacheWriteTokens),
    estimatedCostUsd: roundCost(totals.estimatedCost),
    byModel: aggregateArtifactUsageByModelShares(tokenRows, sessionShares),
  };
}

function findArtifactUsageTokenRows(input: {
  organizationId: string;
  sessionArtifactIds: string[];
}): Promise<ArtifactUsageTokenRow[]> {
  return withDb((db) =>
    db.agentSessionTokenUsage.findMany({
      where: {
        agentSessionId: { in: input.sessionArtifactIds },
        session: { artifact: { organizationId: input.organizationId } },
      },
      select: {
        agentSessionId: true,
        model: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        estimatedCost: true,
      },
    })
  );
}

function accumulateAttributionLensSession(input: {
  branchMap: Map<string, BranchAttributionAccumulator>;
  prMap: Map<string, PrAttributionAccumulator>;
  session: AttributionLensRecord;
}): void {
  const branches = dedupeSessionBranches(input.session);
  if (branches.length === 0) {
    return;
  }

  const share = toAttributionShare(input.session, branches.length);

  for (const branch of branches) {
    accumulateBranchShare(input.branchMap, branch, share);
    accumulatePrShare(input.prMap, branch, share);
  }
}

function accumulateArtifactUsageSession(input: {
  session: AttributionLensRecord;
  sessionShares: Map<string, ArtifactUsageTargetShare>;
  targetArtifactId: string;
  totals: AttributionAccumulator;
}): void {
  const branches = dedupeSessionBranches(input.session);
  const targetBranch = branches.find(
    (branch) => branch.branchArtifactId === input.targetArtifactId
  );
  if (!targetBranch || branches.length === 0) {
    return;
  }

  const share = {
    denominator: branches.length,
    ...toAttributionShare(input.session, branches.length),
  };
  input.sessionShares.set(input.session.artifactId, share);
  addAttributionShare(input.totals, share);
}

function aggregateArtifactUsageByModelShares(
  tokenRows: ArtifactUsageTokenRow[],
  sessionShares: Map<string, ArtifactUsageTargetShare>
): ArtifactSessionUsageByModel[] {
  const byModel = new Map<
    string,
    Omit<AttributionAccumulator, "sessionCount">
  >();

  for (const row of tokenRows) {
    const sessionShare = sessionShares.get(row.agentSessionId);
    if (!sessionShare) {
      continue;
    }
    const existing = byModel.get(row.model) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: 0,
    };
    existing.inputTokens +=
      tokenCountToNumber(row.inputTokens) / sessionShare.denominator;
    existing.outputTokens +=
      tokenCountToNumber(row.outputTokens) / sessionShare.denominator;
    existing.cacheReadTokens +=
      tokenCountToNumber(row.cacheReadTokens) / sessionShare.denominator;
    existing.cacheWriteTokens +=
      tokenCountToNumber(row.cacheWriteTokens) / sessionShare.denominator;
    existing.estimatedCost +=
      decimalToNumber(row.estimatedCost) / sessionShare.denominator;
    byModel.set(row.model, existing);
  }

  return [...byModel.entries()]
    .map(([model, data]) => ({
      model,
      inputTokens: Math.round(data.inputTokens),
      outputTokens: Math.round(data.outputTokens),
      cacheReadTokens: Math.round(data.cacheReadTokens),
      cacheWriteTokens: Math.round(data.cacheWriteTokens),
      estimatedCostUsd: roundCost(data.estimatedCost),
    }))
    .sort((left, right) => right.estimatedCostUsd - left.estimatedCostUsd);
}

function formatAttributionLenses(
  branchMap: Map<string, BranchAttributionAccumulator>,
  prMap: Map<string, PrAttributionAccumulator>
): AttributionLenses {
  return {
    byBranch: [...branchMap.entries()]
      .map(([branchArtifactId, data]) => ({
        branchArtifactId,
        repositoryFullName: data.repositoryFullName,
        branchName: data.branchName,
        sessionCount: data.sessionCount,
        inputTokens: Math.round(data.inputTokens),
        outputTokens: Math.round(data.outputTokens),
        cacheReadTokens: Math.round(data.cacheReadTokens),
        cacheWriteTokens: Math.round(data.cacheWriteTokens),
        estimatedCost: roundCost(data.estimatedCost),
      }))
      .sort((left, right) => right.estimatedCost - left.estimatedCost),
    byPr: [...prMap.values()]
      .map((data) => ({
        repositoryFullName: data.repositoryFullName,
        prNumber: data.prNumber,
        prTitle: data.prTitle,
        branchArtifactId: data.branchArtifactId,
        purpose: data.purpose,
        purposeLabel: SESSION_PR_PURPOSE_LABELS[data.purpose],
        sessionCount: data.sessionCount,
        inputTokens: Math.round(data.inputTokens),
        outputTokens: Math.round(data.outputTokens),
        cacheReadTokens: Math.round(data.cacheReadTokens),
        cacheWriteTokens: Math.round(data.cacheWriteTokens),
        estimatedCost: roundCost(data.estimatedCost),
      }))
      .sort((left, right) => right.estimatedCost - left.estimatedCost),
  };
}

function dedupeSessionBranches(session: AttributionLensRecord) {
  const byBranchArtifactId = new Map<
    string,
    {
      branch: NonNullable<
        AttributionLensRecord["artifact"]["sourceLinks"][number]["target"]["branch"]
      >;
      purpose: SessionPrPurpose;
    }
  >();

  for (const link of session.artifact.sourceLinks) {
    if (link.target.organizationId !== session.artifact.organizationId) {
      continue;
    }
    const branch = link.target.branch;
    if (!branch) {
      continue;
    }
    const purpose = deriveSessionPrPurposeFromMetadata(
      parseSessionPrLinkMetadata(link.metadata)
    );
    const existing = byBranchArtifactId.get(link.targetId);
    if (existing) {
      existing.purpose = chooseStrongerSessionPrPurpose(
        existing.purpose,
        purpose
      );
    } else {
      byBranchArtifactId.set(link.targetId, { branch, purpose });
    }
  }

  return [...byBranchArtifactId.entries()].map(
    ([branchArtifactId, { branch, purpose }]) => ({
      branchArtifactId,
      branch,
      purpose,
    })
  );
}

function accumulateBranchShare(
  map: Map<string, BranchAttributionAccumulator>,
  link: ReturnType<typeof dedupeSessionBranches>[number],
  share: Omit<AttributionAccumulator, "sessionCount">
): void {
  const existing = map.get(link.branchArtifactId);
  const repositoryFullName = link.branch.repository?.fullName ?? null;
  if (existing) {
    addAttributionShare(existing, share);
    return;
  }

  map.set(link.branchArtifactId, {
    sessionCount: 1,
    repositoryFullName,
    branchName: link.branch.branchName,
    ...share,
  });
}

function accumulatePrShare(
  map: Map<string, PrAttributionAccumulator>,
  link: ReturnType<typeof dedupeSessionBranches>[number],
  share: Omit<AttributionAccumulator, "sessionCount">
): void {
  const pr = link.branch.currentPullRequestDetail;
  const branchRepository = link.branch.repository?.fullName;
  const prRepository = pr?.repository?.fullName;
  if (
    !(
      pr?.isCurrent &&
      pr.lastVerifiedAt &&
      branchRepository &&
      prRepository === branchRepository
    )
  ) {
    return;
  }

  const key = `${prRepository}#${pr.number}`;
  const existing = map.get(key);
  if (existing) {
    addAttributionShare(existing, share);
    existing.purpose = chooseStrongerSessionPrPurpose(
      existing.purpose,
      link.purpose
    );
    return;
  }

  map.set(key, {
    sessionCount: 1,
    repositoryFullName: prRepository,
    prNumber: pr.number,
    prTitle: pr.title,
    branchArtifactId: link.branchArtifactId,
    purpose: link.purpose,
    ...share,
  });
}

function chooseStrongerSessionPrPurpose(
  left: SessionPrPurpose,
  right: SessionPrPurpose
): SessionPrPurpose {
  if (
    left === SessionPrPurposeValues.Authored ||
    right === SessionPrPurposeValues.Authored
  ) {
    return SessionPrPurposeValues.Authored;
  }
  if (
    left === SessionPrPurposeValues.Referenced ||
    right === SessionPrPurposeValues.Referenced
  ) {
    return SessionPrPurposeValues.Referenced;
  }
  return SessionPrPurposeValues.Unknown;
}

function toAttributionShare(
  session: AttributionLensRecord,
  denominator: number
): Omit<AttributionAccumulator, "sessionCount"> {
  return {
    inputTokens: tokenCountToNumber(session.inputTokens) / denominator,
    outputTokens: tokenCountToNumber(session.outputTokens) / denominator,
    cacheReadTokens: tokenCountToNumber(session.cacheReadTokens) / denominator,
    cacheWriteTokens:
      tokenCountToNumber(session.cacheWriteTokens) / denominator,
    estimatedCost: decimalToNumber(session.estimatedCost) / denominator,
  };
}

function createAttributionAccumulator(): AttributionAccumulator {
  return {
    sessionCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0,
  };
}

function addAttributionShare(
  accumulator: AttributionAccumulator,
  share: Omit<AttributionAccumulator, "sessionCount">
): void {
  accumulator.sessionCount += 1;
  accumulator.inputTokens += share.inputTokens;
  accumulator.outputTokens += share.outputTokens;
  accumulator.cacheReadTokens += share.cacheReadTokens;
  accumulator.cacheWriteTokens += share.cacheWriteTokens;
  accumulator.estimatedCost += share.estimatedCost;
}

function decimalToNumber(
  value: Prisma.Decimal | number | null | undefined
): number {
  return toNumber(value);
}

function tokenCountToNumber(value: bigint | number | null | undefined): number {
  return toNumber(value);
}

function roundCost(value: number): number {
  return Number(value.toFixed(6));
}
