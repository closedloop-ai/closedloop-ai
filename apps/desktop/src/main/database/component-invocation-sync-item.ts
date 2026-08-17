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
import {
  AGENT_COMPONENT_INVOCATION_MAX_COST,
  AGENT_COMPONENT_INVOCATION_MAX_TOKENS,
  AgentComponentInvocationAnchorKind,
  type AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  type AgentComponentInvocationSyncItem,
  canonicalAgentComponentInvocationCost,
} from "@repo/api/src/types/agent-component-invocation";
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
};

export function readStoredInvocationRows(
  tx: Pick<Prisma.TransactionClient, "$queryRawUnsafe">,
  sessionId: string
): Promise<StoredInvocationRow[]> {
  return tx.$queryRawUnsafe<StoredInvocationRow[]>(
    `SELECT session_id, external_invocation_id, external_source_id, child_session_id,
            agent_id, parent_agent_id, component_kind, component_key, raw_name,
            normalized_name, relationship, invoked_at, sequence, anchor_kind,
            anchor_value, provider_tool_use_id, attribution_status,
            evidence_class, evidence_pointer, definition_hash,
            normalizer_contract_version, definition_content, git_branch,
            repository_full_name, model, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, estimated_cost,
            footprint_tokens
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
    sequence: Number(row.sequence),
    anchor,
    ...(row.provider_tool_use_id
      ? { providerInvocationId: row.provider_tool_use_id }
      : {}),
    status:
      row.attribution_status as AgentComponentInvocationSyncItem["status"],
    evidenceClass: row.evidence_class,
    ...(row.definition_hash ? { definitionHash: row.definition_hash } : {}),
    ...(row.normalizer_contract_version == null
      ? {}
      : {
          normalizerContractVersion: Number(row.normalizer_contract_version),
        }),
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
    ...storedTokenCount("footprintTokens", row.footprint_tokens),
  };
}

/**
 * ISS-4976 (@wongk review): the model, the four token counts, and the cost are
 * per-SUBAGENT-TURN usage. Both Prisma schemas say so in the same words — "a
 * subagent invocation carries the model it ran and that turn's usage; other
 * kinds leave them NULL" — and the shared ingest boundary rejects them on any
 * other kind, so a non-subagent row that somehow holds one must not be projected
 * onto the wire. `footprintTokens` is deliberately not part of this: it is the
 * kind-agnostic context-footprint metric and is emitted for every kind.
 */
function storedSubagentUsage(
  row: StoredInvocationRow
): Partial<AgentComponentInvocationSyncItem> {
  if (row.component_kind !== AgentComponentInvocationKind.Subagent) {
    return {};
  }
  return {
    ...(row.model ? { model: row.model } : {}),
    ...storedTokenCount("inputTokens", row.input_tokens),
    ...storedTokenCount("outputTokens", row.output_tokens),
    ...storedTokenCount("cacheReadTokens", row.cache_read_tokens),
    ...storedTokenCount("cacheWriteTokens", row.cache_write_tokens),
    ...storedEstimatedCost(row.estimated_cost),
  };
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
