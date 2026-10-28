import type {
  AgentSessionUsageByBranch,
  AgentSessionUsageByPr,
} from "@repo/api/src/types/agent-session-usage-breakdown";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import type {
  ArtifactSessionUsageByModel,
  ArtifactSessionUsageSummary,
  SessionPrPurpose,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import {
  allowsUniqueBranchPrFallback,
  commandDerivedSessionPrRefsFromMetadata,
  deriveSessionPrPurposeFromRelationTypes,
  parseSessionPrLinkMetadata,
  SESSION_PR_PURPOSE_LABELS,
  SessionPrPurpose as SessionPrPurposeValues,
  sessionPrIdentityKey,
} from "@repo/api/src/types/session-artifact-link";
import { type Prisma, withDb } from "@repo/database";
import type { LimitFunction } from "p-limit";
import { branchCandidatePullRequests } from "@/app/branches/branch-canonical-pull-request";
import {
  type AttributionLensRecord,
  readSessionAttributionRecords,
} from "./agent-session-attribution-read";
import { toNumber } from "./prisma-number";

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
 * Builds the PR/branch attribution lenses from the matched sessions and their
 * session→PR links. Callers receive only the aggregate lenses; the read behind
 * them lives in `agent-session-attribution-read.ts`.
 *
 * ISS-7598: `limiter` is passed straight through to that read, so a caller
 * running this lens concurrently with other DB reads can hold all of them to one
 * shared connection budget.
 */
export async function aggregateSessionAttributionLenses(
  organizationId: string,
  where: Prisma.SessionDetailWhereInput,
  limiter?: LimitFunction
): Promise<AttributionLenses> {
  const branchMap = new Map<string, BranchAttributionAccumulator>();
  const prMap = new Map<string, PrAttributionAccumulator>();

  for (const session of await readSessionAttributionRecords(
    organizationId,
    where,
    limiter
  )) {
    accumulateAttributionLensSession({ branchMap, prMap, session });
  }

  return formatAttributionLenses(branchMap, prMap);
}

/**
 * Splits a branch artifact usage summary by each session's distinct PR/branch
 * targets. The helper owns the denominator calculation so callers cannot
 * accidentally double-count N-target sessions.
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

  const sessions = await readSessionAttributionRecords(input.organizationId, {
    artifactId: { in: input.sessionArtifactIds },
    artifact: { organizationId: input.organizationId },
  });
  for (const session of sessions) {
    accumulateArtifactUsageSession({
      session,
      sessionShares,
      targetArtifactId: input.targetArtifactId,
      totals,
    });
  }

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
      toNumber(row.inputTokens) / sessionShare.denominator;
    existing.outputTokens +=
      toNumber(row.outputTokens) / sessionShare.denominator;
    existing.cacheReadTokens +=
      toNumber(row.cacheReadTokens) / sessionShare.denominator;
    existing.cacheWriteTokens +=
      toNumber(row.cacheWriteTokens) / sessionShare.denominator;
    existing.estimatedCost +=
      toNumber(row.estimatedCost) / sessionShare.denominator;
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
      pullRequestDetails: AttributionLensRecord["artifact"]["sourceLinks"][number]["target"]["pullRequestDetails"];
      prRefs: Map<string, PrAttributionRef>;
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
    const metadata = parseSessionPrLinkMetadata(link.metadata);
    const prRefs = attributionRefs(link, metadata);
    const existing = byBranchArtifactId.get(link.targetId);
    if (existing) {
      mergePrAttributionRefs(existing.prRefs, prRefs);
    } else {
      byBranchArtifactId.set(link.targetId, {
        branch,
        pullRequestDetails: link.target.pullRequestDetails,
        prRefs,
      });
    }
  }

  return [...byBranchArtifactId.entries()].map(
    ([branchArtifactId, { branch, prRefs, pullRequestDetails }]) => ({
      branchArtifactId,
      branch,
      pullRequestDetails,
      prRefs: [...prRefs.values()],
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
  if (link.prRefs.length === 0) {
    return;
  }
  const prShare = divideAttributionShare(share, link.prRefs.length);
  for (const ref of link.prRefs) {
    const pr = matchingAttributionDetail(link, ref);
    if (!pr) {
      continue;
    }
    const key = sessionPrIdentityKey(ref.repositoryFullName, ref.prNumber);
    const existing = map.get(key);
    if (existing) {
      addAttributionShare(existing, prShare);
      existing.purpose = chooseStrongerSessionPrPurpose(
        existing.purpose,
        ref.purpose
      );
      continue;
    }
    map.set(key, {
      sessionCount: 1,
      repositoryFullName: ref.repositoryFullName,
      prNumber: ref.prNumber,
      prTitle: pr.title,
      branchArtifactId: link.branchArtifactId,
      purpose: ref.purpose,
      ...prShare,
    });
  }
}

type PrAttributionRef = {
  repositoryFullName: string;
  prNumber: number;
  purpose: SessionPrPurpose;
};

function attributionRefs(
  link: AttributionLensRecord["artifact"]["sourceLinks"][number],
  metadata: ReturnType<typeof parseSessionPrLinkMetadata>
): Map<string, PrAttributionRef> {
  // ISS-5823: identities that feed a per-PR COST share come from
  // command-derived evidence only.
  const refs = commandDerivedSessionPrRefsFromMetadata(link.metadata);
  let candidates: readonly {
    repositoryFullName: string;
    prNumber: number;
    relationTypes: readonly SessionPrRelationType[];
  }[] = refs;
  if (refs.length === 0 && allowsUniqueBranchPrFallback(link.metadata)) {
    candidates = uniqueLegacyPrRef(link, metadata);
  }
  return new Map(
    candidates.map((ref) => {
      const identity = sessionPrIdentityKey(
        ref.repositoryFullName,
        ref.prNumber
      );
      return [
        identity,
        {
          repositoryFullName: ref.repositoryFullName,
          prNumber: ref.prNumber,
          purpose: deriveSessionPrPurposeFromRelationTypes(
            ref.relationTypes,
            metadata?.confidence
          ),
        },
      ];
    })
  );
}

function uniqueLegacyPrRef(
  link: AttributionLensRecord["artifact"]["sourceLinks"][number],
  metadata: ReturnType<typeof parseSessionPrLinkMetadata>
) {
  const details = branchCandidatePullRequests(
    link.target.branch,
    link.target.pullRequestDetails
  ).filter((detail) => detail?.number != null);
  const byIdentity = new Map<
    string,
    {
      repositoryFullName: string;
      prNumber: number;
      relationTypes: readonly SessionPrRelationType[];
    }
  >();
  for (const detail of details) {
    if (!detail?.number) {
      continue;
    }
    const repositoryFullName =
      detail.repository?.fullName ??
      detail.repositoryFullName ??
      link.target.branch?.repository?.fullName;
    if (!repositoryFullName) {
      continue;
    }
    byIdentity.set(sessionPrIdentityKey(repositoryFullName, detail.number), {
      repositoryFullName,
      prNumber: detail.number,
      relationTypes: metadata?.relationTypes ?? [],
    });
  }
  return byIdentity.size === 1 ? [...byIdentity.values()] : [];
}

function mergePrAttributionRefs(
  target: Map<string, PrAttributionRef>,
  incoming: Map<string, PrAttributionRef>
): void {
  for (const [identity, ref] of incoming) {
    const existing = target.get(identity);
    target.set(
      identity,
      existing
        ? {
            ...ref,
            purpose: chooseStrongerSessionPrPurpose(
              existing.purpose,
              ref.purpose
            ),
          }
        : ref
    );
  }
}

function matchingAttributionDetail(
  link: ReturnType<typeof dedupeSessionBranches>[number],
  ref: PrAttributionRef
) {
  const candidates = branchCandidatePullRequests(
    link.branch,
    link.pullRequestDetails
  );
  return (
    candidates.find((detail) => {
      const repositoryFullName =
        detail?.repository?.fullName ?? detail?.repositoryFullName;
      return (
        detail?.lastVerifiedAt != null &&
        detail.number === ref.prNumber &&
        repositoryFullName != null &&
        normalizeRepoFullName(repositoryFullName) ===
          normalizeRepoFullName(ref.repositoryFullName)
      );
    }) ?? null
  );
}

function divideAttributionShare(
  share: Omit<AttributionAccumulator, "sessionCount">,
  denominator: number
): Omit<AttributionAccumulator, "sessionCount"> {
  return {
    inputTokens: share.inputTokens / denominator,
    outputTokens: share.outputTokens / denominator,
    cacheReadTokens: share.cacheReadTokens / denominator,
    cacheWriteTokens: share.cacheWriteTokens / denominator,
    estimatedCost: share.estimatedCost / denominator,
  };
}

// Purpose precedence (strongest first): Authored > Reviewed > Referenced. FEA-3585:
// a Reviewed signal must survive when merged with a weaker Referenced one (a PR
// the session reviewed AND had mentioned), but must never outrank Authored — a
// review is not authoring output (preserves FEA-3584's Authored gating).
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
    left === SessionPrPurposeValues.Reviewed ||
    right === SessionPrPurposeValues.Reviewed
  ) {
    return SessionPrPurposeValues.Reviewed;
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
    inputTokens: toNumber(session.inputTokens) / denominator,
    outputTokens: toNumber(session.outputTokens) / denominator,
    cacheReadTokens: toNumber(session.cacheReadTokens) / denominator,
    cacheWriteTokens: toNumber(session.cacheWriteTokens) / denominator,
    estimatedCost: toNumber(session.estimatedCost) / denominator,
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

function roundCost(value: number): number {
  return Number(value.toFixed(6));
}
