/**
 * ISS-9486 — the conflict contract for the per-field optimistic guards on
 * `PATCH /agent-sessions/{id}`: `expectedName`, `expectedStatus`,
 * `expectedProjectId`, `expectedOwnerUserId`. `expectedPriority` keeps its own
 * module (`./artifact-priority-mutation`).
 *
 * One code, one `details` shape, everywhere it is emitted. That is why the
 * status guard REUSES `stale_status` and its `staleStatuses` entries rather than
 * minting a session variant: a client that parses the `PUT /documents/{id}`
 * envelope parses this one. The three fields no other route guards get their
 * own codes in the same shape.
 *
 * Whether an expectation is stale is decided by `./optimistic-write-guard`, so
 * a same-value retry is never a conflict here either.
 */

import type { ArtifactStatusEditSurface } from "./artifact-status-contract.js";
import type { JsonObject } from "./common.ts";
import {
  DocumentStatusMutationErrorCode,
  type DocumentStatusMutationStaleStatus,
  STALE_STATUS_CONFLICT_MESSAGE,
} from "./document-status-mutation.ts";
import { Status, type StatusCode } from "./result.ts";

export const AgentSessionFieldMutationErrorCode = {
  StaleName: "stale_name",
  /** The canonical literal, imported: the envelope is the document route's. */
  StaleStatus: DocumentStatusMutationErrorCode.StaleStatus,
  StaleProjectId: "stale_project_id",
  StaleOwnerUserId: "stale_owner_user_id",
} as const;
export type AgentSessionFieldMutationErrorCode =
  (typeof AgentSessionFieldMutationErrorCode)[keyof typeof AgentSessionFieldMutationErrorCode];

/** Compared against the RENDERED name, `nameOverride ?? artifacts.name`. */
export type AgentSessionStaleName = JsonObject & {
  documentId: string;
  currentName: string;
  expectedName: string;
};

/** `null` on either side is a real value: the session is in no project. */
export type AgentSessionStaleProjectId = JsonObject & {
  documentId: string;
  currentProjectId: string | null;
  expectedProjectId: string | null;
};

/** `null` on either side is a real value: the session has no owner. */
export type AgentSessionStaleOwnerUserId = JsonObject & {
  documentId: string;
  currentOwnerUserId: string | null;
  expectedOwnerUserId: string | null;
};

export type AgentSessionFieldMutationErrorDetails = JsonObject & {
  staleNames?: AgentSessionStaleName[];
  staleStatuses?: DocumentStatusMutationStaleStatus[];
  staleProjectIds?: AgentSessionStaleProjectId[];
  staleOwnerUserIds?: AgentSessionStaleOwnerUserId[];
};

export type AgentSessionFieldMutationError = {
  status: StatusCode;
  code: AgentSessionFieldMutationErrorCode;
  message: string;
  details: AgentSessionFieldMutationErrorDetails;
};

/** The stale guards of one refused write; a key is set only for a stale field. */
export type AgentSessionStaleFields = {
  name?: AgentSessionStaleName;
  status?: DocumentStatusMutationStaleStatus;
  projectId?: AgentSessionStaleProjectId;
  ownerUserId?: AgentSessionStaleOwnerUserId;
};

/**
 * The one 409 for a refused session field write, or `null` when no guard was
 * stale. A grouping write can fail several guards at once: `code` names the
 * first in the order the fields are listed here, and `details` carries every
 * one, so a client that sent three guards learns about all three.
 */
export function staleSessionFieldsConflict(
  stale: AgentSessionStaleFields
): AgentSessionFieldMutationError | null {
  const first = firstStaleField(stale);
  if (!first) {
    return null;
  }
  return {
    status: Status.Conflict,
    code: first.code,
    message: first.message,
    details: {
      ...(stale.name ? { staleNames: [stale.name] } : {}),
      ...(stale.status ? { staleStatuses: [stale.status] } : {}),
      ...(stale.projectId ? { staleProjectIds: [stale.projectId] } : {}),
      ...(stale.ownerUserId ? { staleOwnerUserIds: [stale.ownerUserId] } : {}),
    },
  };
}

function firstStaleField(
  stale: AgentSessionStaleFields
): { code: AgentSessionFieldMutationErrorCode; message: string } | null {
  if (stale.name) {
    return {
      code: AgentSessionFieldMutationErrorCode.StaleName,
      message: "One or more sessions changed before the name update",
    };
  }
  if (stale.status) {
    return {
      code: AgentSessionFieldMutationErrorCode.StaleStatus,
      message: STALE_STATUS_CONFLICT_MESSAGE,
    };
  }
  if (stale.projectId) {
    return {
      code: AgentSessionFieldMutationErrorCode.StaleProjectId,
      message: "One or more sessions changed before the project update",
    };
  }
  if (stale.ownerUserId) {
    return {
      code: AgentSessionFieldMutationErrorCode.StaleOwnerUserId,
      message: "One or more sessions changed before the owner update",
    };
  }
  return null;
}

/**
 * ISS-8718 — the request body for a session RENAME: the subset of the session
 * update contract the route accepts for a rename ALONE. It refuses a body that
 * pairs `name` with a priority or a grouping field (PLN-2086 Milestone 1), so
 * the rename and priority writes cannot share one request.
 *
 * It lives here rather than beside the data source because two sides read it:
 * `packages/app`'s `renameSession` port, and the desktop main process's cloud
 * bridge, which builds a `.strict()` body gate `satisfies Record<keyof …>` over
 * it so a key added to this contract fails `tsc` at the bridge rather than
 * being silently refused at runtime.
 *
 * `expectedName` is the optimistic guard, compared server-side with the
 * RENDERED name (`nameOverride ?? artifacts.name`); omitted is unguarded.
 */
export type RenameAgentSessionRequest = {
  name: string;
  expectedName?: string;
  surface?: ArtifactStatusEditSurface;
};

/**
 * ISS-10995 — the request body for reassigning a session's PROJECT alone, which
 * `PATCH /agent-sessions/[id]` has owned since ISS-8648
 * (`AGENT_SESSION_ROW_FIELD_EDIT.project` is
 * `AgentSessionPatchField.ProjectId`). The Details row writes through
 * `POST /artifact-links/batch-move`, so one field has one writer across both
 * artifact types (operator ruling 2026-10-12); this contract is the route's,
 * kept for the clients already on it.
 *
 * The sibling of {@link RenameAgentSessionRequest}, and here for the same
 * reason: two sides read it, `packages/app`'s write port and the desktop cloud
 * bridge, which builds a `.strict()` body gate `satisfies Record<keyof …>` over
 * it so a key added here fails `tsc` at the bridge instead of being refused at
 * runtime.
 *
 * `null` clears the project — this route is tri-state, unlike `batch-move`,
 * whose `targetProjectId` is `z.uuid()`. `expectedProjectId` is the optimistic
 * guard, compared server-side; omitted is unguarded, and a same-value retry is
 * not a conflict ({@link staleSessionFieldsConflict}).
 */
export type ReassignAgentSessionProjectRequest = {
  projectId: string | null;
  expectedProjectId?: string | null;
};
