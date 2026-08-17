import { AuditAction, AuditObjectType } from "@repo/api/src/types/audit";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import {
  type Document,
  type DocumentDetail,
  statusOptionsForSubtype,
} from "@repo/api/src/types/document";
import {
  getNotificationEntityPath,
  NotificationEntityKind,
} from "@repo/api/src/types/notification-routes";
import { AssignmentEntityType } from "@repo/collaboration/server/inbox-notifications";
import {
  dispatchAuditEvent,
  userAuditActor,
} from "@/app/audit/audit-emit-service";
import { documentService } from "@/app/documents/document-service";
import { captureArtifactUpdate } from "@/lib/artifact-activity-capture";
import { dispatchAssignmentNotification } from "@/lib/assignment-notifications";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId, resolveProjectId } from "@/lib/identifier-utils";
import {
  badRequestResponse,
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import {
  applyCustomFieldsFromBody,
  mergeCustomFieldsIntoResponse,
} from "../../custom-fields/route-helpers";
import { documentVersionService } from "../document-version-service";
import { updateDocumentValidator } from "../validators";
import { resolveLatestVersionContent } from "../version-route-helpers";

export const GET = withAnyAuth<DocumentDetail, "/documents/[id]">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveDocumentId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Artifact");
      }

      const artifact = await documentService.findById(
        resolvedId,
        user.organizationId
      );

      if (!artifact) {
        return notFoundResponse("Artifact");
      }

      // Fetch a specific version's content, or latest by default
      const versionParam = request.nextUrl.searchParams.get("version");
      const versionNumber = versionParam ? Number(versionParam) : undefined;

      if (
        versionNumber !== undefined &&
        (Number.isNaN(versionNumber) ||
          versionNumber < 1 ||
          !Number.isInteger(versionNumber))
      ) {
        return errorResponse(
          "Invalid version parameter",
          new Error("Version must be a positive integer")
        );
      }

      const version = versionNumber
        ? await documentVersionService.getByVersion(resolvedId, versionNumber)
        : await documentVersionService.getLatest(resolvedId);

      if (!version) {
        return notFoundResponse(
          versionParam ? `Artifact version ${versionParam}` : "Artifact version"
        );
      }

      const latestVersionContent = await resolveLatestVersionContent(
        artifact,
        version
      );

      if (!latestVersionContent) {
        return notFoundResponse("Artifact latest version");
      }

      const response = await mergeCustomFieldsIntoResponse(
        { ...artifact, ...latestVersionContent, version },
        CustomFieldEntityType.Document,
        user.organizationId
      );

      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch artifact", error);
    }
  }
);

export const PUT = withAnyAuth<Document, "/documents/[id]">(
  async ({ authMethod, user }, request, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveDocumentId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Artifact");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateDocumentValidator
      );
      if (parseError) {
        return parseError;
      }

      const { customFields, ...artifactInput } = body;

      if (artifactInput.projectId) {
        const pId = await resolveProjectId(
          artifactInput.projectId,
          user.organizationId
        );
        if (!pId) {
          return notFoundResponse("Project");
        }
        artifactInput.projectId = pId;
      }

      const existing = await documentService.findById(
        resolvedId,
        user.organizationId
      );
      if (!existing) {
        return notFoundResponse("Artifact");
      }

      // Documents and Features carry disjoint status vocabularies on the same
      // freeform column (PRD-495). The update validator accepts the union; the
      // valid subset depends on the target artifact's subtype, which is only
      // known after the load above. Reject a cross-vocabulary status here with a
      // clean 400 (mirroring the create path's validator refine) so it never
      // reaches documentService.update, where an out-of-vocabulary value throws
      // and would surface as an undocumented 500.
      if (
        artifactInput.status !== undefined &&
        !statusOptionsForSubtype(existing.type).includes(artifactInput.status)
      ) {
        return badRequestResponse(
          `Status "${artifactInput.status}" is not valid for a ${existing.type} artifact`
        );
      }

      const artifact = await documentService.update(
        resolvedId,
        user.organizationId,
        artifactInput
      );

      // Capture the mutation into the artifact activity feed (FEA-3864).
      // Best-effort and non-blocking — a capture failure never fails this write.
      // The helper is internally isolated; this extra guard is defense-in-depth
      // so a synchronous throw can never bubble into the outer catch and 500 a
      // write that already committed.
      try {
        captureArtifactUpdate({
          organizationId: user.organizationId,
          artifactId: artifact.id,
          actor: { userId: user.id, authMethod },
          before: {
            status: existing.status,
            assigneeId: existing.assigneeId,
            approverId: existing.approverId,
            priority: existing.priority,
            title: existing.title,
            dueDate: existing.dueDate ?? null,
            projectId: existing.projectId,
          },
          after: {
            status: artifact.status,
            assigneeId: artifact.assigneeId,
            approverId: artifact.approverId,
            priority: artifact.priority,
            title: artifact.title,
            dueDate: artifact.dueDate ?? null,
            projectId: artifact.projectId,
          },
        });
      } catch {
        // Swallowed by design: activity capture must never fail the write.
      }

      // Record a status transition on the tamper-evident audit ledger (FEA-3862).
      // Non-blocking and best-effort: `dispatchAuditEvent` enqueues onto the
      // durable outbox via `waitUntil` and never throws, so a ledger hiccup can
      // never fail or delay the document update the user just made.
      if (
        artifactInput.status !== undefined &&
        artifact.status !== existing.status
      ) {
        dispatchAuditEvent({
          organizationId: user.organizationId,
          actor: userAuditActor(user.id),
          action: AuditAction.DocumentStatusChanged,
          objectType: AuditObjectType.Document,
          objectId: artifact.id,
          detail: { from: existing.status, to: artifact.status },
        });
      }

      dispatchAssignmentNotification({
        previousAssigneeId: existing.assigneeId,
        newAssigneeId: artifactInput.assigneeId,
        actorUserId: user.id,
        organizationId: user.organizationId,
        entityType: AssignmentEntityType.Artifact,
        entityTitle: artifact.title,
        entityUrl: getNotificationEntityPath({
          kind: NotificationEntityKind.Artifact,
          slug: artifact.slug,
          subtype: artifact.type,
        }),
        subjectId: artifact.id,
      });

      if (customFields) {
        await applyCustomFieldsFromBody(
          customFields,
          resolvedId,
          CustomFieldEntityType.Document,
          user.organizationId
        );
      }

      return successResponse(artifact);
    } catch (error) {
      return errorResponse("Failed to update artifact", error);
    }
  },
  { requiredScopes: ["write"] }
);

export const DELETE = withAnyAuth<{ deleted: true }, "/documents/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveDocumentId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Artifact");
      }
      await documentService.delete(resolvedId, user.organizationId);
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete artifact", error);
    }
  },
  { requiredScopes: ["delete"] }
);
