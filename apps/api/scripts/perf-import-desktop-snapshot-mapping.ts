/**
 * ISS-5288 — the MAPPING half of the desktop-snapshot import: what one snapshot
 * row bundle becomes on the desktop → cloud sync wire.
 *
 * The reads that produce those bundles are
 * `perf-import-desktop-snapshot-reads.ts`; this module is pure over them, which
 * is what makes it testable against the real Zod schema with no database.
 *
 * THE MAPPING AUTHORITY IS `apps/api/lib/desktop-agent-sessions-schema.ts`, and
 * the shape is mirrored from the desktop's own producer
 * (`apps/desktop/src/main/database/sync-source.ts`) so this lane seeds rows a
 * real sync could have produced. A field the snapshot cannot source HONESTLY is
 * OMITTED, never invented: omission is the wire contract's "no claim" and leaves
 * the cloud value untouched, whereas a fabricated value would make the perf
 * database disagree with the code under test. The omitted set, and why each one
 * is omitted, is {@link OMITTED_WIRE_FIELDS}.
 */
import {
  MAX_SUPPORTED_DATA_REVISION,
  MAX_SYNCED_ACTIVITY_SEGMENTS,
  MAX_SYNCED_COMPONENT_USAGE,
} from "@repo/api/src/types/agent-session";
import { compactMetadataForPreview } from "@repo/lib/agent-sessions/metadata-preview";
import type {
  SnapshotSessionBundle,
  SqliteRow,
} from "./perf-import-desktop-snapshot-reads";

/**
 * Wire fields this importer deliberately does NOT send, and the reason. Every
 * one is optional on the wire, so omitting it is a no-claim rather than a lie —
 * which is the whole point: the desktop DERIVES these at sync-source assembly
 * from its trace builder, and re-deriving them here would be a second
 * implementation of that classifier whose drift nothing would catch.
 */
export const OMITTED_WIRE_FIELDS = {
  deviceTimeZone:
    "not persisted in the snapshot; the desktop stamps its own live IANA zone",
  wallClock: "trace-derived at sync-source assembly, not a stored column",
  activeAgent: "trace-derived at sync-source assembly, not a stored column",
  waitingUser: "trace-derived at sync-source assembly, not a stored column",
  turns: "trace-derived at sync-source assembly, not a stored column",
  steeringEpisodes:
    "trace-derived at sync-source assembly, not a stored column",
  autonomy: "trace-derived at sync-source assembly, not a stored column",
  activityBuckets: "trace-derived at sync-source assembly, not a stored column",
  span: "trace-derived at sync-source assembly, not a stored column",
  markers: "trace-derived at sync-source assembly, not a stored column",
  throttles: "trace-derived at sync-source assembly, not a stored column",
  phases: "trace-derived at sync-source assembly, not a stored column",
  tracePhaseSources: "stored column, but NULL for every row in a real snapshot",
  throttleSources: "stored column, but NULL for every row in a real snapshot",
  correctionSources: "stored column, but NULL for every row in a real snapshot",
  gitDiffStats: "derived from session_artifact_links LOC, not a session column",
  branchDiffStats:
    "derived from session_artifact_links LOC, not a session column",
  prRefs:
    "derived from the link/PR tables with slug validation this lane does not replicate",
  artifactRefs:
    "derived from the link/PR tables with slug validation this lane does not replicate",
} as const;

/** Why a row was left out of the payload. Never silent — every skip is tallied. */
export const SkipReason = {
  SessionMissingTimestamps: "session_missing_timestamps",
  SessionMissingStatus: "session_missing_status",
  AgentMissingIdentity: "agent_missing_identity",
  EventMissingTimestamp: "event_missing_timestamp",
  TokenUsageUnrepresentable: "token_usage_unrepresentable",
  TokenEventMissingTransportId: "token_event_missing_transport_id",
  TokenEventUnrepresentable: "token_event_unrepresentable",
  ActivitySegmentBoundsInvalid: "activity_segment_bounds_invalid",
  ActivityTilingOverPayloadCap: "activity_tiling_over_payload_cap",
  ComponentUsageMissingIdentity: "component_usage_missing_identity",
  ComponentUsageGroupOverCap: "component_usage_group_over_cap",
} as const;
export type SkipReason = (typeof SkipReason)[keyof typeof SkipReason];

export type SkipTally = Partial<Record<SkipReason, number>>;

/**
 * Map one bundle onto the sync wire shape, tallying every row left out.
 *
 * Returns `null` when the session itself cannot be represented — a required
 * wire field the snapshot has no honest value for. That is a NAMED skip the
 * caller reports, not a session quietly dropped.
 */
export function mapSnapshotSession(
  bundle: SnapshotSessionBundle,
  tally: SkipTally
): Record<string, unknown> | null {
  const row = bundle.session;
  const startedAt = trimmedOrNull(row.startedAt);
  const updatedAt = trimmedOrNull(row.updatedAt);
  if (startedAt === null || updatedAt === null) {
    countSkip(tally, SkipReason.SessionMissingTimestamps);
    return null;
  }
  const status = trimmedOrNull(row.status);
  if (status === null) {
    countSkip(tally, SkipReason.SessionMissingStatus);
    return null;
  }

  const repositoryFullName = trimmedOrNull(row.repoFullName);
  const tokenEvents = mapTokenEvents(bundle.tokenEvents, tally);
  const activitySegmentRows = mapActivitySegments(
    bundle.activitySegments,
    tally
  );
  const components = mapComponentUsage(bundle.componentUsage, tally);

  return {
    externalSessionId: String(row.id),
    name: trimmedOrNull(row.name),
    status,
    harness: trimmedOrNull(row.harness),
    cwd: trimmedOrNull(row.cwd),
    model: trimmedOrNull(row.model),
    startedAt,
    updatedAt,
    endedAt: trimmedOrNull(row.endedAt),
    awaitingInputSince: trimmedOrNull(row.awaitingInputSince),
    // The producer compacts metadata through the SAME shared contract the cloud
    // re-applies at persist, so pre-compacting here reproduces the bytes a real
    // sync stores instead of the far larger raw local blob.
    metadata: compactMetadataForPreview(parseJsonText(row.metadata)),
    ...optionalField("billingMode", trimmedOrNull(row.billingMode)),
    ...optionalField("endsWithError", sqliteFlagToBoolean(row.endsWithError)),
    ...optionalField(
      "dataRevision",
      boundedInteger(row.dataRevision, 1, MAX_SUPPORTED_DATA_REVISION)
    ),
    ...optionalField(
      "frustrationRaw",
      boundedInteger(row.frustrationRaw, 0, Number.MAX_SAFE_INTEGER)
    ),
    ...optionalField(
      "frustrationScoreVersion",
      boundedInteger(row.frustrationScoreVersion, 1, Number.MAX_SAFE_INTEGER)
    ),
    ...(repositoryFullName === null
      ? {}
      : { attribution: { repositoryFullName } }),
    agents: mapAgents(bundle.agents, tally),
    events: mapEvents(bundle.events, tally),
    tokenUsageByModel: mapTokenUsage(bundle.tokenUsage, tally),
    ...(tokenEvents.length > 0 ? { tokenEvents } : {}),
    ...(activitySegmentRows.length > 0 ? { activitySegmentRows } : {}),
    ...(components.length > 0 ? { components } : {}),
    ...(bundle.analytics ? mapAnalytics(bundle.analytics) : {}),
  };
}

function mapAgents(
  rows: SqliteRow[],
  tally: SkipTally
): Record<string, unknown>[] {
  const mapped: Record<string, unknown>[] = [];
  for (const row of rows) {
    const name = trimmedOrNull(row.name);
    const type = trimmedOrNull(row.type);
    const status = trimmedOrNull(row.status);
    if (name === null || type === null || status === null) {
      countSkip(tally, SkipReason.AgentMissingIdentity);
      continue;
    }
    mapped.push({
      externalAgentId: String(row.id),
      name,
      type,
      subagentType: trimmedOrNull(row.subagentType),
      status,
      currentTool: trimmedOrNull(row.currentTool),
      startedAt: trimmedOrNull(row.startedAt),
      updatedAt: trimmedOrNull(row.updatedAt),
      endedAt: trimmedOrNull(row.endedAt),
      awaitingInputSince: trimmedOrNull(row.awaitingInputSince),
      parentExternalAgentId: trimmedOrNull(row.parentAgentId),
      metadata: compactMetadataForPreview(parseJsonText(row.metadata)),
    });
  }
  return mapped;
}

function mapEvents(
  rows: SqliteRow[],
  tally: SkipTally
): Record<string, unknown>[] {
  const mapped: Record<string, unknown>[] = [];
  for (const row of rows) {
    const createdAt = trimmedOrNull(row.createdAt);
    const eventType = trimmedOrNull(row.eventType);
    if (createdAt === null || eventType === null) {
      countSkip(tally, SkipReason.EventMissingTimestamp);
      continue;
    }
    mapped.push({
      externalEventId: String(row.id),
      agentExternalId: trimmedOrNull(row.agentId),
      eventType,
      toolName: trimmedOrNull(row.toolName),
      createdAt,
    });
  }
  return mapped;
}

/**
 * Fold the pre-compaction baselines into the effective totals, exactly as the
 * desktop producer does — raw post-compaction counts alone undercount every
 * compacted session and would put a wrong number in the perf database.
 */
function mapTokenUsage(
  rows: SqliteRow[],
  tally: SkipTally
): Record<string, unknown>[] {
  const mapped: Record<string, unknown>[] = [];
  for (const row of rows) {
    const model = trimmedOrNull(row.model);
    const inputTokens = sumTokenCounts(row.inputTokens, row.baselineInput);
    const outputTokens = sumTokenCounts(row.outputTokens, row.baselineOutput);
    const cacheReadTokens = sumTokenCounts(
      row.cacheReadTokens,
      row.baselineCacheRead
    );
    const cacheWriteTokens = sumTokenCounts(
      row.cacheWriteTokens,
      row.baselineCacheWrite
    );
    if (
      model === null ||
      inputTokens === null ||
      outputTokens === null ||
      cacheReadTokens === null ||
      cacheWriteTokens === null
    ) {
      countSkip(tally, SkipReason.TokenUsageUnrepresentable);
      continue;
    }
    mapped.push({
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...mapCacheWriteTtl(row, cacheWriteTokens),
      ...optionalField(
        "estimatedCostUsd",
        nonNegativeFloat(row.costUsdEstimated)
      ),
    });
  }
  return mapped;
}

/**
 * The TTL subdivision is a PAIR — the wire schema rejects one without the other,
 * and rejects a subdivision that exceeds its parent — so emit both or neither.
 */
function mapCacheWriteTtl(
  row: SqliteRow,
  cacheWriteTokens: number
): Record<string, number> {
  const fiveMinute = boundedInteger(
    row.cacheWrite5mTokens,
    0,
    Number.MAX_SAFE_INTEGER
  );
  const oneHour = boundedInteger(
    row.cacheWrite1hTokens,
    0,
    Number.MAX_SAFE_INTEGER
  );
  if (fiveMinute === null || oneHour === null) {
    return {};
  }
  if (fiveMinute + oneHour > cacheWriteTokens) {
    return {};
  }
  return { cacheWrite5mTokens: fiveMinute, cacheWrite1hTokens: oneHour };
}

function mapTokenEvents(
  rows: SqliteRow[],
  tally: SkipTally
): Record<string, unknown>[] {
  const mapped: Record<string, unknown>[] = [];
  // ISS-8051: no bound, local or imported — the ingest contract no longer has
  // one to mirror, and inventing a local one would silently shorten the seeded
  // corpus with nothing to tally the drop against (`SkipTally` exists precisely
  // so no row leaves this mapper uncounted).
  //
  // What this does NOT reproduce is the desktop's own PAGINATION: a real
  // producer splits token events across byte-bounded chunks
  // (`agent-session-sync-payload.ts`), and this seeder calls the handler
  // directly, bypassing the route's body caps. So one seeded payload can be
  // LONGER than any single payload a desktop emits. The DB end-state is the
  // same either way — chunks merge idempotently — so a read-perf run is
  // unaffected; an INGEST-perf run reads as a per-payload upper bound rather
  // than a shape the wire actually carries.
  for (const row of rows) {
    const externalEventId = trimmedOrNull(row.transportId);
    if (externalEventId === null) {
      countSkip(tally, SkipReason.TokenEventMissingTransportId);
      continue;
    }
    const model = trimmedOrNull(row.model);
    const createdAt = trimmedOrNull(row.createdAt);
    const counts = mapTokenEventCounts(row);
    if (model === null || createdAt === null || counts === null) {
      countSkip(tally, SkipReason.TokenEventUnrepresentable);
      continue;
    }
    mapped.push({
      externalEventId,
      agentExternalId: null,
      model,
      ...counts,
      createdAt,
      ...optionalField(
        "estimatedCostUsd",
        nonNegativeFloat(row.costUsdEstimated)
      ),
      ...optionalField("sourceIdentity", parseJsonText(row.sourceIdentity)),
      ...optionalField("costSummary", parseJsonText(row.costSummary)),
    });
  }
  return mapped;
}

function mapTokenEventCounts(row: SqliteRow): Record<string, number> | null {
  const inputTokens = boundedInteger(
    row.inputTokens,
    0,
    Number.MAX_SAFE_INTEGER
  );
  const outputTokens = boundedInteger(
    row.outputTokens,
    0,
    Number.MAX_SAFE_INTEGER
  );
  const cacheReadTokens = boundedInteger(
    row.cacheReadTokens,
    0,
    Number.MAX_SAFE_INTEGER
  );
  const cacheWriteTokens = boundedInteger(
    row.cacheWriteTokens,
    0,
    Number.MAX_SAFE_INTEGER
  );
  if (
    inputTokens === null ||
    outputTokens === null ||
    cacheReadTokens === null ||
    cacheWriteTokens === null
  ) {
    return null;
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

/**
 * ISS-4541 is the contract this mirrors: a tiling reaches the cloud IN FULL or
 * not at all — the desktop paginates an over-cap tiling across sync parts and
 * dead-letters the session rather than shipping a prefix, because a partial
 * tiling is silent data loss the cloud cannot tell from a complete one.
 *
 * This lane hands whole sessions to the fold in ONE payload; multi-part
 * chunking is a producer concern it deliberately does not own (see
 * `BATCH_BYTE_BUDGET`). So the only two honest outcomes for a tiling above the
 * per-payload cap are "send it and fail the batch" or OMIT it — and omission is
 * the wire contract's no-claim, which leaves the cloud tiling untouched. A
 * truncated prefix is neither: it would persist as a complete tiling and make
 * the perf dataset disagree with what a real sync produces. The omission is
 * TALLIED, never silent.
 */
function mapActivitySegments(
  rows: SqliteRow[],
  tally: SkipTally
): Record<string, unknown>[] {
  const mapped: Record<string, unknown>[] = [];
  for (const row of rows) {
    const phase = trimmedOrNull(row.phase);
    const startMs = boundedInteger(row.startMs, 0, Number.MAX_SAFE_INTEGER);
    const endMs = boundedInteger(row.endMs, 0, Number.MAX_SAFE_INTEGER);
    const version = boundedInteger(row.version, 0, Number.MAX_SAFE_INTEGER);
    if (
      phase === null ||
      startMs === null ||
      endMs === null ||
      version === null
    ) {
      countSkip(tally, SkipReason.ActivitySegmentBoundsInvalid);
      continue;
    }
    if (startMs >= endMs) {
      // Half-open [startMs, endMs): a degenerate span is a producer bug the wire
      // schema rejects per row, and one bad row would fail the whole batch.
      countSkip(tally, SkipReason.ActivitySegmentBoundsInvalid);
      continue;
    }
    mapped.push({
      phase,
      startMs,
      endMs,
      confidence: clampUnitInterval(row.confidence),
      evidenceLayers: parseStringArray(row.evidenceLayers),
      version,
      workItemRef: trimmedOrNull(row.workItemRef),
      subagentId: trimmedOrNull(row.subagentId),
    });
  }
  if (mapped.length > MAX_SYNCED_ACTIVITY_SEGMENTS) {
    countSkip(tally, SkipReason.ActivityTilingOverPayloadCap);
    return [];
  }
  return mapped;
}

function mapComponentUsage(
  rows: SqliteRow[],
  tally: SkipTally
): Record<string, unknown>[] {
  const mapped: Record<string, unknown>[] = [];
  for (const row of rows) {
    const componentKind = trimmedOrNull(row.componentKind);
    const componentKey = trimmedOrNull(row.componentKey);
    const invocations = boundedInteger(
      row.invocations,
      0,
      Number.MAX_SAFE_INTEGER
    );
    const errorCount = boundedInteger(
      row.errorCount,
      0,
      Number.MAX_SAFE_INTEGER
    );
    if (
      componentKind === null ||
      componentKey === null ||
      invocations === null ||
      errorCount === null
    ) {
      countSkip(tally, SkipReason.ComponentUsageMissingIdentity);
      continue;
    }
    mapped.push({
      componentKind,
      componentKey,
      externalComponentId: trimmedOrNull(row.externalComponentId),
      harness: trimmedOrNull(row.harness),
      invocations,
      errorCount,
      firstInvokedAt: trimmedOrNull(row.firstInvokedAt),
      lastInvokedAt: trimmedOrNull(row.lastInvokedAt),
      gitBranch: trimmedOrNull(row.gitBranch),
      componentVersionHash: trimmedOrNull(row.componentVersionHash),
    });
  }
  return boundWholeComponentGroups(mapped, tally);
}

function mapAnalytics(row: SqliteRow): Record<string, unknown> {
  const counts = [
    "humanTurns",
    "agentTurns",
    "eventCount",
    "toolInvocations",
    "errorEvents",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ] as const;
  const rollup: Record<string, unknown> = {
    startedAt: trimmedOrNull(row.startedAt),
    startedDay: trimmedOrNull(row.startedDay),
    status: trimmedOrNull(row.status),
    harness: trimmedOrNull(row.harness),
    isHuman: sqliteFlagToBoolean(row.isHuman) === true,
    updatedAt: trimmedOrNull(row.updatedAt),
    ...optionalField(
      "runtimeMs",
      boundedInteger(row.runtimeMs, 0, Number.MAX_SAFE_INTEGER)
    ),
    ...optionalField("estimatedCostUsd", nonNegativeFloat(row.estCost)),
  };
  for (const key of counts) {
    // A rollup counter that cannot be represented is reported as a measured
    // zero rather than dropped: the field is REQUIRED on the wire, and the
    // snapshot's own column is NOT NULL DEFAULT 0.
    rollup[key] = boundedInteger(row[key], 0, Number.MAX_SAFE_INTEGER) ?? 0;
  }
  return { sessionAnalytics: rollup };
}

/** `{ key: value }` when the value is present, `{}` when it is not. */
function optionalField<K extends string, V>(
  key: K,
  value: V | null
): Partial<Record<K, V>> {
  return value === null ? {} : ({ [key]: value } as Record<K, V>);
}

function countSkip(tally: SkipTally, reason: SkipReason): void {
  tally[reason] = (tally[reason] ?? 0) + 1;
}

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** SQLite has no boolean: 1/0 are the flag, NULL is "never recorded". */
function sqliteFlagToBoolean(value: unknown): boolean | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value !== 0;
}

function boundedInteger(
  value: unknown,
  min: number,
  max: number
): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return null;
  }
  return value >= min && value <= max ? value : null;
}

/**
 * The effective total the cloud stores. `null` when either side is
 * unrepresentable or the sum leaves the safe-integer envelope the wire keeps
 * token counts inside — a wrong count must never be persisted.
 */
function sumTokenCounts(current: unknown, baseline: unknown): number | null {
  const left = boundedInteger(current, 0, Number.MAX_SAFE_INTEGER);
  const right = boundedInteger(baseline, 0, Number.MAX_SAFE_INTEGER);
  if (left === null || right === null) {
    return null;
  }
  const total = left + right;
  return Number.isSafeInteger(total) ? total : null;
}

function nonNegativeFloat(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function clampUnitInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function parseJsonText(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => trimmedOrNull(entry))
      .filter((entry): entry is string => entry !== null);
  } catch {
    return [];
  }
}

/**
 * Bound `components` at {@link MAX_SYNCED_COMPONENT_USAGE} by taking or skipping
 * each `(componentKind, componentKey)` group WHOLE — the invariant the desktop's
 * own `boundWholeComponentGroups` enforces (`sync-source.ts`).
 *
 * A raw prefix slice would split a group across its per-branch rows, and the
 * cloud treats the branch set present for a group as authoritative: it
 * `deleteMany`s every branch bucket not in the payload. So a half-group
 * undercounts on first import AND prunes branches an earlier import wrote. A
 * group skipped in FULL is absent, and an absent group leaves the stored rows
 * untouched.
 *
 * An over-budget group is skipped rather than terminating the scan, so a later
 * smaller group still gets its chance — breaking would starve every group
 * ordered after the first oversized one on every run. Grouping is keyed rather
 * than run-scanned so it holds even if the snapshot read returns rows out of
 * `(kind, key)` order.
 */
function boundWholeComponentGroups(
  mapped: Record<string, unknown>[],
  tally: SkipTally
): Record<string, unknown>[] {
  if (mapped.length <= MAX_SYNCED_COMPONENT_USAGE) {
    return mapped;
  }
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of mapped) {
    const key = JSON.stringify([row.componentKind, row.componentKey]);
    const group = groups.get(key);
    if (group) {
      group.push(row);
      continue;
    }
    groups.set(key, [row]);
  }
  const bounded: Record<string, unknown>[] = [];
  for (const group of groups.values()) {
    if (bounded.length + group.length > MAX_SYNCED_COMPONENT_USAGE) {
      countSkip(tally, SkipReason.ComponentUsageGroupOverCap);
      continue;
    }
    bounded.push(...group);
  }
  return bounded;
}
