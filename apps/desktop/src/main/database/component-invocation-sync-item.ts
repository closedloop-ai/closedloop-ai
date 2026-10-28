/**
 * Desktop-local invocation row -> sync-item projection for the dedicated
 * component-invocation protocol (FEA-3294).
 *
 * Extracted from `component-invocations.ts`, which is over the file-size
 * ceiling and shrink-only, so the row->wire mapping has one owner. Every field
 * emitted here enters the generation/part hash preimage, making this the
 * producer half of a byte-exact contract with the cloud's `toSyncItem`: an
 * absent optional value is an OMITTED key, never `null`, so an older Desktop
 * build that computes nothing new stays byte-identical on the wire.
 */

import { storedAgentComponentFindingsWireProjection } from "@repo/api/src/types/agent-component-findings-funnel";
import {
  AGENT_COMPONENT_INVOCATION_MAX_COST,
  AGENT_COMPONENT_INVOCATION_MAX_TOKENS,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionSource,
  type AgentComponentInvocationEvidenceClass,
  type AgentComponentInvocationKind,
  type AgentComponentInvocationSyncItem,
  AgentComponentInvocationUsageMeasurement,
  agentComponentInvocationContractVersion,
  canonicalAgentComponentInvocationCost,
  LINE_BEARING_INVOCATION_KINDS,
  SUCCESS_BEARING_INVOCATION_KINDS,
  USAGE_BEARING_INVOCATION_KINDS,
} from "@repo/api/src/types/agent-component-invocation";
import { invocationDurationFields } from "@repo/api/src/types/agent-component-invocation-duration";
import { isValidInvocationLineCount } from "@repo/api/src/types/agent-component-invocation-lines";
import type { EvidencePointer } from "./component-invocation-row-writer.js";
import type { Prisma } from "./generated/client.js";

const MAX_SAFE_TOKEN_COUNT = BigInt(AGENT_COMPONENT_INVOCATION_MAX_TOKENS);

export type StoredInvocationRow = {
  session_id: string;
  external_invocation_id: string;
  external_source_id: string | null;
  child_session_id: string | null;
  agent_id: string | null;
  parent_agent_id: string | null;
  component_kind: AgentComponentInvocationKind;
  component_key: string;
  raw_name: string | null;
  normalized_name: string | null;
  relationship: string;
  invoked_at: string | null;
  durationMs?: bigint | number | null;
  sequence: number;
  anchor_kind: string;
  anchor_value: string;
  provider_tool_use_id: string | null;
  attribution_status: string;
  evidence_class: AgentComponentInvocationEvidenceClass;
  evidence_pointer: string | EvidencePointer | null;
  definition_hash: string | null;
  normalizer_contract_version: number | null;
  definition_content: string | null;
  git_branch: string | null;
  repository_full_name: string | null;
  // FEA-3981 (ISS-4976) per-invocation telemetry. SQLite dialect: token counts
  // are INTEGER (read back as bigint), cost is REAL, model is TEXT. All stay
  // NULL on any row written before capture computed them.
  model: string | null;
  input_tokens: bigint | null;
  output_tokens: bigint | null;
  cache_read_tokens: bigint | null;
  cache_write_tokens: bigint | null;
  estimated_cost: number | null;
  footprint_tokens: bigint | null;
  // ISS-7795: which population the values above belong to. NULL on every row
  // written before capture, and on every row capture could not measure.
  usage_measurement: string | null;
  // ISS-10730: per-invocation line attribution. SQLite INTEGER, read back as a
  // number or (for a value written outside Prisma) a bigint, so the projection
  // below normalizes before validating. NULL on every row written before
  // capture and on every kind outside LINE_BEARING_INVOCATION_KINDS.
  lines_added: number | bigint | null;
  lines_removed: number | bigint | null;
  // ISS-10718 / FEA-4093: three-valued. NULL means this kind's success is not a
  // first-class transcript fact, which is NOT a failure.
  succeeded: boolean | number | null;
  // ISS-10725: the findings funnel. SQLite INTEGER, read back as bigint; NULL
  // on every row no code-review run was attributed to.
  findings_emitted: bigint | null;
  findings_invalidated: bigint | null;
  // ISS-11325: WHY those two cells read what they read. NULL on every row
  // written before the column, which is emitted as an OMITTED key and read as
  // the `unrecorded` member — never as a measurement and never as a withholding.
  findings_disposition: string | null;
  // ISS-10720: which source attributed the row. NULL on every row written
  // before the join and every row it did not reach, which means "the
  // transcript attributed it" and is emitted as an OMITTED key.
  attribution_source: string | null;
};

export function readStoredInvocationRows(
  tx: Pick<Prisma.TransactionClient, "$queryRawUnsafe">,
  sessionId: string
): Promise<StoredInvocationRow[]> {
  return tx.$queryRawUnsafe<StoredInvocationRow[]>(
    `SELECT session_id, external_invocation_id, external_source_id, child_session_id,
            agent_id, parent_agent_id, component_kind, component_key, raw_name,
            normalized_name, relationship, invoked_at, duration_ms AS durationMs, sequence, anchor_kind,
            anchor_value, provider_tool_use_id, attribution_status,
            evidence_class, evidence_pointer, definition_hash,
            normalizer_contract_version, definition_content, git_branch,
            repository_full_name, model, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, estimated_cost,
            footprint_tokens, usage_measurement, lines_added, lines_removed,
            succeeded, findings_emitted, findings_invalidated,
            findings_disposition, attribution_source
       FROM agent_component_invocations
      WHERE session_id = $1
      ORDER BY sequence, external_invocation_id`,
    sessionId
  );
}

export function storedRowToSyncItem(
  row: StoredInvocationRow
): AgentComponentInvocationSyncItem {
  const pointer = parseEvidencePointer(row.evidence_pointer);
  const anchor = storedAnchor(row, pointer);
  return {
    externalInvocationId: row.external_invocation_id,
    sourceSessionId: row.session_id,
    ...(row.child_session_id ? { childSessionId: row.child_session_id } : {}),
    ...(pointer?.parentExternalInvocationId
      ? { parentExternalInvocationId: pointer.parentExternalInvocationId }
      : {}),
    ...(pointer?.externalAgentId
      ? { externalAgentId: pointer.externalAgentId }
      : {}),
    kind: row.component_kind,
    componentKey: row.component_key,
    ...(row.raw_name ? { rawName: row.raw_name } : {}),
    ...(row.normalized_name ? { normalizedName: row.normalized_name } : {}),
    relationship:
      row.relationship as AgentComponentInvocationSyncItem["relationship"],
    invokedAt: row.invoked_at,
    ...invocationDurationFields(row.durationMs),
    sequence: Number(row.sequence),
    anchor,
    ...(row.provider_tool_use_id
      ? { providerInvocationId: row.provider_tool_use_id }
      : {}),
    status:
      row.attribution_status as AgentComponentInvocationSyncItem["status"],
    evidenceClass: row.evidence_class,
    ...(row.definition_hash ? { definitionHash: row.definition_hash } : {}),
    ...storedContractVersion(row.normalizer_contract_version),
    ...(row.definition_content
      ? { definitionContent: row.definition_content }
      : {}),
    ...(pointer?.definitionFormat
      ? { definitionFormat: pointer.definitionFormat }
      : {}),
    ...(pointer?.sourcePath ? { sourcePath: pointer.sourcePath } : {}),
    ...(pointer?.sourceModifiedAt
      ? { sourceModifiedAt: pointer.sourceModifiedAt }
      : {}),
    ...(pointer?.capturedAt ? { capturedAt: pointer.capturedAt } : {}),
    ...(row.repository_full_name
      ? { repositoryFullName: row.repository_full_name }
      : {}),
    ...(row.git_branch ? { branchName: row.git_branch } : {}),
    ...storedSubagentUsage(row),
    ...storedFootprint(row),
    ...storedInvocationLines(row),
    ...storedSucceeded(row),
    ...storedFindingsDisposition(row),
    ...storedAttributionSource(row.attribution_source),
  };
}

/**
 * ISS-10730: the line attribution, for the kinds allowed to carry it.
 *
 * All-or-nothing, and gated on the same set the wire boundary admits
 * (`lines_require_line_bearing_kind`), so a row this build legally wrote can
 * never fail the `.strict()` part schema and dead-letter the whole generation.
 * A stored half — one column set and the other NULL, or a value the SSOT
 * predicate rejects — emits NEITHER key: half a delta is not a smaller
 * measurement, and an absent optional is an OMITTED key rather than a `null`,
 * so a row with nothing to say stays byte-identical to a pre-ISS-10730 build's.
 */
function storedInvocationLines(
  row: StoredInvocationRow
): Partial<AgentComponentInvocationSyncItem> {
  if (!LINE_BEARING_INVOCATION_KINDS.has(row.component_kind)) {
    return {};
  }
  const added = normalizeStoredLineCount(row.lines_added);
  const removed = normalizeStoredLineCount(row.lines_removed);
  if (added === undefined || removed === undefined) {
    return {};
  }
  return { linesAdded: added, linesRemoved: removed };
}

function normalizeStoredLineCount(
  value: number | bigint | null
): number | undefined {
  if (value === null) {
    return;
  }
  const candidate = typeof value === "bigint" ? Number(value) : value;
  return isValidInvocationLineCount(candidate) ? candidate : undefined;
}

/**
 * ISS-11325: the stored funnel together with the statement about it.
 *
 * The keep/drop call is {@link storedAgentComponentFindingsWireProjection}'s and
 * NOT this module's, for the reason that function's own docblock gives: the
 * cloud's row→wire projection has to make the identical call or ingest's
 * generation-hash reconstruction disagrees with what the Desktop sent, which is
 * a permanent `generation_conflict` rather than one wrong field.
 */
function storedFindingsDisposition(
  row: StoredInvocationRow
): Partial<AgentComponentInvocationSyncItem> {
  return storedAgentComponentFindingsWireProjection(
    row.findings_emitted,
    row.findings_invalidated,
    row.findings_disposition
  );
}

/**
 * ISS-10720: the stored attribution source, admitted only when it is a value
 * this build's vocabulary knows.
 *
 * A value from a NEWER build is dropped rather than forwarded, for the same
 * reason {@link storedUsageMeasurement} drops an unknown label: the wire schema
 * accepts a closed set, so an unrecognized one would fail the whole part at
 * `.strict()` and cost every row in it. Dropping costs this row's attribution
 * and nothing else — and the omitted key is already the shape "the transcript
 * attributed it" has always had, so the degradation is a value the contract
 * defines rather than an invented one. A corrupt TEXT cell reaches here the
 * same way and takes the same path.
 */
function storedAttributionSource(
  value: string | null
): Partial<AgentComponentInvocationSyncItem> {
  const known = Object.values(AgentComponentInvocationAttributionSource).find(
    (source) => source === value
  );
  return known ? { attributionSource: known } : {};
}

/**
 * The model, the four token counts, and the cost, for the kinds allowed to carry
 * them.
 *
 * ISS-4976 admitted only `subagent`, because that was the only kind anything
 * measured. ISS-7795 added the producer for `skill` and `command` — the harness
 * stamps every assistant turn with the component it served, so those two are now
 * measured from the provider's own reported counts rather than inferred. The
 * remaining kinds stay excluded because nothing measures them, not because the
 * column forbids it; a row of theirs holding a value is still corruption and
 * must not reach the wire.
 *
 * `usageMeasurement` rides with the counts and never without them — the label
 * describes them, so alone it describes nothing, which the boundary rejects as
 * `usage_measurement_requires_telemetry`. `footprintTokens` stays outside this
 * KIND gate — it is the kind-agnostic context-footprint metric, emitted for
 * every kind — but not outside the LABEL rule; see {@link storedFootprint}.
 */
function storedSubagentUsage(
  row: StoredInvocationRow
): Partial<AgentComponentInvocationSyncItem> {
  if (!USAGE_BEARING_INVOCATION_KINDS.has(row.component_kind)) {
    return {};
  }
  const usage = {
    ...(row.model ? { model: row.model } : {}),
    ...storedTokenCount("inputTokens", row.input_tokens),
    ...storedTokenCount("outputTokens", row.output_tokens),
    ...storedTokenCount("cacheReadTokens", row.cache_read_tokens),
    ...storedTokenCount("cacheWriteTokens", row.cache_write_tokens),
    ...storedEstimatedCost(row.estimated_cost),
  };
  if (Object.keys(usage).length === 0) {
    return usage;
  }
  const measurement = storedUsageMeasurement(row.usage_measurement);
  // A row that STATES a label this build cannot read loses its counts too,
  // rather than shipping as an unlabelled count. Emitting the counts alone looks
  // like graceful degradation and is the opposite: as soon as any sibling item
  // in the part carries a known label the part declares v3, and the part schema
  // then fails this unlabelled item as `telemetry_requires_usage_measurement` —
  // a verdict `assertPartSatisfiesWireContract` raises on the device, so the
  // whole generation never ships. Degrading to "no telemetry" costs one row's
  // counts; degrading to "unlabelled telemetry" costs every row in the part.
  //
  // A row with NO label is a different case and keeps its counts: that is the
  // pre-label shape a v2 part legitimately carries, and the boundary accepts it.
  if (row.usage_measurement !== null && Object.keys(measurement).length === 0) {
    return {};
  }
  return { ...usage, ...measurement };
}

/**
 * The stored label, admitted only when it is one this build's vocabulary knows.
 *
 * A value from a newer build is not forwarded: the wire schema accepts a closed
 * set, so an unrecognized one would fail the whole part at `.strict()`. The
 * caller drops that row's counts along with it — see above for why keeping them
 * is worse than losing them.
 */
function storedUsageMeasurement(
  value: string | null
): Partial<AgentComponentInvocationSyncItem> {
  const known = Object.values(AgentComponentInvocationUsageMeasurement).find(
    (measurement) => measurement === value
  );
  return known ? { usageMeasurement: known } : {};
}

/**
 * ISS-10718: the stored verdict, as a wire boolean.
 *
 * SQLite has no boolean, so the column comes back as 0/1 or as a driver-mapped
 * boolean depending on how the row was written. NULL stays absent — a kind whose
 * success nobody adjudicates must not arrive as `false` — and so does any OTHER
 * integer, because a closed two-value field holding a 2 is corruption that would
 * otherwise render as a confident `false`.
 *
 * ISS-10718 (@whitlockk review): the KIND is checked first, the way
 * `storedSubagentUsage` checks it. Hook firings and tool results are the only
 * producers of a verdict, so a value on any other kind is corruption rather
 * than a result — and the ingest boundary refuses it as
 * `succeeded_requires_success_bearing_kind`, which this build must not walk
 * into: `assertPartSatisfiesWireContract` would raise it on the device and
 * dead-letter the generation.
 */
function storedSucceeded(
  row: StoredInvocationRow
): Partial<AgentComponentInvocationSyncItem> {
  if (!SUCCESS_BEARING_INVOCATION_KINDS.has(row.component_kind)) {
    return {};
  }
  const value = row.succeeded;
  if (typeof value === "boolean") {
    return { succeeded: value };
  }
  if (value === 1 || value === 0) {
    return { succeeded: value === 1 };
  }
  return {};
}

function storedAnchor(
  row: StoredInvocationRow,
  pointer: EvidencePointer | null
): AgentComponentInvocationSyncItem["anchor"] {
  if (row.anchor_kind === AgentComponentInvocationAnchorKind.Event) {
    return {
      kind: AgentComponentInvocationAnchorKind.Event,
      eventId: row.anchor_value,
      ...(row.provider_tool_use_id
        ? { providerToolUseId: row.provider_tool_use_id }
        : {}),
    };
  }
  if (row.anchor_kind === AgentComponentInvocationAnchorKind.Agent) {
    return {
      kind: AgentComponentInvocationAnchorKind.Agent,
      agentId: row.anchor_value,
      ...(pointer?.transcriptFileId
        ? { transcriptFileId: pointer.transcriptFileId }
        : {}),
    };
  }
  if (row.anchor_kind === AgentComponentInvocationAnchorKind.UserTurn) {
    return {
      kind: AgentComponentInvocationAnchorKind.UserTurn,
      userTurnId: row.anchor_value,
    };
  }
  if (row.anchor_kind === AgentComponentInvocationAnchorKind.Timestamp) {
    const parsed = parseTimestampAnchor(row.anchor_value);
    return {
      kind: AgentComponentInvocationAnchorKind.Timestamp,
      timestamp: parsed.timestamp,
      ordinal: parsed.ordinal,
    };
  }
  return { kind: AgentComponentInvocationAnchorKind.Session };
}

function parseTimestampAnchor(value: string): {
  timestamp: string;
  ordinal: number;
} {
  try {
    const parsed = JSON.parse(value) as {
      timestamp?: unknown;
      ordinal?: unknown;
    };
    if (
      typeof parsed.timestamp === "string" &&
      typeof parsed.ordinal === "number"
    ) {
      return { timestamp: parsed.timestamp, ordinal: parsed.ordinal };
    }
  } catch {
    // Fall through to the conservative legacy interpretation.
  }
  return { timestamp: value, ordinal: 0 };
}

export function parseEvidencePointer(
  value: string | EvidencePointer | null
): EvidencePointer | null {
  if (!value) {
    return null;
  }
  if (typeof value === "object") {
    return value;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as EvidencePointer)
      : null;
  } catch {
    return null;
  }
}

/**
 * A captured count is only meaningful as a non-negative safe integer. A NULL
 * (nothing computed), a negative, or a value past the safe-integer range is
 * omitted rather than sent: the cloud's `.strict()` ingest boundary rejects the
 * ENTIRE part on an out-of-range count, which would silently drop the whole
 * generation and re-drop it on every retry.
 */
function storedTokenCount(
  key:
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "footprintTokens",
  value: bigint | null
): Partial<AgentComponentInvocationSyncItem> {
  if (value === null || value < 0n || value > MAX_SAFE_TOKEN_COUNT) {
    return {};
  }
  return { [key]: Number(value) };
}

/**
 * SQLite stores the cost as a REAL while the cloud column is `numeric(14, 6)`.
 * Canonicalizing to that scale here — before the value enters the generation
 * hash — is what lets the value the cloud reads back out of persistence
 * re-serialize byte-identically. An out-of-range or non-finite cost is omitted
 * for the same reason the counts above are.
 */
function storedEstimatedCost(
  value: number | null
): Partial<AgentComponentInvocationSyncItem> {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return {};
  }
  const canonical = canonicalAgentComponentInvocationCost(value);
  return canonical > AGENT_COMPONENT_INVOCATION_MAX_COST
    ? {}
    : { estimatedCost: canonical };
}

/**
 * ISS-7580: the normalizer contract version, present only when it is a version.
 *
 * This omit-or-emit shape is the same one the counts and the cost above use, and
 * the reading itself is {@link agentComponentInvocationContractVersion}, shared
 * with the dashboard read row so the two producers of this column cannot
 * disagree. A bare `Number(...)` here read a corrupt TEXT cell as `NaN`, which
 * the strict producer-side schema rejects — taking the whole part with it rather
 * than the one field, and re-rejecting it on every retry.
 */
function storedContractVersion(
  value: number | null
): Partial<AgentComponentInvocationSyncItem> {
  const version = agentComponentInvocationContractVersion(value);
  return version === undefined ? {} : { normalizerContractVersion: version };
}

/**
 * ISS-10736: the kind-agnostic context footprint, with the label that describes
 * it.
 *
 * It is emitted for EVERY kind, unlike the turn counts above, because every kind
 * puts something into context — that is what makes it PRD-753's universal
 * denominator. But it is telemetry, so `hasAgentComponentInvocationTelemetry`
 * counts it and the part schema fails any item carrying it without a label as
 * `telemetry_requires_usage_measurement`. Emitting it bare — which this
 * projection did before ISS-10736, harmlessly only because nothing ever wrote
 * the column — would have failed the WHOLE part on the device the first time a
 * footprint was persisted, taking every sibling row with it.
 *
 * So the same degradation the counts take applies here: a row whose stored label
 * this build cannot read loses its footprint rather than shipping it unlabelled.
 * A row with no label at all is the pre-label v2 shape and is left alone — it
 * cannot carry a footprint, because the writer never persists one without one.
 */
function storedFootprint(
  row: StoredInvocationRow
): Partial<AgentComponentInvocationSyncItem> {
  const footprint = storedTokenCount("footprintTokens", row.footprint_tokens);
  if (Object.keys(footprint).length === 0) {
    return {};
  }
  const measurement = storedUsageMeasurement(row.usage_measurement);
  if (Object.keys(measurement).length === 0) {
    return {};
  }
  return { ...footprint, ...measurement };
}
