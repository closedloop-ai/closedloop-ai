import type { SyncedActivitySegmentRow } from "@repo/api/src/types/agent-session";
import type { BranchRow } from "@repo/api/src/types/branch";
import { BranchStatus } from "@repo/api/src/types/branch";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { branchCostEvidenceFixedRowBytes } from "@repo/api/src/types/branch-usage";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import type { BranchSyncSource } from "../src/main/branch/shared-branches-api.js";
import { ACTIVITY_CLASSIFIER_VERSION } from "../src/main/collectors/parsing/activity-segment-classifier.js";
import type {
  BranchCanonicalActivityReadRequest,
  BranchCanonicalActivityRow,
} from "../src/main/database/branch-activity-read.js";
import { createBranchMetricEventEvidenceMethods } from "../src/main/database/branch-metric-event-provenance.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";

/**
 * Shared canned-row fixtures + fake `BranchSyncSource` for the shared-branches
 * serving-op tests. Extracted from `shared-branches-api.test.ts` (FEA-4280) so
 * the focused `shared-branches-usage-degrade.test.ts` sibling can reuse the exact
 * same fixture wiring without duplicating it — and so the grandfathered
 * `shared-branches-api.test.ts` shrinks. Pure fixtures only; no test state.
 */

export type CannedRows = {
  links?: Record<string, unknown>[];
  prs?: Record<string, unknown>[];
  /** PRD-486: rows for the branch commit read (kind='commit' join). */
  commits?: Record<string, unknown>[];
  tokenAgg?: Record<string, unknown>[];
  usageTokens?: Record<string, unknown>[];
  usageEvents?: Record<string, unknown>[];
  /**
   * FEA-2276: per-session `{ session_id, branch_count }` rows for the detail's
   * even-split divisor read. Omitted → every session defaults to branch_count 1
   * (touches only this branch), matching these single-branch fixtures.
   */
  branchCounts?: Record<string, unknown>[];
  activitySegments?: Record<string, unknown>[];
  lifecycleEvents?: Record<string, unknown>[];
  sessionTokens?: Record<string, unknown>[];
  /** D1: when present, wires a fake `syncSource.loadSyncedSessions`. */
  sessions?: SyncedAgentSession[];
  canonicalActivity?: BranchCanonicalActivityRow[];
};

/**
 * One row the canned `token_events` read serves: the caller-authored snake_case
 * columns from `CannedRows.usageEvents` plus the two identity columns the real
 * read synthesizes. Stated explicitly because an object spread of
 * `Record<string, unknown>` DROPS the index signature — without this the mapped
 * rows type as just the two synthesized columns and the canned columns
 * (`source_identity`, `cost_summary`, …) become unreadable.
 */
type CannedUsageEventRow = {
  [column: string]: unknown;
  event_row_id: string;
  event_fingerprint: string;
};

export const SQL_SECRET = /SELECT|secret/;
export const KIND_BRANCH_RE = /kind = 'branch'/;
/** ISS-4941: the `created_at` lower bound pushed into the `token_events` scan. */
export const EVENT_WINDOW_START_RE = /te\.created_at >= \$1/;

/**
 * A `BranchSyncSource` whose `prisma.client` serves canned rows. The B1 branch
 * reads run on the single Prisma client. Two are TYPED delegates
 * (`sessionArtifactLink.findMany`, `artifact.findMany`); token reads and others
 * stay raw on `$queryRawUnsafe` (row array, no `{ rows }` envelope). The canned rows are
 * authored once in snake_case (the DB-column shape) and translated here into the
 * Prisma RESULT shape each typed read maps, so the real read mapping — incl. the
 * `activityAt` COALESCE and the bigint→number token coercion — is exercised.
 * `onQuery` fires for EVERY read (typed + raw) so the count / guard tests still
 * see one signal per read.
 */
export function makeSource(
  rows: CannedRows,
  onQuery?: (sql: string, parameters?: readonly unknown[]) => void
): BranchSyncSource {
  // Typed link read: session_artifact_links → branch artifact + session. Serves
  // both the link read and the usage read's first query (`distinct: ['sessionId']`
  // selecting `session.billingMode`). The canned `activity_at` is surfaced as
  // `ended_at` so the read's `endedAt ?? startedAt ?? observedAt` COALESCE
  // reproduces it; `billing_mode` (a per-session column) is authored on the link
  // row and feeds the usage read's session→billing scope.
  const sessionArtifactLink = {
    findMany: (args?: {
      distinct?: string[];
      where?: {
        artifact?: {
          kind?: string;
          branchName?: unknown;
          repoFullName?: string | null;
        };
      };
    }) => {
      // PLN-1148 branch-scoped commit read: session_artifact_links joined to a
      // kind='commit' artifact, selecting the commit columns off `artifact`.
      if (args?.where?.artifact?.kind === "commit") {
        onQuery?.("commits");
        return Promise.resolve(
          (rows.commits ?? []).map((c) => ({
            artifact: {
              sha: c.sha,
              committedAt: c.committed_at,
              title: c.message,
            },
          }))
        );
      }
      onQuery?.("links");
      let mapped = (rows.links ?? []).map((r) => ({
        sessionId: r.session_id,
        isPrimary: r.is_primary,
        observedAt: r.observed_at,
        artifact: {
          repoFullName: r.repo_full_name,
          branchName: r.branch_name,
          firstPushedAt:
            r.has_local_publication === false
              ? null
              : (r.first_pushed_at ?? r.observed_at),
          artifactLinks: [],
          linesAdded: r.lines_added ?? null,
          linesRemoved: r.lines_removed ?? null,
          filesChanged: r.files_changed ?? null,
        },
        session: {
          endedAt: r.activity_at ?? null,
          name: r.session_name ?? null,
          startedAt: null,
          billingMode: r.billing_mode ?? null,
          userId: r.user_id ?? null,
        },
      }));
      // PLN-1148 branch-scoped link read passes a STRING `branchName` (keyed to
      // one branch); honor it so the rewired detail's early-exit (empty rows →
      // null after a single read) and per-branch scoping are exercised. The
      // list/usage reads pass `branchName: { not: null }` (an object) and must
      // NOT be filtered — `typeof === "string"` distinguishes the two.
      const wantBranch = args?.where?.artifact?.branchName;
      if (typeof wantBranch === "string") {
        const wantRepo = args?.where?.artifact?.repoFullName ?? null;
        mapped = mapped.filter(
          (m) =>
            m.artifact.branchName === wantBranch &&
            (m.artifact.repoFullName ?? null) === wantRepo
        );
      }
      if (args?.distinct?.includes("sessionId")) {
        const seen = new Set<unknown>();
        return Promise.resolve(
          mapped.filter((m) => {
            if (seen.has(m.sessionId)) {
              return false;
            }
            seen.add(m.sessionId);
            return true;
          })
        );
      }
      return Promise.resolve(mapped);
    },
  };
  // Typed distinct-key read: branch artifacts deduped by (repo, branch) — the
  // mock collapses the canned link rows the way the engine's `distinct` would.
  const artifact = {
    findMany: () => {
      onQuery?.("distinctKeys");
      const seen = new Set<string>();
      const keys: Array<{
        repoFullName: unknown;
        branchName: unknown;
        firstPushedAt: unknown;
        artifactLinks: unknown[];
      }> = [];
      for (const r of rows.links ?? []) {
        const dedupeKey = JSON.stringify([r.repo_full_name, r.branch_name]);
        if (seen.has(dedupeKey)) {
          continue;
        }
        seen.add(dedupeKey);
        keys.push({
          repoFullName: r.repo_full_name,
          branchName: r.branch_name,
          firstPushedAt:
            r.has_local_publication === false
              ? null
              : (r.first_pushed_at ?? r.observed_at),
          artifactLinks: [],
        });
      }
      return Promise.resolve(keys);
    },
  };
  // PLN-1148 branch-scoped PR read: pull_requests keyed by (repo, branch). The
  // canned PR rows are snake_case (DB shape); translate to the Prisma camelCase
  // result the typed read maps.
  const pullRequest = {
    findMany: () => {
      onQuery?.("prs");
      return Promise.resolve(
        (rows.prs ?? []).map((r) => ({
          repoFullName: r.repo_full_name,
          branchName: r.branch_name,
          prNumber: r.pr_number ?? null,
          prUrl: r.pr_url,
          title: r.title ?? null,
          state: r.state ?? null,
          isDraft: r.is_draft ?? null,
          mergedAt: r.merged_at ?? null,
          closedAt: r.closed_at ?? null,
          openedAt: r.opened_at ?? null,
          observedAt: r.observed_at ?? null,
        }))
      );
    },
  };
  // FEA-2260 token reads: both the usage-path and (since FEA-4270) the
  // analytics-path JOIN sessions — the usage path additionally SELECTs
  // `s.billing_mode` for the subscription/API split, which the analytics path
  // omits. Both filter usageTokens to sessions the canned links reference and map
  // to the raw column shape; `withBilling` resolves the per-session billing_mode
  // the usage JOIN would surface. Extracted so `queryRaw` stays under the
  // cognitive-complexity ceiling.
  const mapUsageTokenRows = (withBilling: boolean) => {
    onQuery?.("usageTokens");
    const linkSet = new Set(
      (rows.links ?? []).map((r) => r.session_id as string)
    );
    const billingBySession = new Map<string, string | null>();
    // FEA-4270: the sessions JOIN also surfaces `s.started_at`. The mock has no
    // sessions table, so the link's `activity_at` (the canned session-time proxy
    // the link read already COALESCEs into the session's activity) is the default
    // start for each session — keeping pre-existing in-window fixtures counting.
    const startBySession = new Map<string, string | null>();
    for (const l of rows.links ?? []) {
      const sid = l.session_id as string;
      if (withBilling && !billingBySession.has(sid)) {
        billingBySession.set(sid, (l.billing_mode as string) ?? null);
      }
      if (!startBySession.has(sid)) {
        startBySession.set(sid, (l.activity_at as string) ?? null);
      }
    }
    return (rows.usageTokens ?? [])
      .filter((r) => linkSet.has(r.session_id as string))
      .map((r) => ({
        session_id: r.session_id,
        model: r.model,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_read_tokens: r.cache_read_tokens,
        cache_write_tokens: r.cache_write_tokens,
        cache_write_5m_tokens: r.cache_write_5m_tokens ?? null,
        cache_write_1h_tokens: r.cache_write_1h_tokens ?? null,
        ...(withBilling
          ? {
              billing_mode:
                billingBySession.get(r.session_id as string) ?? null,
            }
          : {}),
        created_at: r.created_at ?? null,
        // FEA-4270: `s.started_at AS session_started_at` from the sessions JOIN
        // (both usage + analytics reads now JOIN sessions). A canned row may set
        // it explicitly to exercise session-start spend windowing; absent, it
        // falls back to the row's own token time (`created_at`) and then the
        // linked session's `activity_at` proxy — both in-window for pre-existing
        // fixtures, so their windowed spend result is unchanged.
        session_started_at:
          (r.session_started_at as string | null | undefined) ??
          (r.created_at as string | null | undefined) ??
          startBySession.get(r.session_id as string) ??
          null,
        cost_usd_estimated: r.cost_usd_estimated ?? null,
      }));
  };
  // Ordered SQL-fragment → canned-rows-key dispatch for the passthrough reads.
  // Order is significant: lifecycle reads (`WITH pr_branch`) mention commits, so
  // they must match before the generic `kind = 'commit'` commit rail.
  const passthroughReads: [string, keyof CannedRows][] = [
    ["FROM session_activity_segments", "activitySegments"],
    ["WITH pr_branch", "lifecycleEvents"],
    ["branch_session_counts AS (", "sessionTokens"],
    ["kind = 'commit'", "commits"],
    ["FROM pull_requests", "prs"],
    ["GROUP BY l.repo_full_name", "tokenAgg"],
    // FEA-2276: the per-session even-split divisor read (GROUP BY session_id).
    ["GROUP BY session_id", "branchCounts"],
  ];
  const queryRaw = (sql: string, ...parameters: unknown[]) => {
    onQuery?.(sql, parameters);
    if (sql.includes("canonical_outside_events AS")) {
      return Promise.resolve(
        (rows.activitySegments ?? []).map((row, index) => ({
          row_kind: "segment",
          segment_id: String(row.id ?? `segment-${index + 1}`),
          session_id: row.session_id,
          phase: row.phase,
          start_ms: String(row.start_ms),
          end_ms: String(row.end_ms),
          confidence: row.confidence,
          event_side: null,
          representative_occurred_at: null,
          source_event_count: null,
          valid_cost_event_count: null,
          positive_cost_event_count: null,
          invalid_cost_value_present: null,
          cost_micro_cents: null,
          input_tokens: null,
          output_tokens: null,
          cache_read_tokens: null,
          cache_write_tokens: null,
          token_counts_invalid: null,
          candidate_count: (rows.activitySegments ?? []).length,
        }))
      );
    }
    if (sql.includes("FROM token_events")) {
      const eventRows = (rows.usageEvents ?? []).map<CannedUsageEventRow>(
        (row, index) => ({
          ...row,
          event_row_id: String(index + 1),
          event_fingerprint: `fingerprint-${index + 1}`,
        })
      );
      if (sql.includes("WITH evidence_size AS MATERIALIZED")) {
        const retainedBytes = eventRows.reduce(
          (total, row) =>
            total +
            Buffer.byteLength(
              `${String(row.source_identity ?? "")}${String(row.cost_summary ?? "")}`
            ) +
            branchCostEvidenceFixedRowBytes,
          0
        );
        return Promise.resolve(
          eventRows.map((row) => ({
            event_row_id: row.event_row_id,
            event_fingerprint: row.event_fingerprint,
            source_identity: row.source_identity ?? null,
            cost_summary: row.cost_summary ?? null,
            evidence_count: eventRows.length,
            retained_bytes: retainedBytes,
          }))
        );
      }
      return Promise.resolve(eventRows);
    }
    for (const [fragment, rowsKey] of passthroughReads) {
      if (sql.includes(fragment)) {
        return Promise.resolve(rows[rowsKey] ?? []);
      }
    }
    if (sql.includes("FROM token_usage tu")) {
      // Both token reads JOIN sessions (FEA-4270 added `s.started_at` to the
      // analytics path too), so the JOIN no longer distinguishes them. The
      // usage-path read is the one that SELECTS `s.billing_mode` for the
      // subscription/API split; the analytics path omits it. `withBilling`
      // resolves the per-session billing_mode the usage JOIN would surface.
      return Promise.resolve(mapUsageTokenRows(sql.includes("s.billing_mode")));
    }
    throw new Error(`unexpected SQL in test: ${sql.slice(0, 60)}`);
  };
  const sessions = rows.sessions;
  const syncSource = sessions
    ? {
        loadSyncedSessions: (ids: string[]) =>
          sessions.filter((session) => ids.includes(session.externalSessionId)),
      }
    : undefined;
  const client = {
    sessionArtifactLink,
    artifact,
    pullRequest,
    $queryRawUnsafe: queryRaw,
  };
  const prisma = {
    client,
    read: (read: (reader: typeof client) => Promise<unknown>) => read(client),
  } as unknown as DesktopPrisma;
  return {
    prisma,
    ...createBranchMetricEventEvidenceMethods(prisma),
    readBranchCanonicalActivityRows: (
      request: BranchCanonicalActivityReadRequest
    ) => {
      const branchKeys = request.branchKeys;
      onQuery?.(
        "canonicalActivity",
        branchKeys.flatMap((key) => [key.repoFullName, key.branchName])
      );
      const wanted = new Set(
        branchKeys.map(
          (key) => `${key.repoFullName ?? ""}\u0000${key.branchName}`
        )
      );
      return Promise.resolve(
        (rows.canonicalActivity ?? []).filter((row) =>
          wanted.has(`${row.repoFullName ?? ""}\u0000${row.branchName}`)
        )
      );
    },
    syncSource,
  } as unknown as BranchSyncSource;
}

/** Minimal `SyncedAgentSession` for the D1 detail-enrichment tests. */
export const syncedSession = (
  over: Partial<SyncedAgentSession> & { externalSessionId: string }
): SyncedAgentSession =>
  ({
    name: null,
    status: "completed",
    harness: "claude",
    model: "claude-sonnet-4-5",
    startedAt: "2026-06-10T10:00:00.000Z",
    updatedAt: "2026-06-10T10:00:00.000Z",
    endedAt: null,
    metadata: null,
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...over,
  }) as SyncedAgentSession;

// Every read — typed delegate OR raw — throws an SQL-shaped secret, so whichever
// read a serving op issues first proves the boundary sanitizes it to a code-only
// error (no SQL leak), independent of which read now runs first.
const throwSecret = () => {
  throw new Error("SELECT secret_column FROM secret_table");
};
export const throwingSource = {
  prisma: {
    client: new Proxy(
      {},
      {
        get: (_target, prop) =>
          prop === "$queryRawUnsafe" ? throwSecret : { findMany: throwSecret },
      }
    ),
  },
} as unknown as BranchSyncSource;

// ISS-4483 (review cid 3679616167, wongk): every read rejects with a db-host
// PROCESS-LIFECYCLE message (the child crash-looping / restarting mid-backfill),
// so a serving op proves the boundary rethrows the TRANSIENT code — not the fatal
// source-error code — for a db-host lifecycle blip.
const throwDbHostExited = () => {
  throw new Error("db-host exited (code: 1)");
};
export const dbHostLifecycleThrowingSource = {
  prisma: {
    client: new Proxy(
      {},
      {
        get: (_target, prop) =>
          prop === "$queryRawUnsafe"
            ? throwDbHostExited
            : { findMany: throwDbHostExited },
      }
    ),
  },
} as unknown as BranchSyncSource;

export const link = (over: Record<string, unknown>) => ({
  repo_full_name: "acme/web",
  branch_name: "feature/x",
  session_id: "s1",
  session_name: null,
  is_primary: true,
  observed_at: "2026-06-10T10:00:00.000Z",
  // Real session last-activity time (COALESCE(ended_at, started_at, observed_at)
  // in the read). Defaults to the observed time; FEA-2022 cases override it.
  activity_at: "2026-06-10T10:00:00.000Z",
  // Most serving-op fixtures model an already published Branch. Focused
  // dual-evidence tests opt out explicitly with `has_local_publication: false`.
  has_local_publication: true,
  ...over,
});

// PRD-486: one row of the branch commit read (kind='commit' joined via session).
export const commit = (over: Record<string, unknown>) => ({
  repo_full_name: "acme/web",
  branch_name: "feature/x",
  sha: "abc1234def5678",
  committed_at: "2026-06-12T08:00:00.000Z",
  message: "Do the thing",
  ...over,
});

/** One exactly attributed monitored-activity row returned by the fake DB host. */
export const canonicalActivity = (
  over: Partial<BranchCanonicalActivityRow> = {}
): BranchCanonicalActivityRow => ({
  repoFullName: "acme/web",
  branchName: "feature/x",
  sourceEventId: "monitored:activity-1",
  occurredAt: "2026-06-10T10:00:00.000Z",
  completeness: BranchActivityEvidenceCompleteness.Complete,
  ...over,
});

/**
 * FEA-4270: one per-event `token_events` row (the raw column shape
 * `readBranchUsageEventRows` maps). `createdAt` is the per-event instant the
 * windowed spend read keys on; `cost` is its captured per-event cost. Used to
 * mirror a session's aggregate tokens as an in/out-of-window event so windowed
 * spend counts by event time, not session start.
 */
export const eventFromToken = (
  sessionId: string,
  createdAt: string | null,
  inputTokens: number,
  outputTokens: number,
  cost: number | null = null
) => ({
  session_id: sessionId,
  model: "unknown-model",
  input_tokens: inputTokens,
  output_tokens: outputTokens,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  billing_mode: null,
  created_at: createdAt,
  session_started_at: createdAt,
  cost_usd_estimated: cost,
});

export const lifecycleEvent = (over: Record<string, unknown>) => ({
  link_id: "lifecycle-link",
  repo_full_name: "acme/web",
  branch_name: "feature/x",
  session_id: "s1",
  session_started_at: "2026-06-10T10:00:00.000Z",
  session_ended_at: "2026-06-10T11:00:00.000Z",
  ...over,
});

export function openPullRequestRow(prUrl = "https://gh/acme/web/pull/42") {
  return {
    repo_full_name: "acme/web",
    branch_name: "feature/x",
    pr_number: 42,
    pr_url: prUrl,
    title: "Feature X",
    state: "open",
    is_draft: false,
    opened_at: "2026-06-10T10:20:00.000Z",
    merged_at: null,
    closed_at: null,
    observed_at: "2026-06-10T10:20:00.000Z",
  };
}

/** Complete local evidence for the Desktop Build/Review/Rework parity case. */
export function phaseProjectionRows(): CannedRows {
  return {
    links: [link({ branch_name: "feature/x", session_id: "s1" })],
    prs: [openPullRequestRow()],
    tokenAgg: [
      {
        repo_full_name: "acme/web",
        branch_name: "feature/x",
        model: "claude-sonnet-4-5",
        input_tokens: 600,
        output_tokens: 300,
        cache_read_tokens: 60,
        cache_write_tokens: 30,
        raw_cost_usd_estimated: 0.9,
        cost_usd_estimated: 0.9,
      },
    ],
    sessionTokens: [
      {
        session_id: "s1",
        branch_count: 1,
        input_tokens: 600,
        output_tokens: 300,
        cache_read_tokens: 60,
        cache_write_tokens: 30,
        cost_usd_estimated: 0.9,
        even_split_cost_usd: 0.9,
      },
    ],
    lifecycleEvents: [
      lifecycleEvent({
        link_id: "branch-build",
        relation: ArtifactRefRelation.Created,
        method: "git_push",
        target_kind: ArtifactRefTargetKind.Branch,
        observed_at: "2026-06-10T10:05:00.000Z",
      }),
      lifecycleEvent({
        link_id: "pr-created",
        relation: ArtifactRefRelation.Created,
        method: "gh_pr_create",
        target_kind: ArtifactRefTargetKind.PullRequest,
        observed_at: "2026-06-10T10:20:00.000Z",
      }),
      lifecycleEvent({
        link_id: "pr-feedback",
        relation: ArtifactRefRelation.Reviewed,
        method: ArtifactRefMethod.PrReviewFeedbackCommand,
        target_kind: ArtifactRefTargetKind.PullRequest,
        observed_at: "2026-06-10T10:40:00.000Z",
      }),
      lifecycleEvent({
        link_id: "branch-rework",
        relation: ArtifactRefRelation.Output,
        method: "git_push",
        target_kind: ArtifactRefTargetKind.Branch,
        observed_at: "2026-06-10T10:50:00.000Z",
      }),
    ],
    sessions: [
      syncedSession({
        externalSessionId: "s1",
        startedAt: "2026-06-10T10:00:00.000Z",
        endedAt: "2026-06-10T11:00:00.000Z",
        tokenUsageByModel: [
          {
            model: "claude-sonnet-4-5",
            inputTokens: 600,
            outputTokens: 300,
            cacheReadTokens: 60,
            cacheWriteTokens: 30,
            estimatedCostUsd: 0.9,
          },
        ],
        activitySegmentRows: [
          phaseActivitySegment("plan", "10:00", "10:20"),
          phaseActivitySegment("other", "10:20", "10:45"),
          phaseActivitySegment("idle", "10:45", "11:00"),
        ],
        tokenEvents: [
          phaseTokenEvent("build", "10:05"),
          phaseTokenEvent("review", "10:40"),
          phaseTokenEvent("rework", "10:50"),
        ],
      }),
    ],
  };
}

export function almostEqual(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) < 0.000_000_001;
}

export function sumStackCost(
  stacks: readonly { estimatedCostUsd: number }[]
): number {
  return stacks.reduce((sum, stack) => sum + stack.estimatedCostUsd, 0);
}

export function sumStackInputTokens(
  stacks: readonly { inputTokens: number }[]
): number {
  return stacks.reduce((sum, stack) => sum + stack.inputTokens, 0);
}

function phaseActivitySegment(
  phase: string,
  start: string,
  end: string
): SyncedActivitySegmentRow {
  return {
    phase,
    startMs: Date.parse(`2026-06-10T${start}:00.000Z`),
    endMs: Date.parse(`2026-06-10T${end}:00.000Z`),
    confidence: 0.9,
    // The wire row carries its provenance too. Neither field reaches the branch
    // rollup (`buildBranchActivitySegments` reads only phase/span/confidence),
    // so the empty layer list keeps these fixtures evidence-free without moving
    // any assertion; the version is the classifier that would have emitted them.
    evidenceLayers: [],
    version: ACTIVITY_CLASSIFIER_VERSION,
  };
}

function phaseTokenEvent(externalEventId: string, time: string) {
  return {
    externalEventId,
    model: "claude-sonnet-4-5",
    inputTokens: 200,
    outputTokens: 100,
    cacheReadTokens: 20,
    cacheWriteTokens: 10,
    estimatedCostUsd: 0.3,
    createdAt: `2026-06-10T${time}:00.000Z`,
  };
}

/**
 * A canonical wire `BranchRow` builder for the desktop serving-op tests, so a
 * suite that needs a row shape (not the canned SQL rows above) does not
 * re-declare the full ~20-field DTO. Every field defaults to the "nothing
 * captured" value — a caller opts INTO the fields its assertion depends on.
 */
export function makeBranchRowFixture(
  over: Partial<BranchRow> & { id: string }
): BranchRow {
  const lastActivityAt = over.lastActivityAt ?? "2026-06-10T12:00:00.000Z";
  return {
    branchName: `feature/${over.id}`,
    baseBranch: null,
    repoFullName: "acme/web",
    owner: "alice",
    status: BranchStatus.Open,
    prNumber: null,
    prTitle: null,
    prState: null,
    prUrl: null,
    multiPrWarning: false,
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
    reviewDecision: null,
    ahead: null,
    behind: null,
    additions: null,
    deletions: null,
    filesChanged: null,
    estimatedCostUsd: null,
    lastActivityAt,
    canonicalLastActiveAt: {
      state: BranchMetricAvailability.Complete,
      value: lastActivityAt,
    },
    sessionIds: [],
    ...over,
  };
}

/**
 * The raw-SQL client behind a `makeSource()` source, rest-typed to match the
 * real `$queryRawUnsafe(sql, ...values)`. A bare `(sql: string)` signature
 * makes a proxy's captured `...args` forwarding untypeable while silently
 * dropping the bound parameters.
 */
export type RawQueryClient = {
  $queryRawUnsafe: (sql: string, ...values: unknown[]) => unknown;
};

/** Reach the raw-SQL client a `makeSource()` source wraps, for proxy tests. */
export function rawQueryClientOf(source: BranchSyncSource): RawQueryClient {
  return (source as unknown as { prisma: { client: RawQueryClient } }).prisma
    .client;
}
