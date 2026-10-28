import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import {
  AgentSessionListCapability,
  type AgentSessionListPageInfo,
} from "@repo/api/src/types/agent-session-list-contract";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import type { Prisma } from "@repo/database";
// The generated namespace, NOT the `@repo/database` barrel: every suite that
// consumes this harness mocks the barrel, and that mock carries no `Decimal`.
import { Decimal } from "@repo/database/generated/internal/prismaNamespace";
import type { Mock } from "vitest";
import { vi } from "vitest";
import type {
  AnalyticsProjectAssignmentRecord,
  AnalyticsProjectSummaryRecord,
  AnalyticsSessionRecord,
} from "@/app/agent-sessions/service/records";
import { mocks } from "./service.test-mocks";

/**
 * ISS-9555: the page echo a default `findSessions` call now returns — the first
 * page at `SESSION_LIST_DEFAULT_LIMIT`.
 *
 * Shared so the whole-response assertions in this directory state one expected
 * envelope rather than each restating the same literal.
 */
export const DEFAULT_LIST_PAGE_ECHO: AgentSessionListPageInfo = {
  capability: AgentSessionListCapability.ServerPaginationV1,
  limit: 25,
  offset: 0,
};

export const SESSION_STARTED_AT = new Date("2026-05-20T17:00:00.000Z");
export const SESSION_UPDATED_AT = new Date("2026-05-20T17:05:00.000Z");

export function installDb(db: Record<string, unknown>) {
  const {
    artifact: artifactOverride,
    artifactLink: artifactLinkOverride,
    branchMaterializationRetry: branchMaterializationRetryOverride,
    computeTarget: computeTargetOverride,
    project: projectOverride,
    publicRepository: publicRepositoryOverride,
    sessionDetail: sessionDetailOverride,
    ...dbWithoutDefaults
  } = db;
  // ISS-5355: getUsageSummary now also reads the Project facet options
  // (`buildProjectFacetOptions`), which reads the session population
  // (`artifact.findMany`) and then counts it per project in one `$queryRaw`
  // (ISS-11895). Both default to no rows so every pre-existing usage-summary
  // test resolves with an empty Project facet instead of tripping on an
  // unmocked model; a test that exercises the facet overrides
  // `artifact`/`$queryRaw`.
  const artifactDefaults = {
    groupBy: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    findMany: vi.fn().mockResolvedValue([]),
  };
  const projectDefaults = {
    findMany: vi.fn().mockResolvedValue([]),
  };
  const artifactLinkDefaults = {
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
  };
  const computeTargetDefaults = {
    findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
    update: vi.fn().mockResolvedValue({ id: "target-1" }),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const dbWithDefaults = {
    $executeRaw: vi.fn(),
    // FEA-2913 + ISS-4439: persistSessionChildren recomputes the tool-use/error
    // counts and the MAX(event_created_at) activity timestamp in one
    // conditional-aggregation query, then persists them via a raw UPDATE ...
    // RETURNING. Default both calls to a zero-count / no-activity row so the
    // upsert path resolves without each test wiring the raw calls.
    $queryRawUnsafe: vi
      .fn()
      .mockResolvedValue([
        { toolUseCount: 0n, errorCount: 0n, maxEventCreatedAt: null },
      ]),
    // findSessionDetail enriches with the per-file transcript availability
    // summary (PLN-1289); default to no rows unless a test overrides it.
    sessionTranscript: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // ISS-6028: the delivery summary reads its merged PRs from the PR side
    // (`findMergedPrsLinkedToSessions`) once the session→PR-link probe passes.
    // Default to no merged PRs so a test that wires a truthy probe for another
    // reason (e.g. the attribution lenses) resolves with null delivery cards
    // instead of tripping on an unmocked model; a delivery test overrides it.
    pullRequestDetail: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // ISS-7176: findSessions/listByArtifactIds read `estimatedCost` straight off
    // the record now — no per-event reconciliation, no `$queryRaw` call on this
    // path. This default stays wired at `[]` only because component-invocations
    // also uses `$queryRaw` for its own purpose; a test exercising THAT must
    // scope its mock (e.g. branch on the SQL / call order).
    $queryRaw: vi.fn().mockResolvedValue([]),
    // FEA-4022: upsertSessions reads the org's calculateSessionFrustration gate
    // before the transaction (via frustrationSettingService → withDb →
    // organization.findUnique). Default to no settings (gate off) so existing
    // sync tests need no wiring; a test that exercises the opted-in path
    // overrides `organization`.
    organization: {
      findUnique: vi.fn().mockResolvedValue({ settings: null }),
    },
    // FEA-4204: findSessions batches the page's trace-comment thread counts in
    // ONE `commentThread.groupBy`. Default to no groups so every existing list
    // test resolves with a computed zero per row rather than tripping on an
    // unmocked model; a test that exercises the count overrides `commentThread`.
    commentThread: {
      groupBy: vi.fn().mockResolvedValue([]),
    },
    customFieldValue: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // PLN-2061 M5: findSessionDetail reads the session's retained
    // monitored-activity rows; default to none.
    artifactActivityEvent: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    ...dbWithoutDefaults,
    // ISS-10629: the fabricated `SessionDetail` `FieldRef` stand-ins this used to
    // merge in went with `buildStatusFacetPredicate` — no `apps/api` predicate
    // emits a two-column comparison any more, so nothing reads `.fields` off
    // the delegate.
    sessionDetail: {
      ...withDerivedSessionDetailFindMany(
        sessionDetailOverride as Record<string, unknown> | undefined
      ),
    },
    artifactLink: {
      ...artifactLinkDefaults,
      ...((artifactLinkOverride as Record<string, unknown> | undefined) ?? {}),
    },
    computeTarget: {
      ...computeTargetDefaults,
      ...((computeTargetOverride as Record<string, unknown> | undefined) ?? {}),
    },
    artifact: {
      ...artifactDefaults,
      ...((artifactOverride as Record<string, unknown> | undefined) ?? {}),
    },
    project: {
      ...projectDefaults,
      ...((projectOverride as Record<string, unknown> | undefined) ?? {}),
    },
    publicRepository: {
      findMany: vi.fn().mockResolvedValue([]),
      ...((publicRepositoryOverride as Record<string, unknown> | undefined) ??
        {}),
    },
    branchMaterializationRetry: {
      findMany: vi.fn().mockResolvedValue([]),
      ...((branchMaterializationRetryOverride as
        | Record<string, unknown>
        | undefined) ?? {}),
    },
    gitHubInstallationRepository: {
      findMany: vi.fn().mockResolvedValue([]),
      ...(((dbWithoutDefaults as Record<string, unknown>)
        .gitHubInstallationRepository as Record<string, unknown> | undefined) ??
        {}),
    },
  };
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
}

/**
 * ISS-9112: the session-detail read is now a `findMany` over an id SET, so a
 * suite that stands the stored row up as `sessionDetail.findFirst` — the shape
 * of the read it replaced — would otherwise hand the detail path an unmocked
 * delegate. Where a suite supplies `findFirst` and no `findMany` of its own, the
 * one is served from the other; the record the suite wrote is still the record
 * the projection sees. A suite that supplies its own `findMany` (the list path)
 * keeps it untouched.
 */
function withDerivedSessionDetailFindMany(
  override: Record<string, unknown> | undefined
): Record<string, unknown> {
  const provided = override ?? {};
  const findFirst = provided.findFirst;
  if (typeof findFirst !== "function" || provided.findMany) {
    return provided;
  }
  return {
    ...provided,
    findMany: vi.fn(async (args: unknown) => {
      const row = await (findFirst as (args: unknown) => unknown)(args);
      return row ? [row] : [];
    }),
  };
}

export function buildSyncedSession(
  overrides: Partial<SyncedAgentSession> = {}
) {
  return {
    externalSessionId: "sess-1",
    name: "Session One",
    status: "active",
    harness: "claude",
    cwd: "/tmp/worktree",
    model: "claude-sonnet-4",
    startedAt: SESSION_STARTED_AT.toISOString(),
    updatedAt: SESSION_UPDATED_AT.toISOString(),
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  };
}

/**
 * The session artifact id every harness upsert resolves to. ISS-8604 made this
 * load-bearing rather than decorative: `upsertSessionSlice` now compares the id
 * it reads back against `existing.artifactId` to learn which arm the DATABASE
 * took, so a stored-row stub that OMITS `artifactId` reads as a swept row and
 * drives the create-arm repair. A stub standing in for an ordinary resync must
 * carry this id — see `withPersistedSessionArtifactId`.
 */
export const PERSISTED_SESSION_ARTIFACT_ID = "persisted-session-1";

/**
 * ISS-12251: early enough that `lowerSessionCreatedAt` never has anything to
 * lower.
 */
const PERSISTED_SESSION_CREATED_AT = new Date("2015-01-01T00:00:00.000Z");

type PersistedSessionDetailReadBack = {
  artifactId: string;
  artifact: { createdAt: Date };
};

/**
 * ISS-12251: the row `sessionDetail.upsert` reads back under its `select`, plus
 * whatever columns a test echoes in `extra`.
 */
export function persistedSessionDetail(
  artifactId?: string
): PersistedSessionDetailReadBack;
export function persistedSessionDetail<Extra extends object>(
  artifactId: string,
  extra: Extra
): Extra & PersistedSessionDetailReadBack;
export function persistedSessionDetail(
  artifactId: string = PERSISTED_SESSION_ARTIFACT_ID,
  extra: object = {}
): PersistedSessionDetailReadBack {
  return {
    ...extra,
    artifactId,
    artifact: { createdAt: PERSISTED_SESSION_CREATED_AT },
  };
}

export function buildDefaultAgentSessionMocks(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> & { findUnique: Mock; upsert: Mock; update: Mock } {
  return {
    findUnique: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(persistedSessionDetail()),
    update: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

/**
 * A stored-row stub for the ORDINARY update arm: the same artifact id the
 * upsert resolves to, so the slice reads "the row I found is the row I wrote".
 * Spread over a suite's own columns rather than replacing them.
 */
export function withPersistedSessionArtifactId<T extends object>(
  storedRow: T
): T & { artifactId: string } {
  return { artifactId: PERSISTED_SESSION_ARTIFACT_ID, ...storedRow };
}

// generateSlug() allocates a SES-* slug via slugCounter.upsert inside the sync
// transaction when a session artifact is first created.
export function buildSlugCounterMock(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> & { upsert: Mock } {
  return {
    upsert: vi.fn().mockResolvedValue({ currentValue: 1 }),
    ...overrides,
  };
}

export function buildAgentSessionDbMock(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> & { findUnique: Mock; findMany: Mock } {
  return {
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    // ISS-6823: the analytics Repository breakdown is a `groupBy` now, so every
    // `getAnalytics` mock needs one. Defaulted to no groups (an empty
    // breakdown) so a suite that is not about repositories need not state it.
    groupBy: vi.fn().mockResolvedValue([]),
    // ISS-7705: the usage summary probes LOC/$ coverage with `sessionDetail.count`
    // once its delivery scope has merged PRs. Defaulted to 0 — an empty numerator
    // cohort, which folds to `complete` — so a suite that is not about coverage is
    // unaffected and none of them has to learn a new model. A suite that IS about
    // coverage overrides it.
    count: vi.fn().mockResolvedValue(0),
    ...withDerivedSessionDetailFindMany(overrides),
  };
}

/**
 * One `sessionDetail.groupBy(["repositoryFullName"])` row, in the shape Prisma
 * returns it — the analytics Repository breakdown's only input (ISS-6823).
 */
export function buildRepositoryGroupRow(input: {
  repositoryFullName: string | null;
  sessionCount: number;
  inputTokens: number | bigint;
  outputTokens: number | bigint;
  estimatedCost: number;
  errorCount?: number | null;
}) {
  return {
    repositoryFullName: input.repositoryFullName,
    _count: { _all: input.sessionCount },
    _sum: {
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      estimatedCost: input.estimatedCost,
      // Omission defaults, an explicit `null` PASSES THROUGH: coercing here
      // would swallow the null before `buildUsageByRepository`'s own
      // `_sum.errorCount ?? 0` ever saw it, leaving the null case green with
      // that guard deleted.
      errorCount: input.errorCount === undefined ? 0 : input.errorCount,
    },
  };
}

export function buildAttributionLensRecord(input: {
  artifactId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
  branches: unknown[];
}) {
  return {
    artifactId: input.artifactId,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheWriteTokens: input.cacheWriteTokens,
    estimatedCost: input.estimatedCost,
    artifact: {
      organizationId: "org-1",
      sourceLinks: input.branches,
    },
  };
}

type AttributionFixtureLink = {
  metadata: unknown;
  targetId: string;
  target: Record<string, unknown>;
};

/**
 * Wires the three reads `readSessionAttributionRecords` issues (ISS-7655) from
 * records built by {@link buildAttributionLensRecord}, so a test still states
 * its attribution fixture once, in the shape the fold consumes.
 *
 * `artifactLink.findMany` is shared with two other readers in this flow: the
 * branch artifact-usage read (`sourceId`) and the delivery merged-PR read
 * (`targetId` + `metadata`). Only the attribution read selects `sourceId` AND
 * `metadata`, so the mock keys on both — `metadata` alone would also match the
 * delivery read and hand it the wrong rows. Every other caller gets
 * `otherLinks`, so a param-blind mock cannot make an assertion about one reader
 * pass on another reader's rows. `artifact.findMany` is likewise shared with
 * the Project facet's population read (`where.session`, ISS-11895), which gets
 * no rows rather than the attribution targets.
 */
export function attributionReadMocks(
  records: ReturnType<typeof buildAttributionLensRecord>[],
  otherLinks: readonly unknown[] = []
): {
  artifactLinkFindMany: Mock;
  artifactFindMany: Mock;
  sessionDetailFindMany: Mock;
} {
  const links: unknown[] = [];
  const targets = new Map<string, unknown>();
  for (const record of records) {
    for (const link of record.artifact
      .sourceLinks as AttributionFixtureLink[]) {
      links.push({
        sourceId: record.artifactId,
        targetId: link.targetId,
        metadata: link.metadata,
      });
      targets.set(link.targetId, { id: link.targetId, ...link.target });
    }
  }
  return {
    artifactLinkFindMany: vi.fn((args?: { select?: Record<string, unknown> }) =>
      Promise.resolve(
        args?.select?.metadata === true && args?.select?.sourceId === true
          ? links
          : [...otherLinks]
      )
    ),
    artifactFindMany: vi.fn((args?: { where?: { session?: unknown } }) =>
      Promise.resolve(args?.where?.session ? [] : [...targets.values()])
    ),
    sessionDetailFindMany: vi.fn().mockResolvedValue(
      records.map(({ artifact, ...scalars }) => ({
        ...scalars,
        artifact: { organizationId: artifact.organizationId },
      }))
    ),
  };
}

export function trustedBranch(
  targetId: string,
  branchName: string,
  prNumber: number,
  // FEA-4378: optional per-PR LOC carried on the verified detail so the
  // authored-PR KLOC roll-up can be exercised. Absent → the columns are null,
  // matching a PR whose additions/deletions were never fetched from GitHub.
  loc?: { additions: number; deletions: number }
) {
  return {
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [SessionPrRelationType.Created],
      confidence: 1,
    },
    targetId,
    target: {
      organizationId: "org-1",
      branch: {
        branchName,
        repository: { fullName: "closedloop-ai/closedloop-ai" },
        currentPullRequestDetail: {
          number: prNumber,
          title: `PR ${prNumber}`,
          isCurrent: true,
          lastVerifiedAt: new Date("2026-03-01T12:00:00.000Z"),
          repository: { fullName: "closedloop-ai/closedloop-ai" },
          additions: loc?.additions ?? null,
          deletions: loc?.deletions ?? null,
        },
      },
    },
  };
}

export function staleBranch(
  targetId: string,
  branchName: string,
  prNumber: number
) {
  const branch = trustedBranch(targetId, branchName, prNumber);
  return {
    ...branch,
    target: {
      organizationId: branch.target.organizationId,
      branch: {
        ...branch.target.branch,
        currentPullRequestDetail: {
          ...branch.target.branch.currentPullRequestDetail,
          lastVerifiedAt: null,
        },
      },
    },
  };
}

export function referencedBranch(
  targetId: string,
  branchName: string,
  prNumber: number
) {
  return {
    ...trustedBranch(targetId, branchName, prNumber),
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [SessionPrRelationType.Referenced],
      confidence: 1,
    },
  };
}

export function lowConfidenceBranch(
  targetId: string,
  branchName: string,
  prNumber: number
) {
  return {
    ...trustedBranch(targetId, branchName, prNumber),
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [SessionPrRelationType.Created],
      confidence: 0.25,
    },
  };
}

export function buildDefaultAgentSessionEventMocks(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> & { count: Mock } {
  return {
    count: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

/**
 * ISS-6912: the WIRE agent shape, which is also the persisted one — `agents` is
 * a genuine JSON column, so unlike {@link buildPersistedEvent} there is no row
 * type to pin this to. Typed as `Prisma.JsonObject` rather than
 * `Record<string, unknown>` so it is assignable to the column it stands in for.
 */
export function buildPersistedAgent(
  overrides: Prisma.JsonObject = {}
): Prisma.JsonObject {
  return {
    externalAgentId: "agent-1",
    name: "Existing agent",
    type: "main",
    status: "active",
    subagentType: null,
    currentTool: null,
    startedAt: SESSION_STARTED_AT.toISOString(),
    updatedAt: SESSION_UPDATED_AT.toISOString(),
    endedAt: null,
    awaitingInputSince: null,
    parentExternalAgentId: null,
    metadata: null,
    ...overrides,
  };
}

/**
 * ISS-6912: one row of `agent_session_events` AS PRISMA RETURNS IT.
 *
 * The return type is pinned to the analytics select's own event element rather
 * than `Record<string, unknown>` on purpose. This builder previously emitted the
 * DESKTOP WIRE shape — an ISO-string `createdAt`, no `eventCreatedAt`, plus the
 * `summary`/`data` keys FEA-2718 dropped from both the wire and the DB — which
 * no longer resembles a persisted row and had not since
 * `20260526000000_normalize_agent_session_events` normalized the JSON blob into
 * this relation. Every consumer of the analytics fold was therefore handed a
 * shape the database cannot produce, so the fold's own bug (a wire-schema parse
 * that rejected every real row and served an empty breakdown) stayed green.
 *
 * Keeping the Prisma-derived annotation is the guard: a column rename or a type
 * change now fails `tsc` in this file instead of quietly re-widening the gap
 * between what the tests feed and what production reads.
 */
export function buildPersistedEvent(
  overrides: Partial<AnalyticsSessionRecord["events"][number]> = {}
): AnalyticsSessionRecord["events"][number] {
  return {
    id: "00000000-0000-7000-8000-000000000001",
    agentSessionId: "00000000-0000-7000-8000-00000000000a",
    externalEventId: "event-1",
    agentExternalId: "agent-1",
    eventType: "tool_use",
    toolName: "Read",
    eventCreatedAt: SESSION_STARTED_AT,
    createdAt: SESSION_STARTED_AT,
    ...overrides,
  };
}

export function buildSessionListRecord(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    artifactId: "session-1",
    externalSessionId: "external-session-1",
    harness: "claude",
    cwd: "/tmp/worktree",
    repositoryFullName: "closedloop-ai/closedloop-ai",
    worktreePath: "/tmp/worktree",
    model: "claude-sonnet-4",
    sessionStartedAt: SESSION_STARTED_AT,
    sessionUpdatedAt: SESSION_UPDATED_AT,
    sessionEndedAt: new Date("2026-05-20T17:10:00.000Z"),
    awaitingInputSince: null,
    lastSyncedAt: SESSION_UPDATED_AT,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 1.25,
    billingMode: null,
    agentCount: 2,
    toolUseCount: 3,
    errorCount: 0,
    baseBranch: "main",
    sourceArtifactId: null,
    sourceLoopId: null,
    computeTarget: {
      id: "target-1",
      machineName: "Ada's MacBook Pro",
      isOnline: true,
      lastSeenAt: SESSION_UPDATED_AT,
      lastAgentSessionSyncAt: SESSION_UPDATED_AT,
      // ISS-4827: the ACCEPTED-sync watermark, distinct from the landed-data one
      // above. Equal by default so a fixture that does not care about the split
      // reads the same either way; the ISS-4828 projection tests pin them apart.
      lastAgentSessionSyncAttemptAt: SESSION_UPDATED_AT,
    },
    // Hoisted fields now live on the parent artifact (FEA-1699).
    artifact: {
      // Org SSOT the by-id session read asserts against (FEA-2734); the detail
      // resolver runs resolveOrgScopeVia() over this before returning.
      organizationId: "org-1",
      name: "Session One",
      status: "completed",
      slug: "SES-1",
      project: {
        id: "project-1",
        name: "Agent Platform",
        slug: "agent-platform",
      },
      sourceLinks: [],
    },
    ...overrides,
  };
}

export function buildSessionDetailRecord(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ...buildSessionListRecord(),
    origin: "DESKTOP_SYNC",
    state: null,
    branch: null,
    pullRequests: null,
    wallClock: null,
    activeAgent: null,
    waitingUser: null,
    linesAdded: null,
    linesRemoved: null,
    filesChanged: null,
    turns: null,
    steeringEpisodes: null,
    autonomy: null,
    activityBuckets: null,
    sessionSpan: null,
    markers: null,
    throttles: null,
    phases: null,
    phaseIterations: null,
    phaseLoopbacks: null,
    metadata: null,
    tokenUsageByModel: [],
    agents: [],
    events: [],
    tracePhaseSources: null,
    throttleSources: null,
    correctionSources: null,
    // Always an array in the real Prisma payload (a to-many relation select).
    tokenEvents: [],
    ...overrides,
  };
}

export function buildSourceArtifactRecord(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "0196f2df-5b7d-7e72-9e4c-8d8af9fba001",
    name: "Agent Platform PRD",
    slug: "agent-platform-prd",
    type: ArtifactType.Document,
    subtype: DocumentType.Prd,
    ...overrides,
  };
}

/**
 * ISS-9113: one `artifact.findMany` row from the Project breakdown's group-key
 * read — an ARTIFACT id and the project it parents to, which is all that read
 * selects now.
 */
export function buildAnalyticsProjectAssignmentRecord(
  index: number,
  projectId: string | null = "project-1"
): AnalyticsProjectAssignmentRecord {
  return { id: `session-${index}`, projectId };
}

/** ISS-9113: one `project.findMany` row backing {@link buildAnalyticsProjectAssignmentRecord}. */
export function buildAnalyticsProjectSummaryRecord(
  overrides: Partial<AnalyticsProjectSummaryRecord> = {}
): AnalyticsProjectSummaryRecord {
  return {
    id: "project-1",
    name: "Agent Platform",
    slug: "agent-platform",
    ...overrides,
  };
}

/**
 * ISS-6912: typed for the same reason as {@link buildPersistedEvent}.
 *
 * ISS-9113: carries the token columns too — analytics reads ONE session
 * projection now, so there is one builder rather than a JSON-shaped and a
 * project-shaped pair.
 */
export function buildAnalyticsSessionRecord(
  index: number,
  // `estimatedCost` widens to `number` so a suite can state a cost without
  // reaching for the Decimal constructor; the record still carries the real
  // Decimal the column produces, so `toNumber` is exercised on its actual input.
  overrides: Partial<Omit<AnalyticsSessionRecord, "estimatedCost">> & {
    estimatedCost?: number | Decimal | null;
  } = {}
): AnalyticsSessionRecord {
  const { estimatedCost, ...rest } = overrides;
  return {
    artifactId: `session-${index}`,
    agents: [],
    events: [],
    inputTokens: 0n,
    outputTokens: 0n,
    ...rest,
    estimatedCost:
      typeof estimatedCost === "number"
        ? new Decimal(estimatedCost)
        : (estimatedCost ?? null),
  };
}
