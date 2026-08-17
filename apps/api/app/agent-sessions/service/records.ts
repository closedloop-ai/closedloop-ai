import { MAX_STORED_ACTIVITY_SEGMENTS } from "@repo/api/src/types/agent-session";
import { SESSION_DETAIL_EVENT_MAX_ROWS } from "@repo/api/src/types/agent-session-detail-limits";
import { LinkType } from "@repo/api/src/types/artifact";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import type { BasicUser } from "@repo/api/src/types/user";
import {
  ArtifactType,
  type Prisma,
  type TransactionClient,
} from "@repo/database";
import { basicUserSelect } from "@/lib/db-utils";
import type {
  AgentSessionListQuery,
  AgentSessionUsageQuery,
} from "../validators";

// Defensive ceiling for the keep-all, unretained per-event token stream loaded
// by agentSessionDetailSelect. Mirrors the getSessionTokenEvents reader's
// SESSION_TOKEN_EVENT_MAX_ROWS cap so a single pathological session (or the
// branch merged trace's per-session fan-out) can't materialize an unbounded row
// set into the detail projection. Not a functional page size — the detail cost
// badges only need the ordered per-event cost points, and 10k events is far
// beyond any real session's turn count.
export const SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS = 10_000;

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
    // ISS-6005: the parent row's `@updatedAt` — the other half of
    // `recordUpdatedAt` (status folds, and future comment/tag writes, mutate
    // THIS row rather than the session_detail row).
    updatedAt: true,
    slug: true,
    project: projectSummarySelect,
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
          {
            metadata: {
              path: ["linkKind"],
              equals: SessionArtifactLinkKind.SessionPr,
            },
          },
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
                    // FEA-4317 (wongk review): the PR-opened timestamp, set only
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
            // `authoredPrLinesChanged` and the PR-status projection each dedup by PR
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
                // FEA-4317 (wongk review): lifecycle-observed signal — see the
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

export const agentSessionListSelect = {
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
  errorCount: true,
  baseBranch: true,
  sourceArtifactId: true,
  sourceLoopId: true,
  user: basicUserSelect,
  computeTarget: computeTargetSummarySelect,
  artifact: sessionArtifactSummarySelect,
} satisfies Prisma.SessionDetailSelect;

const agentSessionDetailSelectBase = {
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
  // unbounded row set — matching the defensive cap the getSessionTokenEvents
  // reader already applies to the raw per-event stream.
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
} satisfies Prisma.SessionDetailSelect;

export const agentSessionExportSelect = {
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

export const analyticsScalarSelect = {
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

export const analyticsJsonSelect = {
  artifactId: true,
  agents: true,
  events: true,
} satisfies Prisma.SessionDetailSelect;

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

export type AnalyticsScalarSessionRecord = Prisma.SessionDetailGetPayload<{
  select: typeof analyticsScalarSelect;
}>;

export type AnalyticsJsonSessionRecord = Prisma.SessionDetailGetPayload<{
  select: typeof analyticsJsonSelect;
}>;

export type AgentSessionUpsertTx = TransactionClient;

/**
 * Lineage-only project attribution for a synced session. A session parents to a
 * project ONLY through real lineage — the source artifact it was launched from,
 * or the loop that ran it. There is deliberately no repository-derived map here:
 * a project nominating default repos for agentic execution does not make a repo
 * belong to a project (FEA-1749).
 */
export type SessionProjectResolution = {
  artifactProjectById: Map<string, string>;
  loopProjectById: Map<string, string>;
  /**
   * FEA-1718: the subset of the payload's `attribution.sourceLoopId` values that
   * resolved to a REAL loop in THIS organization. `loopProjectById` cannot serve
   * this — it holds only the loops that additionally carry a project, so a
   * genuine loop with an unparented artifact is absent from it.
   *
   * Distinct from "a session names a loop": only a validated membership may
   * promote a row to `SessionOrigin.LOOP`, because that origin exempts the row
   * from the desktop-sync retention sweeps. Populated from the same `loop`
   * query that builds `loopProjectById`, so it costs no extra round trip.
   */
  sameOrgLoopIds: Set<string>;
};

export type AgentSessionScope = {
  organizationId: string;
  // FEA-3534: the authenticated viewer's user id, threaded from the route so
  // `viewerScope=self` (the dashboard "Me" scope) is enforced server-side —
  // `buildWhere` pins `userId` to this value rather than trusting a client-sent
  // `userId`/`userIds` filter. Optional so internal callers that never request
  // self scope (and the org/team paths) can omit it.
  viewerId?: string;
  // ISS-4556 / ISS-4559: the resolved `sessions-displayed-status-parity` flag for
  // this viewer, threaded from the route so `buildStatusFacetPredicate` can stay
  // synchronous. ON, the ACTIVE facet excludes a row exactly when it projects to
  // Waiting (`projectDisplayedSessionStatus`) instead of dropping every
  // awaiting-input row regardless of `sessionEndedAt` — the drift that hid an
  // ended + awaiting-input row from BOTH the Active and Waiting facets. Optional,
  // and absent means OFF, so every internal caller keeps today's behavior.
  displayedStatusParity?: boolean;
};

export type SessionListInput = AgentSessionScope & {
  filters: AgentSessionListQuery;
};

export type SessionUsageInput = AgentSessionScope & {
  filters: AgentSessionUsageQuery;
};

export type SessionDetailInput = AgentSessionScope & {
  id: string;
};

export type UpsertSessionsContext = {
  organizationId: string;
  userId: string;
  computeTargetId: string;
  gatewaySessionId?: string;
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
