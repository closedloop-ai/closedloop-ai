/**
 * FEA-2649: corpus-expectations.yaml generator.
 *
 * Usage (from apps/desktop):
 *   pnpm exec tsx test/golden/derive-corpus-expectations.ts [--output <path>] [--contrib-dir <dir>]
 *   pnpm exec tsx test/golden/derive-corpus-expectations.ts --emit-json   # TZ worker
 *
 * The main invocation spawns TWO children of itself — TZ=UTC and
 * TZ=America/Chicago — because Node caches the process timezone; per-TZ local
 * bucketing cannot be derived reliably in one process. Each child seeds a temp
 * SQLite store through the PRODUCTION importer (the Layer 2 shared-DB recipe),
 * captures raw rows, derives its payload, and prints JSON. The parent asserts
 * the TZ-invariant sections are byte-identical between children, merges the
 * TZ-dependent sections under utc:/chicago: keys, and writes a PROPOSED file.
 * The default output is packages/golden-sessions/corpus-expectations.yaml, but
 * once that file is SIGNED the generator refuses to overwrite it. Regenerate
 * to a temporary --output path and review the diff instead.
 *
 * The values it writes are a PROPOSAL; signing is governed by
 * packages/golden-sessions/AGENTS.md. The generator never runs in CI and the
 * runner never regenerates the yaml — tests only READ it.
 *
 * With --contrib-dir, each child also writes one per-dossier contribution JSON
 * (this session's share of every rollup) for the per-session verification
 * agents mandated by PLN-1340 v3.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { InsightsPeriod } from "@closedloop-ai/loops-api/insights";
import { median } from "@repo/api/src/utils/math";
import { stringify as yamlStringify } from "yaml";
import { TERMINAL_STATUS_SET } from "../../src/main/database/db-constants.js";
import { openTestDb } from "../agent-db-test-utils.js";
import { assertCorpusExpectationsWritable } from "./corpus-expectations-file.js";
import {
  activeWriteLinks,
  agentSuccessRateTwin,
  captureLayer3Rows,
  compareStrings,
  countBy,
  createdArtifactIdSet,
  deriveAutonomyByDay,
  deriveAvgDepth,
  deriveAvgDurationSec,
  deriveDashboardPrArtifactIds,
  deriveHeatmapCells,
  deriveLocRows,
  deriveSpendByModel,
  deriveTtmLatencies,
  deriveUsageTotalsInWindow,
  deriveWindowCost,
  hasFullPriorPeriodTwin,
  isFailedAgentStatus,
  isSubagentRow,
  isSuccessAgentStatus,
  type L3Rows,
  loadCorpus,
  localDayOf,
  num,
  prArtifactsInWindow,
  rangeTwin,
  seedCorpus,
  tokenEventsInWindow,
  windowSessions,
} from "./golden-layer3-derive.js";
import { deriveKloc, deriveMedianPrSize } from "./golden-layer3-derive-loc.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CORPUS_YAML_PATH = resolve(
  dirname(SCRIPT_PATH),
  "../../../../packages/golden-sessions/corpus-expectations.yaml"
);
const PERIODS = [
  InsightsPeriod.Week,
  InsightsPeriod.Month,
  InsightsPeriod.Quarter,
  InsightsPeriod.All,
] as const;

type TzPayload = {
  tz: string;
  invariant: Record<string, unknown>;
  tzDependent: Record<string, unknown>;
};

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function sortRecord<T>(entries: Iterable<[string, T]>): Record<string, T> {
  return Object.fromEntries(
    [...entries].sort(([a], [b]) => compareStrings(a, b))
  );
}

async function derivePayload(contribDir: string | null): Promise<TzPayload> {
  const corpus = loadCorpus();
  const dir = mkdtempSync(join(tmpdir(), "golden-l3-derive-"));
  let db: Awaited<ReturnType<typeof openTestDb>> | undefined;
  try {
    db = await openTestDb(dir, { now: () => corpus.referenceNowIso });
    await seedCorpus(db, corpus);
    const rows = await captureLayer3Rows(db);
    const payload = buildPayload(rows, corpus.referenceNowIso, corpus);
    if (contribDir) {
      writeContributions(rows, corpus.referenceNowIso, contribDir, corpus);
    }
    return payload;
  } finally {
    try {
      await db?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function buildWindowsSection(
  rows: L3Rows,
  refIso: string
): Record<string, unknown> {
  const windows: Record<string, unknown> = {};
  for (const period of PERIODS) {
    const range = rangeTwin(period, refIso);
    const inWin = windowSessions(rows, range.startIso, range.endIso);
    const inWinIds = new Set(inWin.map((s) => s.id));
    const prior = rows.sessions.filter(
      (s) =>
        s.started_at !== null &&
        s.started_at >= range.priorStartIso &&
        s.started_at < range.startIso
    );
    const locRows = deriveLocRows(rows, range.startIso, range.endIso);
    const usage = deriveUsageTotalsInWindow(rows, range.startIso, range.endIso);
    windows[period] = {
      window_start: period === InsightsPeriod.All ? "epoch" : range.startIso,
      sessions: inWin.length,
      prior_window_sessions: period === InsightsPeriod.All ? 0 : prior.length,
      has_full_prior_period:
        period === InsightsPeriod.All
          ? false
          : hasFullPriorPeriodTwin(rows, range.priorStartIso),
      cost_usd_store: round6(
        deriveWindowCost(rows, range.startIso, range.endIso)
      ),
      usage_totals: {
        tokens: usage.tokens,
        input: usage.input,
        output: usage.output,
        cache_read: usage.cacheRead,
        cache_write: usage.cacheWrite,
        models_in_use: usage.models,
      },
      per_model_spend_usd: sortRecord(
        [...deriveSpendByModel(rows, range.startIso, range.endIso)].map(
          ([m, v]) => [m, round6(v)] as [string, number]
        )
      ),
      pr_captured: prArtifactsInWindow(rows, range.startIso, range.endIso)
        .length,
      pr_merged_state_basis: 0,
      median_pr_size: deriveMedianPrSize(locRows),
      kloc_captured: deriveKloc(locRows),
      ttm_median_ms: median(
        deriveTtmLatencies(rows, range.startIso, range.endIso)
      ),
      tool_events: rows.events.filter(
        (e) => e.tool_name !== null && inWinIds.has(e.session_id)
      ).length,
    };
  }
  return windows;
}

type TokensByModelTotals = {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
};

function buildTokenAnalyticsSection(
  windowEvents: ReturnType<typeof tokenEventsInWindow>
): Record<string, unknown> {
  const taTotals = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const taByModel = new Map<
    string,
    { input: number; output: number; sessions: Set<string>; cost: number }
  >();
  for (const e of windowEvents) {
    taTotals.input += num(e.input_tokens);
    taTotals.output += num(e.output_tokens);
    taTotals.cache_read += num(e.cache_read_tokens);
    taTotals.cache_write += num(e.cache_write_tokens);
    if (e.model !== null) {
      const m = taByModel.get(e.model) ?? {
        input: 0,
        output: 0,
        sessions: new Set<string>(),
        cost: 0,
      };
      m.input += num(e.input_tokens);
      m.output += num(e.output_tokens);
      m.sessions.add(e.session_id);
      m.cost += num(e.cost_usd_estimated);
      taByModel.set(e.model, m);
    }
  }
  return {
    totals: taTotals,
    by_model: sortRecord(
      [...taByModel].map(([m, v]) => [
        m,
        {
          input: v.input,
          output: v.output,
          sessions: v.sessions.size,
          cost_usd_events: round6(v.cost),
        },
      ])
    ),
  };
}

function buildCostConservationSection(rows: L3Rows): Record<string, unknown> {
  // per-session cost conservation: token_events vs token_usage (FEA-3232 surface)
  const eventCostBySession = new Map<string, number>();
  for (const e of rows.tokenEvents) {
    eventCostBySession.set(
      e.session_id,
      (eventCostBySession.get(e.session_id) ?? 0) + num(e.cost_usd_estimated)
    );
  }
  const usageCostBySession = new Map<string, number>();
  for (const t of rows.tokenUsage) {
    usageCostBySession.set(
      t.session_id,
      (usageCostBySession.get(t.session_id) ?? 0) + num(t.cost_usd_estimated)
    );
  }
  return sortRecord(
    [...usageCostBySession].map(([sid, usageCost]) => [
      sid,
      {
        token_usage_usd: round6(usageCost),
        token_events_usd: round6(eventCostBySession.get(sid) ?? 0),
      },
    ])
  );
}

function buildOracleSections(
  rows: L3Rows,
  corpus: ReturnType<typeof loadCorpus>
): { oracle: Record<string, unknown>; storeTokens: Record<string, unknown> } {
  // oracle overlays (Σ over the signed per-dossier expectations.yaml).
  // These deliberately DIFFER from the store-derived values wherever the open
  // L1 parser bugs sit (FEA-3126 output double-add, etc.) — the visible delta
  // is the point: the runner resolves it through the divergence registries.
  let oracleUserTurns = 0;
  let oracleAssistantTurns = 0;
  const oracleTokensByModel = new Map<string, TokensByModelTotals>();
  for (const { d } of corpus.inputs) {
    oracleUserTurns += d.expectations.turns?.user ?? 0;
    oracleAssistantTurns += d.expectations.turns?.assistant ?? 0;
    for (const [model, t] of Object.entries(
      d.expectations.tokens_by_model ?? {}
    )) {
      const m = oracleTokensByModel.get(model) ?? {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
      };
      m.input += t?.input ?? 0;
      m.output += t?.output ?? 0;
      m.cache_read += t?.cache_read ?? 0;
      m.cache_write += t?.cache_write ?? 0;
      oracleTokensByModel.set(model, m);
    }
  }
  const storeTokensByModel = new Map<string, TokensByModelTotals>();
  for (const t of rows.tokenUsage) {
    if (t.model === null) {
      continue;
    }
    const m = storeTokensByModel.get(t.model) ?? {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    };
    m.input += num(t.input_tokens);
    m.output += num(t.output_tokens);
    m.cache_read += num(t.cache_read_tokens);
    m.cache_write += num(t.cache_write_tokens);
    storeTokensByModel.set(t.model, m);
  }
  return {
    oracle: {
      // No cost key: per-dossier cost.total is deliberately ZERO across the
      // corpus (pricing is genai-prices at INGEST, not a parser fact the L1
      // review could sign) — the store's token_usage.cost_usd_estimated is
      // the cost ground truth at this layer.
      turns_user_total: oracleUserTurns,
      turns_assistant_total: oracleAssistantTurns,
      tokens_by_model: sortRecord(oracleTokensByModel),
    },
    storeTokens: sortRecord(storeTokensByModel),
  };
}

function buildPayload(
  rows: L3Rows,
  refIso: string,
  corpus: ReturnType<typeof loadCorpus>
): TzPayload {
  // ── TZ-invariant sections ──────────────────────────────────────────────
  const statuses = sortRecord(countBy(rows.sessions, (s) => s.status));
  const byHarness = sortRecord(countBy(rows.sessions, (s) => s.harness));
  const distinctEventTypes = new Set(rows.events.map((e) => e.event_type)).size;
  let usageInput = 0;
  let usageOutput = 0;
  for (const t of rows.tokenUsage) {
    usageInput += num(t.input_tokens);
    usageOutput += num(t.output_tokens);
  }
  const windows = buildWindowsSection(rows, refIso);
  const windowEvents = tokenEventsInWindow(rows, refIso);

  // workflow
  const subagents = rows.agents.filter(isSubagentRow);
  const completedAgents = rows.agents.filter((a) =>
    isSuccessAgentStatus(a.status)
  ).length;
  const errorAgents = rows.agents.filter((a) =>
    isFailedAgentStatus(a.status)
  ).length;
  const subagentTypes = sortRecord(
    countBy(subagents, (a) => a.subagent_type ?? a.type ?? "unknown")
  );

  // core features
  const toolCounts = sortRecord(countBy(rows.events, (e) => e.tool_name));
  const skillEvents = rows.events.filter((e) => e.tool_name === "Skill").length;

  // branches
  const writeLinks = activeWriteLinks(rows);
  const branchKeys = new Set(
    writeLinks.map(
      (w) =>
        `${w.artifact.repo_full_name ?? ""}#${w.artifact.branch_name ?? ""}`
    )
  );

  const { oracle, storeTokens } = buildOracleSections(rows, corpus);

  const invariant: Record<string, unknown> = {
    oracle,
    store_tokens_by_model: storeTokens,
    corpus: {
      dossiers_total: corpus.dossiersTotal,
      sessions_imported: rows.sessions.length,
      by_harness: byHarness,
      sessions_by_status_store: statuses,
    },
    summary: {
      total_sessions: rows.sessions.length,
      // getSummary's "active" = NOT terminal (matches the production filter;
      // review round-1 correctness finding — was status === "running").
      active_sessions: rows.sessions.filter(
        (s) => !TERMINAL_STATUS_SET.has(s.status)
      ).length,
      total_agents: rows.agents.length,
      total_events: rows.events.length,
      distinct_event_types: distinctEventTypes,
      total_tokens_usage: usageInput + usageOutput,
    },
    windows,
    cost_conservation_by_session: buildCostConservationSection(rows),
    workflow: {
      total_agents: rows.agents.length,
      total_subagents: subagents.length,
      main_count: rows.agents.length - subagents.length,
      completed_agents: completedAgents,
      error_agents: errorAgents,
      success_rate: round6(agentSuccessRateTwin(completedAgents, errorAgents)),
      avg_depth: round6(deriveAvgDepth(rows)),
      avg_duration_sec: round6(deriveAvgDurationSec(rows)),
      subagent_types: subagentTypes,
    },
    core_features: {
      distinct_tools: Object.keys(toolCounts).length,
      tool_invocations_total: Object.values(toolCounts).reduce(
        (s, v) => s + v,
        0
      ),
      tool_counts: toolCounts,
      skill_invocation_events: skillEvents,
      // getPullRequests population (pr_number + repo + ≥1 link), not every
      // kind='pull_request' row — review round-1 correctness finding.
      pull_request_artifacts: deriveDashboardPrArtifactIds(rows).size,
      created_link_artifacts: createdArtifactIdSet(rows).size,
    },
    sessions_page: {
      total: rows.sessions.length,
      terminal: rows.sessions.length,
      waiting: 0,
      running_filter_matches: 0,
    },
    branches: {
      active_write_links: writeLinks.length,
      distinct_push_qualified_branch_keys: branchKeys.size,
      pull_request_rows: rows.pullRequests.length,
    },
  };

  // ── TZ-dependent sections (local-day buckets) ──────────────────────────
  const trend90 = rangeTwin(InsightsPeriod.Quarter, refIso);
  const autonomy = deriveAutonomyByDay(
    rows,
    trend90.trendStartIso,
    trend90.endIso
  );
  const heatmap = deriveHeatmapCells(
    rows,
    trend90.trendStartIso,
    trend90.endIso
  );
  const heatmapDayTotals = new Map<string, { human: number; agent: number }>();
  for (const c of heatmap) {
    const d = heatmapDayTotals.get(c.day) ?? { human: 0, agent: 0 };
    d.human += c.human;
    d.agent += c.agent;
    heatmapDayTotals.set(c.day, d);
  }
  const sessionsPerDay = countBy(rows.sessions, (s) =>
    s.started_at === null ? null : localDayOf(s.started_at)
  );
  const tokenEventsCostPerDay = new Map<string, number>();
  for (const e of windowEvents) {
    const day = localDayOf(e.created_at);
    tokenEventsCostPerDay.set(
      day,
      (tokenEventsCostPerDay.get(day) ?? 0) + num(e.cost_usd_estimated)
    );
  }

  const tzDependent: Record<string, unknown> = {
    // getTokenAnalytics uses a 30-local-calendar-day window. Its totals and
    // by-model rows therefore vary by timezone when an event lands inside the
    // UTC/local-midnight boundary, not only its per-day rendering.
    token_analytics_30d: buildTokenAnalyticsSection(windowEvents),
    autonomy_by_day: sortRecord(
      autonomy.map((p) => [
        p.day,
        {
          agent: p.agent,
          total: p.total,
          index: round6((100 * p.agent) / p.total),
        },
      ])
    ),
    heatmap_day_totals: sortRecord(
      [...heatmapDayTotals].map(([day, v]) => [day, v])
    ),
    sessions_started_per_day: sortRecord(sessionsPerDay),
    token_events_cost_per_day_30d: sortRecord(
      [...tokenEventsCostPerDay].map(([d, v]) => [d, round6(v)])
    ),
  };

  return { tz: process.env.TZ ?? "unknown", invariant, tzDependent };
}

function buildStoreContribution(
  rows: L3Rows,
  sid: string
): Record<string, unknown> {
  const usage = rows.tokenUsage.filter((t) => t.session_id === sid);
  const events = rows.events.filter((e) => e.session_id === sid);
  const tEvents = rows.tokenEvents.filter((e) => e.session_id === sid);
  const buckets = rows.turnBuckets.filter((b) => b.session_id === sid);
  const session = rows.sessions.find((s) => s.id === sid);
  const bucketTotal = (kind: string) =>
    buckets
      .filter((b) => b.turn_kind === kind)
      .reduce((s, b) => s + num(b.turn_count), 0);
  return {
    status: session?.status ?? null,
    started_at: session?.started_at ?? null,
    ended_at: session?.ended_at ?? null,
    harness: session?.harness ?? null,
    cost_usd_estimated: session?.cost_usd_estimated ?? null,
    token_usage: usage.map((t) => ({
      model: t.model,
      input: num(t.input_tokens),
      output: num(t.output_tokens),
      cache_read: num(t.cache_read_tokens),
      cache_write: num(t.cache_write_tokens),
      cost_usd: t.cost_usd_estimated,
    })),
    token_events_cost_usd: round6(
      tEvents.reduce((s, e) => s + num(e.cost_usd_estimated), 0)
    ),
    event_count: events.length,
    tool_counts: sortRecord(countBy(events, (e) => e.tool_name)),
    agent_count: rows.agents.filter((a) => a.session_id === sid).length,
    subagent_count: rows.agents.filter(
      (a) => a.session_id === sid && isSubagentRow(a)
    ).length,
    turn_bucket_totals: {
      human: bucketTotal("human"),
      agent: bucketTotal("agent"),
    },
    turn_buckets_by_local_day: sortRecord(
      countBy(buckets, (b) => localDayOf(b.ts))
    ),
    pr_artifacts: rows.artifacts
      .filter(
        (a) =>
          a.kind === "pull_request" &&
          rows.artifactLinks.some(
            (l) => l.artifact_id === a.id && l.session_id === sid
          )
      )
      .map((a) => ({
        repo: a.repo_full_name,
        pr_number: a.pr_number === null ? null : num(a.pr_number),
        observed_at: a.observed_at,
      })),
  };
}

function buildContribution(
  rows: L3Rows,
  refIso: string,
  d: ReturnType<typeof loadCorpus>["inputs"][number]["d"],
  input: ReturnType<typeof loadCorpus>["inputs"][number]["input"]
): Record<string, unknown> {
  return {
    sessionId: d.sessionId,
    referenceNow: refIso,
    tz: process.env.TZ ?? "unknown",
    store: buildStoreContribution(rows, d.sessionId),
    input_facts: {
      startedAt: input.startedAt ?? null,
      endedAt: input.endedAt ?? null,
      gitBranch: input.gitBranch ?? null,
      tokensByModel: input.tokensByModel ?? null,
      toolUses: (input.toolUses ?? []).length,
      messages: (input.messages ?? []).length,
      tokenSeries: (input.tokenSeries ?? []).length,
      subagents: (input.subagents ?? []).length,
    },
    oracle_facts: {
      harness: d.expectations.harness ?? null,
      status: d.expectations.session?.status ?? null,
      cost_total: d.expectations.cost?.total ?? null,
      tokens_by_model: d.expectations.tokens_by_model ?? null,
      turns: d.expectations.turns ?? null,
      subagent_count: d.expectations.subagents?.count ?? null,
      tools: d.expectations.activity?.tools ?? null,
    },
  };
}

function writeContributions(
  rows: L3Rows,
  refIso: string,
  contribDir: string,
  corpus: ReturnType<typeof loadCorpus>
): void {
  mkdirSync(contribDir, { recursive: true });
  for (const { d, input } of corpus.inputs) {
    const contribution = buildContribution(rows, refIso, d, input);
    writeFileSync(
      join(contribDir, `${d.sessionId}.json`),
      `${JSON.stringify(contribution, null, 2)}\n`
    );
  }
}

// ── YAML assembly (parent) ───────────────────────────────────────────────────

function runChild(tz: string, contribDir: string | null): TzPayload {
  const args = [SCRIPT_PATH, "--emit-json"];
  if (contribDir) {
    args.push("--contrib-dir", join(contribDir, tz.replace(/\//g, "_")));
  }
  const res = spawnSync("pnpm", ["exec", "tsx", ...args], {
    cwd: resolve(dirname(SCRIPT_PATH), "../.."),
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  });
  if (res.status !== 0) {
    throw new Error(
      `TZ=${tz} derivation child failed (${String(res.status)}):\n${res.stderr}`
    );
  }
  const start = res.stdout.lastIndexOf("\n__L3_PAYLOAD__");
  const end = res.stdout.lastIndexOf("__L3_PAYLOAD_END__");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `TZ=${tz} child printed no payload markers:\n${res.stdout.slice(-2000)}`
    );
  }
  return JSON.parse(
    res.stdout.slice(start + "\n__L3_PAYLOAD__".length, end)
  ) as TzPayload;
}

function assembleYaml(
  referenceNowIso: string,
  utc: TzPayload,
  chicago: TzPayload
): string {
  if (!isDeepStrictEqual(utc.invariant, chicago.invariant)) {
    throw new Error(
      "TZ-invariant sections differ between UTC and America/Chicago derivations — " +
        "a section assumed TZ-independent is not; fix the derivation before drafting"
    );
  }
  const header = `# corpus-expectations.yaml — corpus-level golden rollups (FEA-2649, Layer 3).
#
# STATUS: the \`status:\` scalar below is the only authority — this comment block
# is generated and never re-emitted on signing, so it must not restate the
# current state. Lifecycle and signing: packages/golden-sessions/AGENTS.md.
#
# Derivation (mechanical, reproducible):
#   apps/desktop/test/golden/derive-corpus-expectations.ts
#   — seeds a temp SQLite store by running db.importer.importSession(<dossier
#     normalized.json>) for all importable dossiers (the Layer 2 shared-DB
#     recipe) at the pinned reference clock, reads the raw tables back, and
#     recomputes every rollup in JS. Layer 2 (FEA-2647) proves the seeded store
#     equals the dossiers, so these values are the store-truth of the corpus.
#   — oracle_* keys are summed from the signed per-dossier
#     expectations.yaml files instead (they differ from store-derived values
#     exactly where the open L1 parser bugs FEA-3124/3125/3126/3127/3153 and
#     L2 storage bugs FEA-3226..3229/3232 sit; the Layer 3 runner resolves
#     those deltas through the divergence registries).
#
# BASIS (load-bearing): the seeded store is IMPORT-ONLY — the enrichment sweep
# (which fills artifacts.pr_state and lines_added/removed via the local gh CLI)
# never runs in the hermetic test env. Merged-PR counts, merge rate, median PR
# size, and KLOC therefore sign as 0/null here BY DESIGN; they are not claims
# that no corpus PR ever merged.
#
# BASIS 2 (tool tallies): tool_counts / tool_events count ALL captured events,
# INCLUDING folded subagent tool uses — that is what the dashboard Tools
# surfaces aggregate. The per-dossier oracle activity.tools is
# parent-transcript-only by the L1 signed convention, so the two tallies
# legitimately differ on dossiers with folded subagents (per-session
# verification flagged c980bd56 Bash 49→64/Read 9→13 and eec22ae6 Bash
# 44→61/Read 18→32). Whether the product SHOULD count subagent tool use is a
# display-semantics decision for the corpus maintainer (FEA-2649 adjudication).
#
# reference_now is a PURE FUNCTION of the corpus: max ISO timestamp anywhere in
# the import inputs, plus 1h (the Layer 2 clock rule). The runner
# recomputes it and fails if this literal drifts — any corpus intake therefore
# forces a re-derivation + re-signing under packages/golden-sessions/AGENTS.md.
#
# Time windows: "7"/"30"/"90" are rolling UTC instants ending at reference_now
# (the insights resolveRange contract); day buckets are LOCAL calendar days —
# TZ-dependent sections carry utc:/chicago: variants and the dual-TZ suites
# each assert their own.
`;
  const doc: Record<string, unknown> = {
    schema_version: 2,
    status: "PROPOSED",
    derived_by:
      "apps/desktop/test/golden/derive-corpus-expectations.ts (FEA-3362 corpus intake)",
    reference_now: referenceNowIso,
    ...utc.invariant,
    tz_dependent: {
      utc: utc.tzDependent,
      chicago: chicago.tzDependent,
    },
  };
  return header + yamlStringify(doc, { sortMapEntries: false });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const emitJson = argv.includes("--emit-json");
  const contribFlag = argv.indexOf("--contrib-dir");
  const contribDir = contribFlag === -1 ? null : argv[contribFlag + 1];
  const outputFlag = argv.indexOf("--output");
  const outputArg = outputFlag === -1 ? null : argv[outputFlag + 1];
  if (outputFlag !== -1 && !outputArg) {
    throw new Error("--output requires a file path");
  }
  const outputPath = outputArg ? resolve(outputArg) : CORPUS_YAML_PATH;

  if (emitJson) {
    const payload = await derivePayload(contribDir ?? null);
    process.stdout.write(
      `\n__L3_PAYLOAD__${JSON.stringify(payload)}__L3_PAYLOAD_END__\n`
    );
    return;
  }

  assertCorpusExpectationsWritable(outputPath);
  const corpus = loadCorpus();
  const utc = runChild("UTC", contribDir);
  const chicago = runChild("America/Chicago", contribDir);
  const yaml = assembleYaml(corpus.referenceNowIso, utc, chicago);
  assertCorpusExpectationsWritable(outputPath);
  writeFileSync(outputPath, yaml);
  process.stdout.write(
    `wrote ${outputPath} (reference_now ${corpus.referenceNowIso})\n`
  );
}

await main();
