/**
 * @file reconciliation-worker.ts
 * @description Desktop-main (ESM) nightly cost-reconciliation worker
 * (FEA-1435/1436). It compares the LOCAL genai-prices estimate (computed from
 * the token usage the sidecar recorded in dashboard.db) against what each vendor
 * ACTUALLY billed (fetched from the vendor Admin cost APIs), records the drift
 * per (day × vendor × model), and surfaces a notice — with a ranked plain-English
 * cause hint — for any reconciled cell whose drift exceeds the notice threshold.
 *
 * ── Where this runs, and what it never touches ───────────────────────────────
 * Entirely in desktop-main. Reconciliation depends on org-level Admin keys (OS
 * keychain, main-only) and makes outbound calls to the vendor billing APIs. The
 * worker reads the in-process agent database READ-ONLY through the shared
 * connection (FEA-1497). The effective token counts fold the pre-compaction
 * baselines into the standard columns (`input_tokens + baseline_*`, FEA-3390)
 * so a compacted session reconciles its full incurred spend, not just the
 * post-compaction subset. It performs NO pricing of its own beyond calling the
 * shared genai-prices engine (`token-cost.ts`), which TRUSTS the library for
 * every rate — the worker never overrides, clamps, or invents a price.
 *
 * ── Reconciliation grain, per vendor ─────────────────────────────────────────
 * The drift cell is (day, vendor, model). The two vendors expose different
 * grains, so the model dimension is normalized to match what each vendor can
 * actually attribute:
 *   • Anthropic's cost_report breaks token costs out per model, so we reconcile
 *     PER MODEL. Server-side tool costs (web_search/code_execution) arrive with
 *     model:null and are bucketed under the {@link ANTHROPIC_TOOLS_MODEL}
 *     sentinel — the local token-based estimate has no entry there, so they read
 *     as a (correct) under-estimate explained by the server_side_tool_use hint.
 *   • OpenAI's costs endpoint has NO per-model dimension, so we reconcile at DAY
 *     GRAIN: the local estimate is summed across every OpenAI model for the day
 *     and compared, under the {@link OPENAI_DAY_GRAIN_MODEL} sentinel, against
 *     the vendor's day total — rather than fabricating a per-model split the
 *     vendor never provided.
 *
 * ── Fail-honest, never fabricate ─────────────────────────────────────────────
 * Only metered (real per-token API) sessions are reconciled — subscription/seat
 * usage is excluded via the shared billing-mode rule. Unpriced models contribute
 * nothing to the local estimate (no silent $0 invented). A vendor with no
 * configured Admin key is skipped entirely rather than reconciled against a
 * zero bill. The vendor clients throw on a partial page rather than understate.
 */
import type { DatabaseSync } from "node:sqlite";
import { isMeteredApi } from "../../shared/billing-mode.js";
import { computeTokenCost } from "../../shared/token-cost.js";
import type { VendorBilledEntry } from "./admin-billing.js";
import { resolveBillingMode } from "./billing-mode-detector.js";
import { computeDrift, sumMicroCents, usdToMicroCents } from "./cost-math.js";
import {
  type DriftCauseHint,
  rankDriftCauses,
} from "./reconciliation-cause-hint.js";
import type {
  ReconciliationRow,
  ReconciliationStore,
} from "./reconciliation-store.js";

/** Drift magnitude (percent of the vendor bill) above which a notice is raised. */
const DRIFT_NOTICE_PCT = 5;

/** Default reconciliation window: how many days back from `now` to reconcile. */
const DEFAULT_WINDOW_DAYS = 35;

/**
 * Sentinel "model" under which OpenAI is reconciled at day grain (local summed
 * across all OpenAI models for the day vs the vendor's day total).
 */
export const OPENAI_DAY_GRAIN_MODEL = "(all openai models)";

/**
 * Sentinel "model" for Anthropic server-side tool costs (web_search /
 * code_execution) that the vendor reports with no model id.
 */
export const ANTHROPIC_TOOLS_MODEL = "(server-side tools)";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** One (session × model) token-usage row, effective counts already summed. */
export type MeteredUsageRow = {
  sessionId: string;
  /** Model id as stored in the dashboard DB. */
  model: string;
  /** Session start (RFC 3339); supplies both the day and the pricing timestamp. */
  startedAt: string;
  /** Resolved billing mode (only metered rows are reconciled). */
  billingMode: ReturnType<typeof resolveBillingMode>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/** A reconciled cell whose drift crossed the notice threshold, with cause hints. */
export type DriftNotice = {
  day: string;
  vendor: string;
  model: string;
  localEstimateMicroCents: number;
  vendorBilledMicroCents: number;
  driftMicroCents: number;
  driftPct: number | null;
  causes: DriftCauseHint[];
};

/** Result of one reconciliation pass. */
export type ReconciliationResult = {
  rowsWritten: number;
  notices: DriftNotice[];
  /**
   * Vendor ids whose billing API was ACTUALLY called this pass. Empty when there
   * was no local usage window (nothing to reconcile against), so the vendor — and
   * thus the Admin key — was never contacted. Callers use this to avoid claiming a
   * key was "verified" when no vendor request was made.
   */
  queriedVendors: string[];
};

/** Inclusive day window (UTC `YYYY-MM-DD`) the pass reconciled. */
type ReconciliationWindow = {
  fromDay: string;
  toDay: string;
};

/**
 * Injected dependencies. All I/O is injected so a fixture test can replay known
 * usage against a mocked Admin API and assert the drift math, with no DB or
 * network. A vendor is reconciled only when its fetch function is provided
 * (production omits it when no Admin key is configured).
 */
export type ReconciliationDeps = {
  /** Load the metered token-usage rows to reconcile (production reads the DB). */
  loadUsageRows: () => MeteredUsageRow[];
  /** Fetch Anthropic's billed cost report for the window; omit to skip Anthropic. */
  fetchAnthropicBilled?: (query: {
    startingAt: string;
    endingAt: string;
  }) => Promise<VendorBilledEntry[]>;
  /** Fetch OpenAI's billed costs for the window; omit to skip OpenAI. */
  fetchOpenAiBilled?: (query: {
    startTime: number;
    endTime: number;
  }) => Promise<VendorBilledEntry[]>;
  /** Where reconciled rows are persisted. */
  store: Pick<ReconciliationStore, "upsert">;
  /** Injectable clock (tests pin it). */
  now?: () => Date;
};

/** Per (day, vendor, model) local aggregate, with cause-hint signals. */
type LocalCell = {
  day: string;
  vendor: string;
  model: string;
  microCents: number;
  hasCacheWriteTokens: boolean;
};

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Stable composite key for a (day, vendor, model) cell. */
function cellKey(day: string, vendor: string, model: string): string {
  return `${day}\u0000${vendor}\u0000${model}`;
}

/** UTC `YYYY-MM-DD` for a Date. */
function toUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Parse an RFC 3339 timestamp to a Date, or null if unparseable. */
function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Aggregate the local genai-prices estimate per (day, vendor, model). Metered
 * rows only; unpriced rows are dropped (no fabricated $0). OpenAI models are
 * collapsed to the day-grain sentinel so they line up with the vendor's
 * model-less day total. Library prices are used UNCHANGED.
 */
function aggregateLocal(
  rows: readonly MeteredUsageRow[]
): Map<string, LocalCell> {
  // First gather raw micro-cent contributions so the per-cell total is a single
  // exact integer sum (sumMicroCents) rather than a running float.
  const contributions = new Map<
    string,
    { cell: Omit<LocalCell, "microCents">; amounts: number[] }
  >();

  for (const row of rows) {
    if (!isMeteredApi(row.billingMode)) {
      continue;
    }
    const startedAt = parseDate(row.startedAt);
    if (!startedAt) {
      continue;
    }
    const cost = computeTokenCost({
      model: row.model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      timestamp: startedAt,
    });
    // Unpriced models surface as unpriced — they contribute nothing rather than
    // a silent $0 that would manufacture drift against the vendor bill.
    if (!cost.priced || cost.provider == null || cost.costUsd == null) {
      continue;
    }

    const vendor = cost.provider;
    const day = toUtcDay(startedAt);
    // OpenAI is reconciled at day grain (vendor has no per-model dimension); any
    // other provider (Anthropic) keeps its real model id.
    const model = vendor === "openai" ? OPENAI_DAY_GRAIN_MODEL : row.model;
    const key = cellKey(day, vendor, model);

    let entry = contributions.get(key);
    if (!entry) {
      entry = {
        cell: { day, vendor, model, hasCacheWriteTokens: false },
        amounts: [],
      };
      contributions.set(key, entry);
    }
    entry.amounts.push(usdToMicroCents(cost.costUsd));
    if (row.cacheWriteTokens > 0) {
      entry.cell.hasCacheWriteTokens = true;
    }
  }

  const cells = new Map<string, LocalCell>();
  for (const [key, { cell, amounts }] of contributions) {
    cells.set(key, { ...cell, microCents: sumMicroCents(amounts) });
  }
  return cells;
}

/**
 * Aggregate vendor-billed entries per (day, vendor, model). The model dimension
 * is normalized to the reconciliation grain: Anthropic token rows keep their
 * model; Anthropic tool rows (model:null) bucket under the tools sentinel;
 * OpenAI (always model:null) buckets under the day-grain sentinel.
 */
function aggregateVendor(
  entries: readonly VendorBilledEntry[],
  vendor: string
): Map<string, { day: string; model: string; microCents: number }> {
  const contributions = new Map<
    string,
    { day: string; model: string; amounts: number[] }
  >();

  for (const entry of entries) {
    let model: string;
    if (vendor === "openai") {
      model = OPENAI_DAY_GRAIN_MODEL;
    } else if (entry.model == null) {
      model = ANTHROPIC_TOOLS_MODEL;
    } else {
      model = entry.model;
    }
    const key = cellKey(entry.day, vendor, model);
    let agg = contributions.get(key);
    if (!agg) {
      agg = { day: entry.day, model, amounts: [] };
      contributions.set(key, agg);
    }
    agg.amounts.push(entry.amountMicroCents);
  }

  const out = new Map<
    string,
    { day: string; model: string; microCents: number }
  >();
  for (const [key, { day, model, amounts }] of contributions) {
    out.set(key, { day, model, microCents: sumMicroCents(amounts) });
  }
  return out;
}

/** True when a notice should be raised for this drift. */
function shouldNotify(
  driftMicroCents: number,
  driftPct: number | null
): boolean {
  if (driftMicroCents === 0) {
    return false;
  }
  // Vendor billed $0 (driftPct undefined) but we estimated a cost: always worth
  // surfacing (trial credit / not-yet-posted invoice).
  if (driftPct === null) {
    return true;
  }
  return Math.abs(driftPct) > DRIFT_NOTICE_PCT;
}

/**
 * Run one reconciliation pass: aggregate local estimates, fetch each configured
 * vendor's billed amount, compute drift per (day, vendor, model), persist the
 * rows, and return the rows-written count plus notices for cells over the drift
 * threshold. Vendors without a fetch function are skipped.
 */
export async function runReconciliation(
  deps: ReconciliationDeps
): Promise<ReconciliationResult> {
  const now = deps.now ?? (() => new Date());
  const usageRows = deps.loadUsageRows();
  const local = aggregateLocal(usageRows);

  // Determine the day window from ALL metered usage rows (not just priced
  // local cells). This ensures the vendor APIs are still queried even when
  // every local model is unpriced (e.g. a new model before genai-prices
  // knows it), so vendor-only cells can surface the missing local estimate.
  const allUsageDays = usageRows
    .filter((r) => isMeteredApi(r.billingMode))
    .map((r) => {
      const d = parseDate(r.startedAt);
      return d ? toUtcDay(d) : null;
    })
    .filter((d): d is string => d !== null);
  const window = computeWindow(allUsageDays);

  // Only reconcile vendors we actually queried. A vendor with no configured
  // Admin key (no fetch function) is skipped wholesale — its local cells are NOT
  // recorded as drift against a $0 bill we never fetched, which would be a false
  // "vendor billed nothing" signal.
  const queriedVendors = new Set<string>();
  const vendorCells = new Map<
    string,
    { day: string; model: string; microCents: number }
  >();
  if (window && deps.fetchAnthropicBilled) {
    queriedVendors.add("anthropic");
    const entries = await deps.fetchAnthropicBilled({
      startingAt: `${window.fromDay}T00:00:00Z`,
      endingAt: `${dayPlusOne(window.toDay)}T00:00:00Z`,
    });
    for (const [key, value] of aggregateVendor(entries, "anthropic")) {
      vendorCells.set(key, value);
    }
  }
  if (window && deps.fetchOpenAiBilled) {
    queriedVendors.add("openai");
    const entries = await deps.fetchOpenAiBilled({
      startTime: dayStartUnixSeconds(window.fromDay),
      endTime: dayStartUnixSeconds(dayPlusOne(window.toDay)),
    });
    for (const [key, value] of aggregateVendor(entries, "openai")) {
      vendorCells.set(key, value);
    }
  }

  const computedAt = now().toISOString();
  const rows: ReconciliationRow[] = [];
  const notices: DriftNotice[] = [];

  // Reconcile over the UNION of local and vendor cells: a local cell with no
  // vendor match is an over-estimate; a vendor cell with no local match (e.g.
  // server-side tools) is an under-estimate. Both are real drift to record.
  const allKeys = new Set<string>([...local.keys(), ...vendorCells.keys()]);
  for (const key of allKeys) {
    const localCell = local.get(key);
    const vendorCell = vendorCells.get(key);
    const coords = localCell ?? vendorCell;
    if (!coords) {
      continue;
    }
    // For a vendor-only cell we only have day/model from the vendor side; derive
    // the vendor id from whichever side is present.
    const vendor = localCell?.vendor ?? vendorForKey(key);
    // Skip local cells whose vendor we did not query (no Admin key configured).
    if (!queriedVendors.has(vendor)) {
      continue;
    }
    const day = coords.day;
    const model = coords.model;

    const localMicroCents = localCell?.microCents ?? 0;
    const vendorMicroCents = vendorCell?.microCents ?? 0;
    const { driftMicroCents, driftPct } = computeDrift(
      localMicroCents,
      vendorMicroCents
    );

    rows.push({
      day,
      vendor,
      model,
      localEstimateMicroCents: localMicroCents,
      vendorBilledMicroCents: vendorMicroCents,
      driftMicroCents,
      driftPct,
      computedAt,
    });

    if (shouldNotify(driftMicroCents, driftPct)) {
      const causes = rankDriftCauses({
        vendor,
        driftMicroCents,
        localMicroCents,
        vendorMicroCents,
        hasCacheWriteTokens: localCell?.hasCacheWriteTokens ?? false,
        // The tools sentinel is, by construction, server-side tool spend with no
        // local token-based estimate.
        hasServerSideToolUse:
          model === ANTHROPIC_TOOLS_MODEL ? true : undefined,
      });
      notices.push({
        day,
        vendor,
        model,
        localEstimateMicroCents: localMicroCents,
        vendorBilledMicroCents: vendorMicroCents,
        driftMicroCents,
        driftPct,
        causes,
      });
    }
  }

  const rowsWritten = deps.store.upsert(rows);
  return { rowsWritten, notices, queriedVendors: [...queriedVendors] };
}

/** Recover the vendor id encoded in a cell key (middle segment). */
function vendorForKey(key: string): string {
  return key.split("\u0000")[1] ?? "";
}

/**
 * Compute the inclusive day window spanned by the local usage. Returns null when
 * there is no usage (nothing to reconcile).
 */
function computeWindow(days: readonly string[]): ReconciliationWindow | null {
  let fromDay: string | null = null;
  let toDay: string | null = null;
  for (const day of days) {
    if (!ISO_DAY_RE.test(day)) {
      continue;
    }
    if (fromDay === null || day < fromDay) {
      fromDay = day;
    }
    if (toDay === null || day > toDay) {
      toDay = day;
    }
  }
  if (fromDay === null || toDay === null) {
    return null;
  }
  return { fromDay, toDay };
}

/** UTC `YYYY-MM-DD` one day after the given ISO day (exclusive upper bound). */
function dayPlusOne(day: string): string {
  return toUtcDay(
    new Date(new Date(`${day}T00:00:00Z`).getTime() + MS_PER_DAY)
  );
}

/** Unix epoch SECONDS at the UTC start of the given ISO day. */
function dayStartUnixSeconds(day: string): number {
  return Math.floor(new Date(`${day}T00:00:00Z`).getTime() / 1000);
}

/**
 * Read the metered token-usage rows to reconcile from an OPEN agent database
 * (READ-ONLY). Mirrors the sync service's query against the in-process schema:
 * the day comes from `sessions.started_at`, and the billing mode is resolved
 * with the shared rule so only real metered API spend is reconciled.
 * `cutoffIso` bounds the scan to recent sessions.
 *
 * FEA-3390: the standard token columns hold only the POST-compaction subset —
 * a compacted session's PRE-compaction totals live in `baseline_*`. Fold them
 * in (`input_tokens + baseline_input`, …, COALESCE-guarded so a non-compacted
 * row with NULL baselines is unchanged) so the effective totals reconciled
 * against the provider bill count every incurred token. Without the fold a
 * compacted session under-estimates and falsely reads as a provider overcharge.
 */
export function loadMeteredUsageRows(
  db: DatabaseSync,
  cutoffIso: string
): MeteredUsageRow[] {
  const rows = db
    .prepare(
      `
        SELECT
          s.id AS session_id,
          s.started_at AS started_at,
          s.billing_mode AS billing_mode,
          s.harness AS harness,
          tu.model AS model,
          COALESCE(tu.input_tokens, 0) + COALESCE(tu.baseline_input, 0) AS input_tokens,
          COALESCE(tu.output_tokens, 0) + COALESCE(tu.baseline_output, 0) AS output_tokens,
          COALESCE(tu.cache_read_tokens, 0) + COALESCE(tu.baseline_cache_read, 0) AS cache_read_tokens,
          COALESCE(tu.cache_write_tokens, 0) + COALESCE(tu.baseline_cache_write, 0) AS cache_write_tokens
        FROM token_usage tu
        JOIN sessions s ON s.id = tu.session_id
        WHERE s.started_at >= ?
        ORDER BY s.started_at ASC, tu.model ASC
      `
    )
    .all(cutoffIso) as Array<{
    session_id: string;
    started_at: string;
    billing_mode: string | null;
    harness: string | null;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
  }>;

  const out: MeteredUsageRow[] = [];
  for (const row of rows) {
    const billingMode = resolveBillingMode({
      billingMode: row.billing_mode,
      harness: row.harness,
    });
    // Only real per-token API spend is reconciled; subscription/seat usage is
    // priced elsewhere as a hypothetical and must never be compared to a bill.
    if (!isMeteredApi(billingMode)) {
      continue;
    }
    out.push({
      sessionId: row.session_id,
      model: row.model,
      startedAt: row.started_at,
      billingMode,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
    });
  }
  return out;
}

/** ISO timestamp `windowDays` before `now` — the lower bound for the DB scan. */
export function reconciliationCutoffIso(
  now: Date,
  windowDays = DEFAULT_WINDOW_DAYS
): string {
  return new Date(now.getTime() - windowDays * MS_PER_DAY).toISOString();
}
