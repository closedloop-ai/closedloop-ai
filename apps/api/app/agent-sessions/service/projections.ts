// Record→DTO projection helpers for agent-session list/detail surfaces.

import {
  SESSION_STATUS,
  TERMINAL_SESSION_STATUSES,
} from "@closedloop-ai/loops-api/session-status";
import { deriveAgentSessionFallbackState } from "@repo/api/src/agent-session-detail-projection";
import {
  SessionPrLifecycleStatus,
  sessionPrWithLifecycle,
} from "@repo/api/src/session-trace/derivation";
import type {
  ActivityBucket,
  AgentSessionListItem,
  AgentSessionProjectSummary,
  AgentSessionSourceArtifactSummary,
  PhaseIterations,
  PhaseLoopback,
  SessionMarker,
  SessionPhase,
  SessionPR,
  SessionSpan,
  SessionThrottle,
} from "@repo/api/src/types/agent-session";
import {
  AgentSessionOrigin,
  AgentSessionState,
  agentSessionStateValidator,
} from "@repo/api/src/types/agent-session";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { DocumentType } from "@repo/api/src/types/document";
import type { BasicUser } from "@repo/api/src/types/user";
import { z } from "zod";
import {
  activityBucketSchema,
  phaseLoopbackSchema,
  sessionMarkerSchema,
  sessionPhaseSchema,
  sessionPrSchema,
  sessionSpanSchema,
  sessionThrottleSchema,
} from "@/lib/desktop-agent-sessions-schema";
import {
  decimalToNumber,
  formatCurrency,
  normalizeNullableString,
  parseJsonArray,
  parseJsonValue,
  tokenCountToNumber,
} from "./coercion";
import type {
  AgentSessionListRecord,
  SourceArtifactSummaryRecord,
} from "./records";

export function toBasicUser(
  user: NonNullable<AgentSessionListRecord["user"]>
): BasicUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl: user.avatarUrl,
  };
}

function toProjectSummary(
  project: AgentSessionListRecord["artifact"]["project"]
): AgentSessionProjectSummary | null {
  if (!project) {
    return null;
  }
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
  };
}

export function displayUserName(user: BasicUser): string {
  const parts = [user.firstName, user.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : user.email;
}

function toSourceArtifactDocumentType(
  record: Pick<SourceArtifactSummaryRecord, "type" | "subtype">
): DocumentType | null {
  if (record.type !== ArtifactType.Document) {
    return null;
  }
  switch (record.subtype) {
    case DocumentType.Prd:
      return DocumentType.Prd;
    case DocumentType.ImplementationPlan:
      return DocumentType.ImplementationPlan;
    case DocumentType.Feature:
      return DocumentType.Feature;
    case DocumentType.Template:
      return DocumentType.Template;
    default:
      return null;
  }
}

function toSourceArtifactSummary(
  record: SourceArtifactSummaryRecord | null | undefined
): AgentSessionSourceArtifactSummary | null {
  if (!record) {
    return null;
  }
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    documentType: toSourceArtifactDocumentType(record),
  };
}

function toAgentSessionOrigin(value: string): AgentSessionOrigin {
  return value === AgentSessionOrigin.Loop
    ? AgentSessionOrigin.Loop
    : AgentSessionOrigin.DesktopSync;
}

export function toAgentSessionState(
  record: Pick<
    AgentSessionListRecord,
    "state" | "artifact" | "awaitingInputSince" | "sessionEndedAt"
  >
): AgentSessionState {
  const parsedState = agentSessionStateValidator.safeParse(record.state);
  if (parsedState.success) {
    return parsedState.data;
  }
  // Terminal statuses ({@link TERMINAL_SESSION_STATUSES}) split by outcome:
  // COMPLETED → Completed, the rest (ERROR/ABANDONED) → Blocked.
  if (TERMINAL_SESSION_STATUSES.has(record.artifact.status)) {
    return record.artifact.status === SESSION_STATUS.COMPLETED
      ? AgentSessionState.Completed
      : AgentSessionState.Blocked;
  }
  if (record.awaitingInputSince && !record.sessionEndedAt) {
    return AgentSessionState.PendingApproval;
  }
  return deriveAgentSessionFallbackState({
    status: record.artifact.status,
    awaitingInputSince: record.awaitingInputSince,
    endedAt: record.sessionEndedAt,
  });
}

const phaseIterationsSchema = z.record(z.string(), z.number().int().positive());

export const DEFAULT_HUMAN_ACTOR_COLOR_TOKEN = "var(--muted-foreground)";

export function buildUserColor(user: BasicUser | null): string | null {
  if (!user) {
    return null;
  }
  const source = user.id || user.email;
  let hash = 0;
  for (const char of source) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }
  return `hsl(${hash} 65% 45%)`;
}

function sessionPullRequestIdentityKey(
  repositoryFullName: string | null | undefined,
  prNumber: number | string
): string {
  const normalizedRepository =
    normalizeNullableString(repositoryFullName)?.toLowerCase();
  const normalizedNumber = String(prNumber).trim();
  return normalizedRepository
    ? `${normalizedRepository}#${normalizedNumber}`
    : `legacy#${normalizedNumber}`;
}

type SourceLinkRecord = NonNullable<
  AgentSessionListRecord["artifact"]["sourceLinks"]
>[number];

function resolveTrustedPrDetail(
  link: SourceLinkRecord,
  repositoryFullName: string,
  prNumber: number
):
  | NonNullable<
      SourceLinkRecord["target"]["branch"]
    >["currentPullRequestDetail"]
  | null {
  const detail = link.target?.branch?.currentPullRequestDetail ?? null;
  if (!detail?.isCurrent || detail.lastVerifiedAt == null) {
    return null;
  }
  const branchRepoRaw =
    link.target?.branch?.repository?.fullName ?? repositoryFullName;
  // FEA-2732: repo-less (non-App) PRs have a null `repository` relation; verify
  // their repo identity via the producer-independent `repositoryFullName`.
  // Normalize both sides: the stored `repositoryFullName` is lowercased while
  // the installation-repo relation / raw meta carry GitHub's canonical casing,
  // so a raw compare would reject valid mixed-case repos (e.g. microsoft/TypeScript).
  const detailRepoRaw =
    detail.repository?.fullName ?? detail.repositoryFullName;
  if (
    !detailRepoRaw ||
    normalizeRepoFullName(detailRepoRaw) !==
      normalizeRepoFullName(branchRepoRaw) ||
    detail.number !== prNumber
  ) {
    return null;
  }
  return detail;
}

export function toSessionPullRequestProjection(
  record: AgentSessionListRecord
): {
  prs: SessionPR[];
  verifiedMergedCount: number;
} {
  const legacyPrs = parseJsonArray<SessionPR>(
    record.pullRequests,
    sessionPrSchema
  );
  const byIdentity = new Map<string, SessionPR>();
  const verifiedMergedIdentities = new Set<string>();
  for (const pr of legacyPrs) {
    byIdentity.set(
      sessionPullRequestIdentityKey(record.repositoryFullName, pr.num),
      toUnverifiedSessionPullRequest(pr)
    );
  }
  for (const link of record.artifact.sourceLinks ?? []) {
    const meta = link.metadata as Record<string, unknown> | null;
    const repositoryFullName = meta?.repositoryFullName as string | undefined;
    const prNumber = meta?.prNumber as number | undefined;
    if (!repositoryFullName || prNumber == null) {
      continue;
    }
    const trustedDetail = resolveTrustedPrDetail(
      link,
      repositoryFullName,
      prNumber
    );
    const linkIdentityKey = sessionPullRequestIdentityKey(
      repositoryFullName,
      prNumber
    );
    const legacyIdentityKey = sessionPullRequestIdentityKey(null, prNumber);
    const existingPr =
      byIdentity.get(linkIdentityKey) ?? byIdentity.get(legacyIdentityKey);
    if (trustedDetail) {
      byIdentity.delete(legacyIdentityKey);
      verifiedMergedIdentities.delete(legacyIdentityKey);
    }
    const pr = sessionPrWithLifecycle({
      num: prNumber,
      title: trustedDetail?.title ?? existingPr?.title ?? null,
      status: trustedDetail
        ? null
        : sanitizeUnverifiedSessionPrStatus(existingPr?.status),
      prState: trustedDetail?.prState ?? null,
      closedAt: trustedDetail?.closedAt ?? null,
      mergedAt: trustedDetail?.mergedAt ?? null,
    });
    byIdentity.set(linkIdentityKey, pr);
    if (trustedDetail && pr.status === SessionPrLifecycleStatus.Merged) {
      verifiedMergedIdentities.add(linkIdentityKey);
    } else {
      verifiedMergedIdentities.delete(linkIdentityKey);
    }
  }
  return {
    prs: [...byIdentity.values()],
    verifiedMergedCount: [...verifiedMergedIdentities].filter((identity) =>
      byIdentity.has(identity)
    ).length,
  };
}

function toUnverifiedSessionPullRequest(pr: SessionPR): SessionPR {
  return {
    ...pr,
    status: sanitizeUnverifiedSessionPrStatus(pr.status),
  };
}

function sanitizeUnverifiedSessionPrStatus(
  status: string | null | undefined
): SessionPR["status"] {
  if (status?.trim().toLowerCase() === SessionPrLifecycleStatus.Merged) {
    return SessionPrLifecycleStatus.Unknown;
  }
  return sessionPrWithLifecycle({
    num: 0,
    title: null,
    status: status ?? null,
    prState: null,
    closedAt: null,
    mergedAt: null,
  }).status;
}

/**
 * Rehydrate the source-tagged gitDiffStats from the flattened scalar columns.
 * Only git-tagged LOC (loc_source === "git") is reconstructed; loose/estimated
 * scalars stay on the plain linesAdded/linesRemoved/filesChanged fields so the
 * UI can tell git-derived LOC apart from agent-estimated LOC.
 */
function toGitDiffStats(
  record: Pick<
    AgentSessionListRecord,
    "locSource" | "linesAdded" | "linesRemoved" | "filesChanged"
  >
): AgentSessionListItem["gitDiffStats"] {
  if (record.locSource !== "git") {
    return null;
  }
  if (
    record.linesAdded == null &&
    record.linesRemoved == null &&
    record.filesChanged == null
  ) {
    return null;
  }
  return {
    linesAdded: record.linesAdded ?? 0,
    linesRemoved: record.linesRemoved ?? 0,
    filesChanged: record.filesChanged ?? 0,
    source: record.locSource,
  };
}

/**
 * Rehydrate the source-tagged branchDiffStats from its dedicated branch_*
 * columns, parallel to {@link toGitDiffStats}. Branch-level LOC owns its own
 * columns (rather than sharing the scalar/loc_source pair), so it round-trips
 * independently of git-derived LOC.
 */
function toBranchDiffStats(
  record: Pick<
    AgentSessionListRecord,
    | "branchLocSource"
    | "branchLinesAdded"
    | "branchLinesRemoved"
    | "branchFilesChanged"
  >
): AgentSessionListItem["branchDiffStats"] {
  // Provenance gate, parallel to toGitDiffStats' `locSource !== "git"` check:
  // applyBranchDiffStatsPatch writes branch_loc_source atomically with the
  // numeric columns, so a missing source means there is no recorded branch LOC
  // to rehydrate. Gating here keeps the round-trip faithful — the source is read
  // back as stored rather than guessed.
  if (record.branchLocSource == null) {
    return null;
  }
  if (
    record.branchLinesAdded == null &&
    record.branchLinesRemoved == null &&
    record.branchFilesChanged == null
  ) {
    return null;
  }
  return {
    linesAdded: record.branchLinesAdded ?? 0,
    linesRemoved: record.branchLinesRemoved ?? 0,
    filesChanged: record.branchFilesChanged ?? 0,
    source: record.branchLocSource,
  };
}

export function toSessionListItem(
  record: AgentSessionListRecord,
  sourceArtifactsById?: Map<string, SourceArtifactSummaryRecord>
): AgentSessionListItem {
  const sourceArtifact =
    record.sourceArtifactId && sourceArtifactsById
      ? toSourceArtifactSummary(
          sourceArtifactsById.get(record.sourceArtifactId) ?? null
        )
      : null;
  const user = record.user ? toBasicUser(record.user) : null;
  const estimatedCost = decimalToNumber(record.estimatedCost);
  const primaryModel = record.model;
  const prProjection = toSessionPullRequestProjection(record);
  const prs = prProjection.prs;

  return {
    id: record.artifactId,
    slug: record.artifact.slug,
    externalSessionId: record.externalSessionId,
    name: record.artifact.name,
    status: record.artifact.status,
    origin: toAgentSessionOrigin(record.origin),
    state: toAgentSessionState(record),
    harness: record.harness,
    cwd: record.cwd,
    repositoryFullName: record.repositoryFullName,
    repo: record.repositoryFullName,
    worktreePath: record.worktreePath,
    model: record.model,
    primaryModel,
    models: primaryModel ? [primaryModel] : [],
    branch: record.branch ?? record.baseBranch,
    prs,
    prsMerged: prProjection.verifiedMergedCount,
    cost: formatCurrency(estimatedCost),
    wallClock: record.wallClock,
    activeAgent: record.activeAgent,
    waitingUser: record.waitingUser,
    linesAdded: record.linesAdded,
    linesRemoved: record.linesRemoved,
    filesChanged: record.filesChanged,
    gitDiffStats: toGitDiffStats(record),
    branchDiffStats: toBranchDiffStats(record),
    turns: record.turns,
    toolCallsTotal: record.toolUseCount,
    steeringEpisodes: record.steeringEpisodes,
    autonomy: record.autonomy,
    tokensIn: tokenCountToNumber(record.inputTokens),
    tokensOut: tokenCountToNumber(record.outputTokens),
    cache: tokenCountToNumber(record.cacheReadTokens),
    cacheWrite: tokenCountToNumber(record.cacheWriteTokens),
    userColor: buildUserColor(user),
    activityBuckets: parseJsonArray<ActivityBucket>(
      record.activityBuckets,
      activityBucketSchema
    ),
    span: parseJsonValue<SessionSpan | null>(
      record.sessionSpan,
      sessionSpanSchema.nullable(),
      null
    ),
    markers: parseJsonArray<SessionMarker>(record.markers, sessionMarkerSchema),
    throttles: parseJsonArray<SessionThrottle>(
      record.throttles,
      sessionThrottleSchema
    ),
    phases: parseJsonArray<SessionPhase>(record.phases, sessionPhaseSchema),
    phaseIterations: parseJsonValue<PhaseIterations>(
      record.phaseIterations,
      phaseIterationsSchema,
      {}
    ),
    phaseLoopbacks: parseJsonArray<PhaseLoopback>(
      record.phaseLoopbacks,
      phaseLoopbackSchema
    ),
    startedAt: record.sessionStartedAt,
    updatedAt: record.sessionUpdatedAt,
    // PLN-1034: fall back to the start time for pre-backfill rows so the column
    // and the default sort always have a real value.
    lastActivityAt: record.lastActivityAt ?? record.sessionStartedAt,
    endedAt: record.sessionEndedAt,
    awaitingInputSince: record.awaitingInputSince,
    inputTokens: tokenCountToNumber(record.inputTokens),
    outputTokens: tokenCountToNumber(record.outputTokens),
    cacheReadTokens: tokenCountToNumber(record.cacheReadTokens),
    cacheWriteTokens: tokenCountToNumber(record.cacheWriteTokens),
    estimatedCost,
    agentCount: record.agentCount,
    toolUseCount: record.toolUseCount,
    errorCount: record.errorCount,
    baseBranch: record.baseBranch,
    sourceArtifactId: record.sourceArtifactId,
    sourceArtifact,
    sourceLoopId: record.sourceLoopId,
    user,
    computeTarget: {
      id: record.computeTarget.id,
      machineName: record.computeTarget.machineName,
      isOnline: record.computeTarget.isOnline,
      lastSeenAt: record.computeTarget.lastSeenAt,
    },
    project: toProjectSummary(record.artifact.project),
  };
}
