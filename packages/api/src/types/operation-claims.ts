/**
 * ISS-12552: what Desktop observed a session do, sent
 * with the session as `operationEvidence`. A claim records an observation; it
 * never classifies. The server binds claims to receipts and classifies them.
 */
import type { OperationKind } from "./attribution-evidence.ts";

/**
 * The claim extractor's version, sent on the wire. Bump when the same
 * transcript would yield different claims, so the server re-reconciles.
 */
export const OPERATION_EVIDENCE_EXTRACTOR_VERSION = 4 as const;

/**
 * ISS-12552 (write-to-commit join, PRD-800): the first extractor version that
 * sends `implementationJoin` claims. A snapshot from an older extractor has
 * none, which is not the same as a session whose join placed nothing.
 */
export const IMPLEMENTATION_JOIN_EXTRACTOR_VERSION = 3 as const;

/**
 * Byte budget for a session's serialized claims. `operationEvidence` is not
 * paginated, so it rides every chunk of a session sync request, whose cap is
 * `DESKTOP_AGENT_SESSION_SYNC_REQUEST_MAX_BYTES` (256 KiB); this keeps it under
 * a fifth of every part. Claims past it are dropped references first and
 * counted in `claimsDroppedByCap`.
 */
export const OPERATION_EVIDENCE_MAX_CLAIM_BYTES = 49_152 as const;

/**
 * Candidate requests kept on one ambiguous call, one per open call around it.
 * Past this, the call keeps no candidates and its request is unresolved
 * (`requestUnresolved`).
 */
export const MAX_CANDIDATE_REQUEST_KEYS = 50 as const;

/** Distinct names kept in `unsupportedToolNames`; the rest are not listed. */
export const MAX_UNSUPPORTED_TOOL_NAMES = 50 as const;

/** How much of a tool's result the transcript holds. */
export const ToolResultState = {
  Present: "present",
  Error: "error",
  /** No result was recorded for the call. */
  Missing: "missing",
  /** The harness itself elided part of the result before writing it. */
  SourceTruncated: "sourceTruncated",
} as const;
export type ToolResultState =
  (typeof ToolResultState)[keyof typeof ToolResultState];

/** What kind of observation a claim records. */
export const OperationClaimSource = {
  /** A ClosedLoop MCP tool call. */
  ClosedloopMcp: "closedloopMcp",
  /** A shell call whose output printed `clop_` operation ids. */
  Shell: "shell",
  /** A ClosedLoop slug named in prose or in another tool's text. */
  Reference: "reference",
  /**
   * ISS-12552 (PRD-800): one per branch, the requests
   * the Desktop's write-to-commit join placed on it. The join runs on the
   * Desktop, so no file path leaves the device (Daveth Oakhurst, 2026-10-20).
   */
  ImplementationJoin: "implementationJoin",
} as const;
export type OperationClaimSource =
  (typeof OperationClaimSource)[keyof typeof OperationClaimSource];

/** An artifact a call named, as the harness sent it. */
export type OperationClaimTarget = {
  /** The parameter that named it. */
  key: string;
  slug?: string;
  uuid?: string;
};

/** The record a ClosedLoop tool's response root names. */
export type OperationClaimResultEntity = {
  id?: string;
  slug?: string;
  version?: number;
};

export type OperationClaim = {
  /** Stable per session: harness plus the harness's own call id. */
  claimKey: string;
  /** The call id was missing or repeated, so the key is an ordinal. */
  ambiguous?: boolean;
  source: OperationClaimSource;
  /** The ClosedLoop tool name, for an MCP claim. */
  toolName?: string;
  operationKind?: OperationKind;
  providerCallId?: string;
  inputTargets?: OperationClaimTarget[];
  relatedTargets?: OperationClaimTarget[];
  resultState?: ToolResultState;
  /** Operation ids from a write tool's own response root, or a shell's output. */
  operationIds?: string[];
  primaryResultEntity?: OperationClaimResultEntity;
  nestedReferenceSlugs?: string[];
  /** The slug a reference claim names. */
  referenceSlug?: string;
  /** The branch an implementation-join claim is for. */
  branch?: string;
  /** The requests an implementation-join claim places on its branch. */
  requestKeys?: string[];
  agentId?: string;
  /**
   * ISS-12552 (PRD-800): the model request that issued the call,
   * scheme-qualified, which a usage unit of that request also names.
   */
  requestKey?: string;
  /**
   * ISS-12552 (PRD-800, Daveth Oakhurst 2026-10-20): additive and
   * optional. When the call's request is ambiguous because it ran inside two
   * or more concurrently open Codex calls, the requests of those calls. Never
   * set with `requestKey`; an older Desktop never sends it.
   */
  candidateRequestKeys?: string[];
  /**
   * ISS-12552 (PRD-800 "Proving usage"): additive and optional.
   * The transcript recorded this call's request but not which one: its
   * candidate requests passed MAX_CANDIDATE_REQUEST_KEYS, or a request record
   * around it had no response id. Such a write proves no usage and never falls
   * back to its agent's run; an older Desktop never sends it, and its writes
   * with no request and no candidates keep that fallback.
   */
  requestUnresolved?: true;
  invokedAt?: string;
  resultAt?: string;
  requestFingerprint?: string;
};

/** What the extractor saw and could not, so absence is never read as zero. */
export type OperationEvidenceCoverage = {
  harness: string;
  harnessVersion?: string;
  /** Whether this harness sends a call id a receipt can join on. */
  evidencePathSupported: boolean;
  closedloopMcpCalls: number;
  shellCallsWithOperationIds: number;
  /** Shell commands that call the ClosedLoop API without a printed id. */
  directApiShellCommands: number;
  /** ClosedLoop tools the semantics table does not know, by name. */
  unsupportedToolNames: Record<string, number>;
  claimsDroppedByCap: number;
};

/** The per-session evidence snapshot Desktop syncs. */
export type SessionOperationEvidence = {
  extractorVersion: number;
  digest: string;
  coverage: OperationEvidenceCoverage;
  claims: OperationClaim[];
};
