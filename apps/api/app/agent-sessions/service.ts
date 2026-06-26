import { SESSION_STATUS } from "@closedloop-ai/loops-api/session-status";
import {
  deriveAgentSessionFallbackState,
  projectAgentSessionTimelineEvents,
  projectAgentSessionTurnItems,
} from "@repo/api/src/agent-session-detail-projection";
import {
  ERROR_EVENT_PATTERN,
  ERROR_EVENT_TERMS,
} from "@repo/api/src/agent-session-events";
import {
  AGENT_FAILED_STATUS_PATTERN,
  AGENT_SUCCESS_STATUS_PATTERN,
} from "@repo/api/src/agent-session-status";
import {
  SessionPrLifecycleStatus,
  sessionPrWithLifecycle,
} from "@repo/api/src/session-trace/derivation";
import type {
  ActivityBucket,
  AgentSessionAgentTypeBreakdown,
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionLastSyncTarget,
  AgentSessionListItem,
  AgentSessionListResponse,
  AgentSessionProjectBreakdown,
  AgentSessionProjectSummary,
  AgentSessionRepositoryBreakdown,
  AgentSessionSourceArtifactSummary,
  AgentSessionToolBreakdown,
  AgentSessionUsageByModel,
  AgentSessionUsageByUser,
  AgentSessionUsageSummary,
  DesktopAgentSessionsPayload,
  PhaseIterations,
  PhaseLoopback,
  SessionMarker,
  SessionPhase,
  SessionPR,
  SessionSpan,
  SessionThrottle,
  SessionTraceCorrectionSource,
  SessionTracePhaseSource,
  SessionTraceThrottleSource,
  SyncedAgentSession,
  SyncedAgentSessionAgent,
  SyncedAgentSessionAttribution,
  SyncedAgentSessionEvent,
  SyncedAgentSessionTokenUsage,
} from "@repo/api/src/types/agent-session";
import {
  AgentSessionOrigin,
  AgentSessionState,
  agentSessionStateValidator,
} from "@repo/api/src/types/agent-session";
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import { DocumentType } from "@repo/api/src/types/document";
import {
  type ArtifactSessionUsageSummary,
  SessionPrLinkSource,
  type SyncedArtifactRef,
  type SyncedSessionPrRef,
} from "@repo/api/src/types/session-artifact-link";
import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import type { BasicUser } from "@repo/api/src/types/user";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { z } from "zod";
import { basicUserSelect, getPrismaErrorCode } from "@/lib/db-utils";
import {
  activityBucketSchema,
  phaseLoopbackSchema,
  sessionMarkerSchema,
  sessionPhaseSchema,
  sessionPrSchema,
  sessionSpanSchema,
  sessionThrottleSchema,
  sessionTraceCorrectionSourceSchema,
  sessionTracePhaseSourceSchema,
  sessionTraceThrottleSourceSchema,
  syncedAgentSessionAgentSchema,
  syncedAgentSessionEventSchema,
} from "@/lib/desktop-agent-sessions-schema";
import { parseJsonObject } from "@/lib/json-schema";
import { generateSlug } from "@/lib/slug-generator";
import type {
  AgentSessionListQuery,
  AgentSessionUsageQuery,
} from "./validators";

const SESSION_LIST_DEFAULT_LIMIT = 25;
const SESSION_LIST_MAX_LIMIT = 100;
const ANALYTICS_QUERY_BATCH_SIZE = 200;
// Keyset-pagination page size for the CSV export stream (findExportRows), which
// aggregates rows incrementally so a large export never materializes every
// matching sessionDetail row in memory at once.
const EXPORT_BATCH_SIZE = 1000;
const uuidSchema = z.uuid();

const computeTargetSummarySelect = {
  select: {
    id: true,
    machineName: true,
    isOnline: true,
    lastSeenAt: true,
  },
} as const;

const projectSummarySelect = {
  select: {
    id: true,
    name: true,
    slug: true,
  },
} as const;

const sourceArtifactSummarySelect = {
  id: true,
  name: true,
  slug: true,
  type: true,
  subtype: true,
} satisfies Prisma.ArtifactSelect;

// Session detail rows are the CTI detail for SESSION artifacts: hoisted fields
// (name, status, slug, project, organizationId) live on the parent `artifact`
// relation and are selected through it.
const sessionArtifactSummarySelect = {
  select: {
    name: true,
    status: true,
    slug: true,
    project: projectSummarySelect,
    sessionPrLinks: {
      orderBy: [{ prNumber: "asc" }, { relationType: "asc" }],
      select: {
        repositoryFullName: true,
        prNumber: true,
        prUrl: true,
        relationType: true,
        pullRequestDetail: {
          select: {
            number: true,
            title: true,
            prState: true,
            closedAt: true,
            mergedAt: true,
            lastVerifiedAt: true,
            isCurrent: true,
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
} satisfies Prisma.ArtifactDefaultArgs;

const agentSessionListSelect = {
  artifactId: true,
  externalSessionId: true,
  harness: true,
  origin: true,
  state: true,
  cwd: true,
  repositoryFullName: true,
  worktreePath: true,
  model: true,
  branch: true,
  issues: true,
  pullRequests: true,
  wallClock: true,
  activeAgent: true,
  waitingUser: true,
  linesAdded: true,
  linesRemoved: true,
  filesChanged: true,
  locSource: true,
  branchLinesAdded: true,
  branchLinesRemoved: true,
  branchFilesChanged: true,
  branchLocSource: true,
  turns: true,
  steeringEpisodes: true,
  autonomy: true,
  activityBuckets: true,
  sessionSpan: true,
  markers: true,
  throttles: true,
  phases: true,
  phaseIterations: true,
  phaseLoopbacks: true,
  sessionStartedAt: true,
  sessionUpdatedAt: true,
  lastActivityAt: true,
  sessionEndedAt: true,
  awaitingInputSince: true,
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  estimatedCost: true,
  agentCount: true,
  toolUseCount: true,
  errorCount: true,
  issueId: true,
  baseBranch: true,
  sourceArtifactId: true,
  sourceLoopId: true,
  user: basicUserSelect,
  computeTarget: computeTargetSummarySelect,
  artifact: sessionArtifactSummarySelect,
} satisfies Prisma.SessionDetailSelect;

const agentSessionDetailSelect = {
  ...agentSessionListSelect,
  metadata: true,
  sourceArtifactId: true,
  sourceLoopId: true,
  tokenUsageByModel: {
    orderBy: {
      model: "asc",
    },
  },
  agents: true,
  events: {
    orderBy: [
      { eventCreatedAt: "asc" },
      { externalEventId: "asc" },
      { id: "asc" },
    ],
  },
  tracePhaseSources: true,
  throttleSources: true,
  correctionSources: true,
} satisfies Prisma.SessionDetailSelect;

const agentSessionExportSelect = {
  sessionStartedAt: true,
  harness: true,
  model: true,
  deviceTimeZone: true,
  user: {
    select: {
      ...basicUserSelect.select,
      teamMemberships: {
        orderBy: {
          team: {
            name: "asc",
          },
        },
        select: {
          team: {
            select: {
              name: true,
            },
          },
        },
      },
    },
  },
  artifact: {
    select: {
      project: {
        select: {
          name: true,
        },
      },
    },
  },
  tokenUsageByModel: {
    orderBy: {
      model: "asc",
    },
  },
} satisfies Prisma.SessionDetailSelect;

const analyticsScalarSelect = {
  artifactId: true,
  repositoryFullName: true,
  inputTokens: true,
  outputTokens: true,
  estimatedCost: true,
  errorCount: true,
  artifact: {
    select: {
      projectId: true,
      project: projectSummarySelect,
    },
  },
} satisfies Prisma.SessionDetailSelect;

const analyticsJsonSelect = {
  artifactId: true,
  agents: true,
  events: true,
} satisfies Prisma.SessionDetailSelect;
type AgentSessionListRecord = Prisma.SessionDetailGetPayload<{
  select: typeof agentSessionListSelect;
}>;
type AgentSessionDetailRecord = Prisma.SessionDetailGetPayload<{
  select: typeof agentSessionDetailSelect;
}>;
type AgentSessionExportRecord = Prisma.SessionDetailGetPayload<{
  select: typeof agentSessionExportSelect;
}>;
type SourceArtifactSummaryRecord = Prisma.ArtifactGetPayload<{
  select: typeof sourceArtifactSummarySelect;
}>;
type AnalyticsScalarSessionRecord = Prisma.SessionDetailGetPayload<{
  select: typeof analyticsScalarSelect;
}>;
type AnalyticsJsonSessionRecord = Prisma.SessionDetailGetPayload<{
  select: typeof analyticsJsonSelect;
}>;
type AgentSessionUpsertTx = TransactionClient;

type SessionProjectResolution = {
  artifactProjectById: Map<string, string>;
  loopProjectById: Map<string, string>;
  projectByRepositoryFullName: Map<string, string | null>;
};

type AgentSessionScope = {
  organizationId: string;
};

type SessionListInput = AgentSessionScope & {
  filters: AgentSessionListQuery;
};

type SessionUsageInput = AgentSessionScope & {
  filters: AgentSessionUsageQuery;
};

type SessionDetailInput = AgentSessionScope & {
  id: string;
};

type UpsertSessionsContext = {
  organizationId: string;
  userId: string;
  computeTargetId: string;
  gatewaySessionId?: string;
};

type SessionTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
};

type LastSyncTargetRecord = {
  id: string;
  machineName: string;
  isOnline: boolean;
  lastSeenAt: Date;
  lastAgentSessionSyncAt: Date | null;
  user: BasicUser;
};

type AgentSessionCsvExportRow = {
  date: string;
  user: string;
  team: string;
  project: string;
  harnessType: string;
  model: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  estimatedCost: number;
};

function decimalToNumber(
  value: Prisma.Decimal | number | null | undefined
): number {
  if (value == null) {
    return 0;
  }
  return Number(value);
}

function toBasicUser(
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

function displayUserName(user: BasicUser): string {
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

function toAgentSessionState(
  record: Pick<
    AgentSessionListRecord,
    "state" | "artifact" | "awaitingInputSince" | "sessionEndedAt"
  >
): AgentSessionState {
  const parsedState = agentSessionStateValidator.safeParse(record.state);
  if (parsedState.success) {
    return parsedState.data;
  }
  if (record.artifact.status === SESSION_STATUS.COMPLETED) {
    return AgentSessionState.Completed;
  }
  if (
    record.artifact.status === SESSION_STATUS.ERROR ||
    record.artifact.status === SESSION_STATUS.ABANDONED
  ) {
    return AgentSessionState.Blocked;
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

function safeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

const phaseIterationsSchema = z.record(z.string(), z.number().int().positive());
const DEFAULT_HUMAN_ACTOR_COLOR_TOKEN = "var(--muted-foreground)";
const REDACTED_EVENT_DATA_VALUE = "[redacted]";
const SENSITIVE_EVENT_DATA_KEYS = new Set([
  "output",
  "prompt",
  "stderr",
  "stdout",
]);

function parseJsonArray<T>(value: unknown, schema: z.ZodType<T>): T[] {
  const parsed = z.array(schema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

function parseJsonValue<T>(
  value: unknown,
  schema: z.ZodType<T>,
  fallback: T
): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

function formatCurrency(value: number): string | null {
  return value > 0
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(value)
    : null;
}

function buildUserColor(user: BasicUser | null): string | null {
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

function toSessionPullRequests(record: AgentSessionListRecord): SessionPR[] {
  const legacyPrs = parseJsonArray<SessionPR>(
    record.pullRequests,
    sessionPrSchema
  );
  const byIdentity = new Map<string, SessionPR>();
  for (const pr of legacyPrs) {
    byIdentity.set(
      sessionPullRequestIdentityKey(record.repositoryFullName, pr.num),
      pr
    );
  }
  for (const link of record.artifact.sessionPrLinks ?? []) {
    const detail = link.pullRequestDetail;
    const trustedDetail =
      detail?.isCurrent &&
      detail.lastVerifiedAt != null &&
      detail.repository.fullName === link.repositoryFullName &&
      detail.number === link.prNumber
        ? detail
        : null;
    const linkIdentityKey = sessionPullRequestIdentityKey(
      link.repositoryFullName,
      link.prNumber
    );
    const legacyIdentityKey = sessionPullRequestIdentityKey(
      null,
      link.prNumber
    );
    const existingPr =
      byIdentity.get(linkIdentityKey) ?? byIdentity.get(legacyIdentityKey);
    if (trustedDetail) {
      byIdentity.delete(legacyIdentityKey);
    }
    byIdentity.set(
      linkIdentityKey,
      sessionPrWithLifecycle({
        num: link.prNumber,
        title: trustedDetail?.title ?? existingPr?.title ?? null,
        status: trustedDetail ? null : (existingPr?.status ?? null),
        prState: trustedDetail?.prState ?? null,
        closedAt: trustedDetail?.closedAt ?? null,
        mergedAt: trustedDetail?.mergedAt ?? null,
      })
    );
  }
  return [...byIdentity.values()];
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

function toSessionListItem(
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
  const prs = toSessionPullRequests(record);

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
    issues: safeStringArray(record.issues),
    prs,
    prsMerged: prs.filter(
      (pr) => pr.status.toLowerCase() === SessionPrLifecycleStatus.Merged
    ).length,
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
    tokensIn: record.inputTokens,
    tokensOut: record.outputTokens,
    cache: record.cacheReadTokens,
    cacheWrite: record.cacheWriteTokens,
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
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadTokens: record.cacheReadTokens,
    cacheWriteTokens: record.cacheWriteTokens,
    estimatedCost,
    agentCount: record.agentCount,
    toolUseCount: record.toolUseCount,
    errorCount: record.errorCount,
    issueId: record.issueId,
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

function toMetadata(value: unknown): JsonObject | null {
  return parseJsonObject(value) ?? null;
}

function toSyncedEventData(value: unknown): JsonValue | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return sanitizeEventDataForCloudSurface(value as JsonValue);
}

/**
 * Summary was historically an unstructured transcript/tool-output surface.
 * Current sync writes keep it null and derive useful row details from sanitized
 * event data instead, so reads suppress legacy summaries as a defense in depth.
 */
function sanitizeEventSummaryForCloudSurface(
  _value: string | null | undefined
): null {
  return null;
}

/**
 * Preserve Session Trace metadata while preventing raw prompt/tool transcript
 * fields from crossing the cloud event boundary. This intentionally redacts
 * only known raw-content keys instead of applying a broad allow-list, so
 * detail fields such as paths, commands, arguments, status, and durations still
 * make repeated tool rows distinguishable.
 */
function sanitizeEventDataForCloudSurface(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sanitizeEventDataForCloudSurface);
  }
  if (!(value && typeof value === "object")) {
    return value;
  }

  const sanitized: JsonObject = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    sanitized[key] = SENSITIVE_EVENT_DATA_KEYS.has(key.toLowerCase())
      ? REDACTED_EVENT_DATA_VALUE
      : sanitizeEventDataForCloudSurface(nestedValue);
  }
  return sanitized;
}

function serializeEventDataForCloudPersistence(
  value: JsonValue | undefined
): string | null {
  return value == null
    ? null
    : JSON.stringify(sanitizeEventDataForCloudSurface(value));
}

function getLoopApiKeySource(value: unknown): string | null {
  const metadata = parseJsonObject(value);
  return typeof metadata?.apiKeySource === "string"
    ? metadata.apiKeySource
    : null;
}

// Desktop billing modes covered by a flat subscription/seat rather than
// per-token API spend. Mirrors SUBSCRIPTION_MODES in the desktop's canonical
// billing-mode engine (apps/desktop/src/shared/billing-mode.ts); kept as an
// explicit allow-list so any unrecognized/legacy value falls through to the API
// bucket rather than being misreported as subscription. Used to attribute
// DESKTOP_SYNC session cost, which has no source Loop to classify by.
const SUBSCRIPTION_BILLING_MODES: ReadonlySet<string> = new Set([
  "subscription_unknown",
  "pro",
  "max_5x",
  "max_20x",
  "codex_subscription",
  "cursor_pro",
  "copilot_seat",
]);

function isSubscriptionBillingMode(value: unknown): boolean {
  return typeof value === "string" && SUBSCRIPTION_BILLING_MODES.has(value);
}

function toSyncedAgents(value: unknown): SyncedAgentSessionAgent[] {
  const parsed = z.array(syncedAgentSessionAgentSchema).safeParse(value);
  return parsed.success ? (parsed.data as SyncedAgentSessionAgent[]) : [];
}

function toSyncedEvents(value: unknown): SyncedAgentSessionEvent[] {
  const parsed = z.array(syncedAgentSessionEventSchema).safeParse(value);
  return parsed.success ? (parsed.data as SyncedAgentSessionEvent[]) : [];
}

function toTokenUsageBreakdown(
  rows: AgentSessionDetailRecord["tokenUsageByModel"]
): SyncedAgentSessionTokenUsage[] {
  return rows.map((row) => ({
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    estimatedCostUsd: decimalToNumber(row.estimatedCost),
  }));
}

function normalizeTokenUsage(
  rows: readonly SyncedAgentSessionTokenUsage[]
): SyncedAgentSessionTokenUsage[] {
  const byModel = new Map<string, SyncedAgentSessionTokenUsage>();

  for (const row of rows) {
    const existing = byModel.get(row.model);
    if (!existing) {
      byModel.set(row.model, {
        ...row,
        estimatedCostUsd: row.estimatedCostUsd ?? 0,
      });
      continue;
    }

    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    existing.cacheReadTokens += row.cacheReadTokens;
    existing.cacheWriteTokens += row.cacheWriteTokens;
    existing.estimatedCostUsd =
      (existing.estimatedCostUsd ?? 0) + (row.estimatedCostUsd ?? 0);
  }

  return [...byModel.values()];
}
function toAttribution(
  session: Pick<
    AgentSessionDetailRecord,
    | "repositoryFullName"
    | "worktreePath"
    | "sourceArtifactId"
    | "sourceLoopId"
    | "issueId"
    | "baseBranch"
  >
): SyncedAgentSessionAttribution | null {
  const attribution: SyncedAgentSessionAttribution = {
    repositoryFullName: session.repositoryFullName,
    worktreePath: session.worktreePath,
    sourceArtifactId: session.sourceArtifactId,
    sourceLoopId: session.sourceLoopId,
    issueId: session.issueId,
    baseBranch: session.baseBranch,
  };
  return Object.values(attribution).some((value) => value != null)
    ? attribution
    : null;
}

function sumTokenUsage(
  rows: readonly SyncedAgentSessionTokenUsage[]
): SessionTotals {
  return rows.reduce<SessionTotals>(
    (totals, row) => ({
      inputTokens: totals.inputTokens + row.inputTokens,
      outputTokens: totals.outputTokens + row.outputTokens,
      cacheReadTokens: totals.cacheReadTokens + row.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens + row.cacheWriteTokens,
      estimatedCost: totals.estimatedCost + (row.estimatedCostUsd ?? 0),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: 0,
    }
  );
}

/**
 * Merge two arrays by a unique key, with incoming entries taking precedence
 * over existing entries. The first argument is a Prisma JSON value (the
 * persisted array), the second is the typed incoming array. Returns a plain
 * array suitable for JSON storage.
 */
function mergeJsonArrayByKey<T extends Record<string, unknown>>(
  existing: Prisma.JsonValue | null | undefined,
  incoming: readonly T[],
  key: string
): T[] {
  const map = new Map<unknown, T>();
  if (Array.isArray(existing)) {
    for (const item of existing) {
      if (item && typeof item === "object" && key in item) {
        map.set((item as Record<string, unknown>)[key], item as T);
      }
    }
  }
  for (const item of incoming) {
    map.set(item[key], item);
  }
  return [...map.values()];
}

function roundCost(value: number): number {
  return Number(value.toFixed(6));
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  return new Date(value);
}

/**
 * Largest of the provided dates, ignoring null/undefined and unparseable
 * values. Used to advance a genuine-activity timestamp monotonically (PLN-1034).
 * Returns null only when no usable date is supplied.
 */
function maxDate(...values: (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const value of values) {
    if (!value) {
      continue;
    }
    const time = value.getTime();
    if (Number.isNaN(time)) {
      continue;
    }
    if (best === null || time > best.getTime()) {
      best = value;
    }
  }
  return best;
}

function normalizeNullableString(
  value: string | null | undefined
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isUuid(value: string | null | undefined): value is string {
  if (!value) {
    return false;
  }
  return uuidSchema.safeParse(value).success;
}

function buildWhere(
  scope: AgentSessionScope,
  filters: AgentSessionUsageQuery | AgentSessionListQuery
): Prisma.SessionDetailWhereInput {
  // Hoisted fields (organizationId, projectId, status) are filtered through the
  // parent `artifact` relation; session-specific fields (userId, harness,
  // sessionStartedAt) stay on the detail row.
  const artifactWhere: Prisma.ArtifactWhereInput = {
    organizationId: scope.organizationId,
  };
  const where: Prisma.SessionDetailWhereInput = {
    artifact: { is: artifactWhere },
  };

  // Multi-select facets (statuses/userIds/repositories) take precedence over the
  // single-value back-compat params (e.g. the user-scoped deep link) when present.
  if (filters.userIds && filters.userIds.length > 0) {
    where.userId = { in: filters.userIds };
  } else if (filters.userId) {
    where.userId = filters.userId;
  }
  if (filters.teamId) {
    where.user = {
      is: {
        teamMemberships: {
          some: {
            teamId: filters.teamId,
          },
        },
      },
    };
  }
  if (filters.repositories && filters.repositories.length > 0) {
    where.repositoryFullName = { in: filters.repositories };
  }

  if (filters.projectId) {
    artifactWhere.projectId = filters.projectId;
  }
  if (filters.statuses && filters.statuses.length > 0) {
    artifactWhere.status = { in: filters.statuses };
  } else if (filters.status) {
    artifactWhere.status = filters.status;
  }
  if (filters.harness) {
    where.harness = filters.harness;
  }
  if (filters.startDate || filters.endDate) {
    where.sessionStartedAt = {
      ...(filters.startDate ? { gte: new Date(filters.startDate) } : {}),
      ...(filters.endDate ? { lte: new Date(filters.endDate) } : {}),
    };
  }

  return where;
}

// PLN-1034: the Sessions list defaults to most-recent genuine activity. Nulls
// (pre-backfill rows) sort last; sessionStartedAt is the stable tiebreaker.
const SESSION_DEFAULT_ORDER_BY: Prisma.SessionDetailOrderByWithRelationInput[] =
  [
    { lastActivityAt: { sort: "desc", nulls: "last" } },
    { sessionStartedAt: "desc" },
    { createdAt: "desc" },
  ];

/**
 * Map a sort column + direction (from the table headers) to a Prisma `orderBy`.
 * Each sortable column falls back to recency as a stable tiebreaker; an unset
 * `sortBy` keeps the default updated-desc ordering.
 */
function buildAgentSessionOrderBy(
  filters: AgentSessionListQuery
): Prisma.SessionDetailOrderByWithRelationInput[] {
  const dir = filters.sortDir ?? "desc";
  switch (filters.sortBy) {
    case "lastActivity":
      return [
        { lastActivityAt: { sort: dir, nulls: "last" } },
        { sessionStartedAt: "desc" },
      ];
    case "user":
      // The User model has no single `name` column; email is a stable, non-null
      // orderable proxy for the display name shown in the User column.
      return [{ user: { email: dir } }, { sessionUpdatedAt: "desc" }];
    case "status":
      return [{ artifact: { status: dir } }, { sessionUpdatedAt: "desc" }];
    case "repo":
      return [{ repositoryFullName: dir }, { sessionUpdatedAt: "desc" }];
    case "harness":
      return [{ harness: dir }, { sessionUpdatedAt: "desc" }];
    case "model":
      return [{ model: dir }, { sessionUpdatedAt: "desc" }];
    case "duration":
      // `wallClock` is a formatted string (e.g. "1h 5m"), so ordering by it
      // sorts lexicographically — wrong. There is no stored numeric duration
      // column to order by, so approximate with the session end time (the
      // closest sortable field), falling back to start time then recency.
      return [
        { sessionEndedAt: dir },
        { sessionStartedAt: dir },
        { sessionUpdatedAt: "desc" },
      ];
    case "cost":
      return [{ estimatedCost: dir }, { sessionUpdatedAt: "desc" }];
    case "started":
      return [{ sessionStartedAt: dir }, { createdAt: "desc" }];
    default:
      return SESSION_DEFAULT_ORDER_BY;
  }
}

async function findSourceArtifactsById(
  organizationId: string,
  sourceArtifactIds: Iterable<string | null | undefined>
): Promise<Map<string, SourceArtifactSummaryRecord>> {
  const ids = [...new Set([...sourceArtifactIds].filter(isUuid))];
  if (ids.length === 0) {
    return new Map();
  }

  const artifacts = await withDb((db) =>
    db.artifact.findMany({
      where: {
        organizationId,
        id: { in: ids },
      },
      select: sourceArtifactSummarySelect,
    })
  );

  return new Map(artifacts.map((artifact) => [artifact.id, artifact]));
}

async function findPagedRecords<TRecord extends { artifactId: string }>(
  fetchPage: (cursorId?: string) => Promise<TRecord[]>
): Promise<TRecord[]> {
  const sessions: TRecord[] = [];
  let cursorId: string | undefined;

  for (;;) {
    const page = await fetchPage(cursorId);

    sessions.push(...page);

    if (page.length < ANALYTICS_QUERY_BATCH_SIZE) {
      return sessions;
    }

    cursorId = page.at(-1)?.artifactId;
    if (!cursorId) {
      return sessions;
    }
  }
}

function buildLastSyncTargetWhere(
  scope: AgentSessionScope,
  filters: AgentSessionUsageQuery
): Prisma.ComputeTargetWhereInput {
  const where: Prisma.ComputeTargetWhereInput = {
    organizationId: scope.organizationId,
  };

  if (filters.userId) {
    where.userId = filters.userId;
  }
  if (filters.teamId) {
    where.user = {
      is: {
        teamMemberships: {
          some: {
            teamId: filters.teamId,
          },
        },
      },
    };
  }

  return where;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: attribution resolution intentionally folds artifact, loop, and repository lookups into one coordinator
async function resolveProjectResolution(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  sessions: readonly SyncedAgentSession[]
): Promise<SessionProjectResolution> {
  const artifactIds = new Set<string>();
  const loopIds = new Set<string>();
  const repositoryFullNames = new Set<string>();

  for (const session of sessions) {
    const attribution = session.attribution;
    if (!attribution) {
      continue;
    }
    if (isUuid(attribution.sourceArtifactId)) {
      artifactIds.add(attribution.sourceArtifactId);
    }
    if (isUuid(attribution.sourceLoopId)) {
      loopIds.add(attribution.sourceLoopId);
    }
    const repositoryFullName = normalizeNullableString(
      attribution.repositoryFullName
    );
    if (repositoryFullName) {
      repositoryFullNames.add(repositoryFullName);
    }
  }

  const [artifacts, loops, repositories] = await Promise.all([
    artifactIds.size > 0
      ? tx.artifact.findMany({
          where: {
            organizationId,
            id: {
              in: [...artifactIds],
            },
          },
          select: {
            id: true,
            projectId: true,
          },
        })
      : Promise.resolve([]),
    loopIds.size > 0
      ? tx.loop.findMany({
          where: {
            organizationId,
            id: {
              in: [...loopIds],
            },
          },
          select: {
            id: true,
            artifactId: true,
            artifact: {
              select: { projectId: true },
            },
          },
        })
      : Promise.resolve([]),
    repositoryFullNames.size > 0
      ? tx.gitHubInstallationRepository.findMany({
          where: {
            fullName: {
              in: [...repositoryFullNames],
            },
            teamRepositories: {
              some: {
                team: {
                  is: {
                    organizationId,
                  },
                },
              },
            },
          },
          select: {
            fullName: true,
            teamRepositories: {
              select: {
                team: {
                  select: {
                    projects: {
                      select: {
                        projectId: true,
                      },
                    },
                  },
                },
              },
            },
          },
        })
      : Promise.resolve([]),
  ]);

  const artifactProjectById = new Map<string, string>();
  for (const artifact of artifacts) {
    // artifact.projectId is nullable since SESSION artifacts can be unparented;
    // only project-attached source artifacts contribute a resolvable project.
    if (artifact.projectId) {
      artifactProjectById.set(artifact.id, artifact.projectId);
    }
  }

  const loopProjectById = new Map<string, string>();
  for (const loop of loops) {
    // Prefer the loop's directly-attached artifact projectId (the artifact
    // selected alongside the loop above). Fall back to the
    // artifactProjectById map populated from session.attribution.sourceArtifactId
    // — useful when the attribution-derived lookup covers an artifact the loop
    // also references but the loop's own artifact include returned null.
    const projectId =
      loop.artifact?.projectId ??
      (loop.artifactId ? artifactProjectById.get(loop.artifactId) : undefined);
    if (projectId) {
      loopProjectById.set(loop.id, projectId);
    }
  }

  const repoToProjectIds = new Map<string, Set<string>>();
  for (const repository of repositories) {
    const ids = repoToProjectIds.get(repository.fullName) ?? new Set<string>();
    for (const teamRepository of repository.teamRepositories) {
      for (const project of teamRepository.team.projects) {
        ids.add(project.projectId);
      }
    }
    repoToProjectIds.set(repository.fullName, ids);
  }

  const projectByRepositoryFullName = new Map<string, string | null>();
  for (const [fullName, projectIds] of repoToProjectIds) {
    projectByRepositoryFullName.set(
      fullName,
      projectIds.size === 1 ? [...projectIds][0] : null
    );
  }

  return {
    artifactProjectById,
    loopProjectById,
    projectByRepositoryFullName,
  };
}

function resolveProjectId(
  session: SyncedAgentSession,
  resolution: SessionProjectResolution
): string | null {
  const attribution = session.attribution;
  if (!attribution) {
    return null;
  }

  if (isUuid(attribution.sourceArtifactId)) {
    const projectId = resolution.artifactProjectById.get(
      attribution.sourceArtifactId
    );
    if (projectId) {
      return projectId;
    }
  }

  if (isUuid(attribution.sourceLoopId)) {
    const projectId = resolution.loopProjectById.get(attribution.sourceLoopId);
    if (projectId) {
      return projectId;
    }
  }

  const repositoryFullName = normalizeNullableString(
    attribution.repositoryFullName
  );
  if (!repositoryFullName) {
    return null;
  }
  return resolution.projectByRepositoryFullName.get(repositoryFullName) ?? null;
}

function toViewerScope(): "organization" {
  return "organization";
}

function toLastSyncTarget(
  record: LastSyncTargetRecord
): AgentSessionLastSyncTarget {
  return {
    computeTargetId: record.id,
    machineName: record.machineName,
    isOnline: record.isOnline,
    lastSeenAt: record.lastSeenAt,
    lastAgentSessionSyncAt: record.lastAgentSessionSyncAt,
    owner: record.user,
  };
}

function toIsoDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Constructing Intl.DateTimeFormat is the expensive part of Intl, and the CSV
 * export calls toLocalDateOnly once per row — cache one formatter per
 * timezone. Invalid timezones cache `null` so the failed construction isn't
 * retried per row. Bounded: there are only ~430 IANA zone names.
 */
const dateOnlyFormatters = new Map<string, Intl.DateTimeFormat | null>();

function getDateOnlyFormatter(timeZone: string): Intl.DateTimeFormat | null {
  const cached = dateOnlyFormatters.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }
  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    formatter = null;
  }
  dateOnlyFormatters.set(timeZone, formatter);
  return formatter;
}

/**
 * FEA-1459: Format a Date as an ISO date string (YYYY-MM-DD) in the given IANA
 * timezone. Falls back to UTC (toIsoDateOnly) if the timezone is
 * null/undefined or invalid.
 */
export function toLocalDateOnly(
  value: Date,
  timeZone: string | null | undefined
): string {
  if (!timeZone) {
    return toIsoDateOnly(value);
  }
  const formatter = getDateOnlyFormatter(timeZone);
  if (!formatter) {
    return toIsoDateOnly(value);
  }
  return formatter.format(value);
}

function toCsvExportRows(
  record: AgentSessionExportRecord
): AgentSessionCsvExportRow[] {
  const teamNames = (record.user?.teamMemberships ?? [])
    .map((membership) => membership.team.name)
    .filter(Boolean)
    .join(", ");
  const baseRow = {
    date: toLocalDateOnly(record.sessionStartedAt, record.deviceTimeZone),
    user: record.user
      ? displayUserName(toBasicUser(record.user))
      : "Unattributed",
    team: teamNames || "Unattributed",
    project: record.artifact.project?.name ?? "Unattributed",
    harnessType: record.harness,
  };

  if (record.tokenUsageByModel.length === 0) {
    return [
      {
        ...baseRow,
        model: record.model ?? "Unknown",
        sessionCount: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        estimatedCost: 0,
      },
    ];
  }

  return record.tokenUsageByModel.map((usage) => ({
    ...baseRow,
    model: usage.model,
    sessionCount: 1,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheWriteTokens,
    cacheReadTokens: usage.cacheReadTokens,
    estimatedCost: decimalToNumber(usage.estimatedCost),
  }));
}
export const agentSessionsService = {
  async upsertSessions(
    context: UpsertSessionsContext,
    payload: DesktopAgentSessionsPayload
  ): Promise<void> {
    const startedAtMs = Date.now();
    const syncTimestamp = new Date();

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: revision-gating adds inherent branching per FEA-1787
    await withDb.tx(async (tx) => {
      const target = await tx.computeTarget.findFirst({
        where: {
          id: context.computeTargetId,
          organizationId: context.organizationId,
        },
        select: {
          id: true,
        },
      });
      if (!target) {
        throw new Error("compute_target_not_found");
      }

      const projectResolution = await resolveProjectResolution(
        tx,
        context.organizationId,
        payload.sessions
      );

      // FEA-1684: batch-resolve artifact slugs referenced across all sessions
      // so per-session ArtifactLink creation uses a single round-trip.
      const slugMap = await resolveArtifactSlugMap(
        tx,
        context.organizationId,
        payload.sessions
      );

      for (const session of payload.sessions) {
        const normalizedTokenUsage = normalizeTokenUsage(
          session.tokenUsageByModel
        );
        const tokenTotals = sumTokenUsage(normalizedTokenUsage);
        const projectId = resolveProjectId(session, projectResolution);
        const attributionColumns = toAttributionColumns(session);
        // The parent artifact requires a non-null display name; fall back to a
        // stable label derived from the external session id (mirrors backfill).
        const sessionName =
          normalizeNullableString(session.name) ??
          `Session ${session.externalSessionId}`;

        // Merge agents with any existing record so chunked batches
        // accumulate rather than overwrite. Existence also drives create-vs-
        // update (a new session needs a parent artifact + SES-* slug).
        // Advisory lock scoped to this transaction prevents concurrent syncs
        // for the same session from both reading stale dataRevision and
        // double-deleting events (TOCTOU race).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${session.externalSessionId}))`;

        const existing = await tx.sessionDetail.findUnique({
          where: {
            computeTargetId_externalSessionId: {
              computeTargetId: context.computeTargetId,
              externalSessionId: session.externalSessionId,
            },
          },
          select: { artifactId: true, agents: true, dataRevision: true },
        });

        const shouldReplace =
          session.dataRevision != null &&
          session.dataRevision !== existing?.dataRevision;

        const mergedAgents = shouldReplace
          ? session.agents
          : mergeJsonArrayByKey(
              existing?.agents,
              session.agents,
              "externalAgentId"
            );

        // Shared mutable detail-table columns, written on both create + update.
        // Attribution-derived columns are NOT here: updates must not clear
        // them when a payload omits attribution (see the spreads below).
        const detailData = {
          harness: normalizeNullableString(session.harness) ?? "unknown",
          cwd: normalizeNullableString(session.cwd),
          model: normalizeNullableString(session.model),
          // FEA-1459: deviceTimeZone is optional on the wire (older Desktop
          // builds omit it). Only write the column when the field is present —
          // an omission must never null-out a zone a newer client already
          // synced, or CSV exports would silently fall back to UTC.
          ...(session.deviceTimeZone === undefined
            ? {}
            : {
                deviceTimeZone: normalizeNullableString(session.deviceTimeZone),
              }),
          ...(session.dataRevision == null
            ? {}
            : { dataRevision: session.dataRevision }),
          sessionStartedAt: new Date(session.startedAt),
          sessionUpdatedAt: new Date(session.updatedAt),
          sessionEndedAt: toDate(session.endedAt),
          awaitingInputSince: toDate(session.awaitingInputSince),
          inputTokens: tokenTotals.inputTokens,
          outputTokens: tokenTotals.outputTokens,
          cacheReadTokens: tokenTotals.cacheReadTokens,
          cacheWriteTokens: tokenTotals.cacheWriteTokens,
          estimatedCost: roundCost(tokenTotals.estimatedCost),
          agentCount: mergedAgents.length,
          metadata: session.metadata ?? Prisma.DbNull,
          agents: mergedAgents,
          lastSyncedAt: syncTimestamp,
          ...toTraceDetailPatch(session),
        };

        // Allocate the SES-* slug only when creating the parent artifact.
        // generateSlug's withDb call joins this ambient transaction via
        // AsyncLocalStorage, so allocation stays atomic with the create.
        const slug = existing
          ? undefined
          : await generateSlug(context.organizationId, SlugPrefix.Session);

        const persisted = await tx.sessionDetail.upsert({
          where: {
            computeTargetId_externalSessionId: {
              computeTargetId: context.computeTargetId,
              externalSessionId: session.externalSessionId,
            },
          },
          create: {
            artifact: {
              create: {
                organization: { connect: { id: context.organizationId } },
                ...(projectId
                  ? { project: { connect: { id: projectId } } }
                  : {}),
                type: ArtifactType.Session,
                name: sessionName,
                status: session.status,
                slug,
                createdBy: { connect: { id: context.userId } },
              },
            },
            user: { connect: { id: context.userId } },
            computeTarget: { connect: { id: context.computeTargetId } },
            externalSessionId: session.externalSessionId,
            toolUseCount: 0,
            errorCount: 0,
            ...detailData,
            ...attributionColumns,
          },
          update: {
            artifact: {
              update: {
                name: sessionName,
                status: session.status,
                // Attribution is optional on the wire (older Desktop builds,
                // chunked/partial payloads). Only (re)connect when a project
                // resolves — never disconnect on a missing signal, or version
                // skew would silently unparent previously attributed sessions.
                ...(projectId
                  ? { project: { connect: { id: projectId } } }
                  : {}),
              },
            },
            ...detailData,
            // Same rule as the project connect above: write only the non-null
            // attribution values so an attribution-less resync never clears
            // previously captured attribution.
            ...toNonNullAttributionPatch(attributionColumns),
          },
          select: {
            artifactId: true,
          },
        });

        await persistSessionChildren(
          tx,
          persisted.artifactId,
          session,
          normalizedTokenUsage,
          shouldReplace
        );

        // FEA-1684: create ArtifactLink edges from this session to referenced
        // Closedloop artifacts (documents, features, plans, etc.).
        await persistArtifactLinks(
          tx,
          context.organizationId,
          persisted.artifactId,
          session.artifactRefs,
          slugMap
        );

        // FEA-1684: create SessionPullRequestLink rows for PR references.
        await persistSessionPrLinks(
          tx,
          context.organizationId,
          persisted.artifactId,
          session.prRefs
        );
      }

      await tx.computeTarget.update({
        where: {
          id: context.computeTargetId,
        },
        data: {
          lastAgentSessionSyncAt: syncTimestamp,
        },
      });
    });

    emitTelemetryMetric({
      metric: "agent_sessions.sync.completed",
      organizationId: context.organizationId,
      computeTargetId: context.computeTargetId,
      gatewaySessionId: context.gatewaySessionId,
      sessionCount: payload.sessions.length,
      syncMode: payload.syncMode,
      latencyMs: Date.now() - startedAtMs,
    });
  },

  async getUsageSummary(
    input: SessionUsageInput
  ): Promise<AgentSessionUsageSummary> {
    const startedAtMs = Date.now();
    const where = buildWhere(input, input.filters);
    const [
      aggregate,
      byUserGroup,
      byModelGroup,
      byHarnessGroup,
      byRepositoryGroup,
      costsByLoop,
      lastSyncTargets,
    ] = await withDb(async (db) =>
      Promise.all([
        db.sessionDetail.aggregate({
          where,
          _count: {
            _all: true,
          },
          _sum: {
            inputTokens: true,
            outputTokens: true,
            cacheReadTokens: true,
            cacheWriteTokens: true,
            estimatedCost: true,
          },
          _min: {
            sessionStartedAt: true,
          },
          _max: {
            sessionStartedAt: true,
          },
        }),
        db.sessionDetail.groupBy({
          by: ["userId"],
          where,
          _count: {
            _all: true,
          },
          _sum: {
            inputTokens: true,
            outputTokens: true,
            cacheReadTokens: true,
            cacheWriteTokens: true,
            estimatedCost: true,
          },
        }),
        db.agentSessionTokenUsage.groupBy({
          by: ["model"],
          where: {
            session: {
              is: where,
            },
          },
          _count: {
            _all: true,
          },
          _sum: {
            inputTokens: true,
            outputTokens: true,
            cacheReadTokens: true,
            cacheWriteTokens: true,
            estimatedCost: true,
          },
        }),
        db.sessionDetail.groupBy({
          by: ["harness"],
          where,
          _count: {
            _all: true,
          },
          _sum: {
            inputTokens: true,
            outputTokens: true,
            cacheReadTokens: true,
            cacheWriteTokens: true,
            estimatedCost: true,
          },
        }),
        db.sessionDetail.groupBy({
          by: ["repositoryFullName"],
          where,
          _count: {
            _all: true,
          },
          _sum: {
            inputTokens: true,
            outputTokens: true,
            estimatedCost: true,
            errorCount: true,
          },
        }),
        // Cost split. Aggregate estimatedCost in the DB grouped by both
        // sourceLoopId and billingMode, instead of materializing one row per
        // session and summing in JS. Loop-originated rows are classified by the
        // linked loop's apiKeySource; DESKTOP_SYNC rows (no source Loop) are
        // classified by their synced billingMode. Classification below.
        db.sessionDetail.groupBy({
          by: ["sourceLoopId", "billingMode"],
          where,
          _sum: {
            estimatedCost: true,
          },
        }),
        db.computeTarget.findMany({
          where: buildLastSyncTargetWhere(input, input.filters),
          select: {
            id: true,
            machineName: true,
            isOnline: true,
            lastSeenAt: true,
            lastAgentSessionSyncAt: true,
            user: {
              select: basicUserSelect.select,
            },
          },
          orderBy: [
            {
              lastAgentSessionSyncAt: "desc",
            },
            {
              lastSeenAt: "desc",
            },
          ],
          take: 20,
        }),
      ])
    );
    const sourceLoopIds = [
      ...new Set(costsByLoop.map((row) => row.sourceLoopId)),
    ].filter((value): value is string => value != null);
    const loopApiKeySourceById = sourceLoopIds.length
      ? new Map(
          (
            await withDb((db) =>
              db.loop.findMany({
                where: {
                  organizationId: input.organizationId,
                  id: {
                    in: sourceLoopIds,
                  },
                },
                select: {
                  id: true,
                  metadata: true,
                },
              })
            )
          ).map((loop) => [loop.id, getLoopApiKeySource(loop.metadata)])
        )
      : new Map<string, string | null>();
    let subscriptionEstimatedCost = 0;
    let apiEstimatedCost = 0;

    for (const row of costsByLoop) {
      const estimatedCost = decimalToNumber(row._sum.estimatedCost);

      if (row.sourceLoopId) {
        // Loop-originated: classified by the linked loop's apiKeySource.
        if (loopApiKeySourceById.get(row.sourceLoopId) === "none") {
          subscriptionEstimatedCost += estimatedCost;
        } else {
          apiEstimatedCost += estimatedCost;
        }
      } else if (isSubscriptionBillingMode(row.billingMode)) {
        // DESKTOP_SYNC (no source Loop): classified by the synced billingMode.
        // A subscription/seat mode counts toward subscription cost; any other
        // value (API key, unknown, legacy null) falls through to API cost.
        subscriptionEstimatedCost += estimatedCost;
      } else {
        apiEstimatedCost += estimatedCost;
      }
    }

    // Sessions whose owner was deleted have a null userId (SetNull); they are
    // grouped under a null key that maps to no user and is dropped below.
    const groupedUserIds = byUserGroup
      .map((group) => group.userId)
      .filter((value): value is string => value != null);
    const users = groupedUserIds.length
      ? await withDb((db) =>
          db.user.findMany({
            where: {
              organizationId: input.organizationId,
              id: {
                in: groupedUserIds,
              },
            },
            select: basicUserSelect.select,
          })
        )
      : [];
    const usersById = new Map(
      users.map((user) => [user.id, toBasicUser(user)])
    );

    const byUser: AgentSessionUsageByUser[] = byUserGroup
      .map((group) => {
        const user = group.userId ? usersById.get(group.userId) : null;
        if (!user) {
          return null;
        }
        return {
          userId: user.id,
          userName: displayUserName(user),
          userEmail: user.email,
          userAvatarUrl: user.avatarUrl,
          sessionCount: group._count._all,
          inputTokens: group._sum.inputTokens ?? 0,
          outputTokens: group._sum.outputTokens ?? 0,
          cacheReadTokens: group._sum.cacheReadTokens ?? 0,
          cacheWriteTokens: group._sum.cacheWriteTokens ?? 0,
          estimatedCost: decimalToNumber(group._sum.estimatedCost),
        };
      })
      .filter((value): value is AgentSessionUsageByUser => value != null)
      .sort((left, right) => right.estimatedCost - left.estimatedCost);

    const byModel: AgentSessionUsageByModel[] = byModelGroup
      .map((group) => ({
        model: group.model,
        sessionCount: group._count._all,
        inputTokens: group._sum.inputTokens ?? 0,
        outputTokens: group._sum.outputTokens ?? 0,
        cacheReadTokens: group._sum.cacheReadTokens ?? 0,
        cacheWriteTokens: group._sum.cacheWriteTokens ?? 0,
        estimatedCost: decimalToNumber(group._sum.estimatedCost),
      }))
      .sort((left, right) => right.estimatedCost - left.estimatedCost);

    const byHarness = byHarnessGroup
      .map((group) => ({
        harness: group.harness,
        sessionCount: group._count._all,
        inputTokens: group._sum.inputTokens ?? 0,
        outputTokens: group._sum.outputTokens ?? 0,
        cacheReadTokens: group._sum.cacheReadTokens ?? 0,
        cacheWriteTokens: group._sum.cacheWriteTokens ?? 0,
        estimatedCost: decimalToNumber(group._sum.estimatedCost),
      }))
      .sort((left, right) => right.sessionCount - left.sessionCount);

    // Repository facet feed (Filter → Repository). Sessions without a captured
    // repository (null) are dropped — there's nothing to filter to.
    const byRepository: AgentSessionRepositoryBreakdown[] = (
      byRepositoryGroup ?? []
    )
      .filter(
        (group): group is typeof group & { repositoryFullName: string } =>
          group.repositoryFullName != null
      )
      .map((group) => ({
        repositoryFullName: group.repositoryFullName,
        sessionCount: group._count._all,
        inputTokens: group._sum.inputTokens ?? 0,
        outputTokens: group._sum.outputTokens ?? 0,
        estimatedCost: decimalToNumber(group._sum.estimatedCost),
        errorCount: group._sum.errorCount ?? 0,
      }))
      .sort((left, right) => right.sessionCount - left.sessionCount);

    const summary: AgentSessionUsageSummary = {
      viewerScope: toViewerScope(),
      totalSessions: aggregate._count._all,
      earliestSessionAt:
        aggregate._min?.sessionStartedAt?.toISOString() ?? null,
      latestSessionAt: aggregate._max?.sessionStartedAt?.toISOString() ?? null,
      totalInputTokens: aggregate._sum.inputTokens ?? 0,
      totalOutputTokens: aggregate._sum.outputTokens ?? 0,
      totalCacheReadTokens: aggregate._sum.cacheReadTokens ?? 0,
      totalCacheWriteTokens: aggregate._sum.cacheWriteTokens ?? 0,
      totalEstimatedCost: decimalToNumber(aggregate._sum.estimatedCost),
      subscriptionEstimatedCost,
      apiEstimatedCost,
      byUser,
      byModel,
      byHarness,
      byRepository,
      lastSyncTargets: lastSyncTargets.map(toLastSyncTarget),
    };

    emitTelemetryMetric({
      metric: "agent_sessions.dashboard.query_latency",
      organizationId: input.organizationId,
      viewerScope: toViewerScope(),
      value: Date.now() - startedAtMs,
    });

    return summary;
  },

  async findExportRows(
    input: SessionUsageInput
  ): Promise<{ rows: AgentSessionCsvExportRow[]; orgSlug: string | null }> {
    const where = buildWhere(input, input.filters);

    const organization = await withDb((db) =>
      db.organization.findUnique({
        where: { id: input.organizationId },
        select: { slug: true },
      })
    );

    const aggregated = new Map<string, AgentSessionCsvExportRow>();

    // Stream sessionDetail rows in keyset-paginated batches rather than loading
    // every matching row at once. sessionDetail grows with every agent run, so a
    // single unbounded findMany can exhaust serverless memory for heavy orgs. The
    // aggregation Map and final sort are unchanged, and the batch order keeps the
    // original (sessionStartedAt, createdAt) ordering with artifactId — the
    // primary key — as a deterministic tiebreaker, so the emitted CSV is
    // identical to the previous single-query implementation.
    let cursorId: string | undefined;
    for (;;) {
      const batch = await withDb((db) =>
        db.sessionDetail.findMany({
          where,
          orderBy: [
            { sessionStartedAt: "desc" },
            { createdAt: "desc" },
            { artifactId: "desc" },
          ],
          take: EXPORT_BATCH_SIZE,
          ...(cursorId ? { cursor: { artifactId: cursorId }, skip: 1 } : {}),
          select: { ...agentSessionExportSelect, artifactId: true },
        })
      );

      if (batch.length === 0) {
        break;
      }

      for (const session of batch) {
        const userKey = session.user?.id ?? "unattributed";
        for (const row of toCsvExportRows(session)) {
          const key = [
            row.date,
            userKey,
            row.team,
            row.project,
            row.harnessType,
            row.model,
          ].join("::");
          const current = aggregated.get(key);
          if (!current) {
            aggregated.set(key, row);
            continue;
          }
          current.sessionCount += 1;
          current.inputTokens += row.inputTokens;
          current.outputTokens += row.outputTokens;
          current.cacheCreationTokens += row.cacheCreationTokens;
          current.cacheReadTokens += row.cacheReadTokens;
          current.estimatedCost = roundCost(
            current.estimatedCost + row.estimatedCost
          );
        }
      }

      if (batch.length < EXPORT_BATCH_SIZE) {
        break;
      }
      cursorId = batch.at(-1)?.artifactId;
      // artifactId is a non-null primary key on a non-empty batch, so this is a
      // safety net: a missing cursor would drop the `cursor` clause below and
      // re-fetch page one forever.
      if (!cursorId) {
        break;
      }
    }

    const rows = [...aggregated.values()].sort((left, right) => {
      if (left.date !== right.date) {
        return right.date.localeCompare(left.date);
      }
      if (left.user !== right.user) {
        return left.user.localeCompare(right.user);
      }
      return left.model.localeCompare(right.model);
    });
    return { rows, orgSlug: organization?.slug ?? null };
  },

  async findSessions(
    input: SessionListInput
  ): Promise<AgentSessionListResponse> {
    const limit = Math.min(
      input.filters.limit ?? SESSION_LIST_DEFAULT_LIMIT,
      SESSION_LIST_MAX_LIMIT
    );
    const offset = input.filters.offset ?? 0;
    const where = buildWhere(input, input.filters);
    const orderBy = buildAgentSessionOrderBy(input.filters);

    const [items, total] = await withDb((db) =>
      Promise.all([
        db.sessionDetail.findMany({
          where,
          select: agentSessionListSelect,
          orderBy,
          skip: offset,
          take: limit,
        }),
        db.sessionDetail.count({ where }),
      ])
    );
    const sourceArtifactsById = await findSourceArtifactsById(
      input.organizationId,
      items.map((item) => item.sourceArtifactId)
    );

    return {
      items: items.map((item) => toSessionListItem(item, sourceArtifactsById)),
      total,
      viewerScope: toViewerScope(),
    };
  },

  async findSessionDetail(
    input: SessionDetailInput
  ): Promise<AgentSessionDetail | null> {
    const record = await withDb((db) =>
      db.sessionDetail.findFirst({
        where: {
          artifactId: input.id,
          artifact: { is: { organizationId: input.organizationId } },
        },
        select: agentSessionDetailSelect,
      })
    );

    if (!record) {
      return null;
    }

    const sourceArtifactsById = await findSourceArtifactsById(
      input.organizationId,
      [record.sourceArtifactId]
    );
    const listItem = toSessionListItem(record, sourceArtifactsById);
    const tokenUsageByModel = toTokenUsageBreakdown(record.tokenUsageByModel);
    const metadata = toMetadata(record.metadata);
    const events = record.events.map(
      (e): SyncedAgentSessionEvent => ({
        externalEventId: e.externalEventId,
        agentExternalId: e.agentExternalId,
        eventType: e.eventType,
        toolName: e.toolName,
        summary: sanitizeEventSummaryForCloudSurface(e.summary),
        data: toSyncedEventData(e.data),
        createdAt: e.eventCreatedAt.toISOString(),
      })
    );
    const timeline = projectAgentSessionTimelineEvents(events, { metadata });
    const models = [
      ...new Set(tokenUsageByModel.map((usage) => usage.model).filter(Boolean)),
    ];
    const agents = toSyncedAgents(record.agents);
    return {
      ...listItem,
      models: models.length > 0 ? models : (listItem.models ?? []),
      metadata,
      sourceArtifactId: record.sourceArtifactId,
      sourceLoopId: record.sourceLoopId,
      tokenUsageByModel,
      attribution: toAttribution(record),
      agents,
      events,
      timeline,
      tracePhaseSources: parseJsonArray<SessionTracePhaseSource>(
        record.tracePhaseSources,
        sessionTracePhaseSourceSchema
      ),
      throttleSources: parseJsonArray<SessionTraceThrottleSource>(
        record.throttleSources,
        sessionTraceThrottleSourceSchema
      ),
      correctionSources: parseJsonArray<SessionTraceCorrectionSource>(
        record.correctionSources,
        sessionTraceCorrectionSourceSchema
      ),
      turnItems: projectAgentSessionTurnItems({
        sessionId: record.artifactId,
        harness: record.harness,
        primaryModel: listItem.primaryModel ?? null,
        humanActor: {
          name: listItem.user ? displayUserName(listItem.user) : null,
          color:
            buildUserColor(listItem.user) ?? DEFAULT_HUMAN_ACTOR_COLOR_TOKEN,
        },
        agents,
        events,
        timeline,
        tokenUsageByModel,
      }),
    };
  },

  async getAnalytics(input: SessionUsageInput): Promise<AgentSessionAnalytics> {
    const where = buildWhere(input, input.filters);
    const scalarSessions = await findPagedRecords<AnalyticsScalarSessionRecord>(
      (cursorId) =>
        withDb((db) =>
          db.sessionDetail.findMany({
            where,
            select: analyticsScalarSelect,
            orderBy: { artifactId: "asc" },
            take: ANALYTICS_QUERY_BATCH_SIZE,
            ...(cursorId
              ? {
                  cursor: { artifactId: cursorId },
                  skip: 1,
                }
              : {}),
          })
        )
    );
    const jsonSessions = await findPagedRecords<AnalyticsJsonSessionRecord>(
      (cursorId) =>
        withDb((db) =>
          db.sessionDetail.findMany({
            where,
            select: analyticsJsonSelect,
            orderBy: { artifactId: "asc" },
            take: ANALYTICS_QUERY_BATCH_SIZE,
            ...(cursorId
              ? {
                  cursor: { artifactId: cursorId },
                  skip: 1,
                }
              : {}),
          })
        )
    );

    const byTool = aggregateByTool(jsonSessions);
    const byAgentType = aggregateByAgentType(jsonSessions);
    const byRepository = aggregateByRepository(scalarSessions);
    const byProject = aggregateByProject(scalarSessions);

    return {
      viewerScope: toViewerScope(),
      byTool,
      byAgentType,
      byRepository,
      byProject,
    };
  },

  /**
   * FEA-1684 Task 8: Cloud attribution query — returns aggregate token usage
   * for all sessions linked to a given artifact via ArtifactLink edges.
   */
  async getArtifactSessionUsage(
    organizationId: string,
    artifactId: string
  ): Promise<ArtifactSessionUsageSummary | null> {
    const artifact = await withDb((db) =>
      db.artifact.findFirst({
        where: { id: artifactId, organizationId },
        select: { id: true, slug: true },
      })
    );
    if (!artifact) {
      return null;
    }

    // Find all ArtifactLink edges where this artifact is the target and the
    // source is a SESSION artifact (linkType = RELATES_TO).
    const links = await withDb((db) =>
      db.artifactLink.findMany({
        where: {
          organizationId,
          targetId: artifactId,
          linkType: LinkType.RelatesTo,
          source: { type: ArtifactType.Session, organizationId },
        },
        select: { sourceId: true },
      })
    );

    const sessionArtifactIds = links.map((link) => link.sourceId);
    if (sessionArtifactIds.length === 0) {
      return {
        artifactId: artifact.id,
        artifactSlug: artifact.slug,
        sessionCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0,
        byModel: [],
      };
    }

    const [aggregate, byModelGroup] = await withDb((db) =>
      Promise.all([
        db.sessionDetail.aggregate({
          where: {
            artifactId: { in: sessionArtifactIds },
            artifact: { organizationId },
          },
          _count: { _all: true },
          _sum: {
            inputTokens: true,
            outputTokens: true,
            cacheReadTokens: true,
            cacheWriteTokens: true,
            estimatedCost: true,
          },
        }),
        db.agentSessionTokenUsage.groupBy({
          by: ["model"],
          where: {
            agentSessionId: { in: sessionArtifactIds },
            session: { artifact: { organizationId } },
          },
          _sum: {
            inputTokens: true,
            outputTokens: true,
            cacheReadTokens: true,
            cacheWriteTokens: true,
            estimatedCost: true,
          },
        }),
      ])
    );

    return {
      artifactId: artifact.id,
      artifactSlug: artifact.slug,
      sessionCount: aggregate._count._all,
      inputTokens: aggregate._sum.inputTokens ?? 0,
      outputTokens: aggregate._sum.outputTokens ?? 0,
      cacheReadTokens: aggregate._sum.cacheReadTokens ?? 0,
      cacheWriteTokens: aggregate._sum.cacheWriteTokens ?? 0,
      estimatedCostUsd: decimalToNumber(aggregate._sum.estimatedCost),
      byModel: byModelGroup
        .map((group) => ({
          model: group.model,
          inputTokens: group._sum.inputTokens ?? 0,
          outputTokens: group._sum.outputTokens ?? 0,
          cacheReadTokens: group._sum.cacheReadTokens ?? 0,
          cacheWriteTokens: group._sum.cacheWriteTokens ?? 0,
          estimatedCostUsd: decimalToNumber(group._sum.estimatedCost),
        }))
        .sort((left, right) => right.estimatedCostUsd - left.estimatedCostUsd),
    };
  },
};

function aggregateByTool(
  sessions: AnalyticsJsonSessionRecord[]
): AgentSessionToolBreakdown[] {
  const map = new Map<
    string,
    { invocationCount: number; errorCount: number; sessionIds: Set<string> }
  >();

  for (const session of sessions) {
    const events = toSyncedEvents(session.events);
    for (const event of events) {
      if (!event.toolName) {
        continue;
      }
      const existing = map.get(event.toolName);
      const isError = ERROR_EVENT_PATTERN.test(event.eventType);
      if (existing) {
        existing.invocationCount += 1;
        if (isError) {
          existing.errorCount += 1;
        }
        existing.sessionIds.add(session.artifactId);
      } else {
        map.set(event.toolName, {
          invocationCount: 1,
          errorCount: isError ? 1 : 0,
          sessionIds: new Set([session.artifactId]),
        });
      }
    }
  }

  return [...map.entries()]
    .map(([toolName, data]) => ({
      toolName,
      invocationCount: data.invocationCount,
      errorCount: data.errorCount,
      sessionCount: data.sessionIds.size,
    }))
    .sort((left, right) => right.invocationCount - left.invocationCount);
}

type AgentTypeAccumulator = {
  count: number;
  successCount: number;
  failedCount: number;
  durations: number[];
};

function accumulateAgentType(
  map: Map<string, AgentTypeAccumulator>,
  agent: SyncedAgentSessionAgent
): void {
  const key = agent.subagentType ?? agent.type ?? "unknown";
  const isSuccess = AGENT_SUCCESS_STATUS_PATTERN.test(agent.status);
  const isFailed = AGENT_FAILED_STATUS_PATTERN.test(agent.status);
  const duration = computeAgentDuration(agent.startedAt, agent.endedAt);

  const existing = map.get(key);
  if (existing) {
    existing.count += 1;
    existing.successCount += isSuccess ? 1 : 0;
    existing.failedCount += isFailed ? 1 : 0;
    if (duration !== null) {
      existing.durations.push(duration);
    }
  } else {
    map.set(key, {
      count: 1,
      successCount: isSuccess ? 1 : 0,
      failedCount: isFailed ? 1 : 0,
      durations: duration === null ? [] : [duration],
    });
  }
}

function aggregateByAgentType(
  sessions: AnalyticsJsonSessionRecord[]
): AgentSessionAgentTypeBreakdown[] {
  const map = new Map<string, AgentTypeAccumulator>();

  for (const session of sessions) {
    const agents = toSyncedAgents(session.agents);
    for (const agent of agents) {
      accumulateAgentType(map, agent);
    }
  }

  return [...map.entries()]
    .map(([agentType, data]) => ({
      agentType,
      count: data.count,
      successCount: data.successCount,
      failedCount: data.failedCount,
      avgDurationMs:
        data.durations.length > 0
          ? Math.round(
              data.durations.reduce((sum, d) => sum + d, 0) /
                data.durations.length
            )
          : null,
    }))
    .sort((left, right) => right.count - left.count);
}

function aggregateByRepository(
  sessions: AnalyticsScalarSessionRecord[]
): AgentSessionRepositoryBreakdown[] {
  const map = new Map<
    string,
    {
      sessionCount: number;
      inputTokens: number;
      outputTokens: number;
      estimatedCost: number;
      errorCount: number;
    }
  >();

  for (const session of sessions) {
    const repo = session.repositoryFullName;
    if (!repo) {
      continue;
    }
    const existing = map.get(repo);
    const cost = decimalToNumber(session.estimatedCost);
    if (existing) {
      existing.sessionCount += 1;
      existing.inputTokens += session.inputTokens;
      existing.outputTokens += session.outputTokens;
      existing.estimatedCost += cost;
      existing.errorCount += session.errorCount;
    } else {
      map.set(repo, {
        sessionCount: 1,
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        estimatedCost: cost,
        errorCount: session.errorCount,
      });
    }
  }

  return [...map.entries()]
    .map(([repositoryFullName, data]) => ({
      repositoryFullName,
      ...data,
    }))
    .sort((left, right) => right.sessionCount - left.sessionCount);
}

function aggregateByProject(
  sessions: AnalyticsScalarSessionRecord[]
): AgentSessionProjectBreakdown[] {
  const map = new Map<
    string,
    {
      projectName: string;
      projectSlug: string | null;
      sessionCount: number;
      inputTokens: number;
      outputTokens: number;
      estimatedCost: number;
    }
  >();

  for (const session of sessions) {
    const project = session.artifact.project;
    if (!(session.artifact.projectId && project)) {
      continue;
    }
    const existing = map.get(session.artifact.projectId);
    const cost = decimalToNumber(session.estimatedCost);
    if (existing) {
      existing.sessionCount += 1;
      existing.inputTokens += session.inputTokens;
      existing.outputTokens += session.outputTokens;
      existing.estimatedCost += cost;
    } else {
      map.set(session.artifact.projectId, {
        projectName: project.name,
        projectSlug: project.slug,
        sessionCount: 1,
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        estimatedCost: cost,
      });
    }
  }

  return [...map.entries()]
    .map(([projectId, data]) => ({
      projectId,
      ...data,
    }))
    .sort((left, right) => right.sessionCount - left.sessionCount);
}

function computeAgentDuration(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined
): number | null {
  if (!(startedAt && endedAt)) {
    return null;
  }
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }
  const duration = end - start;
  return duration >= 0 ? duration : null;
}

/**
 * Persist a session's event + token-usage child rows (keyed on the session's
 * artifact id) and recompute the event-derived counts. Extracted from the
 * upsert loop to keep that method's cognitive complexity in check.
 */
async function persistSessionChildren(
  tx: AgentSessionUpsertTx,
  artifactId: string,
  session: SyncedAgentSession,
  normalizedTokenUsage: readonly SyncedAgentSessionTokenUsage[],
  shouldReplace = false
): Promise<void> {
  if (shouldReplace) {
    await tx.agentSessionEvent.deleteMany({
      where: { agentSessionId: artifactId },
    });
  }

  // Batch upsert events into the child table — single round-trip via raw SQL.
  // `id` is supplied inline via gen_random_uuid(): the Prisma schema's
  // @default(uuid(7)) is client-side and does not apply to raw SQL, and the
  // column has no DB default — omitting it produces a 23502 null violation on
  // every new event.
  if (session.events.length > 0) {
    const rows = session.events.map((event) => [
      artifactId,
      event.externalEventId,
      event.agentExternalId ?? null,
      event.eventType,
      event.toolName ?? null,
      null,
      serializeEventDataForCloudPersistence(event.data),
      new Date(event.createdAt),
    ]);
    const flatValues = rows.flat();
    const rowPlaceholders = rows
      .map((_, i) => {
        const base = i * 8;
        return `(gen_random_uuid(), $${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::jsonb, $${base + 8}::timestamp)`;
      })
      .join(", ");
    await tx.$executeRawUnsafe(
      `INSERT INTO "agent_session_events" ("id", "agent_session_id", "external_event_id", "agent_external_id", "event_type", "tool_name", "summary", "data", "event_created_at") VALUES ${rowPlaceholders} ON CONFLICT ("agent_session_id", "external_event_id") DO UPDATE SET "agent_external_id" = EXCLUDED."agent_external_id", "event_type" = EXCLUDED."event_type", "tool_name" = EXCLUDED."tool_name", "summary" = EXCLUDED."summary", "data" = EXCLUDED."data", "event_created_at" = EXCLUDED."event_created_at"`,
      ...flatValues
    );
  }

  // Recompute event-derived counts from the full child table.
  const totalToolUse = await tx.agentSessionEvent.count({
    where: {
      agentSessionId: artifactId,
      OR: [
        { eventType: "tool_use" },
        { AND: [{ toolName: { not: null } }, { toolName: { not: "" } }] },
      ],
    },
  });
  const totalErrors = await tx.agentSessionEvent.count({
    where: {
      agentSessionId: artifactId,
      // Mirror ERROR_EVENT_PATTERN (/error|fail/i) as case-insensitive
      // substring predicates so the persisted count matches the in-memory
      // aggregateByTool classifier and the desktop countErrorEvents.
      OR: ERROR_EVENT_TERMS.map((term) => ({
        eventType: { contains: term, mode: "insensitive" as const },
      })),
    },
  });

  // Genuine-activity timestamp (PLN-1034): the latest real agent event, floored
  // at the session start. Derived ONLY from the cloud's persisted event stream
  // (the authoritative source) — NOT session_updated_at (bumped by OTEL ingest /
  // enrichment / sync), and NOT the incoming payload's lastActivityAt (a Desktop
  // hint the cloud should not trust over its own events). Monotonic via GREATEST
  // with the existing value so a replacement sync (events deleted + re-inserted
  // with a smaller/older set) can never move it backward.
  const latestEvent = await tx.agentSessionEvent.aggregate({
    where: { agentSessionId: artifactId },
    _max: { eventCreatedAt: true },
  });
  const existingDetail = await tx.sessionDetail.findUnique({
    where: { artifactId },
    select: { lastActivityAt: true },
  });
  const lastActivityAt = maxDate(
    existingDetail?.lastActivityAt,
    new Date(session.startedAt),
    latestEvent._max.eventCreatedAt
  );
  await tx.sessionDetail.update({
    where: { artifactId },
    data: {
      toolUseCount: totalToolUse,
      errorCount: totalErrors,
      lastActivityAt,
    },
  });

  await tx.agentSessionTokenUsage.deleteMany({
    where: { agentSessionId: artifactId },
  });

  if (normalizedTokenUsage.length > 0) {
    await tx.agentSessionTokenUsage.createMany({
      data: normalizedTokenUsage.map((row) => ({
        agentSessionId: artifactId,
        model: row.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        estimatedCost: roundCost(row.estimatedCostUsd ?? 0),
      })),
    });
  }
}

/**
 * Attribution-derived SessionDetail columns. Kept separate from the always-
 * overwritten mutable columns because attribution is optional on the wire
 * (older Desktop builds, chunked/partial payloads) and must never be cleared
 * by a payload that simply omits it.
 */
type SessionAttributionColumns = {
  repositoryFullName: string | null;
  worktreePath: string | null;
  sourceArtifactId: string | null;
  sourceLoopId: string | null;
  issueId: string | null;
  baseBranch: string | null;
};

type NullableJsonPatch =
  | Prisma.NullableJsonNullValueInput
  | Prisma.InputJsonValue;

type SessionTraceDetailPatch = {
  billingMode?: string | null;
  branch?: string | null;
  issues?: NullableJsonPatch;
  pullRequests?: NullableJsonPatch;
  wallClock?: string | null;
  activeAgent?: string | null;
  waitingUser?: string | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  filesChanged?: number | null;
  locSource?: string | null;
  branchLinesAdded?: number | null;
  branchLinesRemoved?: number | null;
  branchFilesChanged?: number | null;
  branchLocSource?: string | null;
  turns?: number | null;
  steeringEpisodes?: number | null;
  autonomy?: number | null;
  activityBuckets?: NullableJsonPatch;
  sessionSpan?: NullableJsonPatch;
  markers?: NullableJsonPatch;
  throttles?: NullableJsonPatch;
  tracePhaseSources?: NullableJsonPatch;
  throttleSources?: NullableJsonPatch;
  correctionSources?: NullableJsonPatch;
  phases?: NullableJsonPatch;
  phaseIterations?: NullableJsonPatch;
  phaseLoopbacks?: NullableJsonPatch;
};

function toAttributionColumns(
  session: SyncedAgentSession
): SessionAttributionColumns {
  return {
    repositoryFullName: normalizeNullableString(
      session.attribution?.repositoryFullName
    ),
    worktreePath: normalizeNullableString(session.attribution?.worktreePath),
    sourceArtifactId: normalizeNullableString(
      session.attribution?.sourceArtifactId
    ),
    sourceLoopId: normalizeNullableString(session.attribution?.sourceLoopId),
    issueId: normalizeNullableString(session.attribution?.issueId),
    baseBranch: normalizeNullableString(session.attribution?.baseBranch),
  };
}

function toNullableJsonPatch(value: unknown): NullableJsonPatch {
  return value == null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

/**
 * Sync-owned Session Trace detail fields. Undefined means the desktop build did
 * not send the field and existing cloud values must be preserved; null is an
 * intentional clear for nullable storage.
 */
function toTraceDetailPatch(
  session: SyncedAgentSession
): SessionTraceDetailPatch {
  const patch: SessionTraceDetailPatch = {};
  setPatchValue(
    patch,
    "billingMode",
    session.billingMode,
    normalizeNullableString
  );
  setPatchValue(patch, "branch", session.branch, normalizeNullableString);
  setPatchValue(patch, "issues", session.issues, toNullableJsonPatch);
  setPatchValue(patch, "pullRequests", session.prs, toNullableJsonPatch);
  setPatchValue(patch, "wallClock", session.wallClock, normalizeNullableString);
  setPatchValue(
    patch,
    "activeAgent",
    session.activeAgent,
    normalizeNullableString
  );
  setPatchValue(
    patch,
    "waitingUser",
    session.waitingUser,
    normalizeNullableString
  );
  // gitDiffStats is the source-tagged variant of the loose lines/files scalars.
  // Persist it into the same dedicated columns, preferring it when present so a
  // git-derived count wins over a heuristic scalar from the same payload. The
  // source tag is recorded separately in loc_source so readers can rehydrate
  // gitDiffStats and distinguish git-derived LOC from agent-estimated scalars.
  setPatchValue(
    patch,
    "linesAdded",
    session.gitDiffStats?.linesAdded ?? session.linesAdded,
    identityPatchValue
  );
  setPatchValue(
    patch,
    "linesRemoved",
    session.gitDiffStats?.linesRemoved ?? session.linesRemoved,
    identityPatchValue
  );
  setPatchValue(
    patch,
    "filesChanged",
    session.gitDiffStats?.filesChanged ?? session.filesChanged,
    identityPatchValue
  );
  // Record provenance whenever the payload carries any LOC signal. A present
  // gitDiffStats tags the scalars as "git"; loose scalars alone clear the marker
  // so a re-sync without git stats does not keep rendering stale LOC as git.
  setPatchValue(
    patch,
    "locSource",
    resolveLocSourcePatch(session),
    identityPatchValue
  );
  // branchDiffStats is branch-level LOC (working-branch changes vs the author's
  // contributed lines) — a distinct metric kept in dedicated branch_* columns so
  // it never collides with the gitDiffStats scalars above.
  applyBranchDiffStatsPatch(patch, session.branchDiffStats);
  setPatchValue(patch, "turns", session.turns, identityPatchValue);
  setPatchValue(
    patch,
    "steeringEpisodes",
    session.steeringEpisodes,
    identityPatchValue
  );
  setPatchValue(patch, "autonomy", session.autonomy, identityPatchValue);
  setPatchValue(
    patch,
    "activityBuckets",
    session.activityBuckets,
    toNullableJsonPatch
  );
  setPatchValue(patch, "sessionSpan", session.span, toNullableJsonPatch);
  setPatchValue(patch, "markers", session.markers, toNullableJsonPatch);
  setPatchValue(patch, "throttles", session.throttles, toNullableJsonPatch);
  setPatchValue(
    patch,
    "tracePhaseSources",
    session.tracePhaseSources,
    toNullableJsonPatch
  );
  setPatchValue(
    patch,
    "throttleSources",
    session.throttleSources,
    toNullableJsonPatch
  );
  setPatchValue(
    patch,
    "correctionSources",
    session.correctionSources,
    toNullableJsonPatch
  );
  setPatchValue(patch, "phases", session.phases, toNullableJsonPatch);
  setPatchValue(
    patch,
    "phaseIterations",
    session.phaseIterations,
    toNullableJsonPatch
  );
  setPatchValue(
    patch,
    "phaseLoopbacks",
    session.phaseLoopbacks,
    toNullableJsonPatch
  );
  return patch;
}

/**
 * Provenance for the flattened LOC scalar columns. "git" when the payload
 * carries source-tagged gitDiffStats; null when only loose scalars are present
 * (clears a stale marker on re-sync); undefined when the payload omits LOC
 * entirely so the existing column value is preserved.
 */
function resolveLocSourcePatch(
  session: SyncedAgentSession
): string | null | undefined {
  if (session.gitDiffStats) {
    return session.gitDiffStats.source;
  }
  const hasLooseScalars =
    session.linesAdded !== undefined ||
    session.linesRemoved !== undefined ||
    session.filesChanged !== undefined;
  return hasLooseScalars ? null : undefined;
}

/**
 * Persist branchDiffStats into its dedicated branch_* columns. Branch LOC has no
 * loose-scalar counterpart, so the source-tagged object owns all four columns:
 * omission (undefined) preserves the existing values, while an explicit null
 * clears them together (mirroring the nullable-clear convention of the patch).
 */
function applyBranchDiffStatsPatch(
  patch: SessionTraceDetailPatch,
  branchDiffStats: SyncedAgentSession["branchDiffStats"]
): void {
  if (branchDiffStats === undefined) {
    return;
  }
  patch.branchLinesAdded = branchDiffStats?.linesAdded ?? null;
  patch.branchLinesRemoved = branchDiffStats?.linesRemoved ?? null;
  patch.branchFilesChanged = branchDiffStats?.filesChanged ?? null;
  patch.branchLocSource = branchDiffStats?.source ?? null;
}

function setPatchValue<T, TKey extends keyof SessionTraceDetailPatch>(
  patch: SessionTraceDetailPatch,
  key: TKey,
  value: T | undefined,
  mapValue: (value: T) => SessionTraceDetailPatch[TKey]
): void {
  if (value !== undefined) {
    patch[key] = mapValue(value);
  }
}

function identityPatchValue<T>(value: T): T {
  return value;
}

/**
 * Update-arm projection of {@link toAttributionColumns}: only non-null values,
 * so an attribution-less resync preserves previously captured attribution
 * (mirrors the parent artifact's connect-only project handling).
 */
function toNonNullAttributionPatch(
  columns: SessionAttributionColumns
): Partial<SessionAttributionColumns> {
  return Object.fromEntries(
    Object.entries(columns).filter(([, value]) => value !== null)
  );
}

// ---------------------------------------------------------------------------
// FEA-1684: ArtifactLink + SessionPullRequestLink ingestion helpers
// ---------------------------------------------------------------------------

/**
 * Batch-resolve Closedloop artifact slugs across all sessions in a sync
 * payload. Returns a Map<slug, artifactUUID> for efficient per-session lookups.
 */
async function resolveArtifactSlugMap(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  sessions: readonly SyncedAgentSession[]
): Promise<Map<string, string>> {
  const distinctSlugs = new Set<string>();
  for (const session of sessions) {
    if (!session.artifactRefs) {
      continue;
    }
    for (const ref of session.artifactRefs) {
      const slug = normalizeNullableString(ref.slug);
      if (slug) {
        distinctSlugs.add(slug);
      }
    }
  }

  if (distinctSlugs.size === 0) {
    return new Map();
  }

  const resolved = await tx.artifact.findMany({
    where: {
      organizationId,
      slug: { in: [...distinctSlugs] },
    },
    select: { id: true, slug: true },
  });

  const slugMap = new Map<string, string>();
  for (const artifact of resolved) {
    if (artifact.slug) {
      slugMap.set(artifact.slug, artifact.id);
    }
  }
  return slugMap;
}

/** Role precedence for merging duplicate artifact refs: input > referenced > workspace. */
const ROLE_PRECEDENCE: Record<string, number> = {
  input: 0,
  referenced: 1,
  workspace: 2,
};

/**
 * Derive a semantic role from the extraction method. The sync contract does
 * not carry the extractor's `relation` field, so we reconstruct the best
 * role from the method string which is always present.
 */
function roleFromMethod(method: string, isPrimary: boolean): string {
  if (isPrimary) {
    return "input";
  }
  switch (method) {
    case "mcp_tool_call":
    case "launch_metadata":
      return "input";
    case "slug_in_branch":
    case "slug_in_cwd":
    case "slug_in_session_slug":
      return "workspace";
    default:
      return "referenced";
  }
}

/**
 * Merge multiple artifact refs that target the same slug within a single
 * session. The highest-precedence role wins (input > referenced > workspace),
 * and isPrimary is OR-aggregated.
 */
function mergeArtifactRefsBySlug(
  refs: readonly SyncedArtifactRef[]
): Map<string, { isPrimary: boolean; method: string; role: string }> {
  const merged = new Map<
    string,
    { isPrimary: boolean; method: string; role: string }
  >();
  for (const ref of refs) {
    const slug = normalizeNullableString(ref.slug);
    if (!slug) {
      continue;
    }

    const role = roleFromMethod(ref.method, ref.isPrimary);
    const existing = merged.get(slug);
    if (!existing) {
      merged.set(slug, { isPrimary: ref.isPrimary, method: ref.method, role });
      continue;
    }
    // OR-aggregate isPrimary
    existing.isPrimary = existing.isPrimary || ref.isPrimary;
    // Higher precedence role wins
    if (
      (ROLE_PRECEDENCE[role] ?? 99) < (ROLE_PRECEDENCE[existing.role] ?? 99)
    ) {
      existing.role = role;
      existing.method = ref.method;
    }
  }
  return merged;
}

/**
 * Create ArtifactLink edges from a session artifact to referenced Closedloop
 * artifacts. Unresolved slugs are accumulated into SessionDetail.metadata
 * under `_unresolvedArtifactRefs`.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: slug resolution + link upsert + metadata merge is inherently branchy
async function persistArtifactLinks(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  sessionArtifactId: string,
  artifactRefs: SyncedArtifactRef[] | undefined,
  slugMap: Map<string, string>
): Promise<void> {
  // `undefined` means the client didn't send refs (older Desktop builds,
  // chunked/partial payloads) — leave existing links untouched. An explicit
  // empty array means "this session references nothing", so stale links must
  // be removed below.
  if (artifactRefs === undefined) {
    return;
  }

  const merged = mergeArtifactRefsBySlug(artifactRefs);
  const unresolvedRefs: string[] = [];
  const resolvedTargetIds = new Set<string>();

  for (const slug of merged.keys()) {
    const resolvedId = slugMap.get(slug);
    if (!resolvedId) {
      unresolvedRefs.push(slug);
      continue;
    }
    if (resolvedId === sessionArtifactId) {
      continue;
    }
    resolvedTargetIds.add(resolvedId);
  }

  // Replacement semantics: drop any existing session→artifact links whose
  // target is no longer referenced (covers the empty-array case, which deletes
  // them all). Scoped to RELATES_TO edges from this session — the only kind
  // persistArtifactLinks creates.
  await tx.artifactLink.deleteMany({
    where: {
      organizationId,
      sourceId: sessionArtifactId,
      linkType: LinkType.RelatesTo,
      ...(resolvedTargetIds.size > 0
        ? { targetId: { notIn: [...resolvedTargetIds] } }
        : {}),
    },
  });

  for (const [slug, ref] of merged) {
    const resolvedId = slugMap.get(slug);
    if (!resolvedId) {
      continue;
    }

    // Skip self-links (session referencing itself)
    if (resolvedId === sessionArtifactId) {
      continue;
    }

    const existing = await tx.artifactLink.findFirst({
      where: {
        sourceId: sessionArtifactId,
        targetId: resolvedId,
        linkType: LinkType.RelatesTo,
      },
      select: { id: true },
    });

    if (!existing) {
      try {
        await tx.artifactLink.create({
          data: {
            organizationId,
            sourceId: sessionArtifactId,
            targetId: resolvedId,
            linkType: LinkType.RelatesTo,
            metadata: {
              role: ref.role,
              method: ref.method,
              isPrimary: ref.isPrimary,
            },
          },
        });
      } catch (e: unknown) {
        // P2002: unique constraint violation from concurrent sync — swallow
        if (getPrismaErrorCode(e) === "P2002") {
          /* swallow */
        } else {
          throw e;
        }
      }
    }
  }

  // Persist unresolved slugs in session metadata for debugging/future resolution
  if (unresolvedRefs.length > 0) {
    const detail = await tx.sessionDetail.findUnique({
      where: { artifactId: sessionArtifactId },
      select: { metadata: true },
    });
    const currentMetadata = parseJsonObject(detail?.metadata) ?? {};
    const existingUnresolved = Array.isArray(
      currentMetadata._unresolvedArtifactRefs
    )
      ? (currentMetadata._unresolvedArtifactRefs as string[])
      : [];
    const mergedUnresolved = [
      ...new Set([...existingUnresolved, ...unresolvedRefs]),
    ];
    await tx.sessionDetail.update({
      where: { artifactId: sessionArtifactId },
      data: {
        metadata: {
          ...currentMetadata,
          _unresolvedArtifactRefs: mergedUnresolved,
        },
      },
    });
  }
}

/**
 * Create or update SessionPullRequestLink rows for PR references extracted
 * from a session. Best-effort resolution of PullRequestDetail for richer
 * joins when the GitHub installation + repository exist.
 */
/**
 * Resolve all installation repos referenced by `prRefs` in a single query,
 * keyed by `fullName`. Returns an empty map when there is no installation.
 */
async function resolveRepoIdsByFullName(
  tx: AgentSessionUpsertTx,
  installationId: string | undefined,
  prRefs: SyncedSessionPrRef[]
): Promise<Map<string, string>> {
  const repoIdByFullName = new Map<string, string>();
  if (installationId === undefined) {
    return repoIdByFullName;
  }
  const distinctRepoFullNames = Array.from(
    new Set(prRefs.map((ref) => ref.repositoryFullName))
  );
  const repos = await tx.gitHubInstallationRepository.findMany({
    where: {
      installationId,
      fullName: { in: distinctRepoFullNames },
    },
    select: { id: true, fullName: true },
  });
  for (const repo of repos) {
    repoIdByFullName.set(repo.fullName, repo.id);
  }
  return repoIdByFullName;
}

/**
 * Resolve all current/verified PullRequestDetail rows for the resolved
 * (repositoryId, number) pairs in a single query, keyed by
 * `${repositoryId}:${number}`. Preserves the `isCurrent`/`lastVerifiedAt`
 * predicates from the original per-ref `findFirst`.
 */
async function resolvePrDetailIdsByRepoAndNumber(
  tx: AgentSessionUpsertTx,
  repoIdByFullName: Map<string, string>,
  prRefs: SyncedSessionPrRef[]
): Promise<Map<string, string>> {
  const prDetailIdByRepoAndNumber = new Map<string, string>();
  const resolvedPairs = prRefs
    .map((ref) => {
      const repositoryId = repoIdByFullName.get(ref.repositoryFullName);
      return repositoryId === undefined
        ? null
        : { repositoryId, number: ref.prNumber };
    })
    .filter((pair): pair is { repositoryId: string; number: number } =>
      Boolean(pair)
    );
  if (resolvedPairs.length === 0) {
    return prDetailIdByRepoAndNumber;
  }
  const prDetails = await tx.pullRequestDetail.findMany({
    where: {
      isCurrent: true,
      lastVerifiedAt: { not: null },
      OR: resolvedPairs.map((pair) => ({
        repositoryId: pair.repositoryId,
        number: pair.number,
      })),
    },
    select: { id: true, repositoryId: true, number: true },
  });
  for (const prDetail of prDetails) {
    prDetailIdByRepoAndNumber.set(
      `${prDetail.repositoryId}:${prDetail.number}`,
      prDetail.id
    );
  }
  return prDetailIdByRepoAndNumber;
}

async function persistSessionPrLinks(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  sessionArtifactId: string,
  prRefs: SyncedSessionPrRef[] | undefined
): Promise<void> {
  if (prRefs === undefined) {
    return;
  }

  const activeKeys = new Set(
    prRefs.map(
      (ref) => `${ref.repositoryFullName}#${ref.prNumber}#${ref.relationType}`
    )
  );

  await tx.sessionPullRequestLink.deleteMany({
    where: {
      organizationId,
      sessionArtifactId,
      source: SessionPrLinkSource.Deterministic,
      ...(activeKeys.size > 0
        ? {
            NOT: prRefs.map((ref) => ({
              repositoryFullName: ref.repositoryFullName,
              prNumber: ref.prNumber,
              relationType: ref.relationType,
            })),
          }
        : {}),
    },
  });

  if (prRefs.length === 0) {
    return;
  }

  // Cache installation lookup — same for all PR refs in a session
  const installation = await tx.gitHubInstallation.findFirst({
    where: { organizationId },
    select: { id: true },
  });

  // Hoist per-ref reads out of the loop to avoid N+1 round-trips on `tx`.
  const repoIdByFullName = await resolveRepoIdsByFullName(
    tx,
    installation?.id,
    prRefs
  );
  const prDetailIdByRepoAndNumber = await resolvePrDetailIdsByRepoAndNumber(
    tx,
    repoIdByFullName,
    prRefs
  );

  for (const prRef of prRefs) {
    // Best-effort PullRequestDetail resolution (reads hoisted above)
    let pullRequestDetailId: string | null = null;
    if (installation) {
      const repositoryId = repoIdByFullName.get(prRef.repositoryFullName);
      if (repositoryId !== undefined) {
        pullRequestDetailId =
          prDetailIdByRepoAndNumber.get(`${repositoryId}:${prRef.prNumber}`) ??
          null;
      }
    }

    // Derive prUrl server-side from the validated repo/number rather than
    // trusting the client-supplied value, which could point anywhere.
    const prUrl = `https://github.com/${prRef.repositoryFullName}/pull/${prRef.prNumber}`;

    try {
      await tx.sessionPullRequestLink.upsert({
        where: {
          sessionArtifactId_repositoryFullName_prNumber_relationType: {
            sessionArtifactId,
            repositoryFullName: prRef.repositoryFullName,
            prNumber: prRef.prNumber,
            relationType: prRef.relationType,
          },
        },
        create: {
          organizationId,
          sessionArtifactId,
          repositoryFullName: prRef.repositoryFullName,
          prNumber: prRef.prNumber,
          prUrl,
          relationType: prRef.relationType,
          source: SessionPrLinkSource.Deterministic,
          confidence: 1.0,
          pullRequestDetailId,
          extractorVersion: 1,
        },
        update: {
          prUrl,
          pullRequestDetailId,
          extractorVersion: 1,
        },
      });
    } catch (e: unknown) {
      // P2002: unique constraint violation from concurrent sync — swallow
      if (getPrismaErrorCode(e) === "P2002") {
        /* swallow */
      } else {
        throw e;
      }
    }
  }
}
