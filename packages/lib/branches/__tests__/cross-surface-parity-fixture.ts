/**
 * PLN-1389 Phase 0 (PRD-522 R6) — Cross-surface branch-parity fixture (SSOT).
 *
 * WHY THIS EXISTS
 * The cloud branch read (`apps/api/app/branches/branch-read-service.ts`) and the
 * desktop-local branch read (`apps/desktop/src/main/branch/shared-branches-api.ts`
 * + `branch-analytics-projection.ts`) return the SAME `@repo/api/src/types/branch`
 * DTOs and share the same `@repo/lib/branches/{merged-trace,value-per-dollar}`
 * kernels — but each assembles the kernel inputs through its OWN projection
 * adapter over its OWN store (Postgres vs SQLite). Those two hand-written adapters
 * have drifted before (see the `value-per-dollar.ts` header: "net vs gross churn,
 * attribution vs even-split spend … shipped different numbers"). This fixture is
 * the guard against that drift.
 *
 * THE PATTERN (plan 0.4): "same fixture → assert cloud read == desktop-local read
 * == expected." The two surfaces live in different test runners (apps/api =
 * vitest + Postgres; apps/desktop = node:test + SQLite) and cannot share one
 * process, so instead of comparing the two live reads directly, BOTH read paths
 * are asserted against the SAME surface-invariant expectation computed here:
 *   - apps/api/app/branches/cross-surface-parity.integration.test.ts   (cloud)
 *   - apps/desktop/test/cross-surface-parity.test.ts                    (desktop)
 * If either adapter drifts, its own test fails. This module owns the scenario
 * (what to seed) AND the expected rollup (what both reads must produce), so the
 * two seed adapters can never silently encode different scenarios.
 *
 * SCOPE — only surface-INVARIANT facts are expected here. Deliberately excluded
 * because the surfaces legitimately differ (see the desktop read notes):
 *   - per-actor usage buckets (desktop collapses to one unattributed bucket),
 *   - `viewerScope` (Organization cloud vs Self local),
 *   - GitHub-only columns (checks/review/ahead/behind/baseBranch — null local),
 *   - `owner` display name (needs a warmed cloud org directory).
 *
 * This file is PURE data + pure functions (no test-runner / DB / electron imports)
 * so both runners can import it as
 * `@repo/lib/branches/__tests__/cross-surface-parity-fixture`.
 */

import type { BranchSession } from "@repo/api/src/types/branch";
import {
  aggregateBranchCostCompleteness,
  type BranchCostCompletenessResult,
  type BranchCostEvidenceContribution,
} from "@repo/api/src/types/branch-usage";
import type { HarnessType } from "@repo/api/src/types/compute-target";
import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
} from "@repo/api/src/types/token-cost-provenance";
import { attributeBranchSessionActivity } from "../activity-attribution";
import {
  type BranchActivityRollup,
  rollupBranchActivity,
} from "../activity-rollup";
import { MERGED_TRACE_IDLE_THRESHOLD_MS } from "../merged-trace";

export const CROSS_SURFACE_REPO_FULL_NAME = "acme/parity";
export const CROSS_SURFACE_BRANCH_NAME = "feature/cross-surface-parity";

/**
 * FEA-2276: a SECOND branch the multi-branch session also touches, so its spend
 * even-splits (branch_count = 2) — exercising the divisor on the branch total AND
 * the activity rollup. Both surface seeds link {@link CROSS_SURFACE_MULTI_BRANCH_SESSION_ID}
 * to this branch as well; the branch UNDER TEST stays {@link CROSS_SURFACE_BRANCH_NAME}.
 */
export const CROSS_SURFACE_SECOND_BRANCH_NAME =
  "feature/cross-surface-parity-secondary";
export const CROSS_SURFACE_BOUNDED_START = "2026-06-15T10:04:00.000Z";
export const CROSS_SURFACE_BOUNDED_END = "2099-01-01T00:00:00.000Z";

/** The session linked to BOTH branches (branchCount 2) — see the spec below. */
export const CROSS_SURFACE_MULTI_BRANCH_SESSION_ID = "parity-session-beta";

/**
 * Two distinct org users touch the branch (R6 multiplayer). On cloud each session
 * is ingested under its user's compute target; on desktop each is seeded with the
 * matching `sessions.user_id`. The AGGREGATE rollup must sum across both users
 * identically — the per-actor split is intentionally NOT parity-checked (local
 * collapses it).
 */
export const CROSS_SURFACE_USER_A = "parity-user-a";
export const CROSS_SURFACE_USER_B = "parity-user-b";

export type ParityTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
};

export type ParitySessionSpec = {
  /** Stable natural key seeded identically on both surfaces. */
  externalSessionId: string;
  userId: string;
  /** Canonical harness union (compile-checked) — not a free string. */
  harness: HarnessType;
  model: string;
  startedAt: string;
  endedAt: string;
  usage: ParityTokenUsage;
  /**
   * FEA-2276: how many active-write branches this session touches (the even-split
   * divisor). Default 1; `beta` is 2 (linked to {@link CROSS_SURFACE_SECOND_BRANCH_NAME}
   * too), so its spend halves on the branch under test.
   */
  branchCount?: number;
};

/**
 * Three sessions from two users, all linked to the branch under test. Two
 * FEA-2276 divisor cases are baked in:
 *   - `beta` also touches a SECOND branch (`branchCount` 2), so its captured cost
 *     even-splits — its Implement spend must read HALF on this branch, on both the
 *     branch total and the per-activity rollup.
 *   - `gamma` carries POSITIVE spend but NO tiling, so that spend must surface in
 *     the explicit `unattributed` bucket (not silently dropped) — the honest
 *     pre-backfill path FEA-2276 targets. Its cost also keeps the branch total
 *     comfortably above 0 (the `total > 0 ? … : null` policy).
 */
export const CROSS_SURFACE_SESSIONS: readonly ParitySessionSpec[] = [
  {
    externalSessionId: "parity-session-alpha",
    userId: CROSS_SURFACE_USER_A,
    harness: "claude",
    model: "claude-sonnet-4-6",
    startedAt: "2026-06-15T10:00:00.000Z",
    endedAt: "2026-06-15T10:20:00.000Z",
    usage: {
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 300,
      cacheWriteTokens: 40,
      estimatedCostUsd: 0.5,
    },
  },
  {
    externalSessionId: CROSS_SURFACE_MULTI_BRANCH_SESSION_ID,
    userId: CROSS_SURFACE_USER_B,
    harness: "codex",
    model: "gpt-5.5",
    startedAt: "2026-06-15T10:05:00.000Z",
    endedAt: "2026-06-15T10:15:00.000Z",
    usage: {
      inputTokens: 50,
      outputTokens: 80,
      cacheReadTokens: 120,
      cacheWriteTokens: 10,
      estimatedCostUsd: 0.25,
    },
    // Also linked to CROSS_SURFACE_SECOND_BRANCH_NAME → even-split divisor 2.
    branchCount: 2,
  },
  {
    externalSessionId: "parity-session-gamma",
    userId: CROSS_SURFACE_USER_A,
    harness: "claude",
    model: "claude-haiku-4-5-20251001",
    startedAt: "2026-06-15T10:40:00.000Z",
    endedAt: "2026-06-15T10:45:00.000Z",
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      // POSITIVE, un-tiled spend → must land in the `unattributed` bucket. Kept a
      // binary-exact value (0.25) so the even-split branch total (0.5 + 0.25/2 +
      // 0.25 = 0.875) is representable exactly and both surfaces' float/SQLite-REAL
      // summation agree bit-for-bit under the parity tests' strict equality.
      estimatedCostUsd: 0.25,
    },
  },
];

/**
 * One merged PR on the branch with COMPLETE LOC enrichment (both additions and
 * deletions present → `isLocEnriched`).
 *
 * FOLLOW-UP (not yet asserted): PR status/prState + LOC-enrichment parity (the
 * `isLocEnriched` / value-per-dollar kernel across surfaces, incl. the un-enriched
 * null path). The two surfaces source branch LOC differently — cloud sums
 * `BranchFileChange` rows; desktop falls back branch-artifact → PR-artifact LOC —
 * so a faithful LOC parity assertion seeds each surface's own LOC source to the
 * values below and asserts both expose them identically. Kept here as the SSOT
 * scenario for that follow-up; the current tests assert rollup + merged-trace.
 */
export const CROSS_SURFACE_PR = {
  number: 4242,
  state: "merged" as const,
  additions: 120,
  deletions: 30,
  filesChanged: 5,
  openedAt: "2026-06-15T09:00:00.000Z",
  mergedAt: "2026-06-15T12:00:00.000Z",
} as const;

// ── Surface-invariant expectation ───────────────────────────────────────────

/**
 * Per-session usage is structurally identical to `ParityTokenUsage`; kept as a
 * distinct name for call-site readability (branch rollup vs scenario input).
 */
export type ParityPerSessionUsage = ParityTokenUsage;

export type ExpectedBranchRollup = {
  /** Count of DISTINCT linked sessions. */
  sessionCount: number;
  /** Aggregate token sums across all linked sessions. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * Branch-detail EVEN-SPLIT cost: each session's captured cost divided by its
   * active-write branch count, summed. `beta` touches two branches (divisor 2), so
   * this is a NON-trivial even-split (0.5 + 0.25/2 + 0.25 = 0.875), not a naive
   * per-session sum — the exact value-per-dollar divergence that shipped different
   * numbers before (see `value-per-dollar.ts`). `null` when the sum is 0 (the
   * `total > 0 ? total : null` contract, both surfaces). The surfaces reach this
   * differently — cloud even-splits only the branch-level cost and keeps
   * per-session token/cost raw (`branch-read-service.ts` `evenSplitBranchCost`),
   * desktop's `branch_count` divisor also divides the token aggregates
   * (`branch-reads.ts`) — but both must land on this same total.
   */
  estimatedCostUsd: number | null;
  /** Per-session usage tuples, compared as an order-independent multiset. */
  perSession: readonly ParityPerSessionUsage[];
};

/** Sort key that makes per-session usage comparable without a cross-surface id. */
export function paritySessionUsageSortKey(u: ParityPerSessionUsage): string {
  return [
    u.inputTokens,
    u.outputTokens,
    u.cacheReadTokens,
    u.cacheWriteTokens,
    u.estimatedCostUsd,
  ].join("|");
}

// ── Merged-trace ordering (R6.3) ─────────────────────────────────────────────

/**
 * Idle-gap threshold, imported from the `@repo/lib/branches/merged-trace` kernel
 * both surfaces feed — NOT a re-declared literal. Re-encoding it would defeat the
 * point of this guard: if the kernel's threshold changed, a hand-copied constant
 * would keep both parity tests passing against a stale expectation.
 */
export const CROSS_SURFACE_IDLE_THRESHOLD_MS = MERGED_TRACE_IDLE_THRESHOLD_MS;

/**
 * One normalized merged-trace item: the surface-INVARIANT projection of a
 * `MergedTraceItem` that both surfaces must agree on. `tMs` is the item instant
 * as epoch-ms (`Date.parse(item.t)`) — compared numerically so a cross-surface
 * timestamp-string FORMAT difference is not mistaken for an ordering drift, while
 * a real mis-ordering (out-of-order `tMs`) still fails. `gapMs` is the synthesized
 * `idle` gap (`null` for non-idle items). The concrete `sessionId` is deliberately
 * excluded: it is a cloud artifact UUID vs a desktop external id and is not
 * comparable across surfaces.
 */
export type ExpectedTraceItem = {
  type: string;
  tMs: number;
  gapMs: number | null;
};

/**
 * Expected normalized merged-trace sequence — the surface-INVARIANT ordering both
 * `branchReadService.getBranchTrace` (cloud) and `getSharedBranchTrace` (desktop)
 * must produce. Both feed the SAME `buildMergedTrace` kernel, so the parity risk
 * is each surface's session-hydration adapter: this asserts both order the
 * branch's sessions chronologically (by `tMs`) AND synthesize the same `idle`
 * markers (position + `gapMs`). The scenario seeds no turn events, so each session
 * contributes exactly one synthesized `sessionstart` (stamped at its start), with
 * an `idle` inserted before any session more than the idle threshold after the
 * previous one — the `idle` is stamped at the PREVIOUS instant and carries the gap
 * (mirrors the kernel). Turn-item interleaving is a future enrichment.
 */
export function computeExpectedMergedTrace(): ExpectedTraceItem[] {
  const sorted = [...CROSS_SURFACE_SESSIONS].sort(
    (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)
  );
  const items: ExpectedTraceItem[] = [];
  let previousMs: number | null = null;
  for (const spec of sorted) {
    const ms = Date.parse(spec.startedAt);
    if (
      previousMs !== null &&
      ms - previousMs >= CROSS_SURFACE_IDLE_THRESHOLD_MS
    ) {
      items.push({ type: "idle", tMs: previousMs, gapMs: ms - previousMs });
    }
    items.push({ type: "sessionstart", tMs: ms, gapMs: null });
    previousMs = ms;
  }
  return items;
}

/** The session's even-split divisor (branchCount, defaulting to 1). */
function paritySessionDivisor(spec: ParitySessionSpec): number {
  return spec.branchCount != null && spec.branchCount > 0
    ? spec.branchCount
    : 1;
}

/** Compute the surface-invariant expected rollup from the scenario (pure). */
export function computeExpectedBranchRollup(): ExpectedBranchRollup {
  const sessions = CROSS_SURFACE_SESSIONS;
  const sum = (pick: (u: ParityTokenUsage) => number): number =>
    sessions.reduce((acc, s) => acc + pick(s.usage), 0);

  // EVEN-SPLIT the branch total: each session's captured cost divided by its
  // active-write branch count (beta → 2). Tokens are NOT even-split at the
  // per-session level either surface exposes, so their sums stay raw.
  const costTotal = sessions.reduce(
    (acc, s) => acc + s.usage.estimatedCostUsd / paritySessionDivisor(s),
    0
  );
  return {
    sessionCount: sessions.length,
    inputTokens: sum((u) => u.inputTokens),
    outputTokens: sum((u) => u.outputTokens),
    cacheReadTokens: sum((u) => u.cacheReadTokens),
    cacheWriteTokens: sum((u) => u.cacheWriteTokens),
    estimatedCostUsd: costTotal > 0 ? costTotal : null,
    // Per-session usage IS the scenario's usage (same shape) — copy to keep the
    // returned rollup independent of the frozen scenario objects.
    perSession: sessions.map((s) => ({ ...s.usage })),
  };
}

// ── FEA-2276 activity-rollup scenario + expectation ──────────────────────────
//
// Extends the R6 branch scenario with the per-session activity tiling +
// per-turn spend both surfaces upsync (cloud `agent_session_activity_segments` +
// `agent_session_token_events`; desktop `session_activity_segments` +
// `token_events`). The cloud read (`attachBranchActivitySegments`) and the
// desktop-local projection (`toEnrichedBranchSession`) BOTH run the shared
// `attributeBranchSessionActivity` kernel over these rows, so the branch cost-to-
// merge rollup must be identical on both surfaces. `computeExpectedActivityRollup`
// derives the surface-invariant expectation by running that SAME kernel + fold,
// so the expectation can't drift from production math.
//
// Coverage baked into the scenario:
//   - alpha: two spans (implement + review), fully-priced by two turns → per-phase
//     split within one session.
//   - beta:  one implement span, one turn, and branchCount 2 → the SAME phase
//     aggregates across two sessions (implement = alpha's + beta's EVEN-SPLIT
//     share), exercising the FEA-2276 per-session divisor in the rollup.
//   - gamma: NO tiling (pre-backfill) but POSITIVE spend → its whole spend/tokens
//     fall to the `unattributed` residual (positive, never dropped or fabricated
//     into a taxonomy bucket).

const ALPHA_START_MS = Date.parse("2026-06-15T10:00:00.000Z");
const BETA_START_MS = Date.parse("2026-06-15T10:05:00.000Z");
const TEN_MIN_MS = 10 * 60_000;

/** A raw classifier span in the scenario (epoch-ms half-open `[startMs, endMs)`). */
export type ParityActivitySegment = {
  phase: string;
  startMs: number;
  endMs: number;
  confidence: number;
};

/**
 * A per-turn spend event in the scenario (ISO instant + already-priced cost).
 * `costUsd: null` = an UNPRICED turn — seeded as cloud's non-nullable Decimal
 * `@default(0)` (estimatedCostUsd omitted) and desktop's NULL `cost_usd_estimated`,
 * so both backends' unpriced round-trip is exercised and must resolve identically.
 */
export type ParityTokenEvent = {
  createdAt: string;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
};

export type ParitySessionActivity = {
  segments: readonly ParityActivitySegment[];
  tokenEvents: readonly ParityTokenEvent[];
};

/**
 * Per-session activity scenario, keyed by `externalSessionId`. A session absent
 * from this map (gamma) carries NO tiling — the surfaces leave its
 * `activitySegments` absent and the rollup routes its spend to `unattributed`.
 * Each session's turn costs sum to its `usage.estimatedCostUsd` and its turn
 * tokens sum to its `usage.inputTokens`/`outputTokens`, so the attributed totals
 * reconcile exactly (no incidental gap) — the gap under test is gamma's whole,
 * untiled spend.
 */
export const CROSS_SURFACE_ACTIVITY: Readonly<
  Record<string, ParitySessionActivity>
> = {
  "parity-session-alpha": {
    segments: [
      {
        phase: "implement",
        startMs: ALPHA_START_MS,
        endMs: ALPHA_START_MS + TEN_MIN_MS,
        confidence: 0.9,
      },
      {
        phase: "review",
        startMs: ALPHA_START_MS + TEN_MIN_MS,
        endMs: ALPHA_START_MS + 2 * TEN_MIN_MS,
        confidence: 0.8,
      },
    ],
    tokenEvents: [
      {
        createdAt: "2026-06-15T10:05:00.000Z",
        costUsd: 0.3,
        inputTokens: 60,
        outputTokens: 120,
      },
      // UNPRICED turn inside the implement span — exercises the cloud-0 / desktop-
      // NULL round-trip on a real backend. Zero tokens + null cost, so it changes
      // no expectation (the span is already priced by the turn above); its only job
      // is to prove both stores map "unpriced" to the same not-priced result.
      {
        createdAt: "2026-06-15T10:03:00.000Z",
        costUsd: null,
        inputTokens: 0,
        outputTokens: 0,
      },
      {
        createdAt: "2026-06-15T10:15:00.000Z",
        costUsd: 0.2,
        inputTokens: 40,
        outputTokens: 80,
      },
    ],
  },
  "parity-session-beta": {
    segments: [
      {
        phase: "implement",
        startMs: BETA_START_MS,
        endMs: BETA_START_MS + TEN_MIN_MS,
        confidence: 0.95,
      },
    ],
    tokenEvents: [
      {
        createdAt: "2026-06-15T10:10:00.000Z",
        costUsd: 0.25,
        inputTokens: 50,
        outputTokens: 80,
      },
    ],
  },
};

/**
 * Build a `BranchSession` (the shape the rollup folds) from a scenario session,
 * running the shared attribution kernel over its tiling when present. Absent
 * tiling → `activitySegments` omitted (never `[]`), mirroring the producers.
 */
function paritySessionForRollup(
  spec: (typeof CROSS_SURFACE_SESSIONS)[number]
): BranchSession {
  const activity = CROSS_SURFACE_ACTIVITY[spec.externalSessionId];
  const activitySegments = activity
    ? attributeBranchSessionActivity(
        activity.segments,
        activity.tokenEvents.map((event) => ({
          tMs: Date.parse(event.createdAt),
          costUsd: event.costUsd,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        }))
      )
    : undefined;
  return {
    sessionId: spec.externalSessionId,
    slug: null,
    name: spec.externalSessionId,
    harness: spec.harness,
    startedAt: spec.startedAt,
    endedAt: spec.endedAt,
    isPrimary: false,
    // The producers stamp the session's global branch count; mirror it so the
    // rollup even-splits beta's attributed cost exactly as the real reads do.
    branchCount: paritySessionDivisor(spec),
    // Owner display name is deliberately NOT parity-checked (surfaces differ);
    // the rollup ignores it, so null keeps the fixture honest.
    ownerUserName: null,
    estimatedCostUsd: spec.usage.estimatedCostUsd,
    inputTokens: spec.usage.inputTokens,
    outputTokens: spec.usage.outputTokens,
    cacheReadTokens: spec.usage.cacheReadTokens,
    cacheWriteTokens: spec.usage.cacheWriteTokens,
    ...(activitySegments === undefined ? {} : { activitySegments }),
  };
}

/**
 * The surface-invariant expected branch activity rollup. Both surface reads must
 * produce `rollupBranchActivity(detail)` deep-equal to this. Computed by running
 * the production kernels over the scenario, so a kernel change updates the
 * expectation in lock-step with both surfaces (no hand-copied numbers to drift).
 */
export function computeExpectedActivityRollup(): BranchActivityRollup {
  const sessions = CROSS_SURFACE_SESSIONS.map(paritySessionForRollup);
  // EVEN-SPLIT reconciliation total, matching the branch detail (beta ÷ 2).
  const costTotal = CROSS_SURFACE_SESSIONS.reduce(
    (acc, spec) =>
      acc + spec.usage.estimatedCostUsd / paritySessionDivisor(spec),
    0
  );
  return rollupBranchActivity({
    sessions,
    estimatedCostUsd: costTotal > 0 ? costTotal : null,
  });
}

/** Canonical provenance seeded into both cloud and Desktop parity stores. */
export function parityCostEvidenceForEvent(
  sessionId: string,
  index: number,
  costUsd: number | null
) {
  const sourceIdentity = {
    availability: TokenSourceIdentityAvailability.Available,
    scheme: "parity-fixture",
    sourceRecordIds: [`${sessionId}:${index}`],
  };
  return {
    sourceIdentity,
    ...(costUsd === null
      ? {}
      : {
          costSummary: {
            completeness: TokenCostCompleteness.Complete,
            subtotalUsd: costUsd,
            lanes: [
              { basis: TokenCostBasis.ApiEstimated, subtotalUsd: costUsd },
            ],
          },
        }),
  };
}

/** Surface-invariant Branch completeness expected from the shared scenario. */
export function computeExpectedCostCompleteness(): BranchCostCompletenessResult {
  const contributions: BranchCostEvidenceContribution[] = [];
  for (const spec of CROSS_SURFACE_SESSIONS) {
    const events = CROSS_SURFACE_ACTIVITY[spec.externalSessionId]?.tokenEvents;
    if (!events) {
      contributions.push({
        sourceIdentity: {
          availability: TokenSourceIdentityAvailability.Unavailable,
          reason: TokenSourceIdentityUnavailableReason.LegacyRecord,
        },
        fallbackSubtotalUsd: spec.usage.estimatedCostUsd,
        coverageIncomplete: true,
      });
      continue;
    }
    const eventTokenTotal = events.reduce(
      (total, event) => total + event.inputTokens + event.outputTokens,
      0
    );
    const lifetimeTokenTotal =
      spec.usage.inputTokens +
      spec.usage.outputTokens +
      spec.usage.cacheReadTokens +
      spec.usage.cacheWriteTokens;
    for (const [index, event] of events.entries()) {
      contributions.push({
        ...parityCostEvidenceForEvent(
          spec.externalSessionId,
          index,
          event.costUsd
        ),
        ...(event.costUsd === null
          ? {}
          : { fallbackSubtotalUsd: event.costUsd }),
        ...(eventTokenTotal === lifetimeTokenTotal
          ? {}
          : { coverageIncomplete: true }),
      });
    }
  }
  return aggregateBranchCostCompleteness(contributions);
}

/** Expected completeness for the real-store event window shared by both adapters. */
export function computeExpectedBoundedCostCompleteness(): BranchCostCompletenessResult {
  const startMs = Date.parse(CROSS_SURFACE_BOUNDED_START);
  const endMs = Date.parse(CROSS_SURFACE_BOUNDED_END);
  const contributions: BranchCostEvidenceContribution[] = [];
  for (const spec of CROSS_SURFACE_SESSIONS) {
    const events = CROSS_SURFACE_ACTIVITY[spec.externalSessionId]?.tokenEvents;
    if (!events) {
      continue;
    }
    for (const [index, event] of events.entries()) {
      const eventMs = Date.parse(event.createdAt);
      if (eventMs < startMs || eventMs > endMs) {
        continue;
      }
      contributions.push({
        ...parityCostEvidenceForEvent(
          spec.externalSessionId,
          index,
          event.costUsd
        ),
        ...(event.costUsd === null
          ? {}
          : { fallbackSubtotalUsd: event.costUsd }),
      });
    }
  }
  return aggregateBranchCostCompleteness(contributions);
}
