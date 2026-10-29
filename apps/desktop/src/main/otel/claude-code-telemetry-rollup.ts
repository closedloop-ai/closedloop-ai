/**
 * @file claude-code-telemetry-rollup.ts
 * @description ISS-10717 — turns the local `claude_code_*` corpus into the
 * per-session shape the cloud lane delivers.
 *
 * The grain decision and its reasoning live on the wire contract
 * (`@repo/api/src/types/desktop-claude-code-telemetry-sync`). What this module
 * owns is the half that decides whether a number may be SENT AT ALL.
 *
 * ── Unknown is not zero, decided here ──────────────────────────────────────
 * A count is emitted only when the signal family has EVER been recorded on this
 * machine. `signalFamiliesEverRecorded` probes each table once per pass; a
 * family with no row anywhere is OMITTED from every session in that pass rather
 * than sent as `0`. A `0` that does reach the wire is therefore a measurement:
 * the family is captured on this machine and this session produced none of it.
 *
 * The case that makes the distinction load-bearing is `claude_code_llm_request`,
 * which Claude Code fills only under `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`.
 * Nothing in this repo sets it, so the table is structurally empty and a `0`
 * there would assert that a session issued no LLM requests when in truth none
 * were ever captured.
 *
 * ── ISS-11322: SIX MORE FAMILIES, THREE OF WHICH ARE NOT COUNTS ─────────────
 * ISS-10717 carried eight. `auth_event`, `plugin_event` and `session_start` join
 * them unchanged: for those a row count IS the signal. The other three could
 * not be counts, and each is carried as its actual measurement instead:
 *
 * - `active_time` → SUMMED SECONDS, per `activity_type`. The table separates
 *   user seconds from CLI seconds; one blended total would fit neither name, and
 *   a count of activity rows would be a third number entirely.
 * - `lines_of_code` → SUMMED `line_count`, per `(model, change_type)`. Lines
 *   added by one model and lines removed by another are not addends of anything.
 * - `session_identity` → its DIMENSIONS. That table is `@id` on `session_id`, so
 *   its count is 0 or 1 and says only whether the harness stamped an identity.
 *
 * Both breakdowns are BOUNDED and publish their own shortfall, exactly as the
 * component breakdown does: a slice that reached the cap says so rather than
 * being presented as the whole set.
 *
 * The CANDIDATE half — which sessions are owed a delivery, and the per-session
 * floor that bounds asking — is `claude-code-telemetry-candidates.ts`.
 */

import type {
  DesktopClaudeCodeComponentTelemetryInput,
  DesktopClaudeCodeDropCounterInput,
  DesktopClaudeCodeSessionTelemetryInput,
} from "@repo/api/src/types/desktop-claude-code-telemetry-sync";
import { DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_COMPONENTS_PER_REQUEST } from "@repo/api/src/types/desktop-claude-code-telemetry-sync";
import type { DesktopPrismaReadClient } from "../database/prisma-client.js";
import { usdDecimalText } from "./claude-code-telemetry-decimal.js";
import {
  loadSessionActiveTime,
  loadSessionIdentity,
  loadSessionLinesOfCode,
} from "./claude-code-telemetry-measures.js";

/**
 * Which signal families this machine has ever recorded.
 *
 * One boolean per family, probed once per pass rather than per session: the
 * question is a property of the MACHINE ("is this table fed here at all"), not
 * of the session, and asking it per session would be the same answer N times.
 */
export type ClaudeCodeSignalFamiliesRecorded = {
  costEvent: boolean;
  apiRequest: boolean;
  errorEvent: boolean;
  permissionEvent: boolean;
  permissionModeChange: boolean;
  mcpServerConnection: boolean;
  toolResult: boolean;
  llmRequest: boolean;
  authEvent: boolean;
  pluginEvent: boolean;
  sessionStart: boolean;
  activeTime: boolean;
  linesOfCode: boolean;
  sessionIdentity: boolean;
};

/** Probe each family once for "has this machine ever recorded one". */
export async function loadSignalFamiliesRecorded(
  client: DesktopPrismaReadClient
): Promise<ClaudeCodeSignalFamiliesRecorded> {
  const [
    costEvent,
    apiRequest,
    errorEvent,
    permissionEvent,
    permissionModeChange,
    mcpServerConnection,
    toolResult,
    llmRequest,
    authEvent,
    pluginEvent,
    sessionStart,
    activeTime,
    linesOfCode,
    sessionIdentity,
  ] = await Promise.all([
    client.claudeCodeCostEvent.findFirst({ select: { id: true } }),
    client.claudeCodeApiRequest.findFirst({ select: { id: true } }),
    client.claudeCodeErrorEvent.findFirst({ select: { id: true } }),
    client.claudeCodePermissionEvent.findFirst({ select: { id: true } }),
    client.claudeCodePermissionModeChange.findFirst({ select: { id: true } }),
    client.claudeCodeMcpServerConnection.findFirst({ select: { id: true } }),
    client.claudeCodeToolResult.findFirst({ select: { id: true } }),
    client.claudeCodeLlmRequest.findFirst({ select: { id: true } }),
    client.claudeCodeAuthEvent.findFirst({ select: { id: true } }),
    client.claudeCodePluginEvent.findFirst({ select: { id: true } }),
    client.claudeCodeSessionStart.findFirst({ select: { id: true } }),
    client.claudeCodeActiveTime.findFirst({ select: { id: true } }),
    client.claudeCodeLinesOfCode.findFirst({ select: { id: true } }),
    // `claude_code_session_identity` is keyed `@id` on `session_id` and has no
    // `id` column, so the probe selects the key it does have.
    client.claudeCodeSessionIdentity.findFirst({ select: { sessionId: true } }),
  ]);
  return {
    costEvent: costEvent !== null,
    apiRequest: apiRequest !== null,
    errorEvent: errorEvent !== null,
    permissionEvent: permissionEvent !== null,
    permissionModeChange: permissionModeChange !== null,
    mcpServerConnection: mcpServerConnection !== null,
    toolResult: toolResult !== null,
    llmRequest: llmRequest !== null,
    authEvent: authEvent !== null,
    pluginEvent: pluginEvent !== null,
    sessionStart: sessionStart !== null,
    activeTime: activeTime !== null,
    linesOfCode: linesOfCode !== null,
    sessionIdentity: sessionIdentity !== null,
  };
}

/**
 * The machine's drop counters as the wire carries them, WITH whether any of them
 * is past what the cloud acknowledged.
 *
 * One read rather than two: the lane needs both on every tick — the counters to
 * ride along with a session, and the owed flag to decide whether a tick with no
 * dirty session still has something to deliver.
 */
export type ClaudeCodeDropCounterSnapshot = {
  counters: DesktopClaudeCodeDropCounterInput[];
  /**
   * True when at least one `(harness, reason)` has counted past its
   * `synced_count`. This is the whole reason the counters are not delivery-coupled
   * to a session: the loss that dirties no session is exactly the one a
   * passenger-only lane never reports.
   */
  undelivered: boolean;
};

/** The machine's current drop counters, as the wire carries them. */
export async function loadClaudeCodeDropCounters(
  client: DesktopPrismaReadClient
): Promise<ClaudeCodeDropCounterSnapshot> {
  const rows = await client.claudeCodeSignalDrop.findMany({
    orderBy: [{ harness: "asc" }, { reason: "asc" }],
  });
  let undelivered = false;
  const counters: DesktopClaudeCodeDropCounterInput[] = [];
  for (const row of rows) {
    if (row.droppedCount !== row.syncedCount) {
      undelivered = true;
    }
    counters.push({
      harness: row.harness,
      reason: row.reason,
      droppedCount: row.droppedCount.toString(),
      firstObservedAt: row.firstObservedAt,
      lastObservedAt: row.lastObservedAt,
    });
  }
  return { counters, undelivered };
}

/**
 * Emit `count` only when the family is recorded on this machine.
 *
 * The whole "unknown is not zero" rule reduces to this one helper, so there is
 * exactly one place a `0` can be decided rather than eight.
 */
function countIfRecorded(recorded: boolean, count: number): number | undefined {
  return recorded ? count : undefined;
}

export type ClaudeCodeSessionRollup = {
  session: DesktopClaudeCodeSessionTelemetryInput;
};

/**
 * Build one session's rollup.
 *
 * Returns `null` when the session has no Claude Code rows at all, which is the
 * ordinary case for a Codex, Cursor, Copilot or OpenCode session: those harnesses
 * produce none of these signals, and shipping an all-omitted row for them would
 * create a cloud record asserting nothing.
 */
export async function buildClaudeCodeSessionRollup(
  client: DesktopPrismaReadClient,
  input: {
    sessionId: string;
    harness: string;
    families: ClaudeCodeSignalFamiliesRecorded;
  }
): Promise<ClaudeCodeSessionRollup | null> {
  const { sessionId, harness, families } = input;
  const where = { sessionId };
  const [
    costEventCount,
    apiRequestCount,
    errorEventCount,
    permissionEventCount,
    permissionModeChangeCount,
    mcpServerConnectionCount,
    toolResultCount,
    llmRequestCount,
    authEventCount,
    pluginEventCount,
    sessionStartRowCount,
  ] = await Promise.all([
    client.claudeCodeCostEvent.count({ where }),
    client.claudeCodeApiRequest.count({ where }),
    client.claudeCodeErrorEvent.count({ where }),
    client.claudeCodePermissionEvent.count({ where }),
    client.claudeCodePermissionModeChange.count({ where }),
    client.claudeCodeMcpServerConnection.count({ where }),
    client.claudeCodeToolResult.count({ where }),
    client.claudeCodeLlmRequest.count({ where }),
    client.claudeCodeAuthEvent.count({ where }),
    client.claudeCodePluginEvent.count({ where }),
    client.claudeCodeSessionStart.count({ where }),
  ]);

  const [costAggregate, apiAggregate, costWindow, sessionStartAggregate] =
    await Promise.all([
      client.claudeCodeCostEvent.aggregate({
        where,
        _sum: { costUsd: true },
      }),
      client.claudeCodeApiRequest.aggregate({
        where,
        _sum: { costUsdMicros: true },
      }),
      client.claudeCodeCostEvent.aggregate({
        where,
        _min: { observedAt: true },
        _max: { observedAt: true },
      }),
      // SUMMED, not counted. `claude_code_session_start` is a DELTA-COUNTER
      // table: signal-reduction folds each `claude_code.session.count` point
      // into one row per `(observed_at, start_type)` and adds the point's value
      // into `session_count`. A row count therefore answers "how many distinct
      // observation instants did this session have", which is a different
      // number wearing the family's name — a single point of value 3 would
      // reach the cloud as 1. The same shape `lines_of_code` already uses.
      client.claudeCodeSessionStart.aggregate({
        where,
        _sum: { sessionCount: true },
      }),
    ]);

  const { components, truncated } = await loadSessionComponents(
    client,
    sessionId
  );

  // ISS-11322's three non-count families, each loaded at the grain its signal
  // actually has. `activeTimeRows`/`linesOfCodeRows` are what THIS SESSION has;
  // whether the family is recorded on this MACHINE is still the `families`
  // probe's call, applied below.
  const [activeTime, linesOfCode, identity] = await Promise.all([
    loadSessionActiveTime(client, sessionId),
    loadSessionLinesOfCode(client, sessionId),
    loadSessionIdentity(client, sessionId),
  ]);

  // EVERY family counts toward "does this session have Claude Code rows at all",
  // including the six ISS-11322 adds. The candidate query now selects a session
  // whose ONLY rows are in one of the six; if this sum did not see them, that
  // session would be selected every tick, build a rollup, return `null` here, and
  // never advance its watermark — selected forever and delivered never. The three
  // value-bearing families contribute their BREAKDOWN ROW COUNT here, which is
  // only ever used as the has-any-rows test and is never sent as a signal count.
  const totalRows =
    costEventCount +
    apiRequestCount +
    errorEventCount +
    permissionEventCount +
    permissionModeChangeCount +
    mcpServerConnectionCount +
    toolResultCount +
    llmRequestCount +
    authEventCount +
    pluginEventCount +
    sessionStartRowCount +
    activeTime.rows.length +
    linesOfCode.rows.length +
    (identity === undefined ? 0 : 1);
  if (totalRows === 0) {
    return null;
  }

  const apiCostMicros = apiAggregate._sum.costUsdMicros;
  const session: DesktopClaudeCodeSessionTelemetryInput = {
    externalSessionId: sessionId,
    harness,
    costEventCount: countIfRecorded(families.costEvent, costEventCount),
    apiRequestCount: countIfRecorded(families.apiRequest, apiRequestCount),
    errorEventCount: countIfRecorded(families.errorEvent, errorEventCount),
    permissionEventCount: countIfRecorded(
      families.permissionEvent,
      permissionEventCount
    ),
    permissionModeChangeCount: countIfRecorded(
      families.permissionModeChange,
      permissionModeChangeCount
    ),
    mcpServerConnectionCount: countIfRecorded(
      families.mcpServerConnection,
      mcpServerConnectionCount
    ),
    toolResultCount: countIfRecorded(families.toolResult, toolResultCount),
    llmRequestCount: countIfRecorded(families.llmRequest, llmRequestCount),
    authEventCount: countIfRecorded(families.authEvent, authEventCount),
    pluginEventCount: countIfRecorded(families.pluginEvent, pluginEventCount),
    sessionStartCount: families.sessionStart
      ? representableCount(sessionStartAggregate._sum.sessionCount)
      : undefined,
    costEventUsd: usdDecimalText(costAggregate._sum.costUsd),
    apiRequestCostUsdMicros:
      apiCostMicros === null ? undefined : apiCostMicros.toString(),
    observedFrom: costWindow._min.observedAt ?? undefined,
    observedTo: costWindow._max.observedAt ?? undefined,
    components,
    // Published WITH its shortfall rather than silently cut: the cloud must not
    // treat a truncated list as the whole set and delete the tail it never saw.
    ...(truncated ? { componentsTruncated: true } : {}),
    // The three value-bearing families. OMITTED ENTIRELY when the family has
    // never been recorded on this machine — the array form of the same rule
    // `countIfRecorded` applies to the counts, because a present `[]` is the
    // measured claim "this machine records active time and this session produced
    // none" and an omission is "this machine has never recorded it".
    ...(families.activeTime ? { activeTime: activeTime.rows } : {}),
    ...(families.activeTime && activeTime.truncated
      ? { activeTimeTruncated: true }
      : {}),
    ...(families.linesOfCode ? { linesOfCode: linesOfCode.rows } : {}),
    ...(families.linesOfCode && linesOfCode.truncated
      ? { linesOfCodeTruncated: true }
      : {}),
    // THE MACHINE PROBE DECIDES PRESENCE; THE SESSION'S ROW DECIDES CONTENT, and
    // conflating the two is the trap here. A machine that has never recorded the
    // identity family omits the field, so the ingest writes nothing and clears
    // nothing — which also means a machine whose identity rows have aged out of
    // the retention window cannot wipe dimensions the cloud already holds. A
    // machine that DOES record it always sends the field: the dimensions when this
    // session has a row, `{}` when it does not. Sending nothing in that second
    // case would publish "the harness stamped no identity for this session" for a
    // machine-level unknown, which is what the probe exists to avoid.
    ...(families.sessionIdentity ? { identity: identity ?? {} } : {}),
  };
  return { session };
}

/**
 * One row per `(session, attribution_key)` — the drilldown the rollup would
 * otherwise lose, and the headline of ISS-10717.
 *
 * Grouped in SQLite rather than folded in JS so a session with thousands of cost
 * events costs one query and a bounded result, not a full row read.
 */
async function loadSessionComponents(
  client: DesktopPrismaReadClient,
  sessionId: string
): Promise<{
  components: DesktopClaudeCodeComponentTelemetryInput[];
  truncated: boolean;
}> {
  const grouped = await client.claudeCodeCostEvent.groupBy({
    by: [
      "attributionKey",
      "attributionSource",
      "agentName",
      "skillName",
      "pluginName",
      "mcpServerName",
      "mcpToolName",
      "querySource",
      "speed",
      "effort",
    ],
    where: { sessionId },
    _count: { _all: true },
    _sum: { costUsd: true },
    // Ordered by COST first, attribution key second. The order decides which
    // components survive the cap, so ranking by cost keeps the ones a reader
    // actually asks about; the key is the tiebreak, which is what makes the
    // page stable across ticks rather than a set that silently reshuffles.
    // One row OVER the cap is requested so the caller can tell a full page from
    // a truncated one without a second count.
    orderBy: [{ _sum: { costUsd: "desc" } }, { attributionKey: "asc" }],
    take: DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_COMPONENTS_PER_REQUEST + 1,
  });
  const truncated =
    grouped.length > DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_COMPONENTS_PER_REQUEST;
  const components = grouped
    .slice(0, DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_COMPONENTS_PER_REQUEST)
    .map((row) => ({
      attributionKey: row.attributionKey,
      attributionSource: row.attributionSource,
      agentName: row.agentName ?? undefined,
      skillName: row.skillName ?? undefined,
      pluginName: row.pluginName ?? undefined,
      mcpServerName: row.mcpServerName ?? undefined,
      mcpToolName: row.mcpToolName ?? undefined,
      querySource: row.querySource ?? undefined,
      speed: row.speed ?? undefined,
      effort: row.effort ?? undefined,
      costEventCount: row._count._all,
      costUsd: usdDecimalText(row._sum.costUsd),
    }));
  return { components, truncated };
}

/**
 * A summed delta counter as the wire's `int` count, or omitted.
 *
 * The cloud column is a PostgreSQL `INTEGER` while the local column is a SQLite
 * `BIGINT`, so a magnitude past the signed 32-bit range has no representation on
 * the far side. Omission is this lane's word for unknown and is the honest answer
 * for a value that cannot be carried; clamping would publish a wrong number as a
 * measured one, and sending it would fail the whole session's delivery in the
 * upsert. A negative sum is refused for the same reason `nonNegativeBigIntText`
 * refuses one: the family is a magnitude, so a negative total is corrupt rather
 * than small.
 */
function representableCount(value: bigint | null): number | undefined {
  if (value === null || value < 0n || value > MAX_WIRE_COUNT) {
    return undefined;
  }
  return Number(value);
}

/** The largest count a PostgreSQL `INTEGER` column holds. */
const MAX_WIRE_COUNT = 2_147_483_647n;
