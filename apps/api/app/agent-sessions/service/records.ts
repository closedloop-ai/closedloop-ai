import { MAX_STORED_ACTIVITY_SEGMENTS } from "@repo/api/src/types/agent-session";
import { SESSION_DETAIL_EVENT_MAX_ROWS } from "@repo/api/src/types/agent-session-detail-limits";
import { SESSION_TOKEN_EVENT_MAX_ROWS } from "@repo/api/src/types/agent-session-token-event-limits";
import { LinkType } from "@repo/api/src/types/artifact";
import type { ArtifactTagPermissions } from "@repo/api/src/types/tag";
import type { BasicUser } from "@repo/api/src/types/user";
import {
  ArtifactType,
  type Prisma,
  type TransactionClient,
} from "@repo/database";
import {
  artifactTagsSelect,
  artifactTagsSelectForOrganization,
} from "@/app/tags/artifact-tag-projection";
import { basicUserSelect } from "@/lib/db-utils";
import {
  SessionPrLinkAudience,
  sessionPrLinkKindWhere,
} from "@/lib/session-pr-links";
import type {
  AgentSessionListQuery,
  AgentSessionUsageQuery,
} from "../validators";

// The detail select's alias of the shared per-session token-event ceiling
// (`@repo/api/src/types/agent-session-token-event-limits`, ISS-9857): one owner,
// so the nested `tokenEvents` take below and the raw stream read in
// `session-usage-reads.ts` cannot drift to different bounds. Kept under this
// name because the source-gate allowlist fingerprint
// `nested-take:SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS` is keyed on the identifier.
// Defensive, not a functional page size: it stops a single pathological session
// (or the branch merged trace's per-session fan-out) from materializing an
// unbounded row set into the detail projection.
export const SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS = SESSION_TOKEN_EVENT_MAX_ROWS;

const computeTargetSummarySelect = {
  select: {
    id: true,
    machineName: true,
    isOnline: true,
    lastSeenAt: true,
    // FEA-3479 (PRD-536 G1): per-target last INGEST (when session rows from this
    // target last LANDED), so list/detail rows can show target-level freshness
    // (previously only on the usage summary's lastSyncTargets).
    lastAgentSessionSyncAt: true,
    // ISS-4827/ISS-4828: per-target last ACCEPTED sync — advanced by every
    // accepted batch, including one carrying no new sessions. The honest
    // "synced Xs ago" companion to the landed-data watermark above.
    lastAgentSessionSyncAttemptAt: true,
  },
} as const;

const projectSummarySelect = {
  select: {
    id: true,
    name: true,
    slug: true,
  },
} as const;

export const sourceArtifactSummarySelect = {
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
    // Org SSOT (PRD-510 FR13) — selected so the by-id session read can run
    // resolveOrgScopeVia() against the session's parent Artifact (D4: the session
    // child tables are join-reached, so org is validated via the artifact here).
    organizationId: true,
    name: true,
    status: true,
    priority: true,
    // ISS-12251 D-1: the session's Owner. On the list select, not only the
    // detail one: the Sessions grid's Owner column is a list cell.
    assignee: basicUserSelect,
    // ISS-6005: the parent row's `@updatedAt` — the other half of
    // `recordUpdatedAt` (status folds, and future comment/tag writes, mutate
    // THIS row rather than the session_detail row).
    updatedAt: true,
    slug: true,
    project: projectSummarySelect,
    // ISS-8712: the org tag vocabulary applied to this Session artifact, joined
    // on the page's own SELECT rather than batched in a second query — the same
    // shape the Branch read uses, and the reason it can be: `TagArtifact` hangs
    // off the Artifact row this select already loads, so it costs no extra
    // round trip and cannot be an N+1. The relation is org-scoped again in the
    // projection as defense in depth.
    tagArtifacts: artifactTagsSelect,
    sourceLinks: {
      // Three projection lanes ride this single relation (Prisma has one
      // `sourceLinks` relation, so it can't be selected twice):
      //   1. session_pr links (linkKind=session_pr) → toSessionPullRequestProjection
      //   2. FEA-3635 session→Closedloop-artifact links → toLinkedArtifactProjection.
      //      slug-links.ts persists these as RELATES_TO edges to a DOCUMENT-typed
      //      target with `{role, method, isPrimary}` metadata (no `linkKind`).
      //   3. FEA-4256 session_branch links → deriveTouchedBranchLink, so the
      //      session detail can link its Branch chip to the session's own branch
      //      detail page. branch-links.ts persists these as RELATES_TO edges to a
      //      BRANCH-typed target; a session that authored a branch but no PR has
      //      only this lane, so the OR must include BRANCH targets (not just the
      //      session_pr/DOCUMENT lanes) or the branch id would be unresolvable.
      // The OR keeps this select scoped to the three lanes, and each projection
      // filters to its own lane by linkKind/target type.
      where: {
        linkType: LinkType.RelatesTo,
        OR: [
          // ISS-5823 Evidence: the session-detail edge carries the links
          // themselves, so prose-derived rows are selected here. Every
          // projection over them gates on its own purpose — see
          // `toSessionPullRequestProjection`, which excludes them explicitly.
          sessionPrLinkKindWhere(SessionPrLinkAudience.Evidence),
          { target: { is: { type: ArtifactType.DOCUMENT } } },
          { target: { is: { type: ArtifactType.BRANCH } } },
        ],
      },
      orderBy: { createdAt: "asc" as const },
      select: {
        metadata: true,
        // FEA-4256: prefer the branch the session actually WROTE when picking
        // which linked branch the detail's Branch chip links to.
        branchParticipation: true,
        target: {
          select: {
            id: true,
            name: true,
            slug: true,
            type: true,
            subtype: true,
            branch: {
              select: {
                repository: {
                  select: {
                    fullName: true,
                  },
                },
                currentPullRequestDetail: {
                  select: {
                    number: true,
                    title: true,
                    prState: true,
                    closedAt: true,
                    mergedAt: true,
                    lastVerifiedAt: true,
                    // FEA-4317 (whitlockk review): the PR-opened timestamp, set only
                    // by a producer that actually OBSERVED the PR's lifecycle
                    // (webhook / `gh` fetch / App backfill). A desktop bare-ref
                    // row (`git_push`/`gh_pr_create` with no `gh pr view`) keeps
                    // the Prisma `prState @default(OPEN)` yet still gets a
                    // `lastVerifiedAt`, so it must NOT launder an Unknown session
                    // PR into Open — the historical/verified pass requires a real
                    // lifecycle signal (terminal timestamp OR githubCreatedAt).
                    githubCreatedAt: true,
                    isCurrent: true,
                    // FEA-4378: per-PR LOC delivered, summed across the session's
                    // AUTHORED PRs into the KLOC numerator so a multi-PR session
                    // whose local working-tree diff is a tiny residual (branches
                    // merged/reset) still reads its real delivered code.
                    additions: true,
                    deletions: true,
                    // FEA-2732: producer-independent repo identity, present on
                    // repo-less (non-App) PRs where `repository` is null.
                    repositoryFullName: true,
                    repository: {
                      select: {
                        fullName: true,
                      },
                    },
                  },
                },
              },
            },
            // FEA-4378 (codex P2) / FEA-4317: the branch Artifact's FULL PR-detail
            // set, not just the one flagged `isCurrent`
            // (`branch.currentPullRequestDetail`). When a session authors PR #2 from
            // the same branch that already held PR #1, the branch's
            // `currentPullRequestDetail` pointer moves to #2, so #1's LOC AND its
            // verified lifecycle (open/merged/closed) would be dropped if we read
            // only the current pointer. Resolving each linked PR number against this
            // per-branch historical set recovers #1's delivered code (FEA-4378) and
            // its verified merged status (FEA-4317). This is the Artifact-level
            // `BranchPullRequests` relation (the branch Artifact owns every PR raised
            // from it), scoped to the linked branch (a branch's PR count is small).
            // `mergedAuthoredPrLinesChanged` and the PR-status projection each dedup by PR
            // identity so a PR reachable via both the current pointer and this set
            // counts once. Lifecycle columns (title/prState/closedAt/mergedAt/
            // isCurrent) mirror `currentPullRequestDetail` so a historical PR's
            // status is verifiable from its own row.
            pullRequestDetails: {
              select: {
                number: true,
                title: true,
                prState: true,
                closedAt: true,
                mergedAt: true,
                isCurrent: true,
                lastVerifiedAt: true,
                // FEA-4317 (whitlockk review): lifecycle-observed signal — see the
                // parallel note on `currentPullRequestDetail.githubCreatedAt`.
                githubCreatedAt: true,
                additions: true,
                deletions: true,
                repositoryFullName: true,
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
} satisfies Prisma.ArtifactDefaultArgs;

// ISS-12197: the Artifact row's lifecycle fields for the Details tab, read on
// DETAIL only for the reason `dataSyncLevel` is: no list cell renders them, and
// `createdBy` is a user join the Sessions list would otherwise pay on every
// page (the Branch read makes the same call in `branch-read-selects.ts`). The
// creator is not the session's Owner, which is the assignee (ISS-12251 D-1).
const sessionArtifactOwnershipSelect = {
  createdAt: true,
  createdBy: basicUserSelect,
  dueDate: true,
} satisfies Prisma.ArtifactSelect;

const sessionArtifactDetailSummarySelect = {
  select: {
    ...sessionArtifactSummarySelect.select,
    ...sessionArtifactOwnershipSelect,
  },
} satisfies Prisma.ArtifactDefaultArgs;

export const agentSessionListSelect = {
  artifactId: true,
  // ISS-8717: read alongside `artifact.name` so `toSessionListItem` can prefer
  // the owner's rename over the collector's placeholder. Both the list and the
  // detail read go through that one projection.
  nameOverride: true,
  externalSessionId: true,
  harness: true,
  origin: true,
  cwd: true,
  repositoryFullName: true,
  worktreePath: true,
  model: true,
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
  // ISS-6005: the row's own DB-maintained mutation stamp (`@updatedAt`) —
  // together with `artifact.updatedAt` below it produces `recordUpdatedAt`,
  // the `Updated` column's value. NOT interchangeable with `sessionUpdatedAt`,
  // the harness-reported recompute time.
  updatedAt: true,
  lastActivityAt: true,
  sessionEndedAt: true,
  awaitingInputSince: true,
  // Selected but no longer read for display (ISS-12430). Same row as every
  // other column here, so it costs no additional read; dropping it from the
  // select and the record type is a separate, call-site-touching cleanup.
  endsWithError: true,
  // FEA-3479 (PRD-536 G1): cloud upsert freshness — written on every sync
  // (service.ts) but previously never selected/served. Feeds "synced Xs ago".
  lastSyncedAt: true,
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  estimatedCost: true,
  billingMode: true,
  agentCount: true,
  toolUseCount: true,
  componentInvocationCount: true,
  errorCount: true,
  baseBranch: true,
  sourceArtifactId: true,
  computeTarget: computeTargetSummarySelect,
  artifact: sessionArtifactSummarySelect,
} satisfies Prisma.SessionDetailSelect;

const agentSessionDetailSelectBase = {
  ...agentSessionListSelect,
  artifact: sessionArtifactDetailSummarySelect,
  metadata: true,
  // ISS-7516: the recording machine's data-sync level, read on DETAIL only. The
  // transcript panel that needs it is a detail surface, and adding a column to
  // the list select widens every Sessions-list read for a value no list cell
  // renders.
  dataSyncLevel: true,
  sourceArtifactId: true,
  // ISS-7229: Claude's own reported cost, read from the COLUMN on detail only.
  // The desktop's OTel sync writes it and this is the read that makes it
  // visible (davetho, #6406). Detail-only for the same reason `dataSyncLevel`
  // is: no list cell renders it.
  authoritativeCostUsd: true,
  tokenUsageByModel: {
    orderBy: {
      model: "asc",
    },
  },
  agents: true,
  // ISS-5075: bounded by SESSION_DETAIL_EVENT_MAX_ROWS (read one past — see the
  // constant) so opening a detail for a long-running session, or fanning the
  // branch merged trace across many sessions, can never materialize an unbounded
  // row set. Projected to the five columns the detail actually serves (mirroring
  // `tokenEvents` below) rather than the whole row, so the bounded read doesn't
  // also carry the parent id, the row id, and a per-row `createdAt` it discards.
  //
  // The deterministic ordering makes the served set a stable chronological PREFIX
  // when the bound is hit, and the projection flags it. Oldest-first is the right
  // half to keep: `timeline` and `turnItems` are derived from these rows and need
  // a coherent opening (a suffix would start mid-turn with dangling tool calls).
  events: {
    select: {
      externalEventId: true,
      agentExternalId: true,
      eventType: true,
      toolName: true,
      eventCreatedAt: true,
    },
    orderBy: [
      { eventCreatedAt: "asc" },
      { externalEventId: "asc" },
      { id: "asc" },
    ],
    take: SESSION_DETAIL_EVENT_MAX_ROWS + 1,
  },
  tracePhaseSources: true,
  throttleSources: true,
  correctionSources: true,
  // FEA-3461 (PRD-510 G1): per-event cost points feed the detail projection's
  // per-turn cost + cumulative-spend badges. FEA-2275 additionally bins these
  // events (by timestamp) into the activity-segment tiling to derive the
  // per-phase breakdown, so the four token-count components ride along too —
  // per-phase token counts (not just cost) are surfaced. Ordered for
  // determinism (the projection re-sorts by tMs regardless). Bounded by
  // SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS so opening a detail for a long-running,
  // keep-all-token-history session (incl. the branch merged trace, which
  // hydrates many sessions through findSessionDetail) can never materialize an
  // unbounded row set — the same owner-defined cap `readSessionTokenEvents`
  // applies to the raw per-event stream.
  tokenEvents: {
    select: {
      eventCreatedAt: true,
      estimatedCost: true,
      costCompleteness: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
    },
    orderBy: {
      eventCreatedAt: "asc",
    },
    take: SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS,
  },
} satisfies Prisma.SessionDetailSelect;

/**
 * FEA-3568: the detail select WITHOUT the activity-segment tiling. The branch
 * merged-trace fan-out (`buildBranchMergedTrace`) hydrates up to
 * MERGED_TRACE_MAX_SESSIONS sessions through `findSessionDetail` and never reads
 * `activitySegmentRows`, so it opts into this variant — dropping the (up to
 * MAX_STORED_ACTIVITY_SEGMENTS-per-session) relation from the query entirely
 * rather than fetching + BigInt/array-mapping thousands of rows only to discard
 * them. The single-session detail path uses the full select below.
 */
export const agentSessionDetailSelectWithoutActivitySegments =
  agentSessionDetailSelectBase;

export const agentSessionDetailSelect = {
  ...agentSessionDetailSelectBase,
  // FEA-3568: the raw activity-segment tiling replicated from the desktop. Read
  // for the detail projection so the web/desktop parity surfaces (FEA-2275/2276)
  // can derive per-phase attribution from it. Ordered by start for a stable,
  // tiling-order read. Org isolation is via the parent SessionDetail join (this
  // table carries no organizationId).
  //
  // ISS-4541 (P1 #4): bound the read at the STORED-tiling ceiling
  // (MAX_STORED_ACTIVITY_SEGMENTS, 50k), NOT the per-PAYLOAD wire cap
  // (MAX_SYNCED_ACTIVITY_SEGMENTS, 5k). Since the desktop now PAGINATES an
  // oversized tiling across chunks that merge additively cloud-side, a stored
  // tiling can legitimately exceed 5k; reading at 5k would silently clip a
  // chunked tiling. Read one past the ceiling (`+ 1`) so the caller can detect a
  // read that hit the bound and surface `activitySegmentRowsTruncated` (never a
  // silent undercount). The ceiling still bounds the materialized set so a
  // pathological session can't pull an unbounded relation.
  activitySegmentRows: {
    select: {
      phase: true,
      startMs: true,
      endMs: true,
      confidence: true,
      evidenceLayers: true,
      classifierVersion: true,
      workItemRef: true,
      subagentId: true,
    },
    orderBy: {
      startMs: "asc",
    },
    take: MAX_STORED_ACTIVITY_SEGMENTS + 1,
  },
  // ISS-10721: the 1:1 activity-metrics rollup. Absent (`null`) for every
  // session whose producer has never sent one — the read maps that to the
  // contract's unknown rather than to zeroes.
  activityMetrics: {
    select: {
      autonomyBand: true,
      coverage: true,
      spendLowConfUsd: true,
      spendMediumConfUsd: true,
      spendHighConfUsd: true,
      segmentCount: true,
      coveredSegmentCount: true,
      classifierVersion: true,
      metricVersion: true,
    },
  },
} satisfies Prisma.SessionDetailSelect;

export const agentSessionExportSelect = {
  sessionStartedAt: true,
  harness: true,
  model: true,
  deviceTimeZone: true,
  artifact: {
    select: {
      // ISS-12251 D-4: the export's per-user rows ("User" column, and that
      // user's teams) are the session's creator.
      createdBy: {
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

/**
 * ISS-9113: the ONE session projection `/agent-sessions/analytics` reads.
 *
 * ISS-6823 left two scans over overlapping scope: a project-parented scan
 * carrying the token columns, and a full-population scan carrying the JSON
 * columns. Every project-parented session satisfies both predicates, so it was
 * selected twice. The token columns are scalars on a row the JSON scan already
 * fetches, so folding them in here costs no extra statement and no extra row —
 * it deletes the second scan outright.
 *
 * `artifact.projectId` deliberately does NOT join here. Under Prisma 7 a nested
 * relation select is its own child statement per page (see `lib/db-fanout.ts`),
 * so joining it would trade one bounded scan for `ceil(population / batch)`
 * extra statements over the WHOLE population — a regression on the unparented
 * majority the Sessions lane actually writes. The parented rows are keyed
 * separately by {@link analyticsProjectAssignmentSelect}, in one statement.
 */
export const analyticsSessionSelect = {
  artifactId: true,
  agents: true,
  events: true,
  inputTokens: true,
  outputTokens: true,
  estimatedCost: true,
} satisfies Prisma.SessionDetailSelect;

/**
 * ISS-9113: which of the scanned sessions belong to a project, keyed by artifact
 * id. Two uuids per parented session and nothing else — the Project breakdown's
 * group key, read from the side that owns it.
 *
 * `project` is NOT nested. Prisma resolves a nested relation with an `IN` list
 * carrying one bind parameter PER PARENT ROW, so nesting it here would put the
 * parented population itself against the Postgres bind-parameter ceiling
 * (`lib/postgres-bind-parameters.ts`) once this read stopped being paged. The
 * distinct project ids are resolved separately, where the list is bounded by
 * the project count rather than by the session count.
 */
export const analyticsProjectAssignmentSelect = {
  id: true,
  projectId: true,
} satisfies Prisma.ArtifactSelect;

/**
 * The project columns the analytics Project breakdown renders — the SAME field
 * list `projectSummarySelect` already owns, unwrapped for a top-level
 * `project.findMany` rather than nested under a relation. Derived from it, not
 * restated: a column added there must reach this read too.
 */
export const analyticsProjectSummarySelect =
  projectSummarySelect.select satisfies Prisma.ProjectSelect;

export type AgentSessionListRecord = Prisma.SessionDetailGetPayload<{
  select: typeof agentSessionListSelect;
}>;

export type AgentSessionDetailRecord = Prisma.SessionDetailGetPayload<{
  select: typeof agentSessionDetailSelect;
}>;

export type AgentSessionExportRecord = Prisma.SessionDetailGetPayload<{
  select: typeof agentSessionExportSelect;
}>;

export type SourceArtifactSummaryRecord = Prisma.ArtifactGetPayload<{
  select: typeof sourceArtifactSummarySelect;
}>;

/** The ownership columns only the detail selects project. */
export type SessionArtifactOwnershipRecord = Prisma.ArtifactGetPayload<{
  select: typeof sessionArtifactOwnershipSelect;
}>;

export type AnalyticsSessionRecord = Prisma.SessionDetailGetPayload<{
  select: typeof analyticsSessionSelect;
}>;

export type AnalyticsProjectAssignmentRecord = Prisma.ArtifactGetPayload<{
  select: typeof analyticsProjectAssignmentSelect;
}>;

export type AnalyticsProjectSummaryRecord = Prisma.ProjectGetPayload<{
  select: typeof analyticsProjectSummarySelect;
}>;

export type AgentSessionUpsertTx = TransactionClient;

/**
 * Lineage-only project attribution for a synced session. A session parents to a
 * project ONLY through real lineage — the source artifact it was launched from.
 * There is deliberately no repository-derived map here:
 * a project nominating default repos for agentic execution does not make a repo
 * belong to a project (FEA-1749).
 */
export type SessionProjectResolution = {
  artifactProjectById: Map<string, string>;
};

export type AgentSessionScope = {
  organizationId: string;
  // FEA-3534: the authenticated viewer's user id, threaded from the route so
  // `viewerScope=self` (the dashboard "Me" scope) is enforced server-side —
  // `buildWhere` pins `createdById` to this value rather than trusting a client-sent
  // `userId`/`userIds` filter. Optional so internal callers that never request
  // self scope (and the org/team paths) can omit it.
  viewerId?: string;
};

export type SessionListInput = AgentSessionScope & {
  filters: AgentSessionListQuery;
  /** Authenticated browser identity for the existing status-root-order rollout. */
  clerkUserId?: string | null;
  /**
   * ISS-8712: the caller's artifact-tag capabilities, resolved from its auth
   * scopes by the route. OMITTED by internal callers that hold no auth context;
   * the rows then carry no tag keys at all, which is the honest answer for a
   * read that never established who is asking.
   */
  tagPermissions?: ArtifactTagPermissions;
};

export type SessionUsageInput = AgentSessionScope & {
  filters: AgentSessionUsageQuery;
};

/**
 * ISS-8554 Phase 3: the structural shape `usage-summary-sql.ts`'s window/facet
 * resolvers (`toWindow`, `toFacets`) actually read — every field they touch is
 * on `baseAgentSessionQueryShape` (`validators.ts`), which BOTH
 * `AgentSessionUsageQuery` and `AgentSessionListQuery` extend. Widened from
 * {@link SessionUsageInput} so the Phase 3 list-sort reader can build the SAME
 * 24-slot facet tuple the summary statements take, from the list's OWN query
 * type, without a second copy of that resolution.
 */
export type SessionFacetFilterInput = AgentSessionScope & {
  filters: AgentSessionUsageQuery | AgentSessionListQuery;
};

export type SessionDetailInput = AgentSessionScope & {
  id: string;
  /**
   * ISS-10995: same contract as {@link SessionListInput.tagPermissions} — the
   * caller's artifact-tag capabilities, resolved from its auth scopes by the
   * route. OMITTED by an internal caller that holds no auth context; the detail
   * then carries no tag keys at all.
   */
  tagPermissions?: ArtifactTagPermissions;
};

export type UpsertSessionsContext = {
  organizationId: string;
  userId: string;
  computeTargetId: string;
};

export type SessionTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
};

export type LastSyncTargetRecord = {
  id: string;
  machineName: string;
  isOnline: boolean;
  lastSeenAt: Date;
  lastAgentSessionSyncAt: Date | null;
  lastAgentSessionSyncAttemptAt: Date | null;
  user: BasicUser;
};

/**
 * The Sessions artifact sub-select with the tag join SCOPED IN SQL to the
 * reading organization.
 *
 * ISS-8712 (whitlockk / codex review): `TagArtifact` carries no same-org constraint
 * of its own, so a row joining ANOTHER tenant's `Tag` to this org's Artifact is
 * representable. `projectArtifactTags` drops such a row before serialization, so
 * nothing leaks to a client either way — but "loaded, then dropped in the
 * mapper" and "never left the database" are different claims, and the Branch
 * read (`branch-read-selects.ts`) has always made the stronger one. These
 * factories make the Sessions reads match it. The mapper's check stays exactly
 * where it is, as defense in depth.
 */
function sessionArtifactSummarySelectForOrganization(organizationId: string) {
  return {
    select: {
      ...sessionArtifactSummarySelect.select,
      tagArtifacts: artifactTagsSelectForOrganization(organizationId),
    },
  };
}

/** {@link agentSessionListSelect} with the org-scoped tag join. */
export function agentSessionListSelectForOrganization(organizationId: string) {
  return {
    ...agentSessionListSelect,
    artifact: sessionArtifactSummarySelectForOrganization(organizationId),
  } satisfies Prisma.SessionDetailSelect;
}

/**
 * {@link sessionArtifactDetailSummarySelect} with the org-scoped tag join —
 * the detail builders below replace `artifact` wholesale, so the ownership
 * fields have to ride this variant or the production detail read drops them.
 */
function sessionArtifactDetailSummarySelectForOrganization(
  organizationId: string
) {
  return {
    select: {
      ...sessionArtifactSummarySelectForOrganization(organizationId).select,
      ...sessionArtifactOwnershipSelect,
    },
  };
}

/** {@link agentSessionDetailSelect} with the org-scoped tag join. */
export function agentSessionDetailSelectForOrganization(
  organizationId: string
) {
  return {
    ...agentSessionDetailSelect,
    artifact: sessionArtifactDetailSummarySelectForOrganization(organizationId),
  } satisfies Prisma.SessionDetailSelect;
}

/**
 * {@link agentSessionDetailSelectWithoutActivitySegments} with the org-scoped
 * tag join.
 */
export function agentSessionDetailSelectWithoutActivitySegmentsForOrganization(
  organizationId: string
) {
  return {
    ...agentSessionDetailSelectWithoutActivitySegments,
    artifact: sessionArtifactDetailSummarySelectForOrganization(organizationId),
  } satisfies Prisma.SessionDetailSelect;
}
