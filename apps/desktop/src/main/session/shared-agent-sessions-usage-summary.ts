/**
 * The canonical local usage-summary fold, in both of its forms.
 *
 * #4150: extracted from `shared-agent-sessions-api.ts` (a shrink-only
 * grandfathered file). The two folds live side by side ON PURPOSE — they are
 * the hydrate path (`buildUsageSummary`, one pass over hydrated sessions) and
 * the O(grouped) SQL fast path (`foldUsageAggregate`) for the SAME summary
 * contract, and they must stay in parity for the same corpus. Keeping them in
 * one module makes a divergence visible in one diff instead of two.
 */
import { buildModelFilterOptionsFromCounts } from "@repo/api/src/agent-session-model-facet";
import {
  type BillingLedger,
  billingLedger,
  normalizeBillingMode,
} from "../../shared/billing-mode.js";
import {
  type SharedAgentSessionHarnessBreakdown,
  type SharedAgentSessionRepositoryBreakdown,
  type SharedAgentSessionUsageByModel,
  type SharedAgentSessionUsageSummary,
  UNKNOWN_HARNESS_BUCKET,
} from "../../shared/shared-agent-sessions-contract.js";
import type { AgentSessionUsageAggregate } from "../agent-sync/agent-session-read-model.js";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import {
  billingModeAt,
  resolveBillingModesNonBlocking,
} from "../cost/billing-mode-detector.js";
import {
  accumulateOwnerTotals,
  buildByUserFromCounts,
  buildByUserRollupFromTotals,
  createOwnerTotalsAccumulator,
  getOrgDirectorySnapshot,
  type OwnerTotalsAccumulator,
} from "./org-directory-cache.js";
import {
  accumulateUsageRepositoryTotals,
  mapAggregateRepoCountsToBreakdowns,
} from "./session-repository-facet.js";
import {
  addSessionToHarnessBreakdown,
  addTotals,
  getOrCreateModelSummary,
  getSessionLedger,
  type SessionTotals,
  sumTokenUsage,
  zeroTotals,
} from "./session-usage-totals.js";

export function buildUsageSummary(
  sessions: readonly SyncedAgentSession[]
): SharedAgentSessionUsageSummary {
  const fold = createUsageSummaryFold();
  for (const session of sessions) {
    addSessionToUsageSummaryFold(fold, session);
  }
  return finishUsageSummaryFold(fold);
}

/**
 * ISS-6895: the running state of {@link buildUsageSummary}, held so the fold can
 * be driven one hydration window at a time instead of over one array holding the
 * whole matched population. Every member is keyed by a DIMENSION (model,
 * harness, repository, owner) or is a scalar, so the accumulator's size is
 * bounded by the corpus's cardinality, never by its row count — that is what
 * lets the desktop summary cover a population above any hydration window while
 * peak memory stays bounded by one window.
 *
 * That property is a claim about EVERY member, VALUES included, so the
 * per-dimension distinct-session counts are plain counters. They were `Set`s of
 * session id, which made `byModel`/`byHarness` O(rows) — one retained id per
 * session for the whole read — and quietly reintroduced the corpus-sized
 * residency the windowed fold exists to remove. Counters are exact here because
 * a session reaches the fold exactly once (ids are deduped by `sanitizeIds`),
 * and the only many-per-session dimension (`byModel`, via `tokenUsageByModel`)
 * dedupes locally within the session. This also matches the SQL twin
 * `foldUsageAggregate`, which has always counted with `+=`.
 */
export type UsageSummaryFold = {
  byModel: Map<string, SharedAgentSessionUsageByModel>;
  byHarness: Map<string, SharedAgentSessionHarnessBreakdown>;
  totals: SessionTotals;
  ledgerTotals: Record<BillingLedger, number>;
  byUser: OwnerTotalsAccumulator;
  primaryModelSessionCounts: Map<string, number>;
  byRepository: Map<string, SharedAgentSessionRepositoryBreakdown>;
  sessionCount: number;
  earliestStartMs: number | null;
  latestStartMs: number | null;
};

export function createUsageSummaryFold(): UsageSummaryFold {
  return {
    byModel: new Map(),
    byHarness: new Map(),
    totals: zeroTotals(),
    ledgerTotals: { metered: 0, subscription: 0, unknown: 0 },
    byUser: createOwnerTotalsAccumulator(),
    // FEA-4303: per-PRIMARY-model (`session.model`) session counts — one
    // increment per session on the single displayed model. Sources the Model
    // filter facet options so they share the primary-model vocabulary of the
    // Model column and the predicate, unlike `byModel` (which spans
    // secondary/subagent models).
    primaryModelSessionCounts: new Map(),
    // FEA-4299: Repository facet options (see `accumulateUsageRepositoryTotals`).
    byRepository: new Map(),
    sessionCount: 0,
    earliestStartMs: null,
    latestStartMs: null,
  };
}

export function addSessionToUsageSummaryFold(
  fold: UsageSummaryFold,
  session: SyncedAgentSession
): void {
  fold.sessionCount += 1;
  // Bounds skip rows with no real start (see `parseBoundsStartMs`), mirroring
  // SQL MIN/MAX and the API's Prisma _min/_max.
  const startMs = parseBoundsStartMs(session.startedAt);
  if (startMs !== null) {
    if (fold.earliestStartMs === null || startMs < fold.earliestStartMs) {
      fold.earliestStartMs = startMs;
    }
    if (fold.latestStartMs === null || startMs > fold.latestStartMs) {
      fold.latestStartMs = startMs;
    }
  }
  const sessionTotals = sumTokenUsage(session);
  addTotals(fold.totals, sessionTotals);
  fold.ledgerTotals[getSessionLedger(session)] += sessionTotals.estimatedCost;
  addSessionToHarnessBreakdown(fold.byHarness, session, sessionTotals);
  // ISS-4613: every session contributes to the Owner (`byUser`) facet, over
  // the SAME all-quality corpus as `totalSessions` and every sibling facet
  // (see the SQL twin's `userResult` in sync-source.ts).
  accumulateOwnerTotals(fold.byUser, session.userId ?? null, sessionTotals);
  accumulateUsageRepositoryTotals(fold.byRepository, session, sessionTotals);

  // FEA-4303: one count per session on its primary model (see helper).
  tallyPrimaryModel(fold.primaryModelSessionCounts, session.model ?? null);

  // ISS-6895: `tokenUsageByModel` can carry SEVERAL rows for the same model, so
  // the per-model distinct-session count needs deduplication — but only WITHIN
  // this session. This local set is bounded by one session's model cardinality
  // and is released with the session; the fold itself keeps only a counter, so
  // no per-row identity outlives the row. Token totals below still sum EVERY
  // usage row, deduped or not.
  const countedModels = new Set<string>();
  for (const usage of session.tokenUsageByModel) {
    const model = usage.model || "unknown";
    const modelSummary = getOrCreateModelSummary(fold.byModel, model);
    if (!countedModels.has(model)) {
      countedModels.add(model);
      modelSummary.sessionCount += 1;
    }
    modelSummary.inputTokens += usage.inputTokens;
    modelSummary.outputTokens += usage.outputTokens;
    modelSummary.cacheReadTokens += usage.cacheReadTokens;
    modelSummary.cacheWriteTokens += usage.cacheWriteTokens;
    modelSummary.estimatedCost += usage.estimatedCostUsd ?? 0;
  }
}

export function finishUsageSummaryFold(
  fold: UsageSummaryFold
): SharedAgentSessionUsageSummary {
  const { ledgerTotals, totals } = fold;
  return {
    viewerScope: "self",
    totalSessions: fold.sessionCount,
    earliestSessionAt:
      fold.earliestStartMs === null
        ? null
        : new Date(fold.earliestStartMs).toISOString(),
    latestSessionAt:
      fold.latestStartMs === null
        ? null
        : new Date(fold.latestStartMs).toISOString(),
    totalInputTokens: totals.inputTokens,
    totalOutputTokens: totals.outputTokens,
    totalCacheReadTokens: totals.cacheReadTokens,
    totalCacheWriteTokens: totals.cacheWriteTokens,
    // FEA-3986: subscription-INCLUSIVE grand total, folded from all three ledgers so it equals subscription + API by construction (the cloud `/agent-sessions/usage` one-snapshot contract).
    totalEstimatedCost:
      ledgerTotals.metered + ledgerTotals.unknown + ledgerTotals.subscription,
    subscriptionEstimatedCost: ledgerTotals.subscription,
    apiEstimatedCost: ledgerTotals.metered + ledgerTotals.unknown,
    // ISS-4773: publish the two halves this local ledger has ALWAYS tracked
    // separately but collapsed on the wire. The cloud producer now emits the same
    // pair, so a surface can report confirmed spend without counting usage whose
    // billing mode was never determined.
    meteredEstimatedCost: ledgerTotals.metered,
    unknownEstimatedCost: ledgerTotals.unknown,
    // Owner rollup resolved against the cloud org directory (empty until it loads).
    byUser: buildByUserRollupFromTotals(fold.byUser, getOrgDirectorySnapshot()),
    byModel: [...fold.byModel.values()],
    // FEA-4303: Model filter facet options grouped by the primary displayed model
    // (shares the vocabulary of the Model column and the local Model predicate).
    modelFilterOptions: buildModelFilterOptionsFromCounts(
      [...fold.primaryModelSessionCounts.entries()].map(
        ([model, sessionCount]) => ({
          model,
          sessionCount,
        })
      )
    ),
    byHarness: [...fold.byHarness.values()],
    byRepository: [...fold.byRepository.values()],
    lastSyncTargets: [],
  };
}

/**
 * Fold the O(grouped) usage aggregate (FEA-1834 / PLN-941 §4) into the canonical
 * summary, matching `buildUsageSummary` for the same corpus.
 *
 * Cost is folded from persisted token_usage estimates. The ledger bucket uses
 * each group's resolved billing mode (re-resolved from the live environment,
 * never read as the raw column, same as the hydrate path's
 * `session.billingMode`). ISS-12120: this fold runs on the Electron main thread
 * (the Sessions usage IPC), so it resolves through the non-blocking resolver,
 * which never waits on the Keychain probe synchronously. `byHarness` is
 * enumerated from `harnessSessionCounts` so harnesses whose sessions carry zero
 * token rows still appear with their session count (the token join alone cannot
 * see them).
 */
export async function foldUsageAggregate(
  aggregate: AgentSessionUsageAggregate
): Promise<SharedAgentSessionUsageSummary> {
  const groupModes = await resolveBillingModesNonBlocking(
    aggregate.tokenGroups.map((group) => ({
      billingMode: group.billingMode,
      harness: group.harness,
      model: null,
    }))
  );
  const totals = zeroTotals();
  const ledgerTotals: Record<BillingLedger, number> = {
    metered: 0,
    subscription: 0,
    unknown: 0,
  };
  const byModel = new Map<string, SharedAgentSessionUsageByModel>();
  const byHarnessTokens = new Map<string, SessionTotals>();

  for (const [index, group] of aggregate.tokenGroups.entries()) {
    const cost = group.estimatedCostUsd ?? 0;

    totals.inputTokens += group.inputTokens;
    totals.outputTokens += group.outputTokens;
    totals.cacheReadTokens += group.cacheReadTokens;
    totals.cacheWriteTokens += group.cacheWriteTokens;

    const ledger = billingLedger(
      normalizeBillingMode(billingModeAt(groupModes, index))
    );
    ledgerTotals[ledger] += cost;

    const modelKey = group.model || "unknown";
    const modelSummary = byModel.get(modelKey) ?? {
      model: modelKey,
      sessionCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: 0,
    };
    modelSummary.inputTokens += group.inputTokens;
    modelSummary.outputTokens += group.outputTokens;
    modelSummary.cacheReadTokens += group.cacheReadTokens;
    modelSummary.cacheWriteTokens += group.cacheWriteTokens;
    modelSummary.estimatedCost += cost;
    modelSummary.sessionCount += group.sessionCount;
    byModel.set(modelKey, modelSummary);

    const harnessKey = group.harness ?? UNKNOWN_HARNESS_BUCKET;
    const harnessTokens = byHarnessTokens.get(harnessKey) ?? zeroTotals();
    harnessTokens.inputTokens += group.inputTokens;
    harnessTokens.outputTokens += group.outputTokens;
    harnessTokens.cacheReadTokens += group.cacheReadTokens;
    harnessTokens.cacheWriteTokens += group.cacheWriteTokens;
    harnessTokens.estimatedCost += cost;
    byHarnessTokens.set(harnessKey, harnessTokens);
  }

  // Normalize harness keys before assembling buckets. SQL groups by the raw
  // column, so a NULL harness and a literal "unknown" harness arrive as separate
  // rows; the hydrate path keys both under "unknown" (`session.harness ?? "unknown"`)
  // and merges them, so we sum their session counts into one bucket too —
  // otherwise byHarness would carry duplicate "unknown" entries.
  const harnessSessionCounts = new Map<string, number>();
  for (const entry of aggregate.harnessSessionCounts) {
    const harnessKey = entry.harness ?? UNKNOWN_HARNESS_BUCKET;
    harnessSessionCounts.set(
      harnessKey,
      (harnessSessionCounts.get(harnessKey) ?? 0) + entry.sessionCount
    );
  }
  const byHarness: SharedAgentSessionHarnessBreakdown[] = [
    ...harnessSessionCounts.entries(),
  ].map(([harnessKey, sessionCount]) => {
    const tokens = byHarnessTokens.get(harnessKey) ?? zeroTotals();
    return {
      harness: harnessKey,
      sessionCount,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cacheReadTokens: tokens.cacheReadTokens,
      cacheWriteTokens: tokens.cacheWriteTokens,
      estimatedCost: tokens.estimatedCost,
    };
  });

  return {
    viewerScope: "self",
    totalSessions: aggregate.totalSessions,
    earliestSessionAt: aggregate.earliestSessionAt,
    latestSessionAt: aggregate.latestSessionAt,
    totalInputTokens: totals.inputTokens,
    totalOutputTokens: totals.outputTokens,
    totalCacheReadTokens: totals.cacheReadTokens,
    totalCacheWriteTokens: totals.cacheWriteTokens,
    // FEA-3986 subscription-INCLUSIVE total (all three ledgers; see `buildUsageSummary`).
    totalEstimatedCost:
      ledgerTotals.metered + ledgerTotals.unknown + ledgerTotals.subscription,
    subscriptionEstimatedCost: ledgerTotals.subscription,
    apiEstimatedCost: ledgerTotals.metered + ledgerTotals.unknown,
    // ISS-4773: publish the two halves this local ledger has ALWAYS tracked
    // separately but collapsed on the wire. The cloud producer now emits the same
    // pair, so a surface can report confirmed spend without counting usage whose
    // billing mode was never determined.
    meteredEstimatedCost: ledgerTotals.metered,
    unknownEstimatedCost: ledgerTotals.unknown,
    // Owner facet on the O(grouped) fast path (counts only; identity from the cloud org directory).
    byUser: buildByUserFromCounts(
      aggregate.userSessionCounts ?? [],
      getOrgDirectorySnapshot()
    ),
    byModel: [...byModel.values()],
    // FEA-4303: Model filter facet options, grouped by the PRIMARY displayed
    // model (`sessions.model`) via the SQL primary-model GROUP BY — the same
    // vocabulary the local Model predicate matches and the Model column paints,
    // NOT the secondary-model-spanning `byModel`. Older sources that predate the
    // aggregate field leave it undefined → the facet falls back to no options.
    modelFilterOptions: buildModelFilterOptionsFromCounts(
      aggregate.primaryModelSessionCounts
    ),
    byHarness,
    // FEA-4299: Repository facet options (see `mapAggregateRepoCountsToBreakdowns`).
    byRepository: mapAggregateRepoCountsToBreakdowns(
      aggregate.repoSessionCounts ?? []
    ),
    lastSyncTargets: [],
  };
}

// FEA-4303: increment the per-primary-model session count by one. A null primary
// model is skipped here and dropped downstream by
// `buildModelFilterOptionsFromCounts` (no Model value to filter to) — mirroring
// the SQL fast path's `GROUP BY s.model` + null-drop so the hydrate and O(grouped)
// usage paths emit identical Model facet options for the same corpus.
function tallyPrimaryModel(
  counts: Map<string, number>,
  primaryModel: string | null
): void {
  if (primaryModel != null) {
    counts.set(primaryModel, (counts.get(primaryModel) ?? 0) + 1);
  }
}

// Date-prefix guard mirroring the sqlite `SESSION_STARTED_AT_BOUNDS_EXPR`
// (`^\d{4}-\d{2}-\d{2}`): a row contributes to the earliest/latest bounds only
// when its `started_at` is a real ISO timestamp. NULL/empty/malformed values
// return null (excluded from MIN/MAX) instead of the epoch-1970 fallback
// `parseSessionDate` uses for filtering, so one legacy row can't make the
// date-range label read "Jan 1, 1970".
const SESSION_STARTED_AT_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

function parseBoundsStartMs(value: string | null | undefined): number | null {
  if (!(value && SESSION_STARTED_AT_DATE_PREFIX.test(value))) {
    return null;
  }
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}
