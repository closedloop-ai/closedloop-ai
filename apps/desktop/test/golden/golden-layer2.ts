/**
 * FEA-2647 Layer 2 golden runner — shared harness.
 *
 * Layer 1 (golden-corpus.ts) proved parse(raw) == normalized.json. This layer
 * proves the WRITE PATH: importing each dossier's frozen normalized.json through
 * the production importer (write-core.ts, via openSqliteAgentDatabase) puts it
 * into the SQLite metric stores without losing, duplicating, or reshaping
 * anything. Per dossier:
 *
 *   1. Fidelity facts (HARD): store == f(input), where f derives the expected
 *      store value from the input NormalizedSession by the documented
 *      write-core contract. A red here is unambiguously a storage bug.
 *   2. Oracle facts (dossier keys): store == expectations.yaml, resolved
 *      through TWO divergence registries — Layer-1-inherited entries
 *      (golden-divergences.ts: the INPUT disagrees with the oracle; expires
 *      when the parser fix lands and normalized.json is re-blessed per
 *      packages/golden-sessions/AGENTS.md) and
 *      Layer-2 storage entries (golden-layer2-divergences.ts: the input agrees
 *      with the oracle but the store does not).
 *   3. Frozen per-store snapshots (layer2-snapshots/<sid>.json): regression
 *      guards over EVERY importer-written table — explicitly NOT ground truth.
 *   4. Re-import idempotency on BOTH import paths (a second importSession, and
 *      rebuildSessionFromParse) — byte-identical store state.
 *
 * Standalone named fixtures: FEA-2342 (multi-model codex split survives
 * parse→store), FEA-2347 (deleteSessionRow leaves no orphan rollups), FEA-1839
 * (hook and import channels never double-count), partial-import fault
 * injection, tokenSeries-empty fallback, and a corpus-wide shared-DB pass.
 *
 * Honors packages/golden-sessions/AGENTS.md: strictly READ-ONLY over the
 * corpus. normalized.json is cloned before import (fileModifiedAt nulled); the
 * FEA-1839 fixture stages raw/ into a temp dir before handing it to the hook
 * transcript extractor.
 *
 * Hermeticity: a per-dossier clock NOW_d = max(all ISO timestamps in the
 * input) + 1h (pure function of the input, so future corpus intakes never
 * invalidate existing snapshots); temp-dir SQLite per test; results are
 * TZ-independent (the paired UTC / America/Chicago test files deep-equal the
 * SAME frozen snapshots). GOLDEN_L2_WRITE_SNAPSHOTS=1 (re)writes snapshots and
 * is permitted under TZ=UTC only — the two TZ files run as concurrent child
 * processes and must never race the same snapshot file.
 */
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { WEB_SEARCH_COST_PER_REQUEST_USD } from "@repo/cost/harness-cost-parity";
import { foldCodexDescendants } from "../../src/main/collectors/codex/codex-collector.js";
import { parseRolloutFile } from "../../src/main/collectors/codex/codex-parser.js";
import {
  deriveEndedOnUnrecoveredError,
  type Harness,
  type NormalizedSession,
} from "../../src/main/collectors/types.js";
import { buildEventDedupKey } from "../../src/main/database/deterministic-event-id.js";
import { openTestDb } from "../agent-db-test-utils.js";
import { makeSession } from "../normalized-session-test-utils.js";
import {
  type DossierExpectations,
  discoverDossiers,
  type GoldenDossier,
} from "./golden-corpus.js";
import { findDivergence } from "./golden-divergences.js";
import {
  expectedSubagentRowIds,
  sanitizeSubagentIdSegment,
} from "./golden-layer2-agent-ids.js";
import { normalizeCell } from "./golden-layer2-cell-normalization.js";
import {
  findLayer2Divergence,
  LAYER2_KNOWN_DIVERGENCES,
} from "./golden-layer2-divergences.js";
import { expectedSessionModel } from "./golden-layer2-expected-model.js";
import {
  HOOK_CONVERGENCE_PLAIN_MISSING,
  HOOK_CONVERGENCE_SUBAGENTS_MISSING,
  selectHookConvergenceTargets,
} from "./golden-layer2-fixture-targets.js";
import { dossierNow, loadLayer2Input } from "./golden-layer2-input.js";
import { checkSharedInvocationStores } from "./golden-layer2-invocation-audit.js";
import { registerInvocationDeleteFixture } from "./golden-layer2-invocation-delete-fixture.js";

type TestDb = Awaited<ReturnType<typeof openTestDb>>;

const SNAPSHOT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "layer2-snapshots"
);
const FIXTURES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/golden-layer2"
);
const WRITE_SNAPSHOTS = process.env.GOLDEN_L2_WRITE_SNAPSHOTS === "1";
const TICKET_ID = /^FEA-\d+$/;

/**
 * Every table the importer writes (write-core.ts import phases 1-8). The six
 * stores named by FEA-2647 additionally get fact-level assertions; the rest are
 * snapshot-covered drift detectors (no signed dossier keys exist for them).
 */
const SNAPSHOT_TABLES = [
  "sessions",
  "agents",
  "events",
  "token_usage",
  "token_events",
  "session_analytics",
  "session_tool_analytics",
  "session_turn_bucket",
  "session_activity_segments",
  "session_artifact_links",
  "artifacts",
  "pull_requests",
  "agent_component_invocations",
  "agent_component_invocation_sync_outbox",
  "agent_component_invocation_sync_cursors",
  "agent_component_session_usage",
  "agent_components",
  "agent_component_versions",
] as const;

/** Synthetic session ids used by standalone fixtures (counted as always-present
 * by the registry sweep, since they never appear in the corpus). */
const MULTI_MODEL_FIXTURE_SESSION_ID = "00000000-0000-4000-8000-000000002342";
const TOKEN_FALLBACK_FIXTURE_SESSION_ID = "golden-l2-tokenseries-fallback";
const ALWAYS_PRESENT_FIXTURE_IDS: ReadonlySet<string> = new Set([
  MULTI_MODEL_FIXTURE_SESSION_ID,
  TOKEN_FALLBACK_FIXTURE_SESSION_ID,
]);

/** Representative dossiers carrying the pinned drift facts that keep the
 * ticket-guarded column masks honest (see IDEMPOTENCY_MASKS). */
const UPDATED_AT_PIN_DOSSIER = "c8dcfab8-3de1-46ea-bf8d-84d319242759";
const COMPONENT_LINK_PIN_DOSSIER = "c8dcfab8-3de1-46ea-bf8d-84d319242759";

// ── Expected-from-input derivations (the fidelity oracles) ──────────────────

type TokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

function expectedTokensByModel(
  input: NormalizedSession
): Map<string, TokenCounts> {
  const map = new Map<string, TokenCounts>();
  for (const [model, counts] of Object.entries(input.tokensByModel ?? {})) {
    // tokenUsage.replace skips all-zero rows — mirror that.
    const c = {
      input: counts.input ?? 0,
      output: counts.output ?? 0,
      cacheRead: counts.cacheRead ?? 0,
      cacheWrite: counts.cacheWrite ?? 0,
    };
    if (
      c.input === 0 &&
      c.output === 0 &&
      c.cacheRead === 0 &&
      c.cacheWrite === 0
    ) {
      continue;
    }
    map.set(model, c);
  }
  return map;
}

type TokenEventRow = {
  model: string;
  createdAt: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** Mirrors buildImportSessionContext's tokenEventsRecords + the batched insert's
 * skip-on-missing-timestamp rule (write-core.ts:1247-1257, 4488-4491). */
function expectedTokenEvents(input: NormalizedSession): TokenEventRow[] {
  const series = input.tokenSeries ?? [];
  const records =
    series.length > 0
      ? series
      : Object.entries(input.tokensByModel ?? {}).map(([model, counts]) => ({
          timestamp: input.startedAt ?? "",
          model,
          input: counts.input,
          output: counts.output,
          cacheRead: counts.cacheRead,
          cacheWrite: counts.cacheWrite,
        }));
  return records
    .filter((r) => Boolean(r.timestamp))
    .map((r) => ({
      model: r.model,
      createdAt: r.timestamp,
      input: r.input ?? 0,
      output: r.output ?? 0,
      cacheRead: r.cacheRead ?? 0,
      cacheWrite: r.cacheWrite ?? 0,
    }));
}

/**
 * Pure re-derivation of importPhaseEvents' event ENUMERATION (write-core.ts
 * 1458-1769) — counts by event type, using the SAME exported buildEventDedupKey
 * for within-import dedup. Deliberate double-entry bookkeeping: if the importer
 * enumeration changes, this fact fails loudly and the contract drift is
 * surfaced instead of silently absorbed.
 *
 * Order is load-bearing (first dedup-key wins): subagent toolUses, then
 * messageTimestamps (Stop), then parent toolUses, then TurnDuration, APIError,
 * ToolError, Compaction — exactly the importer's order.
 */
type EventAdder = (
  eventType: string,
  ts: string | null | undefined,
  toolName: string | null,
  discriminator?: string | null
) => void;

/** Folded-child toolUse events (importPhaseEvents' first enumeration block). */
function addSubagentToolUseEvents(
  input: NormalizedSession,
  add: EventAdder
): Set<string> {
  const foldedSubagentIds = new Set<string>();
  for (const sub of input.subagents ?? []) {
    if (sanitizeSubagentIdSegment(sub.id).length === 0) {
      continue;
    }
    foldedSubagentIds.add(sub.id);
    for (const [idx, tu] of (sub.toolUses ?? []).entries()) {
      add(
        "PostToolUse",
        tu.timestamp,
        tu.name ?? null,
        tu.id ?? `${sub.id}:${idx}`
      );
    }
  }
  return foldedSubagentIds;
}

/** Parent-transcript toolUse events: Agent/Task spawns become PreToolUse, the
 * rest PostToolUse; toolUses already folded into a child are skipped. */
function addParentToolUseEvents(
  input: NormalizedSession,
  foldedSubagentIds: ReadonlySet<string>,
  add: EventAdder
): void {
  for (const [idx, tu] of (input.toolUses ?? []).entries()) {
    if (tu.subagentId != null && foldedSubagentIds.has(tu.subagentId)) {
      continue;
    }
    if (tu.name === "Agent" || tu.name === "Task") {
      add("PreToolUse", tu.timestamp, tu.name, tu.id ?? String(idx));
    } else {
      add("PostToolUse", tu.timestamp, tu.name ?? null, tu.id ?? String(idx));
    }
  }
}

function expectedEventCounts(input: NormalizedSession): Record<string, number> {
  const seen = new Set<string>();
  const counts: Record<string, number> = {};
  const add: EventAdder = (eventType, ts, toolName, discriminator) => {
    if (!ts) {
      return;
    }
    const key = buildEventDedupKey(eventType, ts, toolName, discriminator);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    counts[eventType] = (counts[eventType] ?? 0) + 1;
  };

  const foldedSubagentIds = addSubagentToolUseEvents(input, add);
  for (const ts of input.messageTimestamps ?? []) {
    add("Stop", ts, null);
  }
  addParentToolUseEvents(input, foldedSubagentIds, add);
  for (const td of input.turnDurations ?? []) {
    add("TurnDuration", td.timestamp, null);
  }
  for (const err of input.apiErrors ?? []) {
    add("APIError", err.timestamp ?? null, null);
  }
  for (const err of input.toolResultErrors ?? []) {
    add("ToolError", err.timestamp ?? null, null);
  }
  for (const c of input.compactions ?? []) {
    const ts = (c as { timestamp?: string | null }).timestamp;
    add("Compaction", ts ?? null, null);
  }
  return counts;
}

/** Mirrors the session_analytics rollup's transcript_human_turns SQL: count of
 * JSON OBJECT elements in metadata $.messages whose role === 'human'. */
function expectedHumanTurns(input: NormalizedSession): number {
  let n = 0;
  for (const m of input.messages ?? []) {
    if (
      typeof m === "object" &&
      m !== null &&
      !Array.isArray(m) &&
      (m as { role?: unknown }).role === "human"
    ) {
      n += 1;
    }
  }
  return n;
}

// ── Store reads ──────────────────────────────────────────────────────────────

type StoreTokenUsageRow = {
  model: string;
  input_tokens: number | bigint;
  output_tokens: number | bigint;
  cache_read_tokens: number | bigint;
  cache_write_tokens: number | bigint;
  baseline_input: number | bigint;
  baseline_output: number | bigint;
  baseline_cache_read: number | bigint;
  baseline_cache_write: number | bigint;
  usage_source: string;
  cost_usd_estimated: number | null;
};

async function readStoreFacts(db: TestDb, sessionId: string) {
  const client = db.prisma.client;
  const tokenUsageRows = await client.$queryRawUnsafe<StoreTokenUsageRow[]>(
    "SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, baseline_input, baseline_output, baseline_cache_read, baseline_cache_write, usage_source, cost_usd_estimated FROM token_usage WHERE session_id = $1 ORDER BY model",
    sessionId
  );
  const tokenEventRows = await client.$queryRawUnsafe<
    {
      model: string;
      created_at: string;
      input_tokens: number | bigint;
      output_tokens: number | bigint;
      cache_read_tokens: number | bigint;
      cache_write_tokens: number | bigint;
      cost_usd_estimated: number | null;
    }[]
  >(
    "SELECT model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_estimated FROM token_events WHERE session_id = $1 ORDER BY created_at, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens",
    sessionId
  );
  const eventCountRows = await client.$queryRawUnsafe<
    { event_type: string; n: number | bigint }[]
  >(
    "SELECT event_type, COUNT(*) AS n FROM events WHERE session_id = $1 GROUP BY event_type",
    sessionId
  );
  const sessionRows = await client.$queryRawUnsafe<
    {
      id: string;
      status: string;
      harness: string | null;
      model: string | null;
      cwd: string | null;
      started_at: string | null;
      ended_at: string | null;
      billing_mode: string | null;
      metadata: string | null;
      cost_usd_estimated: number | null;
    }[]
  >(
    "SELECT id, status, harness, model, cwd, started_at, ended_at, billing_mode, metadata, cost_usd_estimated FROM sessions WHERE id = $1",
    sessionId
  );
  const analyticsRows = await client.$queryRawUnsafe<
    {
      human_turns: number | bigint;
      agent_turns: number | bigint;
      input_tokens: number | bigint;
      output_tokens: number | bigint;
      cache_read_tokens: number | bigint;
      cache_write_tokens: number | bigint;
      est_cost: number;
      started_day: string | null;
    }[]
  >(
    "SELECT human_turns, agent_turns, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, est_cost, started_day FROM session_analytics WHERE session_id = $1",
    sessionId
  );
  const agentRows = await client.$queryRawUnsafe<
    {
      id: string;
      type: string | null;
      subagent_type: string | null;
      status: string;
    }[]
  >(
    "SELECT id, type, subagent_type, status FROM agents WHERE session_id = $1 ORDER BY id",
    sessionId
  );
  // FEA-3419: the 1h TTL premium is baked into per-event / per-model costs, so
  // the only session-level line item left is web search (see
  // computeSessionLineItemsUsd).
  const sessionLineItemsUsd = computeSessionLineItemsUsd(
    sessionRows[0]?.metadata ?? null
  );
  return {
    tokenUsageRows,
    tokenEventRows,
    eventCounts: Object.fromEntries(
      eventCountRows.map((r) => [r.event_type, Number(r.n)])
    ),
    sessionRow: sessionRows[0],
    analytics: analyticsRows[0],
    agentRows,
    sessionLineItemsUsd,
  };
}

/**
 * Reproduce, from store primitives, the session-level cost line items the
 * rollup adds ON TOP of Σ token_usage.cost_usd_estimated. FEA-3419: the ONLY
 * such line item is the web-search per-request charge (PRD-538) — the FEA-3636
 * blob-based 1h cache-write TTL premium term was removed because the premium is
 * now baked into per-event / per-model costs by estimateTokenCost
 * (cacheWrite1hTokens), so `sessions.cost == Σtoken_usage + webSearch` exactly.
 * Mirrors the production `webSearchCostSql` fragment so the harness stays a
 * faithful, independent oracle for the seam.
 */
function computeSessionLineItemsUsd(metadataJson: string | null): number {
  let webSearchRequests = 0;
  if (metadataJson) {
    try {
      const meta = JSON.parse(metadataJson) as {
        usageExtras?: {
          web_search_requests?: unknown;
        };
      };
      const wsr = Number(meta.usageExtras?.web_search_requests ?? 0);
      webSearchRequests = Number.isFinite(wsr) && wsr > 0 ? wsr : 0;
    } catch {
      // Malformed metadata → no line items (matches the SQL json_valid guard).
    }
  }
  return webSearchRequests * WEB_SEARCH_COST_PER_REQUEST_USD;
}

// ── Snapshot capture ─────────────────────────────────────────────────────────

/**
 * TICKET-GUARDED column masks. Each mask hides a column whose drift is a KNOWN,
 * ticket-tracked storage bug, so the byte-identical comparisons can still guard
 * everything else. A mask is ACTIVE only while at least one registry entry
 * cites its ticket — when the last entry is removed (bug fixed, self-guard
 * fired), the mask auto-deactivates and any residual drift fails hard. The
 * paired `store.*` pinned facts below assert the drift still EXISTS, so a mask
 * can never silently outlive its bug.
 */
type ColumnMask = { table: string; column: string; ticket: string };

/** Masked in idempotency (re-import / rebuild) comparisons only. */
const IDEMPOTENCY_MASKS: ColumnMask[] = [
  // FEA-3228: component link is NULL on first import, healed by re-import.
  {
    table: "agent_component_session_usage",
    column: "agent_component_id",
    ticket: "FEA-3228",
  },
];

function activeMasks(masks: ColumnMask[]): ColumnMask[] {
  return masks.filter((m) =>
    LAYER2_KNOWN_DIVERGENCES.some((e) => e.ticket === m.ticket)
  );
}

function normalizeRow(
  row: Record<string, unknown>,
  maskedColumns: ReadonlyMap<string, string> | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    const maskTicket = maskedColumns?.get(key);
    out[key] = maskTicket ? `<masked:${maskTicket}>` : normalizeCell(row[key]);
  }
  return out;
}

type RawCapture = Record<string, Record<string, unknown>[]>;

async function captureRawStores(db: TestDb): Promise<RawCapture> {
  const out: RawCapture = {};
  for (const table of SNAPSHOT_TABLES) {
    out[table] = await db.prisma.client.$queryRawUnsafe<
      Record<string, unknown>[]
    >(`SELECT * FROM ${table}`);
  }
  return out;
}

/** Total, deterministic row order: compare serialized forms. */
function compareSerializedRows(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): number {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja < jb) {
    return -1;
  }
  if (ja > jb) {
    return 1;
  }
  return 0;
}

function projectCapture(
  raw: RawCapture,
  masks: ColumnMask[]
): Record<string, Record<string, unknown>[]> {
  const active = activeMasks(masks);
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const table of SNAPSHOT_TABLES) {
    const masked = new Map(
      active
        .filter((m) => m.table === table)
        .map((m) => [m.column, m.ticket] as const)
    );
    const normalized = (raw[table] ?? []).map((r) =>
      normalizeRow(r, masked.size > 0 ? masked : undefined)
    );
    normalized.sort(compareSerializedRows);
    out[table] = normalized;
  }
  return out;
}

/**
 * Re-project a FROZEN snapshot under the idempotency masks, so a post-retry
 * capture can be compared against it. Frozen snapshots contain the real
 * deterministic values; masking the active idempotency-only columns here yields
 * exactly what projectCapture(raw, IDEMPOTENCY_MASKS) produces on the live side.
 */
function projectFrozenForIdempotency(
  frozen: Record<string, Record<string, unknown>[]>
): Record<string, Record<string, unknown>[]> {
  const active = activeMasks(IDEMPOTENCY_MASKS);
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const table of SNAPSHOT_TABLES) {
    const masked = active.filter((m) => m.table === table);
    const rows = (frozen[table] ?? []).map((r) => {
      if (masked.length === 0) {
        return r;
      }
      const copy = { ...r };
      for (const m of masked) {
        if (m.column in copy) {
          copy[m.column] = `<masked:${m.ticket}>`;
        }
      }
      return copy;
    });
    rows.sort(compareSerializedRows);
    out[table] = rows;
  }
  return out;
}

function snapshotPath(sessionId: string): string {
  return join(SNAPSHOT_DIR, `${sessionId}.json`);
}

// ── Divergence-resolved oracle fact checking ─────────────────────────────────

/** L2 registry entries that actually fired this run (three-way self-guard). */
const firedLayer2Divergences = new Set<string>();

type OracleFact = {
  /** Store-scoped key, cited in failures and used for the L2 registry. */
  key: string;
  /** The expectations.yaml value (undefined = dossier doesn't sign this key). */
  oracle: unknown;
  /** f(input): what faithful storage of THIS input should produce. */
  inputDerived: unknown;
  /** The store's actual value. */
  actual: unknown;
  /** Layer 1 registry keys whose entries pin the input-vs-oracle divergence
   * feeding this fact (inheritance lookup). */
  l1Keys: string[];
};

function checkOracleFact(
  sessionId: string,
  fact: OracleFact,
  diagnostics: string[],
  failures: string[]
): void {
  if (fact.oracle === undefined) {
    return;
  }
  const l2 = findLayer2Divergence(sessionId, fact.key);
  const matchesOracle = isDeepStrictEqual(fact.actual, fact.oracle);
  const matchesInput = isDeepStrictEqual(fact.actual, fact.inputDerived);
  if (!matchesInput) {
    if (!l2) {
      failures.push(
        `${fact.key} — store ${JSON.stringify(fact.actual)} does not faithfully preserve ` +
          `input-derived ${JSON.stringify(fact.inputDerived)}` +
          (matchesOracle
            ? `; matching oracle ${JSON.stringify(fact.oracle)} is coincidental — file a storage ticket + propose a golden-layer2-divergences.ts entry`
            : ` (oracle ${JSON.stringify(fact.oracle)}) — file a storage ticket + propose a golden-layer2-divergences.ts entry`)
      );
      return;
    }
    firedLayer2Divergences.add(`${sessionId} ${fact.key}`);
    if (isDeepStrictEqual(fact.actual, l2.actual)) {
      diagnostics.push(
        `expected-fail ${sessionId}: ${fact.key} oracle=${JSON.stringify(fact.oracle)} store=${JSON.stringify(fact.actual)} (${l2.ticket})`
      );
    } else {
      failures.push(
        `${fact.key} — store drifted to a THIRD value ${JSON.stringify(fact.actual)} ` +
          `(oracle ${JSON.stringify(fact.oracle)}, registered L2 divergence ${JSON.stringify(l2.actual)}, ${l2.ticket}); new regression`
      );
    }
    return;
  }

  if (l2) {
    firedLayer2Divergences.add(`${sessionId} ${fact.key}`);
    failures.push(
      `${fact.key} — registered L2 divergence (${l2.ticket}) no longer reproduces; ` +
        "remove the golden-layer2-divergences.ts entry to promote this key to a hard assertion"
    );
    return;
  }
  if (matchesOracle) {
    return;
  }

  // Layer-1 inheritance: the INPUT disagrees with the oracle on a key that the
  // L1 registry pins — storage is faithful when store == f(input).
  const inputDiverges = !isDeepStrictEqual(fact.inputDerived, fact.oracle);
  const inheritedTickets = fact.l1Keys
    .map((k) => findDivergence(sessionId, k)?.ticket)
    .filter((t): t is string => Boolean(t));
  if (inputDiverges && inheritedTickets.length > 0) {
    diagnostics.push(
      `inherited-L1 ${sessionId}: ${fact.key} oracle=${JSON.stringify(fact.oracle)} ` +
        `input+store=${JSON.stringify(fact.actual)} (${[...new Set(inheritedTickets)].join(", ")}; expires on corpus re-bless)`
    );
    return;
  }
  failures.push(
    `${fact.key} expected ${JSON.stringify(fact.oracle)}, got ${JSON.stringify(fact.actual)}` +
      (inputDiverges
        ? ` [input-derived ${JSON.stringify(fact.inputDerived)}; L1 entry ${inheritedTickets.length > 0 ? "matched but store deviates from input" : "MISSING"}]`
        : " [input agrees with oracle — storage bug; file a ticket + propose a golden-layer2-divergences.ts entry]") +
      ` (oracle: packages/golden-sessions/${sessionId}/expectations.yaml)`
  );
}

// ── Fidelity + oracle checks for one imported session ────────────────────────

const TOKEN_FIELDS: [
  "input" | "output" | "cache_read" | "cache_write",
  "input" | "output" | "cacheRead" | "cacheWrite",
  "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens",
][] = [
  ["input", "input", "input_tokens"],
  ["output", "output", "output_tokens"],
  ["cache_read", "cacheRead", "cache_read_tokens"],
  ["cache_write", "cacheWrite", "cache_write_tokens"],
];

type StoreFacts = Awaited<ReturnType<typeof readStoreFacts>>;
type Fail = (msg: string) => void;

type TokenFidelity = {
  expectedUsage: Map<string, TokenCounts>;
  actualUsage: Map<string, TokenCounts>;
  usageModels: string[];
  inputModels: string[];
};

/** Fidelity: token_usage rows, token_events multiset, and the cross-store
 * model-set equality (the FEA-2342 invariant surface). */
function checkTokenStoreFidelity(
  store: StoreFacts,
  input: NormalizedSession,
  fail: Fail
): TokenFidelity {
  const expectedUsage = expectedTokensByModel(input);
  const actualUsage = new Map<string, TokenCounts>(
    store.tokenUsageRows.map((r) => [
      r.model,
      {
        input: Number(r.input_tokens),
        output: Number(r.output_tokens),
        cacheRead: Number(r.cache_read_tokens),
        cacheWrite: Number(r.cache_write_tokens),
      },
    ])
  );
  const usageModels = [...actualUsage.keys()].sort();
  const inputModels = [...expectedUsage.keys()].sort();
  if (!isDeepStrictEqual(usageModels, inputModels)) {
    fail(
      `fidelity token_usage.models: store ${JSON.stringify(usageModels)} != input ${JSON.stringify(inputModels)}`
    );
  }
  for (const [model, exp] of expectedUsage) {
    const act = actualUsage.get(model);
    if (act && !isDeepStrictEqual(act, exp)) {
      fail(
        `fidelity token_usage[${model}]: store ${JSON.stringify(act)} != input ${JSON.stringify(exp)}`
      );
    }
  }
  for (const r of store.tokenUsageRows) {
    if (r.usage_source !== "jsonl_parser") {
      fail(
        `fidelity token_usage[${r.model}].usage_source: expected jsonl_parser, got ${r.usage_source}`
      );
    }
    const baselines = [
      Number(r.baseline_input),
      Number(r.baseline_output),
      Number(r.baseline_cache_read),
      Number(r.baseline_cache_write),
    ];
    if (baselines.some((b) => b !== 0)) {
      fail(
        `fidelity token_usage[${r.model}].baseline_*: expected all 0 on import, got ${JSON.stringify(baselines)}`
      );
    }
  }

  const expectedEvents = expectedTokenEvents(input)
    .map((r) => JSON.stringify(r))
    .sort();
  const actualEvents = store.tokenEventRows
    .map((r) =>
      JSON.stringify({
        model: r.model,
        createdAt: r.created_at,
        input: Number(r.input_tokens),
        output: Number(r.output_tokens),
        cacheRead: Number(r.cache_read_tokens),
        cacheWrite: Number(r.cache_write_tokens),
      })
    )
    .sort();
  if (!isDeepStrictEqual(actualEvents, expectedEvents)) {
    fail(
      `fidelity token_events: ${actualEvents.length} store rows != ${expectedEvents.length} input records ` +
        `(first store=${actualEvents[0]?.slice(0, 160)}, first input=${expectedEvents[0]?.slice(0, 160)})`
    );
  }

  const eventModels = [
    ...new Set(store.tokenEventRows.map((r) => r.model)),
  ].sort();
  if (
    !(
      isDeepStrictEqual(eventModels, usageModels) &&
      isDeepStrictEqual(usageModels, inputModels)
    )
  ) {
    fail(
      `fidelity cross-store model sets: token_events ${JSON.stringify(eventModels)} vs token_usage ${JSON.stringify(usageModels)} vs input ${JSON.stringify(inputModels)}`
    );
  }
  return { expectedUsage, actualUsage, usageModels, inputModels };
}

/**
 * FEA-4187 / ISS-4586: the store's `sessions.status` for a historically-imported
 * (terminal) run mirrors `resolveImportedSessionStatus` — a run that ended on an
 * unrecovered API error stores `error`, every other terminal run stores
 * `inactive` (the canonical terminal-not-failed state that supersedes the former
 * `completed`). The golden corpus is entirely terminal (no recently-active
 * runs), so this reduces to the failed-vs-inactive derivation. Kept in lockstep
 * with the production classifier via the shared `deriveEndedOnUnrecoveredError`
 * helper rather than hardcoding the terminal-not-failed literal.
 */
function expectedImportedStatus(input: NormalizedSession): string {
  // ISS-4586: a finished non-failed run imports as `inactive` (the canonical
  // terminal-not-failed state that supersedes `completed`); an unrecovered-error
  // run imports as `error`. Mirrors `resolveImportedSessionStatus`.
  return deriveEndedOnUnrecoveredError(input) ? "error" : "inactive";
}

/** Fidelity: the metadata JSON round-trip on selected fields. */
function checkSessionMetadataFidelity(
  metadataText: string | null,
  input: NormalizedSession,
  harness: Harness,
  fail: Fail
): void {
  const meta = metadataText
    ? (JSON.parse(metadataText) as Record<string, unknown>)
    : {};
  const lengthOf = (v: unknown) => (Array.isArray(v) ? v.length : null);
  const metaChecks: [string, unknown, unknown][] = [
    ["userMessages", meta.userMessages, input.userMessages ?? 0],
    ["assistantMessages", meta.assistantMessages, input.assistantMessages ?? 0],
    ["entrypoint", meta.entrypoint, input.entrypoint ?? harness],
    ["messages.length", lengthOf(meta.messages), (input.messages ?? []).length],
    [
      "tokenSeries.length",
      lengthOf(meta.tokenSeries),
      (input.tokenSeries ?? []).length,
    ],
    [
      "slashCommands.length",
      lengthOf(meta.slashCommands),
      (input.slashCommands ?? []).length,
    ],
    [
      "compactions.length",
      lengthOf(meta.compactions),
      (input.compactions ?? []).length,
    ],
  ];
  for (const [name, actual, expected] of metaChecks) {
    if (!isDeepStrictEqual(actual, expected)) {
      fail(
        `fidelity sessions.metadata.${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      );
    }
  }
}

/** Fidelity: sessions row scalar fields + the metadata JSON round-trip. */
function checkSessionRowFidelity(
  s: NonNullable<StoreFacts["sessionRow"]>,
  input: NormalizedSession,
  harness: Harness,
  fail: Fail
): void {
  const scalarChecks: [string, unknown, unknown][] = [
    ["status", s.status, expectedImportedStatus(input)],
    ["harness", s.harness, harness],
    ["cwd", s.cwd ?? null, input.cwd ?? null],
    ["started_at", s.started_at ?? null, input.startedAt ?? null],
    ["ended_at", s.ended_at ?? null, input.endedAt ?? null],
    ["model", s.model ?? null, expectedSessionModel(input)],
  ];
  for (const [name, actual, expected] of scalarChecks) {
    if (!isDeepStrictEqual(actual, expected)) {
      fail(
        `fidelity sessions.${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      );
    }
  }
  checkSessionMetadataFidelity(s.metadata, input, harness, fail);
}

/** Fidelity: main agent + parser-sub rows + tool-use-spawned -sub- rows. */
function checkAgentsFidelity(
  store: StoreFacts,
  input: NormalizedSession,
  sessionId: string,
  fail: Fail
): void {
  const mainId = `${sessionId}-main`;
  if (!store.agentRows.some((a) => a.id === mainId)) {
    fail(`fidelity agents: main agent ${mainId} missing`);
  }
  const actualSubIds = store.agentRows
    .filter((a) => a.type === "subagent")
    .map((a) => a.id)
    .sort();
  const expectedAllSubIds = expectedSubagentRowIds(input, sessionId);
  if (!isDeepStrictEqual(actualSubIds, expectedAllSubIds)) {
    fail(
      `fidelity agents.subagents: store ids ${JSON.stringify(actualSubIds)} != expected ${JSON.stringify(expectedAllSubIds)}`
    );
  }
  for (const a of store.agentRows) {
    if (a.type === "subagent" && !["completed", "error"].includes(a.status)) {
      fail(
        `fidelity agents[${a.id}].status: expected terminal (completed/error), got ${a.status}`
      );
    }
  }
}

/** Fidelity: cost conservation across per-event and rollup stores. */
function checkCostConservation(
  sessionId: string,
  store: StoreFacts,
  diagnostics: string[],
  failures: string[],
  fail: Fail
): void {
  const pricedCosts = store.tokenUsageRows
    .map((r) => r.cost_usd_estimated)
    .filter((c): c is number => c !== null);
  const usageCostSum = pricedCosts.reduce((a, b) => a + b, 0);
  const sessionCost = store.sessionRow?.cost_usd_estimated ?? null;
  const estCost = store.analytics ? Number(store.analytics.est_cost) : 0;
  // FEA-3636 / PRD-538: sessions.cost and est_cost are the session TOTAL, which
  // includes SESSION-LEVEL line items (web-search per-request charge + the 1h
  // cache-write TTL premium) that never live on a token_usage row. So the
  // conservation target is Σtoken_usage PLUS those line items — otherwise a
  // session with 1h cache writes (or web search) would look like it drifted.
  const lineItemsUsd = store.sessionLineItemsUsd;
  const expectedTotal = usageCostSum + lineItemsUsd;
  // Both stored values are SQLite SUM() over the same rows; the JS reduce here
  // may differ in the last double bit from a different summation ORDER — allow
  // that, and only that (multi-model sessions hit it).
  const conserved = (a: number, b: number) =>
    Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (pricedCosts.length === 0) {
    // With no priced token rows the total is just the session-level line items
    // (0 for every session lacking web search / 1h writes → null/0 as before).
    const expectedUnpriced = lineItemsUsd > 0 ? lineItemsUsd : null;
    if (
      (expectedUnpriced === null && (sessionCost !== null || estCost !== 0)) ||
      (expectedUnpriced !== null &&
        (sessionCost === null ||
          !conserved(sessionCost, expectedUnpriced) ||
          !conserved(estCost, expectedUnpriced)))
    ) {
      fail(
        `fidelity cost conservation (unpriced): sessions.cost=${sessionCost}, analytics.est_cost=${estCost} vs session line items=${lineItemsUsd}`
      );
    }
    return;
  }
  if (
    sessionCost === null ||
    !conserved(sessionCost, expectedTotal) ||
    !conserved(estCost, expectedTotal)
  ) {
    fail(
      `fidelity cost conservation: sessions.cost=${sessionCost} vs Σtoken_usage=${usageCostSum} + line items=${lineItemsUsd} (=${expectedTotal}) vs analytics.est_cost=${estCost}`
    );
  }

  const eventCostSum = store.tokenEventRows.reduce(
    (sum, row) => sum + (row.cost_usd_estimated ?? 0),
    0
  );
  const roundCost = (value: number) => Number(value.toFixed(6));
  const expected = {
    tokenEvents: roundCost(usageCostSum),
    tokenUsage: roundCost(usageCostSum),
  };
  if (!conserved(eventCostSum, usageCostSum)) {
    checkOracleFact(
      sessionId,
      {
        key: "store.token_events.cost_conservation",
        oracle: expected,
        inputDerived: expected,
        actual: {
          tokenEvents: roundCost(eventCostSum),
          tokenUsage: roundCost(usageCostSum),
        },
        l1Keys: [],
      },
      diagnostics,
      failures
    );
  }
}

/** Oracle facts on session_analytics (token sums, human/agent turns) plus the
 * started_day fidelity check. */
function checkAnalyticsOracleFacts(
  sessionId: string,
  analytics: NonNullable<StoreFacts["analytics"]>,
  input: NormalizedSession,
  exp: DossierExpectations,
  tokens: TokenFidelity,
  oracleModels: string[],
  diagnostics: string[],
  failures: string[]
): void {
  for (const [dossierField, camelField, storeField] of TOKEN_FIELDS) {
    let oracleSum = 0;
    let signed = false;
    for (const model of oracleModels) {
      const v = exp.tokens_by_model?.[model]?.[dossierField];
      if (typeof v === "number") {
        oracleSum += v;
        signed = true;
      }
    }
    let inputSum = 0;
    for (const counts of tokens.expectedUsage.values()) {
      inputSum += counts[camelField];
    }
    checkOracleFact(
      sessionId,
      {
        key: `store.session_analytics.${storeField}`,
        oracle: signed ? oracleSum : undefined,
        inputDerived: inputSum,
        actual: Number(analytics[storeField]),
        l1Keys: oracleModels.map(
          (m) => `tokens_by_model[${m}].${dossierField}`
        ),
      },
      diagnostics,
      failures
    );
  }
  checkOracleFact(
    sessionId,
    {
      key: "store.session_analytics.human_turns",
      oracle: exp.turns?.user,
      inputDerived: expectedHumanTurns(input),
      actual: Number(analytics.human_turns),
      l1Keys: ["turns.user"],
    },
    diagnostics,
    failures
  );
  checkOracleFact(
    sessionId,
    {
      key: "store.session_analytics.agent_turns",
      oracle: exp.turns?.assistant,
      inputDerived: input.assistantMessages ?? 0,
      actual: Number(analytics.agent_turns),
      l1Keys: ["turns.assistant"],
    },
    diagnostics,
    failures
  );
  // started_day is a UTC substr derivation — TZ-independent by contract.
  const expectedDay = (input.startedAt ?? "").slice(0, 10) || null;
  if ((analytics.started_day ?? null) !== expectedDay) {
    failures.push(
      `fidelity session_analytics.started_day: expected ${expectedDay} (UTC substr), got ${analytics.started_day}`
    );
  }
}

async function checkImportedSession(
  db: TestDb,
  sessionId: string,
  input: NormalizedSession,
  expectations: DossierExpectations,
  harness: Harness,
  diagnostics: string[],
  failures: string[]
): Promise<void> {
  const store = await readStoreFacts(db, sessionId);
  const fail: Fail = (msg) => failures.push(msg);

  const tokens = checkTokenStoreFidelity(store, input, fail);
  if (store.sessionRow) {
    checkSessionRowFidelity(store.sessionRow, input, harness, fail);
  } else {
    fail("fidelity sessions: row missing after import");
  }
  checkAgentsFidelity(store, input, sessionId, fail);

  const expectedCounts = expectedEventCounts(input);
  if (!isDeepStrictEqual(store.eventCounts, expectedCounts)) {
    fail(
      `fidelity events counts-by-type: store ${JSON.stringify(store.eventCounts)} != derived-from-input ${JSON.stringify(expectedCounts)} ` +
        "(derivation mirrors importPhaseEvents; a mismatch is either a storage bug or an importer-contract drift)"
    );
  }
  checkCostConservation(sessionId, store, diagnostics, failures, fail);

  // ── Oracle facts (dossier keys), divergence-resolved ──────────────────────
  const oracleModels = Object.keys(expectations.tokens_by_model ?? {}).sort();
  checkOracleFact(
    sessionId,
    {
      key: "store.token_usage.models",
      oracle: oracleModels,
      inputDerived: tokens.inputModels,
      actual: tokens.usageModels,
      l1Keys: ["session.models_used"],
    },
    diagnostics,
    failures
  );
  for (const model of oracleModels) {
    for (const [dossierField, camelField] of TOKEN_FIELDS) {
      checkOracleFact(
        sessionId,
        {
          key: `store.token_usage[${model}].${dossierField}`,
          oracle: expectations.tokens_by_model?.[model]?.[dossierField],
          inputDerived: tokens.expectedUsage.get(model)?.[camelField] ?? 0,
          actual: tokens.actualUsage.get(model)?.[camelField] ?? 0,
          l1Keys: [`tokens_by_model[${model}].${dossierField}`],
        },
        diagnostics,
        failures
      );
    }
  }
  if (store.analytics) {
    checkAnalyticsOracleFacts(
      sessionId,
      store.analytics,
      input,
      expectations,
      tokens,
      oracleModels,
      diagnostics,
      failures
    );
  } else {
    fail("fidelity session_analytics: rollup row missing after import");
  }
}

/**
 * Pinned drift facts (FEA-3228) asserted right after the FIRST import
 * on one representative dossier each — they keep the ticket-guarded column
 * masks honest: when the bug is fixed, the fact stops reproducing, the sweep
 * self-guard fires, and removing the registry entry deactivates the mask.
 */
async function checkPinnedFirstImportFacts(
  db: TestDb,
  sessionId: string,
  diagnostics: string[],
  failures: string[]
): Promise<void> {
  if (sessionId === COMPONENT_LINK_PIN_DOSSIER) {
    const nullLinks = await db.prisma.client.$queryRawUnsafe<
      { n: number | bigint }[]
    >(
      "SELECT COUNT(*) AS n FROM agent_component_session_usage WHERE session_id = $1 AND agent_component_id IS NULL",
      sessionId
    );
    checkOracleFact(
      sessionId,
      {
        key: "store.first_import.component_link_null",
        oracle: false,
        inputDerived: false,
        actual: Number(nullLinks[0]?.n ?? 0) > 0,
        l1Keys: [],
      },
      diagnostics,
      failures
    );
  }
}

/** Write (regeneration mode) or deep-equal the frozen per-dossier snapshot. */
function compareOrWriteSnapshot(
  snapshot1: Record<string, Record<string, unknown>[]>,
  sessionId: string,
  failures: string[]
): void {
  const snapPath = snapshotPath(sessionId);
  if (WRITE_SNAPSHOTS) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(snapPath, `${JSON.stringify(snapshot1, null, 2)}\n`);
    return;
  }
  if (!existsSync(snapPath)) {
    failures.push(
      `snapshot missing: ${snapPath} — generate via GOLDEN_L2_WRITE_SNAPSHOTS=1 (UTC suite) and review the diff (see the snapshots README)`
    );
    return;
  }
  const frozen = JSON.parse(readFileSync(snapPath, "utf8")) as Record<
    string,
    Record<string, unknown>[]
  >;
  if (isDeepStrictEqual(snapshot1, frozen)) {
    return;
  }
  const diffs: string[] = [];
  for (const table of SNAPSHOT_TABLES) {
    if (!isDeepStrictEqual(snapshot1[table], frozen[table])) {
      diffs.push(
        `${table} (${snapshot1[table]?.length ?? 0} rows vs frozen ${(frozen[table] ?? []).length})`
      );
    }
  }
  failures.push(
    `snapshot drift in: ${diffs.join(", ")} — store output changed for identical input ` +
      `(snapshot: apps/desktop/test/golden/layer2-snapshots/${sessionId}.json; see the snapshots README)`
  );
}

/**
 * Idempotency on BOTH import paths: a second boot import, then the atomic
 * rebuild — each must leave the store byte-identical (modulo the
 * ticket-guarded IDEMPOTENCY_MASKS; the pinned drift facts keep those honest).
 * skipped:true is EXPECTED on the re-import (session exists, nothing new).
 */
async function checkIdempotencyPaths(
  db: TestDb,
  sessionId: string,
  input: NormalizedSession,
  harness: Harness,
  raw1: RawCapture,
  diagnostics: string[],
  failures: string[]
): Promise<void> {
  const readUpdatedAt = async () =>
    (
      await db.prisma.client.$queryRawUnsafe<{ updated_at: string }[]>(
        "SELECT updated_at FROM sessions WHERE id = $1",
        sessionId
      )
    )[0]?.updated_at;

  const updatedAtBefore = await readUpdatedAt();
  const again = await db.importer.importSession(input, harness);
  if (again.failed || again.incomplete === true) {
    failures.push(`re-import failed/partial (${JSON.stringify(again)})`);
    return;
  }
  if (sessionId === UPDATED_AT_PIN_DOSSIER) {
    checkOracleFact(
      sessionId,
      {
        key: "store.idempotency.reimport_skipped",
        oracle: true,
        inputDerived: true,
        actual: again.skipped,
        l1Keys: [],
      },
      diagnostics,
      failures
    );
  }
  // Pinned drift fact (FEA-3227): the re-import bumps the sync watermark.
  if (sessionId === UPDATED_AT_PIN_DOSSIER) {
    checkOracleFact(
      sessionId,
      {
        key: "store.idempotency.sessions_updated_at",
        oracle: false,
        inputDerived: false,
        actual: (await readUpdatedAt()) !== updatedAtBefore,
        l1Keys: [],
      },
      diagnostics,
      failures
    );
  }
  const idem1 = projectCapture(raw1, IDEMPOTENCY_MASKS);
  const idem2 = projectCapture(await captureRawStores(db), IDEMPOTENCY_MASKS);
  if (!isDeepStrictEqual(idem2, idem1)) {
    const tables = SNAPSHOT_TABLES.filter(
      (t) => !isDeepStrictEqual(idem2[t], idem1[t])
    );
    failures.push(
      `idempotency (boot re-import) violated in: ${tables.join(", ")} — importing the same session twice changed the store`
    );
  }

  const rebuild = await db.rebuildSessionFromParse(input, harness);
  if (!rebuild.rebuilt) {
    failures.push(
      `rebuildSessionFromParse did not rebuild (activeRace=${rebuild.activeRace})`
    );
    return;
  }
  const idem3 = projectCapture(await captureRawStores(db), IDEMPOTENCY_MASKS);
  if (!isDeepStrictEqual(idem3, idem1)) {
    const tables = SNAPSHOT_TABLES.filter(
      (t) => !isDeepStrictEqual(idem3[t], idem1[t])
    );
    failures.push(
      `idempotency (rebuildSessionFromParse) violated in: ${tables.join(", ")} — the rebuild path diverges from the boot-import path`
    );
  }
}

/**
 * Global identity stores under a SHARED DB: a broken cross-session upsert shows
 * up as duplicate identity rows, dangling references, or clobbered first-seen
 * stamps — the folded state a single-dossier snapshot can never exercise (a PR
 * artifact or a `tool/Read` component identity recurs across dossiers here).
 */
async function checkGlobalIdentityStores(
  db: TestDb,
  failures: string[]
): Promise<void> {
  const dupArtifacts = await db.prisma.client.$queryRawUnsafe<
    { identity_key: string; n: number | bigint }[]
  >(
    "SELECT identity_key, COUNT(*) AS n FROM artifacts GROUP BY identity_key HAVING COUNT(*) > 1"
  );
  if (dupArtifacts.length > 0) {
    failures.push(
      `shared-DB artifacts: ${dupArtifacts.length} duplicated identity_key(s) — global upsert split identities: ${dupArtifacts
        .slice(0, 3)
        .map((r) => r.identity_key)
        .join(", ")}`
    );
  }
  const dupComponents = await db.prisma.client.$queryRawUnsafe<
    { component_kind: string; external_id: string; n: number | bigint }[]
  >(
    "SELECT component_kind, external_id, COUNT(*) AS n FROM agent_components GROUP BY component_kind, external_id HAVING COUNT(*) > 1"
  );
  if (dupComponents.length > 0) {
    failures.push(
      `shared-DB agent_components: ${dupComponents.length} duplicated (kind, external_id) pair(s) — existence upsert is not idempotent across sessions`
    );
  }
  const danglingLinks = await db.prisma.client.$queryRawUnsafe<
    { n: number | bigint }[]
  >(
    "SELECT COUNT(*) AS n FROM session_artifact_links sal LEFT JOIN artifacts a ON a.id = sal.artifact_id WHERE a.id IS NULL"
  );
  if (Number(danglingLinks[0]?.n ?? 0) > 0) {
    failures.push(
      `shared-DB session_artifact_links: ${Number(danglingLinks[0]?.n ?? 0)} link(s) point at a missing artifacts row`
    );
  }
  const badComponentTimes = await db.prisma.client.$queryRawUnsafe<
    { n: number | bigint }[]
  >(
    "SELECT COUNT(*) AS n FROM agent_components WHERE first_seen_at > last_seen_at"
  );
  if (Number(badComponentTimes[0]?.n ?? 0) > 0) {
    failures.push(
      `shared-DB agent_components: ${Number(badComponentTimes[0]?.n ?? 0)} row(s) with first_seen_at > last_seen_at — revisit upsert clobbered first-seen`
    );
  }
  // FEA-3591: the write-path floor guarantees `last_activity_at >= started_at`
  // for every session the importer produces — resumed/continued dossiers whose
  // inherited events predate the resume `started_at` must clamp, not regress.
  const badLastActivity = await db.prisma.client.$queryRawUnsafe<
    { id: string; started_at: string; last_activity_at: string }[]
  >(
    "SELECT id, started_at, last_activity_at FROM sessions WHERE last_activity_at < started_at"
  );
  if (badLastActivity.length > 0) {
    failures.push(
      `shared-DB sessions: ${badLastActivity.length} row(s) violate last_activity_at >= started_at (FEA-3591 floor): ${badLastActivity
        .slice(0, 3)
        .map((r) => `${r.id} (${r.last_activity_at} < ${r.started_at})`)
        .join(", ")}`
    );
  }
}

// ── Suite registration ───────────────────────────────────────────────────────

/** Register the full Layer 2 suite under the current process TZ. */
export function registerGoldenLayer2Suite(): void {
  if (WRITE_SNAPSHOTS && process.env.TZ !== "UTC") {
    throw new Error(
      "GOLDEN_L2_WRITE_SNAPSHOTS=1 is only permitted under TZ=UTC — the UTC and " +
        "America/Chicago suites run as concurrent child processes and must never " +
        "race the same snapshot file. Regenerate via the UTC suite only."
    );
  }

  const dossiers = discoverDossiers();
  const dossierIds = new Set(dossiers.map((d) => d.sessionId));
  const nonNull = dossiers.filter((d) => d.normalized !== null);

  test("layer2 divergence registry is well-formed", () => {
    const seen = new Set<string>();
    for (const d of LAYER2_KNOWN_DIVERGENCES) {
      assert.match(
        d.ticket,
        TICKET_ID,
        `L2 divergence ${d.sessionId}:${d.key} must cite a FEA ticket`
      );
      const dup = `${d.sessionId} ${d.key}`;
      assert.ok(!seen.has(dup), `duplicate L2 divergence entry ${dup}`);
      seen.add(dup);
      assert.ok(
        d.key.startsWith("store."),
        `L2 divergence ${dup} must use the store.* key namespace`
      );
    }
  });

  test("layer2: at least one dossier prices (cost-conservation is not vacuous)", async () => {
    // Guard against a silent pricing-coverage lapse turning every cost
    // conservation check into 0 == 0 == 0. One small priced dossier suffices.
    const d = nonNull.find(
      (x) =>
        Object.keys(
          (x.normalized as { tokensByModel?: object }).tokensByModel ?? {}
        ).length > 0
    );
    assert.ok(d, "corpus has no dossier with token usage");
    const { input, nowD, harness } = loadLayer2Input(d);
    const dir = mkdtempSync(join(tmpdir(), "golden-l2-price-"));
    const db = await openTestDb(dir, { now: () => nowD });
    try {
      const result = await db.importer.importSession(input, harness);
      assert.ok(!(result.skipped || result.failed), "seed import failed");
      const rows = await db.prisma.client.$queryRawUnsafe<
        { n: number | bigint }[]
      >(
        "SELECT COUNT(*) AS n FROM token_usage WHERE session_id = $1 AND cost_usd_estimated IS NOT NULL",
        d.sessionId
      );
      assert.ok(
        Number(rows[0]?.n ?? 0) > 0,
        `${d.sessionId}: no token_usage row was priced — pricing table no longer covers the corpus window; cost conservation would pass vacuously`
      );
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const d of dossiers) {
    if (d.normalized === null) {
      test(`golden layer2 ${d.sessionId}: null-normalized drop contract`, () => {
        // The collector emits no session for this raw input (Layer 1 proves the
        // evidence); Layer 2's contract is simply that there is nothing to
        // import — the dossier must not have a snapshot.
        assert.ok(
          !existsSync(snapshotPath(d.sessionId)),
          `${d.sessionId}: normalized.json is null but a layer2 snapshot exists — remove it`
        );
      });
      continue;
    }

    test(`golden layer2 ${d.sessionId}: import matches dossier + snapshot + idempotency`, {
      timeout: 300_000,
    }, async () => {
      const { input, nowD, harness } = loadLayer2Input(d);
      const dir = mkdtempSync(join(tmpdir(), "golden-l2-"));
      const db = await openTestDb(dir, { now: () => nowD });
      const diagnostics: string[] = [];
      const failures: string[] = [];
      try {
        const result = await db.importer.importSession(input, harness);
        assert.ok(
          !result.skipped,
          `${d.sessionId}: first import unexpectedly skipped`
        );
        assert.ok(!result.failed, `${d.sessionId}: import failed`);
        assert.ok(
          result.incomplete !== true,
          `${d.sessionId}: import was PARTIAL (a tolerated record group failed to commit) — the store is incomplete`
        );

        await checkImportedSession(
          db,
          d.sessionId,
          input,
          d.expectations,
          harness,
          diagnostics,
          failures
        );
        await checkPinnedFirstImportFacts(
          db,
          d.sessionId,
          diagnostics,
          failures
        );

        // Frozen snapshot: regression guard over every importer-written table.
        const raw1 = await captureRawStores(db);
        compareOrWriteSnapshot(projectCapture(raw1, []), d.sessionId, failures);
        await checkIdempotencyPaths(
          db,
          d.sessionId,
          input,
          harness,
          raw1,
          diagnostics,
          failures
        );
      } finally {
        await db.close();
        rmSync(dir, { recursive: true, force: true });
      }

      for (const line of diagnostics) {
        console.log(`  [layer2-divergence] ${line}`);
      }
      assert.ok(
        failures.length === 0,
        `${d.sessionId}: ${failures.length} layer2 fact(s) diverged:\n  - ${failures.join("\n  - ")}`
      );
    });
  }

  // ── Named fixture: FEA-2342 — multi-model split survives parse→store ───────
  test("golden layer2 fixture: multi-model codex split survives storage (FEA-2342)", async () => {
    const fixtureFile = join(
      FIXTURES_DIR,
      `rollout-2026-07-01T00-00-00-${MULTI_MODEL_FIXTURE_SESSION_ID}.jsonl`
    );
    assert.ok(existsSync(fixtureFile), `missing fixture ${fixtureFile}`);
    // Parse through the PRODUCTION codex path (the same file-I/O wrapper the
    // collector uses), against a temp copy — never the checked-in fixture.
    const tempDir = mkdtempSync(join(tmpdir(), "golden-l2-2342-"));
    const diagnostics: string[] = [];
    const failures: string[] = [];
    try {
      const stagedPath = join(tempDir, "rollout.jsonl");
      cpSync(fixtureFile, stagedPath);
      const session = await parseRolloutFile(stagedPath);
      assert.ok(session, "codex parser emitted no session for the fixture");
      await foldCodexDescendants(session, stagedPath, [stagedPath]);
      session.fileModifiedAt = null;
      const nowD = dossierNow(session);
      const dbDir = mkdtempSync(join(tmpdir(), "golden-l2-2342-db-"));
      const db = await openTestDb(dbDir, { now: () => nowD });
      try {
        const result = await db.importer.importSession(session, "codex");
        assert.ok(
          !(result.skipped || result.failed) && result.incomplete !== true,
          "fixture import failed"
        );
        const store = await readStoreFacts(db, session.sessionId);
        const usageModels = store.tokenUsageRows.map((r) => r.model).sort();
        const eventModels = [
          ...new Set(store.tokenEventRows.map((r) => r.model)),
        ].sort();
        const expectedModels = ["gpt-5.4", "gpt-5.5"];
        checkOracleFact(
          session.sessionId,
          {
            key: "store.multi_model.token_usage_models",
            oracle: expectedModels,
            inputDerived: Object.keys(session.tokensByModel ?? {}).sort(),
            actual: usageModels,
            l1Keys: [],
          },
          diagnostics,
          failures
        );
        checkOracleFact(
          session.sessionId,
          {
            key: "store.multi_model.token_events_models",
            oracle: expectedModels,
            inputDerived: [
              ...new Set((session.tokenSeries ?? []).map((r) => r.model)),
            ].sort(),
            actual: eventModels,
            l1Keys: [],
          },
          diagnostics,
          failures
        );
        // Per-model conservation: token_usage row == Σ its token_events rows.
        for (const model of expectedModels) {
          const usage = store.tokenUsageRows.find((r) => r.model === model);
          const sums = store.tokenEventRows
            .filter((r) => r.model === model)
            .reduce(
              (acc, r) => ({
                input: acc.input + Number(r.input_tokens),
                output: acc.output + Number(r.output_tokens),
              }),
              { input: 0, output: 0 }
            );
          checkOracleFact(
            session.sessionId,
            {
              key: `store.multi_model.conservation[${model}]`,
              oracle: sums,
              inputDerived: sums,
              actual: usage
                ? {
                    input: Number(usage.input_tokens),
                    output: Number(usage.output_tokens),
                  }
                : { input: 0, output: 0 },
              l1Keys: [],
            },
            diagnostics,
            failures
          );
        }
      } finally {
        await db.close();
        rmSync(dbDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
    for (const line of diagnostics) {
      console.log(`  [layer2-divergence] ${line}`);
    }
    assert.ok(
      failures.length === 0,
      `FEA-2342 fixture: ${failures.length} fact(s) diverged:\n  - ${failures.join("\n  - ")}`
    );
  });

  registerInvocationDeleteFixture({
    nonNull,
    loadLayer2Input,
    checkOracleFact,
    normalizeRow,
    compareSerializedRows,
  });

  // ── Named fixture: FEA-1839 — hook + import never double-count ─────────────
  test("golden layer2 fixture: hook and import channels never double-count (FEA-1839)", async () => {
    // Both targets are PINNED; see golden-layer2-fixture-targets.ts for why the
    // subagent-bearing one must not be discovered by predicate.
    const { plain, withSubagents } = selectHookConvergenceTargets(nonNull);
    assert.ok(plain, HOOK_CONVERGENCE_PLAIN_MISSING);
    assert.ok(withSubagents, HOOK_CONVERGENCE_SUBAGENTS_MISSING);
    const targets: GoldenDossier[] = [plain, withSubagents];
    assert.equal(targets.length, 2, "FEA-1839 fixture must cover two dossiers");
    const diagnostics: string[] = [];
    const failures: string[] = [];
    for (const d of targets) {
      const { input, nowD, harness } = loadLayer2Input(d);
      assert.equal(
        harness,
        "claude",
        `${d.sessionId}: hook path is claude-only`
      );
      const dir = mkdtempSync(join(tmpdir(), "golden-l2-1839-"));
      const rawStage = mkdtempSync(join(tmpdir(), "golden-l2-1839-raw-"));
      const db = await openTestDb(dir, { now: () => nowD });
      try {
        const result = await db.importer.importSession(input, harness);
        assert.ok(
          !(result.skipped || result.failed) && result.incomplete !== true,
          `${d.sessionId}: seed import failed`
        );
        const before = await readStoreFacts(db, d.sessionId);

        // Stage the dossier's raw transcript (never hand the corpus path to the
        // extractor) and replay a live "Stop" hook pointing at it — the exact
        // both-channels overlap FEA-1839's mutual exclusivity exists to prevent.
        cpSync(d.rawDir, rawStage, { recursive: true });
        const transcriptPath = join(rawStage, `${d.sessionId}.jsonl`);
        assert.ok(
          existsSync(transcriptPath),
          `${d.sessionId}: staged transcript missing at ${transcriptPath}`
        );
        const processed = await db.processEvent(
          "Stop",
          { session_id: d.sessionId, transcript_path: transcriptPath },
          "claude"
        );
        assert.ok(
          processed,
          `${d.sessionId}: processEvent(Stop) not processed`
        );

        const after = await readStoreFacts(db, d.sessionId);
        checkTokenStoreFidelity(after, input, (message) =>
          failures.push(`${d.sessionId}: hook replay ${message}`)
        );
        const expectedEventCountsAfterHook = {
          ...before.eventCounts,
          Stop: (before.eventCounts.Stop ?? 0) + 1,
        };
        checkOracleFact(
          d.sessionId,
          {
            key: "store.hook_convergence.event_delta",
            oracle: expectedEventCountsAfterHook,
            inputDerived: expectedEventCountsAfterHook,
            actual: after.eventCounts,
            l1Keys: [],
          },
          diagnostics,
          failures
        );
        checkOracleFact(
          d.sessionId,
          {
            key: "store.hook_convergence.session_analytics",
            oracle: before.analytics,
            inputDerived: before.analytics,
            actual: after.analytics,
            l1Keys: [],
          },
          diagnostics,
          failures
        );
      } finally {
        await db.close();
        rmSync(dir, { recursive: true, force: true });
        rmSync(rawStage, { recursive: true, force: true });
      }
    }
    for (const line of diagnostics) {
      console.log(`  [layer2-divergence] ${line}`);
    }
    assert.ok(
      failures.length === 0,
      `FEA-1839 fixture: ${failures.length} fact(s) diverged:\n  - ${failures.join("\n  - ")}`
    );
  });

  // ── Fixture: tokenSeries-empty fallback ────────────────────────────────────
  test("golden layer2 fixture: empty tokenSeries synthesizes one token_event per model", async () => {
    const input = makeSession({
      sessionId: TOKEN_FALLBACK_FIXTURE_SESSION_ID,
      model: "claude-opus-4-8",
      startedAt: "2026-06-01T00:00:00.000Z",
      endedAt: "2026-06-01T00:10:00.000Z",
      tokensByModel: {
        "claude-opus-4-8": {
          input: 100,
          output: 40,
          cacheRead: 5,
          cacheWrite: 2,
        },
        "claude-haiku-4-5-20251001": {
          input: 10,
          output: 4,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
      tokenSeries: [],
    });
    input.fileModifiedAt = null;
    const dir = mkdtempSync(join(tmpdir(), "golden-l2-fallback-"));
    const db = await openTestDb(dir, { now: () => dossierNow(input) });
    try {
      const result = await db.importer.importSession(input, "claude");
      assert.ok(!(result.skipped || result.failed), "fallback import failed");
      const store = await readStoreFacts(db, input.sessionId);
      const rows = store.tokenEventRows
        .map((r) => ({
          model: r.model,
          createdAt: r.created_at,
          input: Number(r.input_tokens),
          output: Number(r.output_tokens),
        }))
        .sort((a, b) => a.model.localeCompare(b.model));
      assert.deepEqual(
        rows,
        [
          {
            model: "claude-haiku-4-5-20251001",
            createdAt: "2026-06-01T00:00:00.000Z",
            input: 10,
            output: 4,
          },
          {
            model: "claude-opus-4-8",
            createdAt: "2026-06-01T00:00:00.000Z",
            input: 100,
            output: 40,
          },
        ],
        "empty tokenSeries must synthesize exactly one token_event per model at startedAt (write-core.ts:1247-1257)"
      );
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Fixture: partial-import detection + retry convergence ──────────────────
  test("golden layer2 fixture: partial import is detected and retry converges", async () => {
    // Scope (PLN-1337 v3 §5): proves incomplete:true detection, fail-tolerance
    // (gating rows land), and retry convergence — NOT per-group transaction
    // rollback atomicity (that would need mid-transaction fault injection).
    const d = nonNull.find(
      (x) => x.sessionId === "88afd667-ff1a-4818-9fb5-ba25418c6306"
    );
    assert.ok(d, "fault-injection dossier 88afd667 missing");
    const { input, nowD, harness } = loadLayer2Input(d);
    const dir = mkdtempSync(join(tmpdir(), "golden-l2-fault-"));
    // ISS-5101 opt-out: this fixture INJECTS the failing import (drops a
    // tolerated group's table) and asserts `incomplete:true` itself below.
    const db = await openTestDb(
      dir,
      { now: () => nowD },
      { allowImportFailures: true }
    );
    try {
      const ddl = await db.prisma.client.$queryRawUnsafe<
        { sql: string | null }[]
      >(
        "SELECT sql FROM sqlite_master WHERE tbl_name = 'session_activity_segments' AND sql IS NOT NULL ORDER BY type DESC, name"
      );
      assert.ok(
        ddl.length > 0,
        "no DDL captured for session_activity_segments"
      );
      await db.run("DROP TABLE session_activity_segments");

      const result = await db.importer.importSession(input, harness);
      assert.ok(!result.failed, "gating group should still succeed");
      assert.equal(
        result.incomplete,
        true,
        "dropping a tolerated group's table must surface incomplete:true — a silent pass here means partial imports are being marked seen"
      );
      const gate = await db.prisma.client.$queryRawUnsafe<
        { n: number | bigint }[]
      >("SELECT COUNT(*) AS n FROM sessions WHERE id = $1", d.sessionId);
      assert.ok(
        Number(gate[0]?.n ?? 0) === 1,
        "fail-tolerant contract: the gating session row must land despite the failed group"
      );

      for (const { sql } of ddl) {
        if (sql) {
          await db.run(sql);
        }
      }
      const retry = await db.importer.importSession(input, harness);
      assert.ok(!retry.failed, "retry import failed");
      assert.ok(
        retry.incomplete !== true,
        "retry after table restore must not be partial"
      );
      // Retry converges to the SAME state as a clean import (frozen snapshot),
      // modulo the ticket-guarded idempotency masks: the fault-then-retry path
      // is a first-import-then-re-import sequence, so the FEA-3227/3228 drift
      // (updated_at bump, healed component links) legitimately appears here.
      const capture = projectCapture(
        await captureRawStores(db),
        IDEMPOTENCY_MASKS
      );
      const snapPath = snapshotPath(d.sessionId);
      if (!WRITE_SNAPSHOTS && existsSync(snapPath)) {
        const frozen = projectFrozenForIdempotency(
          JSON.parse(readFileSync(snapPath, "utf8")) as Record<
            string,
            Record<string, unknown>[]
          >
        );
        assert.ok(
          isDeepStrictEqual(capture, frozen),
          "retry-converged state does not match the dossier's frozen snapshot — partial-import retry does not converge"
        );
      }
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Corpus-wide shared-DB pass (cross-session contamination) ───────────────
  test("golden layer2: all dossiers share one DB without cross-contamination", {
    timeout: 600_000,
  }, async () => {
    const inputs = nonNull.map((d) => ({
      d,
      ...loadLayer2Input(d),
    }));
    // One clock for the whole shared store: after every dossier's window.
    const nowD = inputs
      .map((i) => i.nowD)
      .sort()
      .at(-1)!;
    const dir = mkdtempSync(join(tmpdir(), "golden-l2-shared-"));
    const db = await openTestDb(dir, { now: () => nowD });
    const failures: string[] = [];
    try {
      for (const { d, input, harness } of inputs) {
        const result = await db.importer.importSession(input, harness);
        assert.ok(
          !(result.skipped || result.failed) && result.incomplete !== true,
          `${d.sessionId}: shared-DB import failed`
        );
      }
      const count = await db.prisma.client.$queryRawUnsafe<
        { n: number | bigint }[]
      >("SELECT COUNT(*) AS n FROM sessions");
      assert.equal(Number(count[0]?.n ?? 0), inputs.length);
      // Per-session token facts must hold with every other session present —
      // catches one session's rows bleeding into another (global identity
      // stores like artifacts/agent_components upsert across sessions).
      for (const { d, input } of inputs) {
        const store = await readStoreFacts(db, d.sessionId);
        checkTokenStoreFidelity(store, input, (message) =>
          failures.push(`${d.sessionId}: shared-DB ${message}`)
        );
        const expectedCounts = expectedEventCounts(input);
        if (!isDeepStrictEqual(store.eventCounts, expectedCounts)) {
          failures.push(
            `${d.sessionId}: shared-DB event counts diverged from input`
          );
        }
      }
      await checkGlobalIdentityStores(db, failures);
      await checkSharedInvocationStores(db, inputs, failures);
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
    assert.ok(
      failures.length === 0,
      `shared-DB pass: ${failures.length} session(s) diverged:\n  - ${failures.join("\n  - ")}`
    );
  });

  // Registered LAST: node:test runs top-level tests in registration order, so
  // every test above has completed by the time this sweep runs.
  test("every registered layer2 divergence was exercised", () => {
    for (const entry of LAYER2_KNOWN_DIVERGENCES) {
      const present =
        dossierIds.has(entry.sessionId) ||
        ALWAYS_PRESENT_FIXTURE_IDS.has(entry.sessionId);
      if (!present) {
        continue; // inert pre-seeded entry for a dossier arriving via another PR
      }
      assert.ok(
        firedLayer2Divergences.has(`${entry.sessionId} ${entry.key}`),
        `L2 divergence ${entry.sessionId}:${entry.key} (${entry.ticket}) never fired — ` +
          "stale key path or the store stopped producing it; remove or fix the entry"
      );
    }
  });
}
