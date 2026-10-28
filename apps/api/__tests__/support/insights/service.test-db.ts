/**
 * Shared fake-Prisma harness for the Insights service tests.
 *
 * Extracted from `service.test.ts` (ISS-4919 review): that file is on the
 * SHRINK-ONLY grandfather list, and per AGENTS.md a substantive change to a
 * grandfathered file should leave it smaller. This block — the fake client, its
 * where-clause recorder, the raw-SQL flatteners and the org-scoping assertion —
 * is one cohesive responsibility (test harness) with a clean seam: nothing in it
 * touches the service under test, and it is now shared by `service.test.ts` and
 * `cost-kpi.test.ts` instead of being reachable from only one file.
 */

import { GitHubPRState } from "@repo/api/src/types/github";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { expect, vi } from "vitest";
import {
  type ProjectedPrIdentityInput,
  projectedPrIdentity,
} from "@/app/insights/merged-pr-loc";
import { GITHUB_REPO_SCOPE } from "@/lib/github/github-connection-credential";
import { isRecord } from "@/lib/type-guards";

/** The organization every fixture and org-scoping assertion is keyed to. */
export const ORG = "org-1";

export type WhereRecord = unknown[];

export function collectKey(
  value: unknown,
  target: string,
  found: string[]
): void {
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === target && typeof nested === "string") {
      found.push(nested);
    } else {
      collectKey(nested, target, found);
    }
  }
}

export function findOrgIds(value: unknown, found: string[]): void {
  collectKey(value, "organizationId", found);
}

/**
 * ISS-8153: true when a branch-donut `where`'s AND arms carry the owned-rows
 * has-PR (`some`) / no-PR (`none`) arm — the canonical predicates replaced the
 * pointer test, so the fakes route donut counts on this shape.
 */
export function hasOwnedPrArm(where: unknown, kind: "some" | "none"): boolean {
  if (!where || typeof where !== "object") {
    return false;
  }
  const arms = (where as { AND?: unknown }).AND;
  if (!Array.isArray(arms)) {
    return false;
  }
  return arms.some((arm) => {
    const details = (
      arm as {
        artifact?: { is?: { pullRequestDetails?: Record<string, unknown> } };
      }
    )?.artifact?.is?.pullRequestDetails;
    return Boolean(details && kind in details);
  });
}

export function hasEmptyInPredicate(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (
    "in" in value &&
    Array.isArray((value as { in?: unknown }).in) &&
    (value as { in: unknown[] }).in.length === 0
  ) {
    return true;
  }
  return Object.values(value).some((nested) => hasEmptyInPredicate(nested));
}

// FEA-2876: a token-usage fixture row. Its token/cost columns feed the fake DB's
// aggregate({_sum}) and groupBy({_sum}) so one fixture drives the KPI totals, the
// token-distribution donut, and the spend-by-model breakdown.
export type TokenUsageFixture = {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCost?: number;
};

export function sumBy<T>(
  rows: T[],
  pick: (row: T) => number | undefined
): number {
  return rows.reduce((total, row) => total + (pick(row) ?? 0), 0);
}

/**
 * Build a fake Prisma client that returns fixtures and records every where
 * clause it is handed. Counts/aggregates branch on the where shape so the many
 * call sites resolve deterministically.
 */
export type FakeInsightsDb = {
  /** The fake Prisma client. Handed to the mocked `withDb` callback as `never`
   *  — it implements only the surface these tests exercise, not the real
   *  `PrismaClient`. Declared explicitly (not inferred) so this module's public
   *  type does not reference `@vitest/spy`'s internals, which is not portable
   *  across the package boundary (TS2742). */
  db: unknown;
  /** Every `where` clause the fake client was handed, for org-scoping asserts. */
  wheres: WhereRecord;
  /** Every raw-SQL fragment passed to `$queryRaw` / `$queryRawUnsafe`. */
  rawQueries: unknown[];
  /** The args of each merged-PR `findMany`, for scan-cap / ordering asserts. */
  mergedFindArgs: Record<string, unknown>[];
};

export function makeFakeDb(fixtures: {
  mergedPrs?: unknown[];
  // ISS-5411: the PRIOR window's merged-PR rows, and the closed-PR rows behind
  // the merge-rate denominator. Both counts are deduped by PR identity like the
  // current window. ISS-5624 moved that dedupe into SQL, so these fixtures no
  // longer stand in for a row scan the service reduces in JS — the fake reduces
  // them with the SAME `projectedPrIdentity` the emitted SQL mirrors and returns
  // the resulting COUNT, which is what the real statement ships. Both default to
  // empty, i.e. a count of zero.
  priorMergedPrs?: ProjectedPrIdentityInput[];
  closedPrs?: ProjectedPrIdentityInput[];
  /**
   * ISS-12408: what the shared pull-request fold returns for the Delivery view.
   * Each figure defaults to the distinct pull requests in the matching fixture
   * above (`mergedPrs`, `closedPrs`, `priorMergedPrs`), which is what the
   * statement would count over those rows.
   */
  pullRequestFacts?: {
    merged?: number;
    closedUnmerged?: number;
    priorMerged?: number;
    medianSize?: number | null;
    sized?: number;
  };
  checkStatusGroups?: unknown[];
  // ISS-4634: where-aware variant of `checkStatusGroups`. The check-status donut
  // is now windowed on the selected range, so a static fixture cannot tell a
  // windowed query from an unwindowed one. When supplied, the fake derives the
  // groupBy rows from the emitted `where` and takes precedence over the static
  // fixture.
  checkStatusGroupsFor?: (where: Record<string, unknown>) => unknown[];
  reviewQueueGroups?: unknown[];
  sessions?: unknown[];
  eventTypeGroups?: { eventType: string; _count: { _all: number } }[];
  toolUsageGroups?: { toolName: string; _count: { _all: number } }[];
  eventVolumeRows?: unknown[];
  // FEA-2877: the utilization path rolls sessions up in the DB. Each raw query
  // is routed to its own fixture by inspecting the emitted SQL text.
  sessionRollupRows?: unknown[];
  userBreakdownRows?: unknown[];
  sessionActivityRows?: unknown[];
  // FEA-3684: pre-bucketed (day, hour, human, agent) rows the Event Activity
  // heatmap reads from $queryRaw, standing in for the DB unnest of each session's
  // `metadata.messages` split by turn role. Routed by the `metadata -> 'messages'`
  // unnest (before the generic agent-bucket branch, which also uses
  // jsonb_array_elements).
  activityHeatmapRows?: unknown[];
  // FEA-3684: same tzdata-skew simulation for the heatmap — its tz-aware bucket
  // query (AT TIME ZONE) throws so the service must retry in UTC.
  failTimeZoneHeatmap?: boolean;
  // FEA-2955: the agent status/type charts unnest each session's `agents` JSON
  // array and group by the raw value in the DB. Each raw query is routed to its
  // fixture by the field it binds ("status" vs "type").
  agentStatusBuckets?: unknown[];
  agentTypeBuckets?: unknown[];
  // FEA-3537: the agent-pipeline graph rolls up nodes (by subagent type) and
  // edges (parent→child hand-offs) from the same narrowed `agent_rows` SQL set.
  agentPipelineNodes?: unknown[];
  agentPipelineEdges?: unknown[];
  // FEA-2877: simulate a Postgres tzdata that rejects the requester timezone —
  // the tz-aware session-activity query (AT TIME ZONE) throws so the service
  // must retry in UTC rather than 500 the endpoint.
  failTimeZoneActivity?: boolean;
  // FEA-2956: same tzdata-skew simulation for the daily tool-run series — the
  // tz-aware SUM(tool_use_count) query throws so the service must retry in UTC.
  failTimeZoneToolRuns?: boolean;
  // FEA-3465: same tzdata-skew simulation for the daily event-volume series — the
  // tz-aware COUNT(*) query throws so the service must retry in UTC rather than
  // 500 the utilization endpoint.
  failTimeZoneEvents?: boolean;
  // FEA-2956: pre-bucketed (day, n) tool-run totals the daily tool-run series
  // reads from $queryRaw, standing in for the DB SUM(tool_use_count) aggregation.
  toolRunsByDayRows?: unknown[];
  // FEA-3384: pre-aggregated per-reviewer rows (reviewer, reviewed, approved,
  // median_wait_ms) the reviewer-load table reads from $queryRaw, standing in for
  // the DB GROUP BY author_login aggregation.
  reviewerLoadRows?: unknown[];
  tokenUsage?: unknown[];
  // FEA-2876: pre-bucketed (day, model, cost) rows the token model-usage series
  // reads from $queryRaw, standing in for the DB date_trunc aggregation.
  modelUsageRows?: unknown[];
  // ISS-4463: pre-grouped (outcome, cost) rows for the outcome half of the fused
  // Agents spend scan. Omitted by suites that only exercise spend-by-model.
  spendOutcomeRows?: { outcome: string; cost: number }[];
  counts?: (where: Record<string, unknown>) => number;
  costSum?: number;
  toolUseSum?: number;
  activeInstallation?: unknown | null;
  userGrant?: unknown | null;
  // FEA-4022: the org's `calculateSessionFrustration` opt-in gate (read via
  // organization.findUnique in getAgents). Defaults to disabled so existing
  // getAgents tests never see the frustration trend unless they opt in.
  frustrationEnabled?: boolean;
  // FEA-4022: pre-aggregated (day, total, sessions) rows the frustration-trend
  // query reads from $queryRaw, standing in for the DB per-day SUM/COUNT over
  // non-null frustration_raw. Routed by the `frustration_raw` column.
  frustrationTrendRows?: unknown[];
  // FEA-4022 (T15): when true, the frustration-trend $queryRaw rejects — proves
  // the trend fails open (chart omitted) instead of failing the whole Agents
  // response.
  failFrustrationTrend?: boolean;
  // FEA-2233: earliest relevant record returned by the `_min` aggregates that
  // power the "full prior period" rule. Defaults to the epoch so existing
  // delta-bearing tests assume a full prior period; pass a recent Date to
  // exercise the partial-prior case, or `null` for a no-history org.
  earliest?: Date | null;
  orgMergedPullRequestLinks?: unknown[];
  // ISS-8424: the all-time session-linked merged census the Delivery read takes
  // to tell an unmeasured population from a measured zero
  // (`censusMergedPrVerification`). Defaults to a MEASURED population, so every
  // suite predating ISS-8424 keeps rendering real numbers; a suite that wants
  // the unmeasured branch asks for it by name.
  mergedPrVerificationCensus?: {
    hasSessionLinkedMergedPrs: boolean;
    hasVerifiedMergedPrs: boolean;
  };
  // ISS-11915: the Branch ids the Branches list's candidate read returns for
  // the Dashboard period. Defaults to none.
  branchListPopulationIds?: string[];
}): FakeInsightsDb {
  const earliest =
    fixtures.earliest === undefined ? new Date(0) : fixtures.earliest;
  const wheres: WhereRecord = [];
  // Every Prisma.sql fragment handed to $queryRaw, captured so tests can assert
  // the raw event-volume aggregation carries the org/team scope predicate. Each
  // entry is the tagged-template stand-in shape `{ strings, values }` produced
  // by the mocked Prisma.sql (nested fragments appear inside `values`).
  const rawQueries: unknown[] = [];
  // FEA-2878: every pullRequestDetail.findMany call (the merged-PR scan) so tests
  // can assert the scan is capped/ordered independently of the `where` records.
  const mergedFindArgs: Record<string, unknown>[] = [];
  const record = <T>(args: { where?: unknown } | undefined, value: T): T => {
    if (args?.where) {
      wheres.push(args.where);
    }
    return value;
  };
  const mergedPrs = withAdmissionBranchCounts(fixtures.mergedPrs ?? []);
  const orgMergedPullRequestLinks =
    fixtures.orgMergedPullRequestLinks ??
    defaultOrgMergedPullRequestLinks(mergedPrs);
  const count = (args: { where: Record<string, unknown> }) => {
    wheres.push(args.where);
    return Promise.resolve(fixtures.counts?.(args.where) ?? 0);
  };
  const db = {
    pullRequestDetail: {
      findMany: (a: { where?: unknown }) => {
        mergedFindArgs.push(a as Record<string, unknown>);
        return Promise.resolve(filterRowsById(mergedPrs, a.where));
      },
      count,
      groupBy: (a: { where?: unknown }) =>
        Promise.resolve(record(a, fixtures.reviewQueueGroups ?? [])),
      // FEA-2233: earliest merged PR for the full-prior-period rule.
      aggregate: (a: { where?: unknown }) => {
        wheres.push(a.where);
        return Promise.resolve({ _min: { mergedAt: earliest } });
      },
    },
    organization: {
      // FEA-4022: the frustration opt-in gate. `settings.calculateSessionFrustration`
      // reflects the `frustrationEnabled` fixture (default off). The lookup is
      // keyed by the org id itself (a `{ id }` where, not an `{ organizationId }`
      // scope), so it is intentionally NOT pushed into `wheres` — that record
      // feeds `expectAllOrgScoped`, which asserts an `organizationId` predicate.
      findUnique: () =>
        Promise.resolve({
          settings: {
            calculateSessionFrustration: fixtures.frustrationEnabled === true,
          },
        }),
    },
    sessionDetail: {
      findMany: (a: { where?: unknown }) =>
        Promise.resolve(record(a, fixtures.sessions ?? [])),
      count,
      aggregate: (a: {
        where?: unknown;
        _sum?: Record<string, boolean>;
        _min?: Record<string, boolean>;
      }) => {
        wheres.push(a.where);
        // FEA-2233: earliest session start for the full-prior-period rule.
        if (a._min) {
          return Promise.resolve({ _min: { sessionStartedAt: earliest } });
        }
        if (a._sum?.estimatedCost) {
          return Promise.resolve({
            _sum: { estimatedCost: fixtures.costSum ?? 0 },
          });
        }
        return Promise.resolve({
          _sum: { toolUseCount: fixtures.toolUseSum ?? 0 },
        });
      },
    },
    branchDetail: {
      groupBy: (a: { where?: Record<string, unknown> }) =>
        Promise.resolve(
          record(
            a,
            fixtures.checkStatusGroupsFor?.(a.where ?? {}) ??
              fixtures.checkStatusGroups ??
              []
          )
        ),
      count,
    },
    artifactLink: {
      findMany: (a: { where?: unknown }) =>
        Promise.resolve(record(a, orgMergedPullRequestLinks)),
    },
    agentSessionTokenUsage: {
      // Token analytics are DB-aggregated (FEA-2876): the KPI/token-distribution
      // totals come from aggregate({_sum}); the spend-by-model breakdown and the
      // ISS-4463 spend-by-outcome split now share ONE $queryRaw (GROUPING SETS),
      // and the per-day series is another. The fake derives them from the same
      // `tokenUsage` fixture rows so a single fixture drives the whole surface.
      aggregate: (a: { where?: unknown }) => {
        wheres.push(a.where);
        const rows = (fixtures.tokenUsage ?? []) as TokenUsageFixture[];
        return Promise.resolve({
          _sum: {
            inputTokens: sumBy(rows, (r) => r.inputTokens),
            outputTokens: sumBy(rows, (r) => r.outputTokens),
            cacheReadTokens: sumBy(rows, (r) => r.cacheReadTokens),
            cacheWriteTokens: sumBy(rows, (r) => r.cacheWriteTokens),
          },
        });
      },
    },
    agentSessionEvent: {
      count,
      groupBy: (a: { by?: string[]; where?: unknown }) =>
        Promise.resolve(
          record(
            a,
            a.by?.includes("toolName")
              ? (fixtures.toolUsageGroups ?? [])
              : (fixtures.eventTypeGroups ?? [])
          )
        ),
    },
    $queryRaw: (sql: unknown) => {
      rawQueries.push(sql);
      // ISS-11915: the Dashboard branch population is the Branches list's own
      // candidate read. Routed FIRST: its eligibility SQL also reads
      // `pull_request_detail`, which the distinct-PR routes below would match.
      if (flattenRawSql(sql).text.includes("latest_activity_atom")) {
        return Promise.resolve(
          (fixtures.branchListPopulationIds ?? []).map(candidateRawRowFor)
        );
      }
      // Route each raw aggregation to its fixture by the SQL it emits:
      // - the session rollup (count + runtime + status) carries EXTRACT(EPOCH,
      // - the user breakdown joins users (u.email),
      // - the token model-usage series (FEA-2876) reads
      //   agent_session_token_usage,
      // - the event-volume query reads agent_session_events,
      // - the daily tool-run series (FEA-2956) SUMs tool_use_count per day,
      // - the remaining date_trunc query is the daily session-activity series.
      const { text, values } = flattenRawSql(sql);
      // ISS-12408: the shared pull-request fold behind Merged PRs, its prior
      // window, the closed-unmerged count and the median. Routed before every
      // `pull_request_detail` branch below, which would otherwise answer it with
      // ids or a count. It returns one row per window key the caller asked for.
      if (text.includes("WITH counting AS MATERIALIZED")) {
        const asked = values.flatMap((value) =>
          Array.isArray(value) ? value.map(String) : []
        );
        const distinct = (rows: ProjectedPrIdentityInput[] | undefined) =>
          new Set((rows ?? []).map(projectedPrIdentity)).size;
        const facts = fixtures.pullRequestFacts ?? {};
        const row = (key: string, merged: number, closedUnmerged: number) => ({
          key,
          merged,
          sized: key === "current" ? (facts.sized ?? 0) : 0,
          median_size: key === "current" ? (facts.medianSize ?? null) : null,
          closed_unmerged: closedUnmerged,
          decided_identities: merged + closedUnmerged,
          conflicted: false,
        });
        return Promise.resolve([
          ...(asked.includes("current")
            ? [
                row(
                  "current",
                  facts.merged ?? distinct(mergedPrs.filter(hasPrIdentity)),
                  facts.closedUnmerged ?? distinct(fixtures.closedPrs)
                ),
              ]
            : []),
          ...(asked.includes("prior")
            ? [
                row(
                  "prior",
                  facts.priorMerged ?? distinct(fixtures.priorMergedPrs),
                  0
                ),
              ]
            : []),
        ]);
      }
      // ISS-5624: the distinct-PR counts behind the prior-window delta and the
      // merge-rate denominator. Routed by their table, then told apart by the
      // column each windows on — the prior merged window on `p.merged_at`, the
      // closed side on the branch artifact's `a.created_at` (FEA-3208). The fake
      // reduces the fixture rows through the real identity helper the emitted
      // SQL mirrors, so a scenario still expresses itself as "N rows for M pull
      // requests" and the service sees the M the statement would have returned.
      // ISS-8424: the verification census. Routed BEFORE the distinct-PR counts
      // below, which it would otherwise match — it reads the same table and
      // also windows nothing but `p.merged_at IS NOT NULL`. Its aliased EXISTS
      // probes are the one shape no other statement over this table emits.
      if (text.includes('AS "hasVerifiedMergedPrs"')) {
        const census = fixtures.mergedPrVerificationCensus ?? {
          hasSessionLinkedMergedPrs: true,
          hasVerifiedMergedPrs: true,
        };
        return Promise.resolve([census]);
      }
      if (text.includes("FROM pull_request_detail p")) {
        if (text.includes("SELECT p.id")) {
          return Promise.resolve(
            mergedPrs.flatMap((row) =>
              isRecord(row) && typeof row.id === "string"
                ? [{ id: row.id }]
                : []
            )
          );
        }
        if (!text.includes("SELECT DISTINCT") && text.includes("p.merged_at")) {
          return Promise.resolve([
            {
              n:
                fixtures.counts?.({
                  prState: GitHubPRState.Merged,
                  mergedAt: { lte: true },
                }) ?? 0,
            },
          ]);
        }
        const rows = text.includes("p.merged_at")
          ? (fixtures.priorMergedPrs ?? [])
          : (fixtures.closedPrs ?? []);
        return Promise.resolve([
          { n: new Set(rows.map(projectedPrIdentity)).size },
        ]);
      }
      // FEA-3537: the agent-pipeline graph now returns node and edge rows from a
      // single query over one materialized `agent_rows` CTE. Route it before the
      // generic JSON-agent bucket branch, which also unnests `agents`.
      //
      // ISS-7511 — this branch FABRICATES the result: it recognizes the CTE name
      // and hands back finished rows, so nothing downstream of it exercises the
      // aggregation. What a caller may conclude from it is the round-trip count,
      // the scope predicate carried in the emitted SQL, and the JS mapping over
      // the returned rows — never that the statement groups, joins, or windows
      // correctly. The clauses that build these rows are covered against a real
      // Postgres in `app/insights/agent-pipeline.integration.test.ts`; assert new
      // SQL behavior there, not by widening this fixture.
      if (text.includes("WITH agent_rows AS MATERIALIZED")) {
        return Promise.resolve([
          ...(fixtures.agentPipelineNodes ?? []).map((row, index) => {
            const node = row as Record<string, unknown>;
            return {
              rowType: "node",
              sortOrder: index + 1,
              subagentType: node.subagent_type,
              total: node.total,
              completed: node.completed,
              errors: node.errors,
              sessions: node.sessions,
              avgDuration: node.avg_duration,
              source: null,
              target: null,
              weight: null,
            };
          }),
          ...(fixtures.agentPipelineEdges ?? []).map((row, index) => {
            const edge = row as Record<string, unknown>;
            return {
              rowType: "edge",
              sortOrder: index + 1,
              subagentType: null,
              total: null,
              completed: null,
              errors: null,
              sessions: null,
              avgDuration: null,
              source: edge.source,
              target: edge.target,
              weight: edge.weight,
            };
          }),
        ]);
      }
      // FEA-4022: the frustration-trend series SUMs frustration_raw per day over
      // non-null rows. Routed by its unique column before the generic branch.
      if (text.includes("frustration_raw")) {
        if (fixtures.failFrustrationTrend) {
          return Promise.reject(new Error("frustration query blew up"));
        }
        return Promise.resolve(fixtures.frustrationTrendRows ?? []);
      }
      // FEA-3684: the Event Activity heatmap also unnests JSON (metadata.messages),
      // so route it by that unnest BEFORE the generic agent-bucket branch. When the
      // requester zone is unknown to Postgres, the tz-aware variant (AT TIME ZONE)
      // rejects and the service retries the UTC variant.
      if (text.includes("metadata -> 'messages'")) {
        if (fixtures.failTimeZoneHeatmap && text.includes("AT TIME ZONE")) {
          return Promise.reject(
            new Error('time zone "Mars/Olympus" not recognized')
          );
        }
        return Promise.resolve(fixtures.activityHeatmapRows ?? []);
      }
      // FEA-3638 (Tier-2 collapse): the status + type buckets now come back from a
      // SINGLE unnest query (one round-trip) whose rows carry a `field`
      // discriminator ("status"/"type"), rolled up via GROUPING SETS. The fake
      // tags each pre-grouped fixture row with its field and returns the union,
      // mirroring the DB shape the collapsed query yields.
      if (text.includes("jsonb_array_elements")) {
        const tag = (field: "status" | "type", groups?: unknown[]) =>
          (groups ?? []).map((row) => ({
            ...(row as Record<string, unknown>),
            field,
          }));
        return Promise.resolve([
          ...tag("status", fixtures.agentStatusBuckets),
          ...tag("type", fixtures.agentTypeBuckets),
        ]);
      }
      // FEA-3384: the reviewer-load table is GROUP BY author_login over
      // github_pr_reviews with a percentile_cont median wait. Checked before the
      // session-rollup route because it also emits EXTRACT(EPOCH (for the wait).
      if (text.includes("github_pr_reviews")) {
        return Promise.resolve(fixtures.reviewerLoadRows ?? []);
      }
      if (text.includes("EXTRACT(EPOCH")) {
        return Promise.resolve(fixtures.sessionRollupRows ?? []);
      }
      if (text.includes("u.email")) {
        return Promise.resolve(fixtures.userBreakdownRows ?? []);
      }
      // ISS-4463: the Agents spend scan rolls up (model) and (outcome) in ONE
      // statement via GROUPING SETS, so it must be routed by that grouping
      // BEFORE the generic token-usage branch (the model-usage series reads the
      // same table). Model rows still derive from the `tokenUsage` fixture — one
      // fixture drives spend-by-model exactly as the prior groupBy did — while
      // outcome rows come from their own optional fixture, so a suite that does
      // not exercise the outcome split simply sees four measured-zero buckets.
      if (text.includes("GROUPING SETS ((model), (outcome))")) {
        const usage = (fixtures.tokenUsage ?? []) as TokenUsageFixture[];
        const spend = new Map<string, number>();
        for (const row of usage) {
          spend.set(
            row.model,
            (spend.get(row.model) ?? 0) + (row.estimatedCost ?? 0)
          );
        }
        return Promise.resolve([
          ...[...spend.entries()].map(([model, cost]) => ({
            field: "model",
            model,
            outcome: null,
            cost,
          })),
          ...(fixtures.spendOutcomeRows ?? []).map((row) => ({
            field: "outcome",
            model: null,
            ...row,
          })),
        ]);
      }
      if (text.includes("agent_session_token_usage")) {
        return Promise.resolve(fixtures.modelUsageRows ?? []);
      }
      if (text.includes("agent_session_events")) {
        if (text.includes('AS "toolName"')) {
          return Promise.resolve(
            (fixtures.toolUsageGroups ?? []).map((row) => ({
              toolName: row.toolName,
              n: row._count._all,
            }))
          );
        }
        if (text.includes('AS "eventType"')) {
          return Promise.resolve(
            (fixtures.eventTypeGroups ?? []).map((row) => ({
              eventType: row.eventType,
              n: row._count._all,
            }))
          );
        }
        if (text.includes("COALESCE(SUM(e.n), 0)")) {
          return Promise.resolve([
            { n: fixtures.counts?.({ eventCreatedAt: {} }) ?? 0 },
          ]);
        }
        // FEA-3465: simulate a Postgres tzdata that rejects the requester
        // timezone — the tz-aware event-volume query (AT TIME ZONE) throws so the
        // service must retry in UTC rather than 500 the utilization endpoint.
        if (fixtures.failTimeZoneEvents && text.includes("AT TIME ZONE")) {
          return Promise.reject(
            new Error('time zone "Mars/Olympus" not recognized')
          );
        }
        return Promise.resolve(fixtures.eventVolumeRows ?? []);
      }
      if (text.includes("tool_use_count")) {
        if (fixtures.failTimeZoneToolRuns && text.includes("AT TIME ZONE")) {
          return Promise.reject(
            new Error('time zone "Mars/Olympus" not recognized')
          );
        }
        return Promise.resolve(fixtures.toolRunsByDayRows ?? []);
      }
      // Daily session-activity series. When the requester zone is unknown to
      // Postgres, the tz-aware variant (AT TIME ZONE) rejects and the service
      // retries the UTC variant.
      if (fixtures.failTimeZoneActivity && text.includes("AT TIME ZONE")) {
        return Promise.reject(
          new Error('time zone "Mars/Olympus" not recognized')
        );
      }
      return Promise.resolve(fixtures.sessionActivityRows ?? []);
    },
    gitHubInstallation: {
      findFirst: (a: { where?: unknown }) =>
        Promise.resolve(record(a, activeInstallationFixture(fixtures))),
    },
    gitHubUserConnection: {
      findUnique: vi.fn().mockResolvedValue(fixtures.userGrant ?? null),
    },
  };
  return { db, wheres, rawQueries, mergedFindArgs };
}

function filterRowsById(rows: unknown[], where: unknown): unknown[] {
  if (!(isRecord(where) && isRecord(where.id))) {
    return rows;
  }
  const ids = where.id.in;
  if (!Array.isArray(ids)) {
    return rows;
  }
  const idSet = new Set(
    ids.filter((id): id is string => typeof id === "string")
  );
  return rows.filter((row) => isRecord(row) && idSet.has(String(row.id)));
}

function withAdmissionBranchCounts(rows: unknown[]): unknown[] {
  const countsByBranchId = new Map<string, number>();
  for (const row of rows) {
    const branchArtifactId = readBranchArtifactId(row);
    if (branchArtifactId) {
      countsByBranchId.set(
        branchArtifactId,
        (countsByBranchId.get(branchArtifactId) ?? 0) + 1
      );
    }
  }
  return rows.map((row, index) => {
    if (!isRecord(row)) {
      return row;
    }
    const branchArtifactId = readBranchArtifactId(row);
    if (!branchArtifactId) {
      return row;
    }
    const branchArtifact = isRecord(row.branchArtifact)
      ? row.branchArtifact
      : {};
    const count = isRecord(branchArtifact._count)
      ? branchArtifact._count.pullRequestDetails
      : undefined;
    return {
      ...row,
      id: typeof row.id === "string" ? row.id : `merged-pr-${index + 1}`,
      lastVerifiedAt:
        "lastVerifiedAt" in row ? row.lastVerifiedAt : new Date(0),
      branchArtifact: {
        ...branchArtifact,
        id:
          typeof branchArtifact.id === "string"
            ? branchArtifact.id
            : branchArtifactId,
        _count: {
          ...(isRecord(branchArtifact._count) ? branchArtifact._count : {}),
          pullRequestDetails:
            typeof count === "number"
              ? count
              : (countsByBranchId.get(branchArtifactId) ?? 1),
        },
      },
    };
  });
}

function defaultOrgMergedPullRequestLinks(rows: unknown[]): unknown[] {
  const links: unknown[] = [];
  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }
    const targetId = readBranchArtifactId(row);
    if (!targetId) {
      continue;
    }
    links.push({
      targetId,
      metadata: defaultOrgMergedPullRequestLinkMetadata(row),
    });
  }
  return links;
}

function defaultOrgMergedPullRequestLinkMetadata(row: Record<string, unknown>) {
  const repositoryFullName = readRepositoryFullName(row);
  const prNumber = typeof row.number === "number" ? row.number : null;
  if (repositoryFullName && prNumber != null) {
    return {
      linkKind: SessionArtifactLinkKind.SessionPr,
      prRefs: [{ repositoryFullName, prNumber, relationTypes: [] }],
    };
  }
  return { linkKind: SessionArtifactLinkKind.SessionPr };
}

function readBranchArtifactId(row: unknown): string | null {
  if (!isRecord(row)) {
    return null;
  }
  if (typeof row.branchArtifactId === "string") {
    return row.branchArtifactId;
  }
  return isRecord(row.branchArtifact) &&
    typeof row.branchArtifact.id === "string"
    ? row.branchArtifact.id
    : null;
}

function readRepositoryFullName(row: Record<string, unknown>): string | null {
  if (typeof row.repositoryFullName === "string" && row.repositoryFullName) {
    return row.repositoryFullName;
  }
  if (isRecord(row.repository) && typeof row.repository.fullName === "string") {
    return row.repository.fullName;
  }
  return null;
}

/**
 * Flatten a mocked Prisma.sql fragment (`{ strings, values }`, possibly nested
 * via interpolated fragments) into its concatenated SQL text and the flat list
 * of bound scalar values, so tests can assert the raw event-volume query both
 * emits the org/team scope predicate SQL and binds the expected ids.
 */
export function flattenRawSql(sql: unknown): {
  text: string;
  values: unknown[];
} {
  if (!sql || typeof sql !== "object") {
    return { text: typeof sql === "string" ? sql : "", values: [] };
  }
  const fragment = sql as { strings?: unknown; values?: unknown };
  if (!(Array.isArray(fragment.strings) && Array.isArray(fragment.values))) {
    return { text: "", values: [] };
  }
  let text = "";
  const values: unknown[] = [];
  fragment.strings.forEach((chunk, index) => {
    text += String(chunk);
    if (index < (fragment.values as unknown[]).length) {
      const interpolated = (fragment.values as unknown[])[index];
      // A nested Prisma.sql fragment (e.g. the scope predicate) is spliced into
      // the SQL text; a plain scalar (org/user/team id) is a bound value.
      if (
        interpolated &&
        typeof interpolated === "object" &&
        "strings" in interpolated
      ) {
        const nested = flattenRawSql(interpolated);
        text += nested.text;
        values.push(...nested.values);
      } else {
        values.push(interpolated);
      }
    }
  });
  return { text, values };
}

/**
 * Pick the one captured raw query whose emitted SQL contains `needle`, flattened.
 * The utilization path now fires several sibling `$queryRaw` aggregations in a
 * single `Promise.all` (session rollup, user breakdown, event volume, session
 * activity — FEA-2877), so their order in `rawQueries` is not stable. Tests that
 * assert against a specific aggregation select it by an identifying SQL token
 * (e.g. the event-volume query's `agent_session_events`) rather than by index.
 */
export function findRawSql(
  rawQueries: unknown[],
  needle: string
): { text: string; values: unknown[] } {
  const match = rawQueries
    .map((sql) => flattenRawSql(sql))
    .find((raw) => raw.text.includes(needle));
  if (!match) {
    throw new Error(`no raw query matched ${JSON.stringify(needle)}`);
  }
  return match;
}

export function activeInstallationFixture(fixtures: {
  activeInstallation?: unknown | null;
}) {
  if (fixtures.activeInstallation !== undefined) {
    return fixtures.activeInstallation;
  }
  return { id: "gh-install-1" };
}

/**
 * ISS-7404: delivery provenance is resolved through
 * `resolveGitHubDataConnectionStatus`, which now judges a grant on its mirrored
 * scopes. The default carries `repo` because these fixtures stand in for a
 * grant that CAN serve GitHub data; pass a narrower set for the refusal case.
 */
export function makeInsightsUserGrant(
  overrides: Partial<{
    revokedAt: Date | null;
    scopes: string[];
  }> = {}
) {
  return {
    revokedAt: overrides.revokedAt ?? null,
    scopes: overrides.scopes ?? [GITHUB_REPO_SCOPE],
  };
}

function hasPrIdentity(row: unknown): row is ProjectedPrIdentityInput {
  return (
    isRecord(row) &&
    typeof row.id === "string" &&
    typeof row.number === "number"
  );
}

/**
 * A minimal projection-identity row for the `priorMergedPrs` / `closedPrs`
 * fixtures (ISS-5624). Defaults to a repo-less desktop-shaped row, which is the
 * `repo:` identity tier — pass overrides for the App-adopted twin.
 */
export function identityRow(
  id: string,
  number: number,
  overrides: Partial<ProjectedPrIdentityInput> = {}
): ProjectedPrIdentityInput {
  return {
    id,
    number,
    githubId: null,
    repositoryFullName: "acme/closedloop-ai",
    repositoryId: null,
    ...overrides,
  };
}

// biome-ignore-start lint/suspicious/noMisplacedAssertion: shared org-scoping assertion helper invoked from each section test
export function expectAllOrgScoped(wheres: WhereRecord): void {
  expect(wheres.length).toBeGreaterThan(0);
  for (const where of wheres) {
    const found: string[] = [];
    findOrgIds(where, found);
    expect(found).toContain(ORG);
  }
}
// biome-ignore-end lint/suspicious/noMisplacedAssertion: shared org-scoping assertion helper invoked from each section test

/**
 * The `@repo/database` mock every insights service suite needs: a `withDb` spy
 * plus the generated enums and the minimal `Prisma.sql`/`Prisma.join`
 * tagged-template stand-ins the raw queries build against.
 *
 * Shared rather than copied because `vi.mock` factories are per-file, so
 * splitting a suite would otherwise duplicate ~55 lines of enum scaffolding and
 * let the two copies drift. Call it from a lazy factory --
 * `vi.mock("@repo/database", async () => (await import(...)).databaseMock())` --
 * so the hoisted factory body resolves this import at call time.
 */
export async function databaseMock(): Promise<Record<string, unknown>> {
  const githubTypes = await import("@repo/api/src/types/github");
  return {
    withDb: vi.fn(),
    ChecksStatus: {
      UNKNOWN: "UNKNOWN",
      PENDING: "PENDING",
      PASSING: "PASSING",
      FAILING: "FAILING",
    },
    GitHubPRState: {
      CLOSED: githubTypes.GitHubPRState.Closed,
      MERGED: githubTypes.GitHubPRState.Merged,
      OPEN: githubTypes.GitHubPRState.Open,
    },
    ArtifactType: { BRANCH: "BRANCH", SESSION: "SESSION" },
    GitHubInstallationStatus: {
      ACTIVE: "ACTIVE",
      PENDING_CLAIM: "PENDING_CLAIM",
      SUSPENDED: "SUSPENDED",
      UNINSTALLED: "UNINSTALLED",
    },
    ReviewDecision: {
      APPROVED: "APPROVED",
      CHANGES_REQUESTED: "CHANGES_REQUESTED",
      COMMENTED: "COMMENTED",
      DISMISSED: "DISMISSED",
    },
    Prisma: {
      // Minimal tagged-template stand-in for Prisma.sql so the raw
      // event-volume query builds without a live client.
      sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
        strings: Array.from(strings),
        values,
      }),
      // Minimal Prisma.join stand-in (FEA-3684 heatmap headless predicate): weave
      // `separator` between each item as an interpolated value, yielding the same
      // { strings, values } shape flattenRawSql already understands.
      join: (items: unknown[], separator = ",") => ({
        strings: items
          .map((_, index) => (index === 0 ? "" : separator))
          .concat(""),
        values: items,
      }),
      raw: (text: string) => ({ strings: [text], values: [] }),
      empty: { strings: [""], values: [] },
    },
  };
}

// ---------------------------------------------------------------------------
// Branch-population fixture evaluation (ISS-4634, re-founded on the Branches
// list population by ISS-11915). Harness code belongs here per this module's
// own charter.
// ---------------------------------------------------------------------------
export type BranchPopulationRow = {
  id: string;
  hasPr: boolean;
  checksStatus: string;
};

/**
 * The fixture rows the donut's `where` admits. Production narrows every donut
 * query to the Branches list population with `artifactId: { in: ids }`, so a
 * query that dropped that predicate admits NOTHING here rather than the whole
 * fixture, and the assertion moves.
 */
function populationRowsIn(
  rows: BranchPopulationRow[],
  where: Record<string, unknown>
): BranchPopulationRow[] {
  const artifactId = where.artifactId;
  const ids =
    isRecord(artifactId) && Array.isArray(artifactId.in) ? artifactId.in : [];
  return rows.filter((row) => ids.includes(row.id));
}

export function checkStatusGroupsFrom(
  rows: BranchPopulationRow[],
  where: Record<string, unknown>
): { checksStatus: string; _count: { _all: number } }[] {
  const tally = new Map<string, number>();
  for (const row of populationRowsIn(rows, where)) {
    tally.set(row.checksStatus, (tally.get(row.checksStatus) ?? 0) + 1);
  }
  return [...tally].map(([checksStatus, n]) => ({
    checksStatus,
    _count: { _all: n },
  }));
}

/** The branch-coverage counts, or null when `where` is some other count call. */
export function branchPrCountFrom(
  rows: BranchPopulationRow[],
  where: Record<string, unknown>
): number | null {
  const wantsPr = hasOwnedPrArm(where, "some");
  const wantsNoPr = hasOwnedPrArm(where, "none");
  if (!(wantsPr || wantsNoPr)) {
    return null;
  }
  return populationRowsIn(rows, where).filter((row) => row.hasPr === wantsPr)
    .length;
}

/** One candidate-read raw row for a population id, with no Last-active evidence. */
function candidateRawRowFor(id: string): Record<string, unknown> {
  return {
    id,
    repositorySortKey: "acme/repo",
    branchSortKey: id,
    atomVersion: null,
    atomSource: null,
    atomSourceEventId: null,
    atomOccurredAt: null,
    atomActivityKind: null,
    atomAttributionKind: null,
    atomPullRequestDetailId: null,
    atomCompleteness: null,
    atomCreatedAt: null,
    linkedSessionActivityAt: null,
  };
}
