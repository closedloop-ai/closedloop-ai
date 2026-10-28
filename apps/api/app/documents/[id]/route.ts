import type { ArtifactStatusProvenance } from "@repo/api/src/types/artifact-status-contract";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { Document, DocumentDetail } from "@repo/api/src/types/document";
import {
  getNotificationEntityPath,
  NotificationEntityKind,
} from "@repo/api/src/types/notification-routes";
import { AssignmentEntityType } from "@repo/collaboration/server/inbox-notifications";
import { withDb } from "@repo/database";
import type { NextRequest } from "next/server";
import { userAuditActor } from "@/app/audit/audit-emit-service";
import { blockedDependentUnblockService } from "@/app/documents/blocked-dependent-unblock-service";
import {
  emitDocumentCustomFieldValidationAnalytics,
  emitDocumentFieldEditAnalytics,
  emitDocumentLegacyChangeAnalytics,
  emitDocumentRefusalAnalytics,
} from "@/app/documents/document-field-edit-analytics";
import { dispatchDocumentMutationAudits } from "@/app/documents/document-mutation-side-effects";
import {
  documentService,
  indexDocumentProjection,
} from "@/app/documents/document-service";
import {
  documentStatusMutationPermissionsForAuth,
  withDocumentStatusMutation,
} from "@/app/documents/document-status-mutation-capability";
import { documentStatusMutationService } from "@/app/documents/document-status-mutation-service";
import {
  type ActivityActor,
  captureArtifactUpdate,
} from "@/lib/artifact-activity-capture";
import { createArtifactFieldEditAnalyticsContext } from "@/lib/artifact-field-edit-analytics-context";
import { dispatchAssignmentNotification } from "@/lib/assignment-notifications";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import type {
  AuthContext,
  AuthenticatedJsonResponse,
  RouteContext,
} from "@/lib/auth/with-auth";
import { resolveDocumentId, resolveProjectId } from "@/lib/identifier-utils";
import { statusMutationErrorResponse } from "@/lib/mutation-error-response";
import { recordRequestArtifact } from "@/lib/observability/request-span-attribution";
import { customFieldChanges } from "@/lib/operation-receipts/changed-fields";
import {
  type OperationReceiptRecorder,
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  type FollowOnWriteStep,
  followOnWrite,
  mapRecordedWrite,
  type RecordWriteInTransaction,
} from "@/lib/record-write-in-transaction";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import {
  applyArtifactCustomFieldsInTransaction,
  customFieldsPreflightResponse,
  customFieldWriteErrorResponse,
  mergeCustomFieldsIntoResponse,
} from "../../custom-fields/route-helpers";
import { documentDeleteReceiptWrite } from "../document-delete-receipt";
import {
  changedDocumentFields,
  updateFieldsReceiptWrite,
} from "../document-update-receipt";
import { documentVersionService } from "../document-version-service";
import { updateDocumentValidator } from "../validators";
import {
  parseVersionParam,
  resolveLatestVersionContent,
} from "../version-route-helpers";

export const GET = withAnyAuth<DocumentDetail, "/documents/[id]">(
  async (auth, request, params) => {
    const { user } = auth;
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

      // ISS-7224: the span's `artifact.type` comes off the loaded ROW. The path
      // is `/documents/{id}` and carries no type, so a path- or body-derived
      // value would be a guess; this one is what the artifact actually is.
      recordRequestArtifact(artifact);

      // Fetch a specific version's content, or latest by default
      const parsedVersion = parseVersionParam(request);
      if (parsedVersion.ok === false) {
        return parsedVersion.response;
      }
      const { versionParam, versionNumber } = parsedVersion;

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
        withDocumentStatusMutation(
          {
            ...artifact,
            ...latestVersionContent,
            version,
          },
          documentStatusMutationPermissionsForAuth(auth)
        ),
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
  withOperationReceipts(OperationKind.UpdateFields, updateDocumentResponse),
  { requiredScopes: ["write"] }
);

async function updateDocumentResponse(
  { authMethod, user }: AuthContext,
  request: NextRequest,
  params: RouteContext<"/documents/[id]">["params"],
  receipts: OperationReceiptRecorder
): Promise<AuthenticatedJsonResponse<Document>> {
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

    // `surface` is provenance for the activity receipt and the unified
    // artifact_field_edit_result event, NOT an artifact column — split it off so it
    // can never reach `documentStatusMutationService.updateDocument`, which
    // spreads what it is given straight at Prisma.
    const { customFields, surface, ...artifactInput } = body;

    // Resolve trusted provenance once for the transaction-owned receipt and
    // every post-commit outcome emitted for this write.
    const provenance = createArtifactFieldEditAnalyticsContext({
      organizationId: user.organizationId,
      userId: user.id,
      surface,
      authMethod,
    }).provenance;

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

    // ISS-7224: stamped from the ALREADY-LOADED row before the write, so a
    // `documentService.update` that throws still produces a 5xx span carrying
    // `artifact.type` — otherwise a Prisma failure on an IMPLEMENTATION_PLAN
    // update is invisible to an `artifact.type:IMPLEMENTATION_PLAN` query,
    // which is exactly the population that needs to see it. The subtype never
    // changes on update, so the pre-write type is the post-write type; only
    // the status can move, and the success path below overwrites it. It also
    // stamps the custom-field preflight's 400 below, which returns before any
    // write and would otherwise carry no `artifact.type` either.
    recordRequestArtifact(existing);

    // Ahead of the document write, so a bad value is refused before the write
    // transaction opens. A value that turns invalid after this check (say a
    // reference target deleted meanwhile) is refused where the fields apply:
    // inside that transaction when the request records, rolling the whole
    // update back (ISS-12552), otherwise after the commit, as on main.
    const customFieldsPreflight = await customFieldsPreflightResponse(
      customFields,
      resolvedId,
      CustomFieldEntityType.Document,
      user.organizationId
    );
    if (customFieldsPreflight) {
      if (customFieldsPreflight.status === 400) {
        emitDocumentCustomFieldValidationAnalytics({
          organizationId: user.organizationId,
          userId: user.id,
          provenance,
        });
      }
      return customFieldsPreflight;
    }

    const actor = { userId: user.id, authMethod };
    // Recording, the custom fields join the document's transaction; otherwise
    // they apply after the document's post-commit work, as on main.
    const applyCustomFields: FollowOnWriteStep<string[]> = (deferEffect) =>
      customFields
        ? applyArtifactCustomFieldsInTransaction(
            customFields,
            resolvedId,
            CustomFieldEntityType.Document,
            user.organizationId,
            {
              actor,
              ...(provenance === undefined ? {} : { receipt: { provenance } }),
              ...(deferEffect ? { deferEffect } : {}),
            }
          )
        : Promise.resolve([]);
    const emitCustomFieldRefusal = () =>
      emitDocumentCustomFieldValidationAnalytics({
        organizationId: user.organizationId,
        userId: user.id,
        provenance,
      });

    let update: Awaited<ReturnType<typeof updateDocumentWithReceipt>>;
    try {
      update = await updateDocumentWithReceipt({
        resolvedId,
        organizationId: user.organizationId,
        artifactInput,
        applyCustomFields,
        recordUpdate: receipts.whenRecording<string[]>((tx, changedFields) =>
          receipts.record(
            tx,
            updateFieldsReceiptWrite(resolvedId, changedFields)
          )
        ),
        actor,
        provenance,
      });
    } catch (error) {
      const customFieldsRefusal = customFieldWriteErrorResponse(error);
      if (!customFieldsRefusal) {
        throw error;
      }
      emitCustomFieldRefusal();
      return customFieldsRefusal;
    }
    const updateResult = update.result;
    if (!updateResult.ok) {
      emitDocumentRefusalAnalytics({
        organizationId: user.organizationId,
        userId: user.id,
        provenance,
        requested: artifactInput,
        error: updateResult.error,
      });
      return statusMutationErrorResponse(updateResult.error);
    }
    const { document: artifact, previous, written } = updateResult.value;

    // The POST-UPDATE row, so an edit that changed the status is counted
    // under the status it now has rather than the one it left.
    recordRequestArtifact(artifact);

    // Here, not inside `updateDocumentWithReceipt`, because this route owns
    // the transaction the write joins (ISS-10993) and the projection is a
    // post-commit contract: the work this schedules issues `withDb` calls of
    // its own, and under an ambient transaction they land on that
    // transaction's client instead of a pooled connection. Skipped when the
    // guarded retry wrote nothing (ISS-9486): there is no new projection.
    if (written) {
      indexDocumentProjection(artifact, undefined);
    }

    emitDocumentFieldEditAnalytics({
      organizationId: user.organizationId,
      userId: user.id,
      provenance,
      requested: artifactInput,
      previous,
      artifact,
    });
    emitDocumentLegacyChangeAnalytics({
      organizationId: user.organizationId,
      userId: user.id,
      provenance,
      surface,
      authMethod,
      requested: artifactInput,
      previous,
      artifact,
    });

    dispatchDocumentMutationAudits({
      organizationId: user.organizationId,
      userId: user.id,
      artifactInput,
      previous,
      artifact,
    });

    // ISS-9632: if this write moved the artifact to a terminal status, clear
    // every dependent it was blocking whose blockers have now all resolved.
    // Guarded on the same real-transition condition as the ledger emit above
    // — an artifact re-saved at the status it already had did not transition
    // and must not re-trigger a sweep. Awaited (never fire-and-forget) but
    // internally best-effort: it cannot fail a write that already committed.
    if (artifact.status !== previous.status) {
      await blockedDependentUnblockService.resolveBlocksForChangedArtifacts({
        organizationId: user.organizationId,
        changedArtifactIds: [artifact.id],
      });
    }

    dispatchAssignmentNotification({
      previousAssigneeId: previous.assigneeId,
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

    // Not recording: main's place for the custom fields, after the document
    // committed and its effects fired, so a refusal here answers 400 with the
    // document and any earlier field already stored (ISS-12552 flag-off
    // parity).
    const customFieldsRefusal = await customFieldRefusalResponse(
      update.customFields.afterCommit,
      emitCustomFieldRefusal
    );
    if (customFieldsRefusal) {
      return customFieldsRefusal;
    }

    return successResponse(withOperationReceipt(artifact, receipts));
  } catch (error) {
    return errorResponse("Failed to update artifact", error);
  }
}

export const DELETE = withAnyAuth<{ deleted: true }, "/documents/[id]">(
  withOperationReceipts(
    OperationKind.Delete,
    async ({ user }, _, params, receipts) => {
      try {
        const { id } = await params;
        const resolvedId = await resolveDocumentId(id, user.organizationId);
        if (!resolvedId) {
          return notFoundResponse("Artifact");
        }
        await documentService.delete(
          resolvedId,
          user.organizationId,
          userAuditActor(user.id),
          receipts.whenRecording((tx, { documentId }) =>
            receipts.record(tx, documentDeleteReceiptWrite(documentId))
          )
        );
        return deleteResponse(receipts.receipt);
      } catch (error) {
        return errorResponse("Failed to delete artifact", error);
      }
    }
  ),
  { requiredScopes: ["delete"] }
);

/**
 * The document write and its activity and operation receipts in ONE
 * transaction (ISS-10993, ISS-12552), with its custom fields when the request
 * records (`recordUpdate` is set). Otherwise the returned `customFields` runs
 * them from `afterCommit`, where the route calls it, as on main. `withDb.tx` joins an ambient
 * transaction, so the mutation service's own database work runs on this one;
 * a receipt that cannot be written, or a custom field value refused mid-apply
 * (`CustomFieldsRefusedError`), rolls the whole edit back.
 *
 * Extracted rather than inlined so the handler's cognitive complexity does not
 * grow by the closure.
 */
async function updateDocumentWithReceipt(params: {
  resolvedId: string;
  organizationId: string;
  artifactInput: Parameters<
    typeof documentStatusMutationService.updateDocument
  >[2];
  applyCustomFields: FollowOnWriteStep<string[]>;
  /** Records the update's receipt with every field it moved. */
  recordUpdate: RecordWriteInTransaction<string[]> | undefined;
  actor: ActivityActor;
  provenance: ArtifactStatusProvenance | undefined;
}) {
  const afterCommit: (() => void)[] = [];
  let documentChanges: string[] = [];
  const customFields = followOnWrite(
    mapRecordedWrite(params.recordUpdate, (movedCustomFieldIds: string[]) => [
      ...documentChanges,
      ...customFieldChanges(movedCustomFieldIds),
    ]),
    params.applyCustomFields
  );
  const result = await withDb.tx(async (tx) => {
    const written = await documentStatusMutationService.updateDocument(
      params.resolvedId,
      params.organizationId,
      params.artifactInput
    );
    if (!written.ok) {
      return written;
    }
    const { document: artifact, previous } = written.value;
    await captureArtifactUpdate({
      tx,
      organizationId: params.organizationId,
      artifactId: artifact.id,
      actor: params.actor,
      before: {
        status: previous.status,
        assigneeId: previous.assigneeId,
        approverId: previous.approverId,
        priority: previous.priority,
        title: previous.title,
        dueDate: previous.dueDate ?? null,
        projectId: previous.projectId,
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
      ...(params.provenance === undefined
        ? {}
        : { provenance: params.provenance }),
    });
    // A guarded retry that wrote nothing changed nothing (ISS-9486).
    documentChanges = written.value.written
      ? changedDocumentFields(params.artifactInput, previous, artifact)
      : [];
    await customFields.inTransaction(tx, (effect) => afterCommit.push(effect));
    return written;
  });
  for (const effect of afterCommit) {
    effect();
  }
  return { result, customFields };
}

/**
 * Runs a custom field write and maps a refusal the caller caused to its 400,
 * or null when it was stored or nothing ran. Any other failure propagates.
 */
async function customFieldRefusalResponse(
  write: () => Promise<unknown>,
  onRefused: () => void
) {
  try {
    await write();
    return null;
  } catch (error) {
    const refusal = customFieldWriteErrorResponse(error);
    if (!refusal) {
      throw error;
    }
    onRefused();
    return refusal;
  }
}
