/**
 * ISS-12552 (PRD-800): the attribution evidence contract. It records what a
 * session actually did to an artifact, proven from operation evidence rather
 * than from where a slug appeared in a transcript.
 *
 * PRD-801 and PRD-802 pin {@link ATTRIBUTION_CONTRACT_VERSION} when they adopt
 * it. The Zod boundary lives in `attribution-evidence-schema.ts` so a
 * `"use client"` surface can import these values without the parsers.
 */

/** The published contract version. Bump only for a breaking shape change. */
export const ATTRIBUTION_CONTRACT_VERSION = 1 as const;

/**
 * Wire prefix of an operation id. The database stores the bare uuid; the wire
 * form is `clop_<uuid>`, so a scan of tool or shell output can never mistake
 * an artifact UUID for an operation id.
 */
export const OPERATION_ID_PREFIX = "clop_" as const;

/**
 * Request headers `apps/mcp` sends with each write and `apps/api` honors only
 * alongside a valid internal secret. Lowercase, as `Headers.get` reads them.
 */
export const OperationEvidenceHeader = {
  /** Marks the request as coming from the Closedloop MCP server. */
  McpClient: "x-closedloop-client",
  /** The harness's per-call id from `tools/call` `_meta`. */
  ClientCallId: "x-closedloop-client-call-id",
  /** `computeRequestFingerprint` over the tool name and arguments. */
  RequestFingerprint: "x-closedloop-request-fingerprint",
} as const;

/** The value of {@link OperationEvidenceHeader.McpClient}. */
export const MCP_CLIENT_HEADER_VALUE = "mcp" as const;

/**
 * Ceiling on operation claims a Desktop sends per session, matching
 * `MAX_SYNCED_ARTIFACT_REFS`. Claims past it are counted in coverage, never
 * silently dropped.
 */
export const MAX_SYNCED_OPERATION_CLAIMS = 500 as const;

/** What a session did to an artifact, as proven by its evidence. */
export const AttributionRelationshipKind = {
  /** Named in prose, a URL, a prompt, or a result the operation did not target. */
  Reference: "reference",
  /** A successful read, list, or search of the artifact. */
  Usage: "usage",
  /** A committed create that persisted the artifact. */
  Creation: "creation",
  /** A committed update that changed content or a persisted field. */
  Revision: "revision",
  /** A persisted comment or review, separate from writing. */
  CommentReview: "commentReview",
  /** Repository work on the branch or PR that implements an issue. */
  Implementation: "implementation",
  /** An operation whose outcome could not be proven. Never classified. */
  Unresolved: "unresolved",
} as const;
export type AttributionRelationshipKind =
  (typeof AttributionRelationshipKind)[keyof typeof AttributionRelationshipKind];

/**
 * The outcome a write response's public `operationReceipt` reports. Clients
 * treat it as open-ended: a value they do not know reads as unknown (see
 * `parseOperationReceiptOutcome`), never as an error.
 */
export const OperationReceiptOutcome = {
  Committed: "committed",
  NoOp: "noOp",
  Rejected: "rejected",
} as const;
export type OperationReceiptOutcome =
  (typeof OperationReceiptOutcome)[keyof typeof OperationReceiptOutcome];

/**
 * The internal outcome of one operation as the evidence pipeline knows it. A
 * superset of {@link OperationReceiptOutcome}; these states never appear on a
 * write response.
 */
export const OperationEvidenceOutcome = {
  ...OperationReceiptOutcome,
  Errored: "errored",
  Canceled: "canceled",
  MissingResult: "missingResult",
  Truncated: "truncated",
  Ambiguous: "ambiguous",
  AwaitingReceipt: "awaitingReceipt",
  DuplicateInLineage: "duplicateInLineage",
} as const;
export type OperationEvidenceOutcome =
  (typeof OperationEvidenceOutcome)[keyof typeof OperationEvidenceOutcome];

/** The kind of operation, from the tool or route semantics, never its name. */
export const OperationKind = {
  Read: "read",
  List: "list",
  Search: "search",
  Create: "create",
  CreateVersion: "createVersion",
  UpdateFields: "updateFields",
  Comment: "comment",
  LinkCreate: "linkCreate",
  LinkDelete: "linkDelete",
  Tag: "tag",
  Untag: "untag",
  Attach: "attach",
  Detach: "detach",
  Move: "move",
  ProjectWrite: "projectWrite",
  /** ISS-12552 (PRD-800): an API-key delete of the target artifact. */
  Delete: "delete",
  /** ISS-12552: an API-key rating of the target artifact. */
  Rate: "rate",
  /**
   * ISS-12552: an API-key reset of the target document's live draft to its
   * latest version, carrying that version. Audit only (Daveth, 2026-10-22):
   * the classifier never treats it as a revision.
   */
  LiveDraftReset: "liveDraftReset",
  /**
   * ISS-12552 (PRD-800 "Writes made outside the Closedloop MCP"): API-key
   * writes with no artifact target, each named for what it wrote. No MCP tool
   * makes one, so no transcript claim ever carries one and the classifier
   * gives them no evidence.
   */
  DesktopSync: "desktopSync",
  Telemetry: "telemetry",
  SettingsWrite: "settingsWrite",
  OrganizationWrite: "organizationWrite",
  LoopWrite: "loopWrite",
  SessionMeshWrite: "sessionMeshWrite",
  Unsupported: "unsupported",
} as const;
export type OperationKind = (typeof OperationKind)[keyof typeof OperationKind];

/** Where the evidence for an operation came from. */
export const OperationSource = {
  /** An API-key write that arrived through the Closedloop MCP server. */
  Mcp: "mcp",
  /** An API-key write that arrived directly. */
  Api: "api",
  /** A shell or script call whose output printed an operation id. */
  Shell: "shell",
  /** A transcript observation with no server record, such as a read. */
  TranscriptOnly: "transcriptOnly",
  /** History corroborated from persisted records by the backfill. */
  HistoricalRecord: "historicalRecord",
  /** Repository write evidence, such as branch write participation. */
  Repository: "repository",
} as const;
export type OperationSource =
  (typeof OperationSource)[keyof typeof OperationSource];

/** Why an operation stays unresolved instead of classified. */
export const UnresolvedReason = {
  MissingResult: "missingResult",
  SourceTruncated: "sourceTruncated",
  AmbiguousToolId: "ambiguousToolId",
  AwaitingReceipt: "awaitingReceipt",
  UnresolvedTarget: "unresolvedTarget",
  NoSessionOwner: "noSessionOwner",
  MultipleCandidates: "multipleCandidates",
  Errored: "errored",
  Canceled: "canceled",
  Rejected: "rejected",
  NoOp: "noOp",
  DuplicateInLineage: "duplicateInLineage",
  UnsupportedOperation: "unsupportedOperation",
} as const;
export type UnresolvedReason =
  (typeof UnresolvedReason)[keyof typeof UnresolvedReason];

/** Canonical token categories shared by numerator and denominator. */
export const UsageTokenCategory = {
  Input: "input",
  Output: "output",
  CacheRead: "cacheRead",
  CacheWrite: "cacheWrite",
} as const;
export type UsageTokenCategory =
  (typeof UsageTokenCategory)[keyof typeof UsageTokenCategory];

/** How a usage unit was proven to belong to a recipient. */
export const UsageAssociationMethod = {
  /** The request's tool call has a server receipt committing the write. */
  RequestReceipt: "requestReceipt",
  AgentPhaseRun: "agentPhaseRun",
  WorkItemRef: "workItemRef",
} as const;
export type UsageAssociationMethod =
  (typeof UsageAssociationMethod)[keyof typeof UsageAssociationMethod];

/** Artifact identity: organization plus canonical id and the observed alias. */
export type AttributionArtifactIdentity = {
  organizationId?: string;
  artifactId?: string;
  artifactType?: string;
  observedSlug?: string;
  observedUuid?: string;
};

/** Operation identity: a stable invocation id, its source, and its outcome. */
export type AttributionOperationIdentity = {
  /** `clop_`-prefixed server receipt id, when a receipt is bound. */
  operationId?: string;
  /** The harness's own tool-call id (Claude `tool_use.id`, Codex `callId`). */
  providerCallId?: string;
  source: OperationSource;
  sessionId?: string;
  agentId?: string;
  operationKind: OperationKind;
  outcome: OperationEvidenceOutcome;
};

/** What the operation durably changed. Attempts and no-ops carry none. */
export type AttributionDurableResult = {
  createdArtifactId?: string;
  versionNumber?: number;
  changedFields?: string[];
  commentId?: string;
  linkId?: string;
  /** Repository output an implementation association points at. */
  repositoryOutput?: { repository: string; headRef: string };
};

/** Where in the evidence an operation was observed. Never transcript text. */
export type AttributionEvidenceAnchor = {
  toolName?: string;
  providerToolUseId?: string;
  recordOrdinal?: number;
};

/** One relationship between a session and an artifact, with its evidence. */
export type AttributionRelationshipEvidence = {
  evidenceId: string;
  kind: AttributionRelationshipKind;
  target: AttributionArtifactIdentity;
  operation?: AttributionOperationIdentity;
  durableResult?: AttributionDurableResult;
  unresolvedReason?: UnresolvedReason;
  anchors?: AttributionEvidenceAnchor[];
};

/** One canonical source usage record. */
export type AttributionUsageIdentity = {
  sourceKey: string;
  sessionId: string;
  agentId?: string;
  model: string;
  category: UsageTokenCategory;
  tokens: number;
  occurredAt: string;
  priced: boolean;
};

/** Evidence linking a usage unit to an eligible recipient and phase. */
export type AttributionUsageAssociation = {
  sourceKey: string;
  recipientKey: string;
  phase: string;
  evidenceId: string;
  method: UsageAssociationMethod;
  limitation?: string;
};

/** Measured, proven, estimated, and missing quantities, kept distinct. */
export type AttributionCoverage = {
  measuredTokens: number;
  provenTokens: number;
  estimatedTokens: number;
  unattributedTokens: number;
  /** Tokens allocated with no cost: their events carry no price. */
  unpricedTokens: number;
  /**
   * PRD-800 'Allocation total and session cost': the allocated
   * per-event cost in micro-dollars, the sum of each priced event's stored
   * cost. Absent when no event is priced.
   */
  allocatedCostMicros?: number;
  /**
   * PRD-800: the session's own stored cost minus the allocated
   * per-event cost, in micro-dollars. Reported, never folded into the shares;
   * absent when either cost is unknown.
   */
  sessionCostGapMicros?: number;
  unresolvedOperations: number;
  unsupportedOperations: number;
  extractionComplete: boolean;
};

/** Versions and time that let consumers replace, not append, projections. */
export type AttributionRevision = {
  contractVersion: number;
  policyVersion: number;
  extractorVersion: number;
  effectiveAt?: string;
};

/**
 * The public receipt on an API-key write response. Limited to an identity and
 * an outcome by the PRD-800 "Long-lived interfaces" ruling.
 */
export type OperationReceipt = {
  operationId: string;
  outcome: string;
};

/**
 * Evidence carried on a SESSION row of `list-artifact-links`. Absent evidence
 * is absent: the row omits this object rather than defaulting a class.
 */
export type SessionLinkAttributionEvidence = {
  contractVersion: number;
  policyVersion: number;
  extractorVersion: number;
  relationshipKind: AttributionRelationshipKind;
  operations: SessionLinkAttributionOperation[];
};

/** One operation behind a SESSION row's relationship kind. */
export type SessionLinkAttributionOperation = {
  operationId?: string;
  relationshipKind: AttributionRelationshipKind;
  operationKind: OperationKind;
  outcome: OperationEvidenceOutcome;
  durableResult?: AttributionDurableResult;
};

const OPERATION_ID_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The wire form of a receipt row id. */
export function formatOperationId(receiptId: string): string {
  return `${OPERATION_ID_PREFIX}${receiptId}`;
}

/**
 * The receipt row id inside a wire operation id, or null when the value is not
 * a well-formed `clop_<uuid>`.
 */
export function parseOperationId(value: string): string | null {
  if (!value.startsWith(OPERATION_ID_PREFIX)) {
    return null;
  }
  const receiptId = value.slice(OPERATION_ID_PREFIX.length).toLowerCase();
  return OPERATION_ID_UUID.test(receiptId) ? receiptId : null;
}

const KNOWN_RECEIPT_OUTCOMES: readonly string[] = Object.values(
  OperationReceiptOutcome
);

function isOperationReceiptOutcome(
  value: string
): value is OperationReceiptOutcome {
  return KNOWN_RECEIPT_OUTCOMES.includes(value);
}

/** A receipt outcome a client knows, or `"unknown"` for any other value. */
export function parseOperationReceiptOutcome(
  value: string
): OperationReceiptOutcome | "unknown" {
  return isOperationReceiptOutcome(value) ? value : "unknown";
}
