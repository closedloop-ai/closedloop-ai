/**
 * @file agent-session-write.ts
 * @description The Sessions WRITE contract (ISS-8648 / ISS-8649) — the request
 * and response shapes for `POST /agent-sessions`, `PATCH /agent-sessions/[id]`
 * and `POST /agent-sessions/bulk-assign`.
 *
 * Kept OUT of the sibling `agent-session.ts` on purpose: that module is the
 * read/ingest projection and is already the largest type module on this surface.
 *
 * ## Absent vs. null on an update
 *
 * `projectId` and `ownerUserId` are TRI-STATE on the update and bulk paths, and
 * every consumer must preserve the distinction:
 *
 *   • key OMITTED  — leave the stored value alone.
 *   • `null`       — clear the assignment.
 *   • a uuid       — assign it.
 *
 * That is why these two keys are declared nullable rather than merely optional:
 * per the repo's cross-repo rule an absent optional field is OMITTED, never
 * serialized as `null`, so `null` is free to carry the "unassign" meaning.
 *
 * ## Status
 *
 * A write may only ever carry a {@link SessionStatus} — the three lifecycle
 * values. The three DISPLAY-only spellings (`waiting`, `unknown`, `stale`) are
 * derived per read and no producer originates them, so these endpoints REJECT
 * them at the boundary instead of folding: a UI-driven write that quietly turned
 * "Stale" into `active` would be the write lying about what it stored. This is
 * not a narrowing of the desktop ingest contract, which still accepts-and-folds
 * for version skew — these are new endpoints with no installed clients.
 */

import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import {
  type AgentSessionBulkAssignField as SharedAgentSessionBulkAssignField,
  AgentSessionBulkAssignField as SharedAgentSessionBulkAssignFieldValue,
} from "@repo/api/src/types/agent-session-bulk-assign";
import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { Priority } from "@repo/api/src/types/common";
import type { SessionStatus } from "@repo/api/src/types/session-status";

/**
 * Upper bound on ids accepted by one bulk-assign call. A caller over the bound
 * is REFUSED rather than truncated: silently assigning a prefix of the selection
 * would leave the grid reporting a bulk edit that only partly happened.
 */
export const AGENT_SESSION_BULK_ASSIGN_MAX_IDS = 500;

export const AgentSessionBulkAssignField =
  SharedAgentSessionBulkAssignFieldValue;
export type AgentSessionBulkAssignField = SharedAgentSessionBulkAssignField;

export type AgentSessionCreateRequest = {
  /**
   * The compute target the session belongs to. Required, and org-scoped by the
   * service: a session with no device is not a session, and connecting a
   * caller-supplied target without checking its org would make this endpoint a
   * cross-org write primitive.
   */
  computeTargetId: string;
  /**
   * Caller-owned identity of the run on that compute target. Together with
   * `computeTargetId` it is the same unique key the desktop ingest upserts on,
   * which is what makes a retry idempotent — and what lets a later desktop sync
   * of the same run land on this row rather than creating a second one.
   */
  externalSessionId: string;
  name?: string;
  status?: SessionStatus;
  projectId?: string | null;
  ownerUserId?: string | null;
  harness?: string;
  repositoryFullName?: string | null;
  /** ISO-8601. Defaults to the server clock when omitted. */
  startedAt?: string;
};

export type AgentSessionCreateResponse = {
  /**
   * The created (or already-present) row in the SAME projection the Sessions
   * list renders, so a host can insert it without a refetch.
   */
  session: AgentSessionListItem;
  /**
   * `false` when the `(computeTargetId, externalSessionId)` row already existed
   * and was returned unchanged — the idempotent-retry outcome.
   */
  created: boolean;
};

export type AgentSessionUpdateRequest = {
  name?: string;
  status?: SessionStatus;
  projectId?: string | null;
  ownerUserId?: string | null;
  /** ISS-10332 — TRI-STATE like the two above: omitted leaves, `null` clears. */
  priority?: Priority | null;
  /**
   * The optimistic guard `PUT /documents/{id}` already takes (ISS-9440): refused
   * with `stale_priority` unless the stored priority still equals this, where
   * `null` ASSERTS the session holds none. Omitted keeps last-write-wins. A
   * `priority` the session already holds is never refused (ISS-9486).
   */
  expectedPriority?: Priority | null;
  /**
   * ISS-9486 — one optimistic guard per writable field, each valid only beside
   * the field it guards and each following the `expectedPriority` rules: omitted
   * is unguarded, a stale value is refused with 409 and that field's
   * `AgentSessionFieldMutationErrorCode`, and a value the session already holds
   * is never refused. `null` on the two nullable ones ASSERTS the assignment is
   * unset.
   *
   * `expectedName` is compared with the RENDERED name
   * (`nameOverride ?? artifacts.name`), because that is what a client read.
   */
  expectedName?: string;
  expectedStatus?: SessionStatus;
  expectedProjectId?: string | null;
  expectedOwnerUserId?: string | null;
  /**
   * Where the rename, priority, or grouping-field write originated. Optional
   * telemetry provenance for activity/analytics receipts; omitted and unknown
   * values preserve the older-client behavior, and API-key callers discard it
   * (ISS-9443).
   */
  surface?: ArtifactStatusEditSurface;
};

export type AgentSessionUpdateResponse = {
  session: AgentSessionListItem;
};

export type AgentSessionBulkAssignRequest = {
  sessionIds: string[];
  field: AgentSessionBulkAssignField;
  /** `null` unassigns. A uuid is validated against the caller's org. */
  value: string | null;
};

export type AgentSessionBulkAssignResponse = {
  field: AgentSessionBulkAssignField;
  /**
   * Rows written. Equal to the requested id count on success — a bulk call that
   * cannot write EVERY id is refused whole, so this can never report a partial
   * application.
   */
  assignedCount: number;
  /** The updated rows in the list projection, for grid reconciliation. */
  sessions: AgentSessionListItem[];
};
