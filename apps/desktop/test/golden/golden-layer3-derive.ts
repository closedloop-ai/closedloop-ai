/**
 * FEA-2649 Layer 3 derivation helpers — the fidelity oracle for the golden
 * aggregation suite (golden-layer3.ts) and the corpus-expectations generator
 * (derive-corpus-expectations.ts).
 *
 * Layer 2 (FEA-2647) proved the SEEDED STORE equals the frozen dossiers, so
 * Layer 3's fidelity baseline is: read the raw store tables back (plain
 * `SELECT *`, no aggregation SQL) and recompute every aggregate in JS from the
 * documented contract. A mismatch between a query module's output and these
 * derivations is unambiguously an aggregation bug (or a registered storage
 * divergence — resolved via golden-layer2-divergences / golden-layer3-divergences).
 *
 * Reuse policy (PLN-1340 v3):
 * - `eachDay` and `formatLocalDayKey` are IMPORTED from production — they are
 *   lockstep-critical presentation-axis helpers (FEA-2430) and a third copy
 *   would be a drift risk. Signed per-day keys in corpus-expectations.yaml
 *   remain the independent check on the axis.
 * - `resolveRange` (window-edge math) is deliberately NOT imported: window
 *   edges and delta math are the subject under test, so `rangeTwin` below
 *   reimplements them independently from the documented contract.
 * - `median` is imported from @repo/api; its edge cases are covered by the
 *   synthetic suite in test/golden-layer3-derive.test.ts, so reuse cannot
 *   silently bless a broken median.
 *
 * Clock contract: REFERENCE_NOW is a pure function of the corpus — the max
 * ISO timestamp anywhere in the import inputs plus 1h (the Layer 2 shared-DB
 * clock). It exists in two representations: the ISO string (openTestDb clock,
 * SQL comparisons, the yaml `reference_now` guard) and the Date (every
 * `now?: Date` query parameter).
 */

import { InsightsPeriod } from "@closedloop-ai/loops-api/insights";
import {
  AGENT_FAILED_STATUS_TERMS,
  AGENT_SUCCESS_STATUS_TERMS,
} from "@repo/api/src/agent-session-status";
import { ssotMergeRateFromCounts } from "@repo/api/src/insights/delivery-kpis/parity";
import { PROSE_MENTION_REF_METHODS } from "@repo/api/src/types/session-artifact-link";
import type {
  Harness,
  NormalizedSession,
} from "../../src/main/collectors/types.js";
import {
  BRANCH_PUSH_METHOD_VALUES,
  BRANCH_WRITE_METHOD_VALUES,
  DESKTOP_AGENT_STATUS,
  TERMINAL_STATUS_SET,
} from "../../src/main/database/db-constants.js";
import {
  formatLocalDayKey,
  packIdFromSkillName,
} from "../../src/main/database/db-helpers.js";
import { PrState } from "../../src/main/enrichment/types.js";
import type { openTestDb } from "../agent-db-test-utils.js";
import { discoverDossiers, type GoldenDossier } from "./golden-corpus.js";
import { loadLayer2Input } from "./golden-layer2-input.js";

type TestDb = Awaited<ReturnType<typeof openTestDb>>;

export const MS_PER_DAY = 86_400_000;
export const TREND_LOOKBACK_DAYS = 90;
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

// ── Corpus loading + reference clock ─────────────────────────────────────────

export type CorpusInput = {
  d: GoldenDossier;
  input: NormalizedSession;
  nowD: string;
  harness: Harness;
};

export type Corpus = {
  inputs: CorpusInput[];
  /** Every discovered dossier, INCLUDING null (non-importable) ones. */
  dossiersTotal: number;
  referenceNowIso: string;
  referenceNowDate: Date;
};

/** Load the non-null dossiers exactly like the Layer 2 shared-DB test and
 * compute the corpus reference clock (max per-dossier NOW_d). */
export function loadCorpus(): Corpus {
  const discovered = discoverDossiers();
  const inputs = discovered
    .filter((d) => d.normalized !== null && d.normalized !== undefined)
    .map((d) => ({ d, ...loadLayer2Input(d) }));
  if (inputs.length === 0) {
    throw new Error(
      "golden corpus discovery returned zero importable dossiers"
    );
  }
  const referenceNowIso = inputs
    .map((i) => i.nowD)
    .sort()
    .at(-1);
  if (!referenceNowIso) {
    throw new Error("could not derive the corpus reference clock");
  }
  return {
    inputs,
    dossiersTotal: discovered.length,
    referenceNowIso,
    referenceNowDate: new Date(referenceNowIso),
  };
}

/** Import every corpus input into `db`, failing loudly on any skip/failure. */
export async function seedCorpus(db: TestDb, corpus: Corpus): Promise<void> {
  for (const { d, input, harness } of corpus.inputs) {
    const result = await db.importer.importSession(input, harness);
    if (result.skipped || result.failed || result.incomplete === true) {
      throw new Error(
        `${d.sessionId}: corpus seed import did not fully succeed ` +
          `(skipped=${String(result.skipped)} failed=${String(result.failed)} incomplete=${String(result.incomplete)})`
      );
    }
  }
}

// ── Raw store capture (plain SELECTs — no aggregation SQL) ───────────────────

export type SessionRow = {
  id: string;
  name: string | null;
  cwd: string | null;
  model: string | null;
  harness: string | null;
  status: string;
  billing_mode: string | null;
  started_at: string | null;
  ended_at: string | null;
  updated_at: string | null;
  awaiting_input_since: string | null;
  cost_usd_estimated: number | null;
  metadata: string | null;
};

export type AgentRow = {
  id: string;
  session_id: string;
  status: string | null;
  type: string | null;
  subagent_type: string | null;
  parent_agent_id: string | null;
  updated_at: string | null;
};

export type EventRow = {
  id: string;
  session_id: string;
  event_type: string;
  tool_name: string | null;
  created_at: string | null;
  data: string | null;
  summary: string | null;
};

export type TokenUsageRow = {
  session_id: string;
  model: string | null;
  input_tokens: number | bigint;
  output_tokens: number | bigint;
  cache_read_tokens: number | bigint;
  cache_write_tokens: number | bigint;
  baseline_input: number | bigint | null;
  baseline_output: number | bigint | null;
  cost_usd_estimated: number | null;
};

export type TokenEventRow = {
  session_id: string;
  model: string | null;
  created_at: string;
  input_tokens: number | bigint;
  output_tokens: number | bigint;
  cache_read_tokens: number | bigint;
  cache_write_tokens: number | bigint;
  cost_usd_estimated: number | null;
};

export type ArtifactRow = {
  id: string;
  kind: string;
  identity_key: string;
  repo_full_name: string | null;
  branch_name: string | null;
  pr_number: number | bigint | null;
  pr_state: string | null;
  url: string | null;
  title: string | null;
  head_sha: string | null;
  sha: string | null;
  committed_at: string | null;
  observed_at: string | null;
  created_at: string | null;
  lines_added: number | bigint | null;
  lines_removed: number | bigint | null;
  files_changed: number | bigint | null;
  first_pushed_at: string | null;
  harness: string | null;
};

export type ArtifactLinkRow = {
  id: string;
  artifact_id: string;
  session_id: string;
  relation: string;
  method: string | null;
  is_primary: number | bigint | null;
  observed_at: string | null;
  created_at: string | null;
};

export type PullRequestRow = {
  id: string;
  session_id: string;
  repo_full_name: string | null;
  pr_number: number | bigint | null;
  branch_name: string | null;
  state: string | null;
  pr_url: string | null;
  title: string | null;
  head_sha: string | null;
  opened_at: string | null;
  merged_at: string | null;
  closed_at: string | null;
  observed_at: string | null;
  created_at: string | null;
};

export type TurnBucketRow = {
  session_id: string;
  ts: string;
  turn_kind: string;
  turn_count: number | bigint;
};

export type L3Rows = {
  sessions: SessionRow[];
  agents: AgentRow[];
  events: EventRow[];
  tokenUsage: TokenUsageRow[];
  tokenEvents: TokenEventRow[];
  artifacts: ArtifactRow[];
  artifactLinks: ArtifactLinkRow[];
  pullRequests: PullRequestRow[];
  turnBuckets: TurnBucketRow[];
};

export async function captureLayer3Rows(db: TestDb): Promise<L3Rows> {
  const q = <T>(sql: string) =>
    db.prisma.client.$queryRawUnsafe<T[]>(sql) as Promise<T[]>;
  const [
    sessions,
    agents,
    events,
    tokenUsage,
    tokenEvents,
    artifacts,
    artifactLinks,
    pullRequests,
    turnBuckets,
  ] = await Promise.all([
    q<SessionRow>("SELECT * FROM sessions ORDER BY id"),
    q<AgentRow>("SELECT * FROM agents ORDER BY id"),
    q<EventRow>("SELECT * FROM events ORDER BY id"),
    q<TokenUsageRow>("SELECT * FROM token_usage ORDER BY session_id, model"),
    q<TokenEventRow>(
      "SELECT * FROM token_events ORDER BY session_id, created_at, model"
    ),
    q<ArtifactRow>("SELECT * FROM artifacts ORDER BY id"),
    q<ArtifactLinkRow>("SELECT * FROM session_artifact_links ORDER BY id"),
    q<PullRequestRow>("SELECT * FROM pull_requests ORDER BY id"),
    q<TurnBucketRow>(
      "SELECT * FROM session_turn_bucket ORDER BY session_id, ts, turn_kind"
    ),
  ]);
  return {
    sessions,
    agents,
    events,
    tokenUsage,
    tokenEvents,
    artifacts,
    artifactLinks,
    pullRequests,
    turnBuckets,
  };
}

// ── Small shared helpers ─────────────────────────────────────────────────────

export function num(
  value: number | bigint | string | null | undefined
): number {
  return value == null ? 0 : Number(value);
}

export function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

/** JS twin of the localDay() SQL bucket (strftime 'localtime'). */
export function localDayOf(iso: string): string {
  return formatLocalDayKey(new Date(iso));
}

/** JS twin of the localHour() SQL bucket. */
export function localHourOf(iso: string): number {
  return new Date(iso).getHours();
}

export function agentSuccessRateTwin(
  completed: number,
  errors: number
): number {
  const finished = completed + errors;
  return finished > 0 ? (completed / finished) * 100 : 100;
}

function statusMatchesAny(
  status: string | null,
  terms: readonly string[]
): boolean {
  if (status == null) {
    return false;
  }
  const lower = status.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

export function isSuccessAgentStatus(status: string | null): boolean {
  return statusMatchesAny(status, AGENT_SUCCESS_STATUS_TERMS);
}

export function isFailedAgentStatus(status: string | null): boolean {
  return statusMatchesAny(status, AGENT_FAILED_STATUS_TERMS);
}

export function isSubagentRow(a: AgentRow): boolean {
  return a.parent_agent_id !== null || a.type === "subagent";
}

/** unixepoch(x,'subsec') twin: seconds (float) since epoch. */
function epochSeconds(iso: string): number {
  return Date.parse(iso) / 1000;
}

// ── Window math (deliberately independent of local-insights resolveRange) ────

export type RangeTwin = {
  startIso: string;
  endIso: string;
  trendStartIso: string;
  priorStartIso: string;
};

export function rangeTwin(period: InsightsPeriod, refIso: string): RangeTwin {
  const now = new Date(refIso);
  const endIso = now.toISOString();
  const trendDays =
    period === InsightsPeriod.All
      ? TREND_LOOKBACK_DAYS
      : Math.min(Number(period), TREND_LOOKBACK_DAYS);
  const trendStartIso = new Date(
    now.getTime() - trendDays * MS_PER_DAY
  ).toISOString();
  if (period === InsightsPeriod.All) {
    return {
      startIso: new Date(0).toISOString(),
      endIso,
      trendStartIso,
      priorStartIso: new Date(0).toISOString(),
    };
  }
  const days = Number(period);
  const start = new Date(now.getTime() - days * MS_PER_DAY);
  return {
    startIso: start.toISOString(),
    endIso,
    trendStartIso,
    priorStartIso: new Date(start.getTime() - days * MS_PER_DAY).toISOString(),
  };
}

/** ISO-string BETWEEN (inclusive both ends) — matches SQL string comparison. */
export function inWindow(
  iso: string | null | undefined,
  startIso: string,
  endIso: string
): boolean {
  return typeof iso === "string" && iso >= startIso && iso <= endIso;
}

/** Sessions whose started_at falls in [startIso, endIso] — the insights gate. */
export function windowSessions(
  rows: L3Rows,
  startIso: string,
  endIso: string
): SessionRow[] {
  return rows.sessions.filter((s) => inWindow(s.started_at, startIso, endIso));
}

export function windowSessionIdSet(
  rows: L3Rows,
  startIso: string,
  endIso: string
): Set<string> {
  return new Set(windowSessions(rows, startIso, endIso).map((s) => s.id));
}

// ── Sorting twins ────────────────────────────────────────────────────────────

/** Lexicographic string comparator (ASC) shared by the sort twins. */
export function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/** Stable "count desc" check helper: returns entries sorted by count desc with
 * the given tiebreak; used where SQL declares a total order. */
export function sortByCountDescThenKeyAsc<
  T extends { key: string; count: number },
>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    return compareStrings(a.key, b.key);
  });
}

// ── PR / artifact gates (delivery + dashboard) ───────────────────────────────

export const PR_KIND = "pull_request";

/** COALESCE(observed_at, created_at) — the delivery window timestamp. */
export function prWindowTs(a: ArtifactRow): string | null {
  return a.observed_at ?? a.created_at;
}

/** DISTINCT artifact ids with a relation='created' link (createdArtifactLinksSubquery twin). */
export function createdArtifactIdSet(rows: L3Rows): Set<string> {
  const set = new Set<string>();
  for (const l of rows.artifactLinks) {
    if (l.relation === "created") {
      set.add(l.artifact_id);
    }
  }
  return set;
}

/** FEA-3585 + ISS-5764: ids whose ONLY links are non-delivery evidence. */
export function nonDeliveryOnlyArtifactIdSet(rows: L3Rows): Set<string> {
  const hasNonDelivery = new Set<string>();
  const hasOther = new Set<string>();
  for (const l of rows.artifactLinks) {
    const nonDelivery =
      l.relation === "reviewed" ||
      PROSE_MENTION_REF_METHODS.has(String(l.method));
    (nonDelivery ? hasNonDelivery : hasOther).add(l.artifact_id);
  }
  const out = new Set<string>();
  for (const id of hasNonDelivery) {
    if (!hasOther.has(id)) {
      out.add(id);
    }
  }
  return out;
}

export function prArtifacts(rows: L3Rows): ArtifactRow[] {
  return rows.artifacts.filter((a) => a.kind === PR_KIND);
}

/** PR artifacts counting as DELIVERY (FEA-3585 + ISS-5764 gate). */
export function deliveryPrArtifacts(rows: L3Rows): ArtifactRow[] {
  const nonDeliveryOnly = nonDeliveryOnlyArtifactIdSet(rows);
  return prArtifacts(rows).filter((a) => !nonDeliveryOnly.has(a.id));
}

export function prArtifactsInWindow(
  rows: L3Rows,
  startIso: string,
  endIso: string
): ArtifactRow[] {
  return deliveryPrArtifacts(rows).filter((a) =>
    inWindow(prWindowTs(a), startIso, endIso)
  );
}

/**
 * Merge-rate twin (FEA-3217): mirror the delivery query's terminal-state
 * arithmetic over the same delivery PR population — merged =
 * LOWER(pr_state)='merged', decided = merged OR closed — then route the counts
 * through the SAME shared SSOT (`ssotMergeRateFromCounts`, parity.ts) that the
 * production `computeDelivery` now calls, honoring its null-on-empty-cohort
 * contract: 0 decided PRs ⇒ `null` ("—"), NOT a fabricated `0` reading "0%
 * merged". Recomputed from the raw `pr_state` column, so it stays a fidelity
 * check rather than a copy of the query SQL.
 */
export function deriveMergeRateTwin(
  rows: L3Rows,
  startIso: string,
  endIso: string
): number | null {
  let merged = 0;
  let closed = 0;
  for (const a of prArtifactsInWindow(rows, startIso, endIso)) {
    const state = a.pr_state?.toLowerCase() ?? null;
    if (state === PrState.Merged) {
      merged += 1;
    } else if (state === PrState.Closed) {
      closed += 1;
    }
  }
  return ssotMergeRateFromCounts(merged, closed);
}

/** The dashboard getPullRequests population: PR artifacts with a pr_number,
 * a repo_full_name, AND at least one session link (the SQL's inner joins). */
export function deriveDashboardPrArtifactIds(rows: L3Rows): Set<string> {
  const linked = new Set(rows.artifactLinks.map((l) => l.artifact_id));
  return new Set(
    deliveryPrArtifacts(rows)
      .filter(
        (a) =>
          a.pr_number !== null && a.repo_full_name !== null && linked.has(a.id)
      )
      .map((a) => a.id)
  );
}

// ── Branch gates (branch-reads twins) ────────────────────────────────────────

const WRITE_METHODS: ReadonlySet<string> = new Set(BRANCH_WRITE_METHOD_VALUES);
const PUSH_METHODS: ReadonlySet<string> = new Set(BRANCH_PUSH_METHOD_VALUES);

/** Push evidence: any push-method link on the artifact OR first_pushed_at set. */
export function branchHasPushEvidence(
  artifact: ArtifactRow,
  rows: L3Rows
): boolean {
  if (artifact.first_pushed_at !== null) {
    return true;
  }
  return rows.artifactLinks.some(
    (l) =>
      l.artifact_id === artifact.id &&
      l.method !== null &&
      PUSH_METHODS.has(l.method)
  );
}

/** Active write link: write-method link to a push-qualified branch artifact. */
export function activeWriteLinks(
  rows: L3Rows
): { link: ArtifactLinkRow; artifact: ArtifactRow }[] {
  const byId = new Map(rows.artifacts.map((a) => [a.id, a]));
  const out: { link: ArtifactLinkRow; artifact: ArtifactRow }[] = [];
  for (const l of rows.artifactLinks) {
    if (l.method === null || !WRITE_METHODS.has(l.method)) {
      continue;
    }
    const a = byId.get(l.artifact_id);
    if (a?.kind !== "branch" || a.branch_name === null) {
      continue;
    }
    if (!branchHasPushEvidence(a, rows)) {
      continue;
    }
    out.push({ link: l, artifact: a });
  }
  return out;
}

/** FEA-2032/FEA-2531 even-split twin of readBranchTokenAggregateRows: dedupe a
 * session's active-write (repo, branch) pairs, divide the session's token_usage
 * by that count, group by (repo, branch, model). CAST(SUM(...) AS INTEGER)
 * truncates the SUMMED float; NULL costs stay null when a group never priced. */
export type BranchTokenAggregateTwin = {
  repoFullName: string | null;
  branchName: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsdEstimated: number | null;
};

type EvenSplitAcc = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number | null;
};

function collectActiveWritePairs(rows: L3Rows): {
  pairsBySession: Map<string, Set<string>>;
  pairMeta: Map<string, { repo: string | null; branch: string }>;
} {
  const pairsBySession = new Map<string, Set<string>>();
  const pairMeta = new Map<string, { repo: string | null; branch: string }>();
  for (const { link, artifact } of activeWriteLinks(rows)) {
    const branch = artifact.branch_name;
    if (branch === null) {
      continue;
    }
    const key = `${artifact.repo_full_name ?? " "}#${branch}`;
    pairMeta.set(key, { repo: artifact.repo_full_name, branch });
    const set = pairsBySession.get(link.session_id) ?? new Set<string>();
    set.add(key);
    pairsBySession.set(link.session_id, set);
  }
  return { pairsBySession, pairMeta };
}

function accumulateEvenSplit(
  acc: EvenSplitAcc,
  t: TokenUsageRow,
  divisor: number
): void {
  acc.input += num(t.input_tokens) / divisor;
  acc.output += num(t.output_tokens) / divisor;
  acc.cacheRead += num(t.cache_read_tokens) / divisor;
  acc.cacheWrite += num(t.cache_write_tokens) / divisor;
  if (t.cost_usd_estimated !== null) {
    acc.cost = (acc.cost ?? 0) + num(t.cost_usd_estimated) / divisor;
  }
}

export function deriveBranchTokenAggregates(
  rows: L3Rows
): BranchTokenAggregateTwin[] {
  const { pairsBySession, pairMeta } = collectActiveWritePairs(rows);
  const groups = new Map<string, EvenSplitAcc>();
  for (const t of rows.tokenUsage) {
    const pairs = pairsBySession.get(t.session_id);
    if (!pairs || pairs.size === 0) {
      continue;
    }
    for (const pair of pairs) {
      const groupKey = `${pair}#${t.model ?? " "}`;
      const acc = groups.get(groupKey) ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: null,
      };
      accumulateEvenSplit(acc, t, pairs.size);
      groups.set(groupKey, acc);
    }
  }
  const out: BranchTokenAggregateTwin[] = [];
  for (const [groupKey, acc] of groups) {
    const [pair, modelRaw] = [
      groupKey.slice(0, groupKey.lastIndexOf("#")),
      groupKey.slice(groupKey.lastIndexOf("#") + 1),
    ];
    const meta = pairMeta.get(pair);
    if (!meta) {
      continue;
    }
    out.push({
      repoFullName: meta.repo,
      branchName: meta.branch,
      model: modelRaw === " " ? null : modelRaw,
      inputTokens: Math.trunc(acc.input),
      outputTokens: Math.trunc(acc.output),
      cacheReadTokens: Math.trunc(acc.cacheRead),
      cacheWriteTokens: Math.trunc(acc.cacheWrite),
      costUsdEstimated: acc.cost,
    });
  }
  return out.sort((a, b) => {
    if (a.branchName !== b.branchName) {
      return compareStrings(a.branchName, b.branchName);
    }
    return compareStrings(a.model ?? "", b.model ?? "");
  });
}

// ── Turn buckets (autonomy + heatmap twins) ──────────────────────────────────

export type HeatmapCellTwin = {
  day: string;
  hour: number;
  human: number;
  agent: number;
};

export function deriveHeatmapCells(
  rows: L3Rows,
  startIso: string,
  endIso: string
): HeatmapCellTwin[] {
  const windowIds = windowSessionIdSet(rows, startIso, endIso);
  const byCell = new Map<string, HeatmapCellTwin>();
  for (const b of rows.turnBuckets) {
    if (!windowIds.has(b.session_id)) {
      continue;
    }
    const day = localDayOf(b.ts);
    const hour = localHourOf(b.ts);
    const key = `${day}#${hour}`;
    const cell = byCell.get(key) ?? { day, hour, human: 0, agent: 0 };
    if (b.turn_kind === "human") {
      cell.human += num(b.turn_count);
    } else if (b.turn_kind === "agent") {
      cell.agent += num(b.turn_count);
    }
    byCell.set(key, cell);
  }
  return [...byCell.values()].sort((a, b) => {
    if (a.day !== b.day) {
      return compareStrings(a.day, b.day);
    }
    return a.hour - b.hour;
  });
}

export type AutonomyPointTwin = { day: string; agent: number; total: number };

export function deriveAutonomyByDay(
  rows: L3Rows,
  startIso: string,
  endIso: string
): AutonomyPointTwin[] {
  const windowIds = windowSessionIdSet(rows, startIso, endIso);
  const byDay = new Map<string, AutonomyPointTwin>();
  for (const b of rows.turnBuckets) {
    if (!windowIds.has(b.session_id)) {
      continue;
    }
    const day = localDayOf(b.ts);
    const point = byDay.get(day) ?? { day, agent: 0, total: 0 };
    if (b.turn_kind === "agent") {
      point.agent += num(b.turn_count);
    }
    point.total += num(b.turn_count);
    byDay.set(day, point);
  }
  return [...byDay.values()].sort((a, b) => compareStrings(a.day, b.day));
}

// ── Token rollups ────────────────────────────────────────────────────────────

export type TokenTotalsTwin = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** token_usage joined to in-window sessions (model NOT NULL) — Agents KPIs. */
export function deriveUsageTotalsInWindow(
  rows: L3Rows,
  startIso: string,
  endIso: string
): TokenTotalsTwin & { tokens: number; models: number } {
  const windowIds = windowSessionIdSet(rows, startIso, endIso);
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const models = new Set<string>();
  for (const t of rows.tokenUsage) {
    if (t.model === null || !windowIds.has(t.session_id)) {
      continue;
    }
    // The Agents-section totals SUM the RAW columns (not the FEA-2879
    // baseline-effective sums used by session_analytics).
    totals.input += num(t.input_tokens);
    totals.output += num(t.output_tokens);
    totals.cacheRead += num(t.cache_read_tokens);
    totals.cacheWrite += num(t.cache_write_tokens);
    models.add(t.model);
  }
  return {
    ...totals,
    tokens: totals.input + totals.output,
    models: models.size,
  };
}

/** Estimated USD spend per model over token_usage ⋈ in-window sessions. */
export function deriveSpendByModel(
  rows: L3Rows,
  startIso: string,
  endIso: string
): Map<string, number> {
  const windowIds = windowSessionIdSet(rows, startIso, endIso);
  const byModel = new Map<string, number>();
  for (const t of rows.tokenUsage) {
    if (t.model === null || !windowIds.has(t.session_id)) {
      continue;
    }
    byModel.set(
      t.model,
      (byModel.get(t.model) ?? 0) + num(t.cost_usd_estimated)
    );
  }
  return byModel;
}

/** Total estimated cost over token_usage ⋈ in-window sessions (Delivery cost KPI). */
export function deriveWindowCost(
  rows: L3Rows,
  startIso: string,
  endIso: string
): number {
  const windowIds = windowSessionIdSet(rows, startIso, endIso);
  let cost = 0;
  for (const t of rows.tokenUsage) {
    if (windowIds.has(t.session_id) && t.session_id) {
      cost += num(t.cost_usd_estimated);
    }
  }
  return cost;
}

// ── getTokenAnalytics twins (token_events, 30 local calendar days) ───────────

export function tokenAnalyticsWindow(refIso: string): {
  cutoffIso: string;
  upperIso: string;
} {
  const WINDOW_DAYS = 30;
  const ref = new Date(refIso);
  const cutoff = new Date(ref);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (WINDOW_DAYS - 1));
  const upper = new Date(ref);
  upper.setHours(23, 59, 59, 999);
  return { cutoffIso: cutoff.toISOString(), upperIso: upper.toISOString() };
}

export function tokenEventsInWindow(
  rows: L3Rows,
  refIso: string
): TokenEventRow[] {
  const { cutoffIso, upperIso } = tokenAnalyticsWindow(refIso);
  return rows.tokenEvents.filter(
    (e) =>
      typeof e.created_at === "string" &&
      ISO_DATE_PREFIX.test(e.created_at) &&
      e.created_at >= cutoffIso &&
      e.created_at <= upperIso
  );
}

// ── Recursive agent depth twin (getWorkflowData avgDepth) ────────────────────

export function deriveAvgDepth(rows: L3Rows): number {
  const children = new Map<string, AgentRow[]>();
  for (const a of rows.agents) {
    if (a.parent_agent_id !== null) {
      const list = children.get(a.parent_agent_id) ?? [];
      list.push(a);
      children.set(a.parent_agent_id, list);
    }
  }
  const maxDepthBySession = new Map<string, number>();
  const walk = (agent: AgentRow, depth: number) => {
    const prev = maxDepthBySession.get(agent.session_id);
    if (prev === undefined || depth > prev) {
      maxDepthBySession.set(agent.session_id, depth);
    }
    for (const child of children.get(agent.id) ?? []) {
      walk(child, depth + 1);
    }
  };
  for (const a of rows.agents) {
    if (a.parent_agent_id === null) {
      walk(a, 0);
    }
  }
  const depths = [...maxDepthBySession.values()];
  return depths.length > 0
    ? depths.reduce((s, d) => s + d, 0) / depths.length
    : 0;
}

/** AVG session duration twin (unixepoch subsec math, >= 0 guard). */
export function deriveAvgDurationSec(rows: L3Rows): number {
  const durations: number[] = [];
  for (const s of rows.sessions) {
    if (s.started_at === null) {
      continue;
    }
    const end = s.ended_at ?? s.updated_at;
    if (end === null) {
      continue;
    }
    const d = epochSeconds(end) - epochSeconds(s.started_at);
    if (d >= 0) {
      durations.push(d);
    }
  }
  return durations.length > 0
    ? durations.reduce((s, d) => s + d, 0) / durations.length
    : 0;
}

// ── Delivery derivations ─────────────────────────────────────────────────────

export type DeliveryLatencyTwin = { artifactId: string; latencyMs: number };

/** One latency per PR artifact: created-link-first, then earliest session start;
 * latency = COALESCE(observed,created) - started_at, only when >= started_at. */
export function deriveTtmLatencies(
  rows: L3Rows,
  startIso: string,
  endIso: string
): number[] {
  const sessionById = new Map(rows.sessions.map((s) => [s.id, s]));
  // FEA-3585: reviewed-only PRs are excluded from TTM (mirrors the production
  // latency query's `excludeNonDeliveryOnlyArtifacts` gate).
  const nonDeliveryOnly = nonDeliveryOnlyArtifactIdSet(rows);
  const best = new Map<
    string,
    { createdRank: number; startedAt: string; latencyMs: number }
  >();
  for (const l of rows.artifactLinks) {
    const a = rows.artifacts.find((x) => x.id === l.artifact_id);
    if (!a || a.kind !== PR_KIND || nonDeliveryOnly.has(a.id)) {
      continue;
    }
    const ts = prWindowTs(a);
    if (!inWindow(ts, startIso, endIso)) {
      continue;
    }
    const s = sessionById.get(l.session_id);
    if (!s || s.started_at === null || ts === null || ts < s.started_at) {
      continue;
    }
    const candidate = {
      createdRank: l.relation === "created" ? 0 : 1,
      startedAt: s.started_at,
      latencyMs: (epochSeconds(ts) - epochSeconds(s.started_at)) * 1000,
    };
    const prev = best.get(a.id);
    if (
      !prev ||
      candidate.createdRank < prev.createdRank ||
      (candidate.createdRank === prev.createdRank &&
        candidate.startedAt < prev.startedAt)
    ) {
      best.set(a.id, candidate);
    }
  }
  return [...best.values()].map((b) => b.latencyMs).filter((v) => v >= 0);
}

export type LocRowTwin = {
  loc: number;
  enriched: boolean;
  /** ISS-5412: the PR carries ANY line count — the population the sum sees. */
  sized: boolean;
  day: string;
};

export function deriveLocRows(
  rows: L3Rows,
  startIso: string,
  endIso: string
): LocRowTwin[] {
  const out: LocRowTwin[] = [];
  for (const a of prArtifactsInWindow(rows, startIso, endIso)) {
    const ts = prWindowTs(a);
    out.push({
      loc: num(a.lines_added) + num(a.lines_removed),
      enriched: a.lines_added !== null && a.lines_removed !== null,
      sized: a.lines_added !== null || a.lines_removed !== null,
      day: ts === null ? "" : localDayOf(ts),
    });
  }
  return out;
}

/** Earliest relevant record for the FEA-2210 full-prior-period rule.
 * NOTE: the production query reads session_analytics.started_at for the
 * session half; the seeded store's session_analytics.started_at mirrors
 * sessions.started_at (L2-proven), so sessions is an equivalent source. */
export function deriveEarliestRecordIso(rows: L3Rows): string | null {
  let earliest: string | null = null;
  // FEA-3585: reviewed-only PRs don't move the earliest-record boundary (mirrors
  // the production earliest-record query's reviewed-only exclusion).
  for (const a of deliveryPrArtifacts(rows)) {
    const ts = prWindowTs(a);
    if (ts !== null && (earliest === null || ts < earliest)) {
      earliest = ts;
    }
  }
  for (const s of rows.sessions) {
    if (
      s.started_at !== null &&
      (earliest === null || s.started_at < earliest)
    ) {
      earliest = s.started_at;
    }
  }
  return earliest;
}

export function hasFullPriorPeriodTwin(
  rows: L3Rows,
  priorStartIso: string
): boolean {
  const earliest = deriveEarliestRecordIso(rows);
  return earliest !== null && earliest <= priorStartIso;
}

// ── Sessions page twins (read-stores getPage) ────────────────────────────────

export type PageFilterTwin = {
  status?: string | null;
  q?: string | null;
};

/** LIKE '%q%' twin over id/name/cwd/model — case-insensitive per SQLite LIKE
 * default on ASCII. */
function likeContains(haystack: string | null, needle: string): boolean {
  if (haystack === null) {
    return false;
  }
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function deriveSessionPageSet(
  rows: L3Rows,
  filter: PageFilterTwin
): SessionRow[] {
  const status =
    typeof filter.status === "string" && filter.status.length > 0
      ? filter.status
      : null;
  const q =
    typeof filter.q === "string" && filter.q.trim().length > 0
      ? filter.q.trim()
      : null;
  let set = rows.sessions;
  if (status === DESKTOP_AGENT_STATUS.WAITING) {
    set = set.filter(
      (s) =>
        !TERMINAL_STATUS_SET.has(s.status) && s.awaiting_input_since !== null
    );
  } else if (status === DESKTOP_AGENT_STATUS.RUNNING) {
    set = set.filter(
      (s) =>
        !TERMINAL_STATUS_SET.has(s.status) && s.awaiting_input_since === null
    );
  } else if (status && status !== "all") {
    set = set.filter((s) => s.status === status);
  }
  if (q) {
    set = set.filter(
      (s) =>
        likeContains(s.id, q) ||
        likeContains(s.name, q) ||
        likeContains(s.cwd, q) ||
        likeContains(s.model, q)
    );
  }
  // ORDER BY started_at DESC, id DESC
  return [...set].sort((a, b) => {
    const sa = a.started_at ?? "";
    const sb = b.started_at ?? "";
    if (sa !== sb) {
      return compareStrings(sb, sa);
    }
    return compareStrings(b.id, a.id);
  });
}

// ── Per-session detail twins ─────────────────────────────────────────────────

export type SessionDetailTwin = {
  sessionId: string;
  agentCount: number;
  eventCount: number;
  totalTokens: number;
  costUsdEstimated: number | null;
};

export function deriveSessionDetail(
  rows: L3Rows,
  sessionId: string
): SessionDetailTwin {
  const agentCount = rows.agents.filter(
    (a) => a.session_id === sessionId
  ).length;
  const eventCount = rows.events.filter(
    (e) => e.session_id === sessionId
  ).length;
  let tokens = 0;
  for (const t of rows.tokenUsage) {
    if (t.session_id === sessionId) {
      tokens += num(t.input_tokens) + num(t.output_tokens);
    }
  }
  const session = rows.sessions.find((s) => s.id === sessionId);
  return {
    sessionId,
    agentCount,
    eventCount,
    totalTokens: tokens,
    costUsdEstimated: session?.cost_usd_estimated ?? null,
  };
}

// ── Group-by twins ───────────────────────────────────────────────────────────

export function countBy<T>(
  items: T[],
  key: (item: T) => string | null
): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    if (k === null) {
      continue;
    }
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
}

// ── Skills / packs twins (dashboard getSkills / getPacks) ────────────────────

// Re-check finding: production name resolution TRIMS and rejects
// whitespace-only strings (nonEmptyString, db-helpers.ts) — the twin must
// match or a whitespace-padded skill name diverges the two ids and blames
// production. String-primitive reuse, same policy as `median`.
function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type SkillTwin = {
  id: string;
  packId: string | null;
  name: string;
  harness: string;
  invocationCount: number;
};

/** getSkills twin: events with toolName='Skill', name from
 * data.skillName/skill/name then summary, harness looked up per session,
 * grouped by `${harness}:${packId ?? "standalone"}:${name}`. Reuses the
 * production `packIdFromSkillName` (pack identity is not this layer's
 * subject; the counts and grouping are). */
export function deriveSkills(rows: L3Rows): Map<string, SkillTwin> {
  const harnessBySession = new Map(rows.sessions.map((s) => [s.id, s.harness]));
  const grouped = new Map<string, SkillTwin>();
  for (const e of rows.events) {
    if (e.tool_name !== "Skill") {
      continue;
    }
    let data: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = e.data === null ? null : JSON.parse(e.data);
      data =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
    } catch {
      data = null;
    }
    const name =
      nonEmpty(data?.skillName) ??
      nonEmpty(data?.skill) ??
      nonEmpty(data?.name) ??
      nonEmpty(e.summary);
    if (!name) {
      continue;
    }
    const harness =
      nonEmpty(harnessBySession.get(e.session_id) ?? null) ?? "unknown";
    const packId = packIdFromSkillName(name);
    const id = `${harness}:${packId ?? "standalone"}:${name}`;
    const existing = grouped.get(id);
    if (existing) {
      existing.invocationCount++;
    } else {
      grouped.set(id, { id, packId, name, harness, invocationCount: 1 });
    }
  }
  return grouped;
}

export type PackTwin = {
  id: string;
  skillCount: number;
  toolCallCount: number;
};

/** getPacks twin: group the skill twins by packId (skipping standalone). */
export function derivePacks(
  skills: Map<string, SkillTwin>
): Map<string, PackTwin> {
  const packs = new Map<string, PackTwin>();
  for (const skill of skills.values()) {
    if (!skill.packId) {
      continue;
    }
    const pack = packs.get(skill.packId) ?? {
      id: skill.packId,
      skillCount: 0,
      toolCallCount: 0,
    };
    pack.skillCount++;
    pack.toolCallCount += skill.invocationCount;
    packs.set(skill.packId, pack);
  }
  return packs;
}

/** getWorkflowData cooccurrence twin: DISTINCT (session, agent-type) pairs,
 * then per unordered type pair (t1 < t2) COUNT(DISTINCT session). */
export function deriveCooccurrence(rows: L3Rows): Map<string, number> {
  const typesBySession = new Map<string, Set<string>>();
  for (const a of rows.agents) {
    const type = a.subagent_type ?? a.type ?? "unknown";
    const set = typesBySession.get(a.session_id) ?? new Set<string>();
    set.add(type);
    typesBySession.set(a.session_id, set);
  }
  const weights = new Map<string, number>();
  for (const types of typesBySession.values()) {
    const sorted = [...types].sort(compareStrings);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}→${sorted[j]}`;
        weights.set(key, (weights.get(key) ?? 0) + 1);
      }
    }
  }
  return weights;
}

// Independent Layer 3 twin of the production display allocator. This must not
// import local-insights.ts: the golden expected-value path owns its derivation.
export function allocateRoundedUsdValues(
  values: Readonly<Record<string, number>>,
  targetTotal?: number
): Record<string, number> {
  const entries = Object.entries(values).map(([key, value]) => {
    const exactCents = value * 100;
    const allocatedCents = Math.trunc(exactCents);
    return {
      allocatedCents,
      key,
      remainder: exactCents - allocatedCents,
      value,
    };
  });
  if (entries.length === 0) {
    return {};
  }

  const targetCents = Math.round((targetTotal ?? stableUsdSum(entries)) * 100);
  let remainingCents =
    targetCents - entries.reduce((sum, entry) => sum + entry.allocatedCents, 0);
  const direction = Math.sign(remainingCents);
  if (direction !== 0) {
    const candidates = entries
      .filter((entry) =>
        direction > 0 ? entry.remainder > 0 : entry.remainder < 0
      )
      .sort((a, b) => compareUsdRemainders(a, b, direction));
    const apportioned = Math.min(Math.abs(remainingCents), candidates.length);
    for (let index = 0; index < apportioned; index += 1) {
      candidates[index].allocatedCents += direction;
    }
    remainingCents -= direction * apportioned;
  }
  if (remainingCents !== 0) {
    const recipient = entries.reduce((largest, entry) =>
      compareUsdMagnitude(entry, largest) < 0 ? entry : largest
    );
    recipient.allocatedCents += remainingCents;
  }

  return Object.fromEntries(
    entries.map((entry) => [
      entry.key,
      normalizeUsdZero(entry.allocatedCents / 100),
    ])
  );
}

type UsdAllocationEntry = {
  allocatedCents: number;
  key: string;
  remainder: number;
  value: number;
};

function stableUsdSum(entries: readonly UsdAllocationEntry[]): number {
  return [...entries]
    .sort((a, b) => compareStrings(a.key, b.key))
    .reduce((sum, entry) => sum + entry.value, 0);
}

function compareUsdRemainders(
  a: UsdAllocationEntry,
  b: UsdAllocationEntry,
  direction: number
): number {
  const difference =
    direction > 0 ? b.remainder - a.remainder : a.remainder - b.remainder;
  return difference || compareStrings(a.key, b.key);
}

function compareUsdMagnitude(
  a: UsdAllocationEntry,
  b: UsdAllocationEntry
): number {
  return Math.abs(b.value) - Math.abs(a.value) || compareStrings(a.key, b.key);
}

function normalizeUsdZero(value: number): number {
  return value === 0 ? 0 : value;
}
