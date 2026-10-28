// Shared audit-ledger contract constants (FEA-3856 / FEA-3799 Phase 1 Slice 1a).
//
// Used by the apps/api ledger and emit services and by the `verify-audit-ledger`
// MCP tool, so it lives in packages/api rather than co-located in apps/api.
// Slice 1a shipped the actor-type enum and the genesis prev-hash sentinel;
// FEA-3862 added the emit points (`AuditAction`) and the verify endpoint.

/**
 * The kind of principal that produced an audit entry.
 *
 * Recorded as a free column (no FK) so a `system` or future `agent` actor id
 * does not require the Phase-2 per-agent key table to exist. Phase 1 attributes
 * Clerk / api-key / desktop-session writes as `user` and unattributed internal
 * paths as `system`; signed `agent` attribution lands in Phase 2.
 */
export const AuditActorType = {
  User: "user",
  Agent: "agent",
  System: "system",
} as const;

export type AuditActorType =
  (typeof AuditActorType)[keyof typeof AuditActorType];

export const AUDIT_ACTOR_TYPES = [
  AuditActorType.User,
  AuditActorType.Agent,
  AuditActorType.System,
] as const;

/**
 * Genesis `prevHash` for the first entry in an organization's chain: 32 zero
 * bytes rendered as lowercase hex (64 chars). Matches the ledger hashing helper
 * in apps/api/app/audit/audit-ledger-service.ts.
 */
export const AUDIT_GENESIS_PREV_HASH = "0".repeat(64);

/**
 * The kind of object an audit entry describes. A free column (no FK), so the
 * ledger can attribute an action to any domain record without a schema
 * dependency. `objectId` is the record's id within that type.
 */
export const AuditObjectType = {
  Document: "document",
  ApiKey: "api_key",
  Project: "project",
  /**
   * Any artifact row, whatever its subtype. `document` stays the type for a
   * route whose own subject is a document; this one is for the routes that act
   * on artifacts of any subtype — `POST /artifact-links/batch-move` walks a
   * link graph that carries branches and deployments, and `POST
   * /entity-tags/batch` tags whatever the id resolves to (ISS-9465).
   */
  Artifact: "artifact",
  /**
   * An agent session. The object type `bulk-assign` has recorded its owner
   * assignments under since ISS-9465, when the owner lived on
   * `session_detail`. ISS-12251 moved the owner onto the artifact assignee; the
   * object type is kept so `agent_session.assigned` keeps one shape.
   */
  AgentSession: "agent_session",
} as const;

export type AuditObjectType =
  (typeof AuditObjectType)[keyof typeof AuditObjectType];

/**
 * The action an audit entry records. Free-form text on the wire (the `action`
 * column is `TEXT`), but every emit point in the platform must reference one of
 * these constants so the vocabulary stays a single source of truth. Values are
 * `<object>.<verb>` and are stable — they are hashed into the chain, so
 * renaming one rewrites history. Add, never rename.
 *
 * The `<object>` half must match the entry's `AuditObjectType`, which is why a
 * project move by `POST /documents/batch-move` and one by
 * `POST /artifact-links/batch-move` share `artifact.project_changed`: one event
 * kind, one member, and a document row is an artifact row.
 */
export const AuditAction = {
  DocumentStatusChanged: "document.status_changed",
  DocumentDeleted: "document.deleted",
  ApiKeyMinted: "api_key.minted",
  ApiKeyRevoked: "api_key.revoked",
  // ISS-9688. A project's status and priority were audited nowhere: the ledger
  // only ever described documents and api keys, so a user re-prioritizing a
  // project left no entry at all. That ticket withheld the same member from an
  // artifact's priority; ISS-9465 ruling 6 reversed it for the bulk path, so
  // `DocumentPriorityChanged` below is the artifact counterpart.
  ProjectStatusChanged: "project.status_changed",
  ProjectPriorityChanged: "project.priority_changed",
  // ISS-9465 introduced these actions for bulk routes. ISS-10681 and ISS-10686
  // reuse the same members for equivalent single-artifact mutations so each
  // action keeps one stable ledger vocabulary and detail shape.
  DocumentPriorityChanged: "document.priority_changed",
  ArtifactProjectChanged: "artifact.project_changed",
  ArtifactTagApplied: "artifact.tag_applied",
  ArtifactTagRemoved: "artifact.tag_removed",
  AgentSessionAssigned: "agent_session.assigned",
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/**
 * Head of an organization's audit chain: the highest `seq` and its `hash`. An
 * organization with no entries yet returns the empty sentinel (`seq: 0`,
 * `hash: AUDIT_GENESIS_PREV_HASH`) so callers can treat "empty chain" and
 * "populated chain" uniformly.
 */
export type AuditChainHead = {
  seq: string;
  hash: string;
};

/**
 * Empty-chain sentinel for `AuditChainHead`: `seq: "0"` and the genesis hash.
 * `seq` is a string because a chain's real `seq` is a BigInt that does not
 * survive JSON — the REST/MCP contract carries it as a decimal string.
 */
export const AUDIT_EMPTY_CHAIN_HEAD: AuditChainHead = {
  seq: "0",
  hash: AUDIT_GENESIS_PREV_HASH,
};

/**
 * Wire result of verifying an organization's chain (REST `POST /audit/verify`
 * and the MCP tool). `ok: true` means every row recomputes and links;
 * `ok: false` reports the `seq` (decimal string) of the first broken row and a
 * machine-readable reason.
 */
export type AuditVerifyResult =
  | { ok: true; head: AuditChainHead }
  | { ok: false; brokenAtSeq: string; reason: string };
