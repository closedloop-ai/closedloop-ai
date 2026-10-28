import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import {
  getNotificationEntityPath,
  NotificationEntityKind,
} from "@repo/api/src/types/notification-routes";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { Status } from "@repo/api/src/types/result";
import { AssignmentEntityType } from "@repo/collaboration/server/inbox-notifications";
import { userAuditActor } from "@/app/audit/audit-emit-service";
import { dispatchAssignmentNotification } from "@/lib/assignment-notifications";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveProjectId } from "@/lib/identifier-utils";
import { statusMutationErrorResponse } from "@/lib/mutation-error-response";
import {
  type OperationReceiptRecorder,
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import { writeInShape } from "@/lib/record-write-in-transaction";

import {
  badRequestResponse,
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { applyProjectCustomFieldsInTransaction } from "../../custom-fields/project-custom-field-values";
import {
  applyCustomFieldsOrErrorResponse,
  customFieldsPreflightResponse,
  customFieldWriteErrorResponse,
  mergeCustomFieldsIntoResponse,
} from "../../custom-fields/route-helpers";
import { dispatchProjectChangeAuditEvents } from "../project-change-audit";
import { projectDeleteReceiptWrite } from "../project-operation-receipt";
import { projectUpdateReceiptWrite } from "../project-update-receipt";
import {
  InvalidProjectTeamsError,
  InvalidProjectTeamsReason,
  projectsService,
} from "../service";
import {
  TeamRequirementVerb,
  teamRequirementErrorResponse,
  unresolvedTeamErrorResponse,
} from "../team-requirement";
import { updateProjectValidator } from "../validators";

/**
 * GET /projects/:id - Get a single project by ID
 */
export const GET = withAnyAuth<ProjectWithDetails, "/projects/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveProjectId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Project");
      }

      const project = await projectsService.findById(
        resolvedId,
        user.organizationId
      );

      if (!project) {
        return notFoundResponse("Project");
      }

      const response = await mergeCustomFieldsIntoResponse(
        project,
        CustomFieldEntityType.Project,
        user.organizationId
      );

      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch project", error);
    }
  }
);

/**
 * PUT /projects/:id - Update a project
 */
export const PUT = withAnyAuth<ProjectWithDetails, "/projects/[id]">(
  withOperationReceipts(
    OperationKind.ProjectWrite,
    async ({ user }, request, params, receipts) => {
      try {
        const { id } = await params;
        const resolvedId = await resolveProjectId(id, user.organizationId);
        if (!resolvedId) {
          return notFoundResponse("Project");
        }

        const {
          body,
          rawBody,
          errorResponse: parseError,
          issues,
        } = await parseBody(request, updateProjectValidator);
        if (parseError) {
          return (
            (await teamRequirementErrorResponse({
              issues,
              rawBody,
              organizationId: user.organizationId,
              verb: TeamRequirementVerb.Update,
            })) ?? parseError
          );
        }

        const { customFields, ...projectInput } = body;

        const existing = await projectsService.findById(
          resolvedId,
          user.organizationId
        );
        if (!existing) {
          return notFoundResponse("Project");
        }

        // Ahead of the project write, so a bad value is refused before the
        // project row is locked, and because unrecorded (as on main) a
        // custom-field failure after it would return a 400 for an update that
        // had already committed.
        const customFieldsPreflight = await customFieldsPreflightResponse(
          customFields,
          resolvedId,
          CustomFieldEntityType.Project,
          user.organizationId
        );
        if (customFieldsPreflight) {
          return customFieldsPreflight;
        }

        // ISS-12552: recorded, the custom fields apply on the project
        // write's own transaction, so a refused value rolls the whole update
        // back and the one receipt names every column and value that moved.
        // Unrecorded, they apply after the commit below, as on main.
        const recordUpdate = projectUpdateRecord(
          receipts,
          customFields,
          resolvedId,
          user.organizationId
        );
        const updateResult = await projectsService.update(
          resolvedId,
          user.organizationId,
          projectInput,
          recordUpdate
        );
        if (!updateResult.ok) {
          return updateResult.error.status === Status.Conflict
            ? statusMutationErrorResponse(updateResult.error)
            : badRequestResponse(updateResult.error.message);
        }
        const { project: updated, previous } = updateResult.value;

        // No before-image means the locked row was not there to update, which is
        // the same answer as no project.
        if (!(updated && previous)) {
          return notFoundResponse("Project");
        }

        // ISS-9688: record the status/priority transition on the audit ledger.
        //
        // Both halves of the diff come from ONE transaction: `previous` is the
        // `FOR UPDATE`-locked before-image and `updated` is that same
        // transaction's written row, so no concurrent PUT can be attributed to
        // this actor (#7225 review, whitlockk and codex). A field re-saved at the
        // value it already held emits nothing. Non-blocking and best-effort — the
        // helper enqueues onto the durable outbox via `waitUntil` and never
        // throws, so the ledger can neither fail nor delay the update that
        // already committed.
        dispatchProjectChangeAuditEvents({
          organizationId: user.organizationId,
          projectId: updated.id,
          actor: userAuditActor(user.id),
          before: { status: previous.status, priority: previous.priority },
          after: { status: updated.status, priority: updated.priority },
        });

        // Unrecorded: main's place for the custom fields, after the project
        // committed and its audit was dispatched, so a refusal here answers
        // 400 for an update that already committed (ISS-12552 flag-off
        // parity).
        const customFieldsFailure = await writeInShape(recordUpdate, {
          unrecorded: () =>
            applyCustomFieldsOrErrorResponse(
              customFields,
              resolvedId,
              CustomFieldEntityType.Project,
              user.organizationId
            ),
          recorded: () => Promise.resolve(null),
        });
        if (customFieldsFailure) {
          return customFieldsFailure;
        }

        // Fetch updated project with details
        const projectWithDetails = await projectsService.findById(
          resolvedId,
          user.organizationId
        );

        if (!projectWithDetails) {
          return errorResponse(
            "Project updated but could not be retrieved",
            new Error("Project not found")
          );
        }

        const teamId = projectWithDetails.teams[0]?.id;
        if (teamId) {
          dispatchAssignmentNotification({
            previousAssigneeId: existing.assigneeId,
            newAssigneeId: projectInput.assigneeId,
            actorUserId: user.id,
            organizationId: user.organizationId,
            entityType: AssignmentEntityType.Project,
            entityTitle: projectWithDetails.name,
            entityUrl: getNotificationEntityPath({
              kind: NotificationEntityKind.Project,
              teamId,
              projectId: projectWithDetails.id,
            }),
            subjectId: projectWithDetails.id,
          });
        }

        return successResponse(
          withOperationReceipt(projectWithDetails, receipts)
        );
      } catch (error) {
        return await projectUpdateErrorResponse(error, user.organizationId);
      }
    }
  ),
  { requiredScopes: ["write"] }
);

/**
 * DELETE /projects/:id - Delete a project
 */
export const DELETE = withAnyAuth<{ deleted: true }, "/projects/[id]">(
  withOperationReceipts(
    OperationKind.ProjectWrite,
    async ({ user }, _, params, receipts) => {
      try {
        const { id } = await params;
        const resolvedId = await resolveProjectId(id, user.organizationId);
        if (!resolvedId) {
          return notFoundResponse("Project");
        }

        await projectsService.delete(
          resolvedId,
          user.organizationId,
          receipts.whenRecording((tx) =>
            receipts.record(tx, projectDeleteReceiptWrite())
          )
        );
        return deleteResponse(receipts.receipt);
      } catch (error) {
        return errorResponse("Failed to delete project", error);
      }
    }
  ),
  { requiredScopes: ["delete"] }
);

/**
 * The project update's record: its custom fields applied on the project
 * write's transaction, then the one receipt naming every column and value that
 * moved. Undefined for a request that gets no receipt.
 */
function projectUpdateRecord(
  receipts: OperationReceiptRecorder,
  customFields: Record<string, string | number | string[] | null> | undefined,
  projectId: string,
  organizationId: string
) {
  return receipts.whenRecording<{ changedFields: string[] }>(
    async (tx, { changedFields }) => {
      const movedCustomFieldIds = customFields
        ? await applyProjectCustomFieldsInTransaction(
            tx,
            customFields,
            projectId,
            organizationId
          )
        : [];
      await receipts.record(
        tx,
        projectUpdateReceiptWrite(changedFields, movedCustomFieldIds)
      );
    }
  );
}

/**
 * The PUT's answer to a thrown error: a custom field value refused inside the
 * recorded write's transaction (ISS-12552), a team the caller cannot use, or
 * a 500.
 */
async function projectUpdateErrorResponse(
  error: unknown,
  organizationId: string
) {
  const customFieldsRefusal = customFieldWriteErrorResponse(error);
  if (customFieldsRefusal) {
    return customFieldsRefusal;
  }
  if (error instanceof InvalidProjectTeamsError) {
    if (error.reason === InvalidProjectTeamsReason.Unresolved) {
      return await unresolvedTeamErrorResponse({
        message: error.message,
        organizationId,
        verb: TeamRequirementVerb.Update,
      });
    }
    return badRequestResponse(error.message);
  }
  return errorResponse("Failed to update project", error);
}
