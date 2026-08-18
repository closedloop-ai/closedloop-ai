/**
 * Runtime Agent Component invocation contracts (FEA-3294).
 *
 * This module is the shared, transport-safe owner for invocation values. It is
 * intentionally independent from the existing schema-v2 agent-session sync:
 * invocation delivery uses its own protocol, endpoint, parts, and exact
 * acknowledgements so an older API cannot silently accept and discard it.
 */

import { stableStringify } from "@closedloop-ai/loops-api/stable-stringify";
import type { SourceOccurrence } from "./agent-component.ts";

export const AgentComponentInvocationKind = {
  Tool: "tool",
  Mcp: "mcp",
  Orchestration: "orchestration",
  Command: "command",
  Skill: "skill",
  Subagent: "subagent",
  // FEA-4093: a configured Hook that fired (captured from transcript
  // `attachment` hook_success/hook_error records). The value equals
  // `AgentComponentKind.Hook` so an invocation projects directly onto the
  // matching Hook inventory row.
  Hook: "hook",
} as const;
export type AgentComponentInvocationKind =
  (typeof AgentComponentInvocationKind)[keyof typeof AgentComponentInvocationKind];

export const AgentComponentInvocationAttributionStatus = {
  Matched: "matched",
  Unresolved: "unresolved",
  Unmatched: "unmatched",
  Ambiguous: "ambiguous",
} as const;
export type AgentComponentInvocationAttributionStatus =
  (typeof AgentComponentInvocationAttributionStatus)[keyof typeof AgentComponentInvocationAttributionStatus];

export const AgentComponentInvocationEvidenceClass = {
  TranscriptSnapshot: "transcriptSnapshot",
  CollectorSnapshot: "collectorSnapshot",
  RepositoryCommit: "repositoryCommit",
  PackMembership: "packMembership",
  None: "none",
} as const;
export type AgentComponentInvocationEvidenceClass =
  (typeof AgentComponentInvocationEvidenceClass)[keyof typeof AgentComponentInvocationEvidenceClass];

export const AgentComponentInvocationRelationship = {
  Direct: "direct",
  ChildSession: "childSession",
  Associated: "associated",
} as const;
export type AgentComponentInvocationRelationship =
  (typeof AgentComponentInvocationRelationship)[keyof typeof AgentComponentInvocationRelationship];

export const AgentComponentInvocationAnchorKind = {
  Event: "event",
  Agent: "agent",
  UserTurn: "userTurn",
  Timestamp: "timestamp",
  Session: "session",
} as const;
export type AgentComponentInvocationAnchorKind =
  (typeof AgentComponentInvocationAnchorKind)[keyof typeof AgentComponentInvocationAnchorKind];

export type AgentComponentInvocationAnchor =
  | {
      kind: typeof AgentComponentInvocationAnchorKind.Event;
      eventId: string;
      providerToolUseId?: string;
    }
  | {
      kind: typeof AgentComponentInvocationAnchorKind.Agent;
      agentId: string;
      externalAgentId?: string;
      transcriptFileId?: string;
    }
  | {
      kind: typeof AgentComponentInvocationAnchorKind.UserTurn;
      userTurnId: string;
    }
  | {
      kind: typeof AgentComponentInvocationAnchorKind.Timestamp;
      timestamp: string;
      ordinal: number;
    }
  | { kind: typeof AgentComponentInvocationAnchorKind.Session };

/** Dedicated invocation protocol; unrelated to agent-session schema version 2. */
export const AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION = 1 as const;

/**
 * ISS-4976 (@wongk / @closedloop-ai-stage review): the version a part MUST
 * declare once any of its items carries per-invocation telemetry.
 *
 * Desktop tags are cut from `main` while the API deploys from `production`, so a
 * Desktop build shipping ahead of the API is ordinary. Without a version bump
 * that build's telemetry-carrying parts would clear the already-deployed route's
 * v1 gate and then be rejected by its `.strict()` item schema as a 400, which the
 * client maps to `validation_failed` — a PERMANENT rejection that dead-letters
 * the part after five attempts and drops the generation for good.
 *
 * Declaring v2 instead hits the version gate the deployed route ALREADY has
 * (`protocolVersion !== 1` → HTTP 501 / `protocol_unsupported`), which the client
 * maps to `unavailable` and retries indefinitely without ever dead-lettering. The
 * generation simply waits and drains once the API deploys.
 *
 * The version is chosen per part from its own items, so a telemetry-free part
 * still declares v1 and is accepted by an older API exactly as it is today.
 */
export const AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION =
  2 as const;

/** Every protocol version this build's ingest boundary accepts. */
export const AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS = [
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
] as const;

export type AgentComponentInvocationSyncProtocolVersion =
  (typeof AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS)[number];

/** Maximum number of invocation occurrences in one complete generation. */
export const AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_ITEMS = 25_000;
/** Maximum number of invocation occurrences in one wire part. */
export const AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_ITEMS = 500;
/** Defensive cap on the number of parts in one generation. */
export const AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_PARTS = 1000;
/** Maximum UTF-8 bytes for optional exact definition content. */
export const AGENT_COMPONENT_INVOCATION_DEFINITION_CONTENT_MAX_BYTES = 98_304;
/** Maximum serialized UTF-8 bytes for one invocation item. */
export const AGENT_COMPONENT_INVOCATION_SYNC_MAX_ITEM_BYTES = 131_072;
/** Maximum serialized UTF-8 bytes for one part envelope. */
export const AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_BYTES = 524_288;
/** Maximum serialized UTF-8 bytes for one endpoint batch. */
export const AGENT_COMPONENT_INVOCATION_SYNC_MAX_BATCH_BYTES = 1_048_576;
/** Maximum cumulative staged bytes across all parts of one generation. */
export const AGENT_COMPONENT_INVOCATION_SYNC_MAX_STAGED_BYTES = 52_428_800;
/** Maximum concurrent incomplete generations per session. */
export const AGENT_COMPONENT_INVOCATION_SYNC_MAX_INFLIGHT_GENERATIONS = 5;
/** Maximum invocation rows returned on one component-detail response. */
export const AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS = 500;

export type AgentComponentInvocationSourceFreshness = {
  sourceUpdatedAt: string;
  dataRevision: number;
  sourceSequence: number;
};

/**
 * One occurrence in the Desktop-local complete-set projection and dedicated
 * sync protocol. Optional fields are omitted when absent; producers must not
 * serialize them as null. `invokedAt` alone is nullable because minimal
 * harnesses may prove a session occurrence without an invocation timestamp.
 */
export type AgentComponentInvocationSyncItem = {
  externalInvocationId: string;
  sourceSessionId: string;
  childSessionId?: string;
  parentExternalInvocationId?: string;
  externalAgentId?: string;
  kind: AgentComponentInvocationKind;
  componentKey: string;
  rawName?: string;
  normalizedName?: string;
  relationship: AgentComponentInvocationRelationship;
  invokedAt: string | null;
  /** Zero-based canonical order inside the source session. */
  sequence: number;
  anchor: AgentComponentInvocationAnchor;
  providerInvocationId?: string;
  status: AgentComponentInvocationAttributionStatus;
  evidenceClass: AgentComponentInvocationEvidenceClass;
  definitionHash?: string;
  normalizerContractVersion?: number;
  /** Optional exact evidence; omitted from read DTOs and when over the cap. */
  definitionContent?: string;
  definitionFormat?: string;
  sourcePath?: string;
  sourceModifiedAt?: string;
  capturedAt?: string;
  repositoryFullName?: string;
  repositoryCommit?: string;
  packId?: string;
  branchName?: string;
  /**
   * FEA-3981 (ISS-4976) per-invocation telemetry. Additive and optional: a
   * producer that has not computed a value omits the key entirely rather than
   * sending `null`, so an older Desktop build stays byte-identical on the wire
   * and its generation identity is unchanged.
   *
   * These describe TWO DIFFERENT POPULATIONS and are NOT additive with each
   * other. Do not sum them into one "total tokens" or one "total cost".
   *
   * - `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`,
   *   `cacheWriteTokens`, `estimatedCost` — the SUBAGENT TURN's own usage: the
   *   model that turn ran under and the tokens/cost that turn billed. Both
   *   Prisma schemas define these as subagent-only ("other kinds leave them
   *   NULL"), and the ingest boundary rejects them on any other kind. That turn
   *   is a child of the session, so its cost is ALREADY counted in the parent
   *   session's own `estimatedCost`: adding per-invocation `estimatedCost` to
   *   the session total double-counts the subagent turns.
   * - `footprintTokens` — the deterministic "tokens this component injected
   *   into context" metric, computed for EVERY kind. A component's injected
   *   definition text is part of the consuming turn's input, so it is already
   *   inside that turn's `inputTokens`: footprint is an attribution of tokens
   *   another field also counts, not an additional token population.
   *
   * A read surface that wants one number must pick ONE population and say which
   * (e.g. "subagent turn spend" or "context footprint"), never fold both.
   *
   * Token counts are safe integers, and `estimatedCost` must already be
   * canonical for the cloud column's decimal scale (see
   * {@link canonicalAgentComponentInvocationCost}) so the value that comes back
   * out of persistence re-serializes byte-identically and the generation hash
   * still reconciles.
   */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCost?: number;
  footprintTokens?: number;
};

/** Desktop-local, unsplit source of truth handed to the dedicated preparer. */
export type AgentComponentInvocationCompleteGeneration =
  AgentComponentInvocationSourceFreshness & {
    externalSessionId: string;
    /** Deterministic hash of the complete canonically ordered item set. */
    externalGenerationId: string;
    items: AgentComponentInvocationSyncItem[];
  };

/**
 * Canonical preimage for `externalGenerationId`. It includes the source session
 * (so two explicit empty generations do not collide across sessions) and the
 * complete canonically ordered item set. Freshness is deliberately excluded:
 * sourceUpdatedAt/dataRevision/sourceSequence order activation separately and
 * do not change the identity of byte-identical invocation history.
 */
export function agentComponentInvocationGenerationHashPreimage(
  generation: Pick<
    AgentComponentInvocationCompleteGeneration,
    "externalSessionId" | "items"
  >
): string {
  const canonical = {
    externalSessionId: generation.externalSessionId,
    items: generation.items,
  };
  return stableStringify(JSON.parse(JSON.stringify(canonical)));
}

/** One independently retriable part of a complete invocation generation. */
export type AgentComponentInvocationSyncPart =
  AgentComponentInvocationSourceFreshness & {
    protocolVersion: AgentComponentInvocationSyncProtocolVersion;
    externalSessionId: string;
    externalGenerationId: string;
    partIndex: number;
    partCount: number;
    partHash: string;
    items: AgentComponentInvocationSyncItem[];
  };

export type AgentComponentInvocationSyncPartWithoutHash = Omit<
  AgentComponentInvocationSyncPart,
  "partHash"
>;

/**
 * Canonical, client-safe preimage hashed by both Desktop and API for `partHash`.
 * Fields are reconstructed explicitly so transport-only extras never enter the
 * hash. JSON normalization first removes absent optional item fields (rather
 * than reinterpreting them as null), then stableStringify sorts nested keys.
 */
export function agentComponentInvocationSyncPartHashPreimage(
  part: AgentComponentInvocationSyncPartWithoutHash
): string {
  const canonical = {
    protocolVersion: part.protocolVersion,
    externalSessionId: part.externalSessionId,
    externalGenerationId: part.externalGenerationId,
    sourceUpdatedAt: part.sourceUpdatedAt,
    dataRevision: part.dataRevision,
    sourceSequence: part.sourceSequence,
    partIndex: part.partIndex,
    partCount: part.partCount,
    items: part.items,
  };
  return stableStringify(JSON.parse(JSON.stringify(canonical)));
}

/** One endpoint request carries one exact part so its acknowledgement is unambiguous. */
export type AgentComponentInvocationSyncBatch = {
  protocolVersion: AgentComponentInvocationSyncProtocolVersion;
  parts: AgentComponentInvocationSyncPart[];
};

export const AgentComponentInvocationSyncAckState = {
  Staged: "staged",
  Activated: "activated",
  Stale: "stale",
} as const;
export type AgentComponentInvocationSyncAckState =
  (typeof AgentComponentInvocationSyncAckState)[keyof typeof AgentComponentInvocationSyncAckState];

export const AgentComponentInvocationSyncRejectReason = {
  ProtocolUnsupported: "protocol_unsupported",
  SessionMissing: "session_missing",
  ValidationFailed: "validation_failed",
  PartConflict: "part_conflict",
  GenerationConflict: "generation_conflict",
  IngestionFailed: "ingestion_failed",
  RateLimited: "rate_limited",
} as const;
export type AgentComponentInvocationSyncRejectReason =
  (typeof AgentComponentInvocationSyncRejectReason)[keyof typeof AgentComponentInvocationSyncRejectReason];

/**
 * Exact per-part acknowledgement. An outbox may advance only when generation,
 * part index, and part hash all match its pending part.
 */
export type AgentComponentInvocationSyncAck =
  | {
      accepted: true;
      protocolVersion: AgentComponentInvocationSyncProtocolVersion;
      externalGenerationId: string;
      partIndex: number;
      partHash: string;
      state: AgentComponentInvocationSyncAckState;
    }
  | {
      accepted: false;
      protocolVersion: AgentComponentInvocationSyncProtocolVersion;
      externalGenerationId: string;
      partIndex: number;
      partHash: string;
      reason: AgentComponentInvocationSyncRejectReason;
    };

/** Bounded, content-free invocation row returned by cloud and Desktop reads. */
export type AgentComponentInvocationReadRow = {
  id: string;
  externalInvocationId: string;
  sessionId: string;
  externalSessionId: string;
  sourceSessionId: string;
  childSessionId?: string;
  parentExternalInvocationId?: string;
  externalAgentId?: string;
  kind: AgentComponentInvocationKind;
  componentKey: string;
  rawName?: string;
  normalizedName?: string;
  relationship: AgentComponentInvocationRelationship;
  invokedAt: string | null;
  sequence: number;
  anchor: AgentComponentInvocationAnchor;
  providerInvocationId?: string;
  status: AgentComponentInvocationAttributionStatus;
  evidenceClass: AgentComponentInvocationEvidenceClass;
  definitionHash?: string;
  normalizerContractVersion?: number;
  definitionVersionId?: string;
  sourceOccurrence?: SourceOccurrence;
  sourcePath?: string;
  sourceModifiedAt?: string;
  capturedAt?: string;
  repositoryFullName?: string;
  repositoryCommit?: string;
  packId?: string;
  branchName?: string;
};

export type AgentComponentInvocationReadPage = {
  items: AgentComponentInvocationReadRow[];
  total: number;
  hasMore: boolean;
  unmatchedCount: number;
  ambiguousCount: number;
};

/**
 * Decimal places carried by the cloud `agent_component_invocations.estimated_cost`
 * column (`numeric(14, 6)`).
 */
const AGENT_COMPONENT_INVOCATION_COST_SCALE = 6;

/** Largest value `numeric(14, 6)` can hold: eight integer digits, six fractional. */
export const AGENT_COMPONENT_INVOCATION_MAX_COST = 99_999_999.999_999;

/** Token counts cross the wire as JSON numbers, so they must stay safe integers. */
export const AGENT_COMPONENT_INVOCATION_MAX_TOKENS = Number.MAX_SAFE_INTEGER;

const AGENT_COMPONENT_INVOCATION_COST_FACTOR =
  10 ** AGENT_COMPONENT_INVOCATION_COST_SCALE;

/**
 * Round a cost to the exact scale the cloud column persists.
 *
 * The generation and part hashes are taken over the item set itself, so a value
 * the database would silently round on write (a seventh decimal place) would
 * come back out different and permanently fail the post-ingest generation-hash
 * reconciliation. Producers canonicalize before hashing and the ingest boundary
 * rejects anything that is not already canonical, so the two never disagree.
 */
export function canonicalAgentComponentInvocationCost(value: number): number {
  return (
    Math.round(value * AGENT_COMPONENT_INVOCATION_COST_FACTOR) /
    AGENT_COMPONENT_INVOCATION_COST_FACTOR
  );
}

/** True when a cost is finite, in range, and already at the persisted scale. */
export function isCanonicalAgentComponentInvocationCost(
  value: number
): boolean {
  return (
    Number.isFinite(value) &&
    value >= 0 &&
    value <= AGENT_COMPONENT_INVOCATION_MAX_COST &&
    canonicalAgentComponentInvocationCost(value) === value
  );
}

/**
 * The subagent-turn usage keys. Both Prisma schemas define these as
 * subagent-only ("a subagent invocation carries the model it ran and that
 * turn's usage; other kinds leave them NULL"), so the ingest boundary rejects
 * them on any other kind and the producer omits them there.
 * `footprintTokens` is deliberately absent: it is kind-agnostic.
 */
export const AGENT_COMPONENT_INVOCATION_SUBAGENT_USAGE_KEYS = [
  "model",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "estimatedCost",
] as const;

/** Every per-invocation telemetry key, whatever population it belongs to. */
export const AGENT_COMPONENT_INVOCATION_TELEMETRY_KEYS = [
  ...AGENT_COMPONENT_INVOCATION_SUBAGENT_USAGE_KEYS,
  "footprintTokens",
] as const;

/** True when the item carries any subagent-turn usage value. */
export function hasAgentComponentInvocationSubagentUsage(
  item: Partial<AgentComponentInvocationSyncItem>
): boolean {
  return AGENT_COMPONENT_INVOCATION_SUBAGENT_USAGE_KEYS.some(
    (key) => item[key] !== undefined
  );
}

/** True when the item carries any per-invocation telemetry value at all. */
export function hasAgentComponentInvocationTelemetry(
  item: Partial<AgentComponentInvocationSyncItem>
): boolean {
  return AGENT_COMPONENT_INVOCATION_TELEMETRY_KEYS.some(
    (key) => item[key] !== undefined
  );
}

/**
 * The protocol version a part carrying `items` must declare.
 *
 * Derived from the items themselves so producer and boundary agree without
 * negotiation: a telemetry-free part stays v1 and an older API accepts it
 * exactly as today, while a telemetry-carrying part declares v2 and an older API
 * answers the retryable `protocol_unsupported` instead of dead-lettering it.
 */
export function agentComponentInvocationSyncProtocolVersionForItems(
  items: readonly Partial<AgentComponentInvocationSyncItem>[]
): AgentComponentInvocationSyncProtocolVersion {
  return items.some(hasAgentComponentInvocationTelemetry)
    ? AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION
    : AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION;
}

/**
 * ISS-4976 (@thadeusb review): whether `value` is a protocol version THIS build
 * participates in — the SET, never one scalar.
 *
 * The single canonical membership test, so every gate that has to answer "can I
 * handle this version?" reads the same tuple the producer picks from
 * ({@link agentComponentInvocationSyncProtocolVersionForItems}) and the two
 * cannot drift. Both directions matter and they fail differently:
 *
 * - Comparing against ONE constant makes a version this build EMITS look
 *   foreign. That is how the desktop outbox loader dropped every v2
 *   (telemetry-carrying) part it had just written — local data loss, before the
 *   wire, with no old peer involved.
 * - Accepting ANY number defeats the quarantine. A corrupt row, or a row a
 *   FUTURE build wrote that this one cannot interpret, must still be turned
 *   away (root AGENTS.md: unknown values degrade gracefully — the API answers
 *   the retryable `protocol_unsupported`, the outbox quarantines the row —
 *   rather than being waved through as if understood).
 */
export function isSupportedAgentComponentInvocationSyncProtocolVersion(
  value: unknown
): value is AgentComponentInvocationSyncProtocolVersion {
  return AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS.some(
    (version) => version === value
  );
}
