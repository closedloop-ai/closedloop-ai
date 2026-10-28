import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import type { AgentSessionFieldMutationError } from "@repo/api/src/types/agent-session-field-mutation";
import { AGENT_SESSION_RENAME_REQUEST_MAX_BYTES } from "@repo/api/src/types/agent-session-rename";
import {
  AGENT_SESSION_ROW_FIELD_EDIT,
  AgentSessionPatchField,
} from "@repo/api/src/types/artifact-row-field-edit";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { Priority } from "@repo/api/src/types/common";
import { unguardedGuardMessage } from "@repo/api/src/types/optimistic-write-guard";
import { isArtifactPriorityEditSurface } from "@repo/api/src/types/priority-contract";
import { Status, type StatusCode } from "@repo/api/src/types/result";
import { ArtifactType, withDb } from "@repo/database";
import { artifactBulkPriorityService } from "@/app/documents/artifact-bulk-priority-service";
import { singlePriorityReceiptRecorder } from "@/app/documents/single-priority-receipt";
import {
  captureSinglePriorityActivity,
  emitSinglePriorityRefusalAnalytics,
  emitSinglePrioritySideEffects,
  type SinglePrioritySideEffectInput,
} from "@/app/documents/single-priority-side-effects";
import { artifactTagPermissionsForAuth } from "@/app/tags/artifact-tag-projection";
import { unsupportedRowFieldError } from "@/lib/artifact-row-field-refusal";
import { getOrgAdminStatus } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { isUuid } from "@/lib/is-uuid";
import { statusMutationErrorResponse } from "@/lib/mutation-error-response";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import {
  badRequestResponse,
  errorResponse,
  type IdRouteParams,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { ARTIFACT_PRIORITY_EDIT_SURFACE_ERROR } from "@/lib/single-artifact-edit-surface";
import { agentSessionsService } from "../service";
import {
  renameForbiddenResponse,
  sessionNotFoundResponse,
} from "../session-mutation-responses";
import {
  groupingFieldsReceiptRecorder,
  sessionFieldsReceiptRecorder,
} from "../session-operation-receipt";
import { sessionRenameService } from "../session-rename-service";
import { sessionWriteService } from "../session-write-service";
import { sanitizedAgentSessionUpdateBodySchema } from "../validators";
import type {
  AgentSessionUpdateRequest,
  AgentSessionUpdateResponse,
} from "../write-contract";
import { firstGuardWithoutItsField } from "./session-update-guards";

// FEA-4155: no `monitoringEnabled` flag gate (see the sibling list route). The
// Sessions surface is always-on now, so opening a session detail must not 403 as
// the winding-down `DESKTOP_AGENT_SESSION_SYNC` flag resolves false. The org
// boundary is the org-scoped `findSessionDetail` read (a session in another org
// still 404s).
export const GET = withAnyAuth<AgentSessionDetail, "/agent-sessions/[id]">(
  async (authContext, _request, params) => {
    const { user } = authContext;
    const { id } = (await params) as Awaited<IdRouteParams["params"]>;
    if (!isUuid(id)) {
      return notFoundResponse("Agent session");
    }
    const session = await agentSessionsService.findSessionDetail({
      id,
      organizationId: user.organizationId,
      // ISS-10995: the Details tab's Tags row needs the relation AND the
      // capabilities, from the same scopes `/entity-tags` enforces, exactly as
      // the sibling list route resolves them. Without this the detail serves
      // neither `tags` nor `tagAvailability` and the row never draws.
      tagPermissions: artifactTagPermissionsForAuth(authContext),
    });

    if (!session) {
      return notFoundResponse("Agent session");
    }

    return successResponse(session);
  }
);

/**
 * PATCH /agent-sessions/[id] — update one session.
 *
 * ISS-8733 reconciled the two writes that landed on this route hours apart. The
 * body is still ISS-8648's, but `name` no longer means what that PR shipped:
 *
 *  • `name` is the RENAME and lands on `session_detail.name_override`
 *    (ISS-8717), never on `artifacts.name`. Ingest rewrites `artifacts.name`
 *    from the collector's derivation on every sync, so a rename stored there is
 *    reverted by the next re-import — which is the defect ISS-8717 exists to
 *    fix. Keeping the two columns apart is also what leaves the collected
 *    placeholder recoverable.
 *  • `status`, `projectId` and `ownerUserId` are the grouping fields, written by
 *    `sessionWriteService.updateSession`. `ownerUserId` writes the artifact
 *    assignee, the session's Owner (ISS-12251 D-1).
 *
 * AUTHORIZATION DIFFERS PER FIELD, deliberately. The grouping fields stay
 * ORG-scoped: any member may re-file a session. The rename is narrower — the
 * session's Owner (the artifact assignee, ISS-12251 D-6) or an ORG ADMIN —
 * because org membership is enough to READ a
 * session and deliberately not enough to rename one (ISS-8711); ISS-8733 added
 * the admin arm so a session is not stranded on an absent owner.
 *
 * `projectId` / `ownerUserId` are TRI-STATE — absent leaves the value alone,
 * `null` clears it, a uuid assigns it — and the uuid is verified against the
 * caller's org before it is written.
 *
 * `status` accepts only the three LIFECYCLE values. The display-only spellings
 * the read side projects (`waiting`, `unknown`, `stale`) are rejected rather
 * than folded, because a UI-driven write that quietly stored `active` for a row
 * the user dropped into "Stale" would be the write lying about what it did.
 *
 * `priority` (ISS-10332) is TRI-STATE the same way — absent leaves, `null`
 * clears — and ORG-scoped like the grouping fields (PLN-2086, ruling 6). It is
 * written by the one canonical priority writer, `artifactBulkPriorityService`,
 * which owns its own transaction, so like `name` it travels ALONE (see
 * {@link MIXED_PRIORITY_BODY_MESSAGE}); `expectedPriority` is its optional
 * optimistic guard. Ingest never writes `artifacts.priority`, so it survives a
 * re-sync.
 *
 * `status` is still rewritten by the desktop ingest's update arm on the next
 * sync of the same run. `projectId` survives: ingest fills a session's project
 * only while it has none (ISS-10995, operator ruling 2026-10-12), and
 * `ownerUserId` is never touched by ingest after create. `name` is the one
 * field that used to share `status`'s fate and no longer does.
 *
 * A body key that is a field of the session ROW but not one of the keys above
 * (`cost`, `harness`, `tags`, …) is refused with `unsupported_field` before
 * anything else is read or written (ISS-9485: never silently dropped). A key
 * the registry does not classify — not a row field at all, or the one gated
 * per-dollar compat alias — is still stripped, for version skew.
 *
 * Status mapping (apps/api/AGENTS.md "Errors as values"):
 *  - 200 — updated
 *  - 400 — `unsupported_field`, Zod failure, a project/owner outside the
 *          caller's org, or a body that pairs `name` with a grouping field
 *          (see {@link MIXED_BODY_MESSAGE})
 *  - 403 — `field_forbidden`: a rename by a caller who is neither the owner
 *          nor an org admin
 *  - 404 — `artifacts_not_found`: no SESSION with that id in the caller's org
 *  - 409 — a guard is stale: `stale_priority` (`expectedPriority`), or the
 *          `AgentSessionFieldMutationErrorCode` of `expectedName`,
 *          `expectedStatus`, `expectedProjectId` or `expectedOwnerUserId`.
 *          ISS-9486: a value the session already holds is never stale, so a
 *          retried write cannot conflict with its own earlier success.
 *  - 413 — body over {@link AGENT_SESSION_RENAME_REQUEST_MAX_BYTES}
 *  - 500 — uncaught service error
 */
export const PATCH = withAnyAuth<
  AgentSessionUpdateResponse,
  "/agent-sessions/[id]"
>(
  withOperationReceipts(
    OperationKind.UpdateFields,
    async (
      { authMethod, user, clerkOrgId, clerkUserId },
      request,
      params,
      receipts
    ) => {
      try {
        const { id } = (await params) as Awaited<IdRouteParams["params"]>;
        const recordFields = sessionFieldsReceiptRecorder(receipts, id);
        const {
          body,
          rawBody,
          errorResponse: parseError,
        } = await parseBody(request, sanitizedAgentSessionUpdateBodySchema, {
          maxBytes: AGENT_SESSION_RENAME_REQUEST_MAX_BYTES,
        });
        const unsupported = unsupportedRowFieldError(
          rawBody,
          AGENT_SESSION_ROW_FIELD_EDIT,
          Object.values(AgentSessionPatchField)
        );
        if (unsupported) {
          return statusMutationErrorResponse(unsupported);
        }
        if (parseError) {
          return parseError;
        }

        const {
          name,
          expectedName,
          priority,
          expectedPriority,
          surface,
          ...groupingFields
        } = body;
        const wantsRename = name !== undefined;
        const mixedBodyMessage = refuseMixedBody(body);
        if (mixedBodyMessage) {
          return badRequestResponse(mixedBodyMessage);
        }

        if (priority !== undefined) {
          const refusal = await writeSessionPriority({
            id,
            user,
            authMethod,
            priority,
            expectedPriority,
            surface,
            recordPriority: singlePriorityReceiptRecorder(receipts, id),
          });
          if (refusal) {
            return refusal;
          }
        }

        if (wantsRename) {
          const renamed = await sessionRenameService.rename(
            {
              id,
              organizationId: user.organizationId,
              actorUserId: user.id,
              authMethod,
              // Resolved from the caller's CLERK MEMBERSHIP, not from the session
              // row, so widening the write predicate never becomes a read-then-write
              // on the thing being written. `getOrgAdminStatus` rather than
              // `requireOrgAdmin` because admin here is a CAPABILITY, not a gate —
              // a non-admin owner is still admitted, so a refusal response from the
              // gate would be wrong. Its own docstring names this case. A Clerk
              // outage resolves to not-admin, which leaves the pre-ISS-8733
              // owner-only rule in force rather than opening the write.
              actorIsOrgAdmin: (
                await getOrgAdminStatus(clerkOrgId, clerkUserId)
              ).isAdmin,
              name,
              ...(expectedName === undefined ? {} : { expectedName }),
              ...(surface === undefined ? {} : { surface }),
            },
            recordFields
          );
          if (!renamed.ok) {
            return renameRefusalResponse(renamed.error);
          }
        }

        // Both tails land here so ONE path shapes the response ISS-8648 published.
        // After a rename `groupingFields` is empty, and the service's no-field arm
        // re-reads the row in the list projection — which is where the rename
        // becomes visible, since `toSessionListItem` prefers `nameOverride`.
        const result = await sessionWriteService.updateSession(
          {
            organizationId: user.organizationId,
            sessionId: id,
            actor: { userId: user.id, authMethod },
            ...(surface === undefined ? {} : { surface }),
            ...groupingFields,
          },
          groupingFieldsReceiptRecorder(recordFields, body)
        );
        if (result.ok) {
          return successResponse(withOperationReceipt(result.value, receipts));
        }
        if (typeof result.error === "object") {
          return statusMutationErrorResponse(result.error);
        }
        if (result.error === Status.NotFound) {
          return sessionNotFoundResponse();
        }
        if (result.error === Status.BadRequest) {
          return badRequestResponse(
            "Unknown project or owner for this organization"
          );
        }
        return errorResponse("Failed to update agent session", result.error);
      } catch (error) {
        return errorResponse("Failed to update agent session", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);

/**
 * REFUSED rather than half-applied. The rename and the grouping fields are two
 * writes against two tables under two authorization rules, and they cannot be
 * committed together without collapsing them into one service. Applying one and
 * reporting the other's refusal would be the endpoint lying about what it
 * stored, so a mixed body is rejected before either write runs. No client sends
 * one: the grid sends grouping fields, the rename control sends a name.
 */
const MIXED_BODY_MESSAGE =
  "Send `name` on its own — a rename and a status/project/owner change cannot be applied together";

/**
 * ISS-10332: the priority write runs in a transaction of its own — this route's
 * since ISS-10993, which the priority service joins — so it cannot commit
 * together with a rename or a grouping write either. Refused for the reason
 * {@link MIXED_BODY_MESSAGE} is, and so is an `expectedPriority` with no
 * `priority` for it to guard.
 */
const MIXED_PRIORITY_BODY_MESSAGE =
  "Send `priority` (with its optional `expectedPriority`) on its own — it cannot be applied together with a rename or a status/project/owner change";

/**
 * The 400 message for a body that pairs writes this route cannot commit
 * together. `surface` is not a write: it is optional receipt provenance for a
 * rename, priority, or grouping-field mutation, so it never counts as a
 * grouping field when this guard decides whether a body mixes writes.
 */
function refuseMixedBody(body: AgentSessionUpdateRequest): string | null {
  const {
    name,
    expectedName,
    priority,
    expectedPriority,
    surface: _surface,
    expectedStatus,
    expectedProjectId,
    expectedOwnerUserId,
    ...groupingFields
  } = body;
  const wantsRename = name !== undefined;
  const hasGroupingFields = Object.keys(groupingFields).length > 0;
  if (wantsRename && hasGroupingFields) {
    return MIXED_BODY_MESSAGE;
  }
  const unguardedGuard = firstGuardWithoutItsField({
    name: [name, expectedName],
    status: [body.status, expectedStatus],
    projectId: [body.projectId, expectedProjectId],
    ownerUserId: [body.ownerUserId, expectedOwnerUserId],
  });
  if (unguardedGuard) {
    return unguardedGuardMessage(unguardedGuard);
  }
  if (priority === undefined) {
    return expectedPriority === undefined ? null : MIXED_PRIORITY_BODY_MESSAGE;
  }
  return wantsRename || hasGroupingFields ? MIXED_PRIORITY_BODY_MESSAGE : null;
}

/** Writes the priority; resolves to the refusal response, or null once written. */
async function writeSessionPriority(input: {
  id: string;
  user: SinglePrioritySideEffectInput["user"];
  authMethod: SinglePrioritySideEffectInput["authMethod"];
  priority: Priority | null;
  expectedPriority: Priority | null | undefined;
  surface: AgentSessionUpdateRequest["surface"];
  recordPriority: RecordWriteInTransaction<{ changed: boolean }> | undefined;
}) {
  if (
    input.surface !== undefined &&
    !isArtifactPriorityEditSurface(input.surface)
  ) {
    return badRequestResponse(ARTIFACT_PRIORITY_EDIT_SURFACE_ERROR);
  }
  const sideEffectInput: Omit<SinglePrioritySideEffectInput, "written"> = {
    user: input.user,
    authMethod: input.authMethod,
    artifactId: input.id,
    artifactType: ArtifactType.SESSION,
    priority: input.priority,
    ...(input.surface === undefined ? {} : { surface: input.surface }),
  };
  // ISS-10993: the priority write and its activity receipt share ONE
  // transaction. `withDb.tx` joins an ambient transaction, so the service's own
  // `withDb.tx` runs on this one and a receipt that cannot be written rolls the
  // priority change back with it.
  const written = await withDb.tx(async (tx) => {
    const result = await artifactBulkPriorityService.updatePriority({
      artifactId: input.id,
      artifactType: ArtifactType.SESSION,
      organizationId: input.user.organizationId,
      priority: input.priority,
      ...(input.expectedPriority === undefined
        ? {}
        : { expectedPriority: input.expectedPriority }),
    });
    if (result.ok) {
      await captureSinglePriorityActivity(tx, {
        ...sideEffectInput,
        written: result.value,
      });
      await input.recordPriority?.(tx, result.value);
    }
    return result;
  });
  if (written.ok) {
    emitSinglePrioritySideEffects({
      ...sideEffectInput,
      written: written.value,
    });
    return null;
  }
  emitSinglePriorityRefusalAnalytics(sideEffectInput, written.error.status);
  if (written.error.status !== Status.NotFound) {
    return statusMutationErrorResponse(written.error);
  }
  // This route's own 404 wording, carrying the envelope every other priority
  // writer answers with.
  return notFoundResponse("Agent session", {
    code: written.error.code,
    ...(written.error.details ? { details: written.error.details } : {}),
  });
}

function renameRefusalResponse(
  error: StatusCode | AgentSessionFieldMutationError
) {
  if (typeof error === "object") {
    return statusMutationErrorResponse(error);
  }
  return error === Status.Forbidden
    ? renameForbiddenResponse()
    : sessionNotFoundResponse();
}
