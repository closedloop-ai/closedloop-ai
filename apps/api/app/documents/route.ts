import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import {
  buildDocumentListContinuationHeaders,
  type CreateDocumentRequestBody,
  type CreateDocumentResponse,
  type Document,
  type DocumentListPage,
  type DocumentWithProject,
  SourceLinkedPlanPolicy,
} from "@repo/api/src/types/document";
import { forbiddenAttachmentUploadResponse } from "@/app/documents/attachment-route-responses";
import { isMcpAttachmentUploadEnabled } from "@/app/documents/attachment-upload-feature";
import { documentListService } from "@/app/documents/document-list-service";
import {
  documentService,
  type RecordCreatedArtifact,
} from "@/app/documents/document-service";
import { sourceLinkedPlanService } from "@/app/documents/source-linked-plan-service";
import { captureArtifactCreation } from "@/lib/artifact-activity-capture";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  resolveArtifactIdentifier,
  resolveProjectId,
} from "@/lib/identifier-utils";
import { recordRequestArtifact } from "@/lib/observability/request-span-attribution";
import {
  type OperationReceiptRecorder,
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import {
  mapCreateDocumentFailure,
  mapSourceLinkedPlanCreateFailure,
  parseCreateDocumentBody,
  shapeCreateDocumentResponse,
  shapeSourceLinkedPlanCreateResponse,
} from "./create-document-route-helpers";
import type { DocumentListArrayPage } from "./document-list-service";
import {
  readDocumentListInSnapshot,
  requiresCustomFieldSnapshot,
} from "./document-list-snapshot";
import { findDocumentsQueryValidator } from "./validators";

/**
 * GET /documents - List documents
 * Accepts API key authentication (sk_live_) or Clerk session authentication.
 *
 * Returns a bare `DocumentWithProject[]` by default. A caller that pages passes
 * `includeTotal=true` and gets a {@link DocumentListPage} envelope instead — the
 * page plus a real server-side total (ISS-4576). The default shape is unchanged
 * so existing consumers (Documents index, pickers, MCP, version-skewed API
 * clients) are unaffected.
 *
 * ISS-6941: the bare-array arm now ALSO states its continuation — total, whether
 * more rows exist, and the next offset — in response headers. The body is
 * untouched, so nothing that parses it can notice; what changes is that a caller
 * paging with `limit` + `offset` and no `includeTotal` can finally tell "that was
 * everything" from "the server capped me at `DOCUMENT_LIST_MAX_LIMIT`". An
 * unbounded read pays nothing for this (its own length is the total); only a
 * caller that actually asked to page pays the `count()`.
 *
 * FEA-1626 (epic FEA-908) added two OPT-IN narrowing dimensions that let a
 * client keep a power user's first paint bounded: `recencyDays=<n>` windows the
 * result to `updatedAt >= now - n days`, and `includeArchivedProjects=false`
 * drops artifacts whose parent project is `ARCHIVED`. Neither is a server-side
 * default: omitting a param means the long-standing full-history behavior, on
 * every arm. That polarity is required by the deploy boundary — `apps/app` and
 * this app ship independently, so a default applied here would narrow the
 * already-deployed old app's response before its feature flag could control it
 * (whitlockk review). Today the My Tasks board is the only caller that opts in, and
 * only behind `my-tasks-recency-window`.
 *
 * ISS-6778 adds a third, `status`, repeated once per value
 * (`?status=TODO&status=IN_PROGRESS`), and it is the one that makes the bound
 * above usable: until now the status question could only be asked AFTER the
 * rows arrived, so its answer was bounded by the page rather than by the
 * population — `symphony-nightly-apply` reported "no
 * TODO issues to sweep" against a project holding 25 of them, and the My Tasks
 * board spends its whole 500-row budget on rows it is about to discard. The
 * predicate is an `IN` on `Artifact.status` in the query, never a post-fetch
 * filter. Same opt-in polarity as its two siblings: omission narrows nothing.
 */
export const GET = withAnyAuth<
  DocumentWithProject[] | DocumentListPage,
  "/documents"
>(async ({ user }, request) => {
  try {
    const searchParams = request.nextUrl.searchParams;

    // Convert searchParams to plain object for validation
    const queryParams: Record<string, unknown> = Object.fromEntries(
      searchParams.entries()
    );

    // ISS-6778: `status` is REPEATED (`?status=TODO&status=IN_PROGRESS`), the
    // shape `apps/api/AGENTS.md` requires of a new multi-value parameter and the
    // one `/search` already uses for `types`. `Object.fromEntries` above keeps
    // only the LAST occurrence of a key, so reading `status` from it would
    // answer `?status=TODO&status=DONE` with DONE alone — a filter the caller
    // asked for, dropped without a word. That is the same silent no-op an empty
    // element is rejected to prevent, so every occurrence is read here, at the
    // boundary where the repetition still exists (tamsinb, whitlockk review).
    const statusValues = searchParams.getAll("status");
    if (statusValues.length > 0) {
      queryParams.status = statusValues;
    }
    const typeValues = searchParams.getAll("types");
    if (typeValues.length > 0) {
      queryParams.types = typeValues;
    }

    // Validate query parameters
    const parseResult = findDocumentsQueryValidator.safeParse(queryParams);

    if (!parseResult.success) {
      return badRequestResponse(
        `Invalid query parameters: ${parseResult.error.message}`
      );
    }

    const { projectId, includeTotal, ...restQuery } = parseResult.data;
    let resolvedProjectId: string | undefined;
    if (projectId) {
      const pId = await resolveProjectId(projectId, user.organizationId);
      if (!pId) {
        return notFoundResponse("Project");
      }
      resolvedProjectId = pId;
    }

    // ISS-7211: the custom-field facets and sort resolve INSIDE the list read's
    // `RepeatableRead` snapshot, alongside the page, the honest-total `count()`,
    // and the value hydration. Resolving them first — as this route originally
    // did — left the page and total agreeing with each other but drawn from ids
    // older than the values rendered onto the rows, so an edit landing in that
    // window returned a row contradicting the filter the user applied (whitlockk).
    // A refusal is the server-side capability gate: `isSortable` /
    // `isSearchable` are enforced against the stored field definition, not
    // merely hidden in the toolbar.
    const {
      customFieldSortId,
      customFieldSortDir,
      customFieldFilters,
      ...listQuery
    } = restQuery;
    const customFieldParams = {
      customFieldSortId,
      customFieldSortDir,
      customFieldFilters,
    };
    const findOptions = {
      organizationId: user.organizationId,
      projectId: resolvedProjectId,
      ...listQuery,
    };

    if (!requiresCustomFieldSnapshot(customFieldParams)) {
      if (includeTotal) {
        return successResponse(
          await documentListService.findPageWithCustomFields(findOptions)
        );
      }
      return arrayResponse(
        await documentListService.findArrayWithContinuation(findOptions)
      );
    }

    // Branched on the response arm rather than resolved into one union and cast
    // apart afterwards: the two arms return different shapes and only one of
    // them carries headers, so a single read typed as the union would need an
    // `as` at every use.
    if (includeTotal) {
      const paged = await readDocumentListInSnapshot<DocumentListPage>(
        findOptions,
        customFieldParams,
        (options, now) => documentListService.readPageInSnapshot(options, now)
      );
      if (!paged.ok) {
        return badRequestResponse(paged.error);
      }
      return successResponse(paged.value);
    }

    const result = await readDocumentListInSnapshot<DocumentListArrayPage>(
      findOptions,
      customFieldParams,
      (options, now) =>
        documentListService.readArrayWithContinuationInSnapshot(options, now)
    );
    if (!result.ok) {
      return badRequestResponse(result.error);
    }
    return arrayResponse(result.value);
  } catch (error) {
    return errorResponse("Failed to fetch documents", error);
  }
});

export const POST = withAnyAuth<CreateDocumentResponse, "/documents">(
  withOperationReceipts(
    OperationKind.Create,
    async (auth, request, _params, receipts) => {
      try {
        const { body, errorResponse: parseError } =
          await parseCreateDocumentBody(request);
        if (parseError) {
          return parseError;
        }

        return await (body.sourceLinkedPlanPolicy ===
        SourceLinkedPlanPolicy.ReuseOrCreate
          ? handleSourceLinkedPlanCreate(auth, body, receipts)
          : handleNormalDocumentCreate(auth, body, receipts));
      } catch (error) {
        return errorResponse("Failed to create document", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);

/**
 * The bare-array response plus its ISS-6941 continuation headers.
 *
 * One place so the two arms that produce an array — the plain read and the
 * custom-field snapshot read — cannot ship different header sets.
 */
function arrayResponse(page: DocumentListArrayPage) {
  return successResponse<DocumentWithProject[] | DocumentListPage>(page.items, {
    headers: buildDocumentListContinuationHeaders(page.continuation),
  });
}

async function handleSourceLinkedPlanCreate(
  auth: CreateDocumentRouteAuth,
  body: CreateDocumentRequestBody,
  receipts: OperationReceiptRecorder
) {
  const { inlineImages: _inlineImages, ...createDocumentBody } = body;
  if (!(createDocumentBody.projectId && createDocumentBody.sourceId)) {
    return badRequestResponse(
      "Invalid source-linked implementation plan create request"
    );
  }

  const resolvedSourceId = await resolveArtifactIdentifier(
    createDocumentBody.sourceId,
    auth.user.organizationId
  );
  if (!resolvedSourceId) {
    return notFoundResponse("Source artifact");
  }

  const result = await sourceLinkedPlanService.createOrReuse(
    auth.user.organizationId,
    auth.user.id,
    {
      ...createDocumentBody,
      projectId: createDocumentBody.projectId,
      sourceId: resolvedSourceId,
      sourceLinkedPlanPolicy: SourceLinkedPlanPolicy.ReuseOrCreate,
    },
    creationReceipt(auth, receipts),
    // Both receipts are written inside the service's own transaction
    // (ISS-10993, ISS-12552). A reused plan wrote nothing, so its operation
    // receipt is a no-op on the plan it returned.
    receipts.whenRecording((tx, reused) =>
      receipts.record(tx, {
        operationKind: OperationKind.Create,
        outcome: OperationReceiptOutcome.NoOp,
        targetArtifactId: reused.id,
      })
    )
  );
  if (!result.ok) {
    return mapSourceLinkedPlanCreateFailure(result.error);
  }

  recordRequestArtifact(result.value.document);
  return successResponse(
    withOperationReceipt(
      shapeSourceLinkedPlanCreateResponse(result.value),
      receipts
    )
  );
}

async function handleNormalDocumentCreate(
  auth: CreateDocumentRouteAuth,
  body: CreateDocumentRequestBody,
  receipts: OperationReceiptRecorder
) {
  const { inlineImages = [], ...createDocumentBody } = body;
  const resolvedProjectId = await resolveCreateProjectId(auth, body);
  if (resolvedProjectId instanceof Response) {
    return resolvedProjectId;
  }
  const resolvedSourceId = await resolveCreateSourceId(auth, body);
  if (resolvedSourceId instanceof Response) {
    return resolvedSourceId;
  }

  const createInput = {
    ...createDocumentBody,
    projectId: resolvedProjectId,
    sourceId: resolvedSourceId,
  };
  const hasInlineImages = inlineImages.length > 0;
  const recordCreated = creationReceipt(auth, receipts);
  if (
    hasInlineImages &&
    auth.authMethod === "api_key" &&
    !(await isMcpAttachmentUploadEnabled({
      clerkUserId: auth.clerkUserId,
      userId: auth.user.id,
    }))
  ) {
    return forbiddenAttachmentUploadResponse();
  }

  if (hasInlineImages) {
    const result = await documentService.createWithInlineImages(
      auth.user.organizationId,
      auth.user.id,
      createInput,
      inlineImages,
      recordCreated
    );
    if (!result.ok) {
      return mapCreateDocumentFailure(result.error);
    }
    recordCreatedDocument(result.value.document);
    return successResponse(
      withOperationReceipt(
        shapeCreateDocumentResponse(result.value.document, result.value),
        receipts
      )
    );
  }

  const document = await documentService.create(
    auth.user.organizationId,
    auth.user.id,
    createInput,
    recordCreated
  );
  if (!document) {
    return badRequestResponse("Failed to create document");
  }

  recordCreatedDocument(document);
  return successResponse(withOperationReceipt(document, receipts));
}

async function resolveCreateProjectId(
  auth: CreateDocumentRouteAuth,
  body: CreateDocumentRequestBody
) {
  // A DOC or TEMPLATE may omit `projectId` (FEA-4345); resolve one only when
  // the body supplies it. The create validator refuses one on a TEMPLATE.
  if (!body.projectId) {
    return undefined;
  }
  const projectId = await resolveProjectId(
    body.projectId,
    auth.user.organizationId
  );
  return projectId ?? notFoundResponse("Project");
}

async function resolveCreateSourceId(
  auth: CreateDocumentRouteAuth,
  body: CreateDocumentRequestBody
) {
  if (!body.sourceId) {
    return undefined;
  }
  const sourceId = await resolveArtifactIdentifier(
    body.sourceId,
    auth.user.organizationId
  );
  return sourceId ?? notFoundResponse("Source artifact");
}

function recordCreatedDocument(document: Document): void {
  // ISS-7224: stamp the CREATED row, so a create is counted under the type the
  // artifact actually has. Both plain and inline-image creates stamp.
  //
  // The activity receipt is NOT here (ISS-10993): the store writes it on the
  // artifact row's own transaction, from the `activityActor` this route hands
  // `documentService.create`.
  recordRequestArtifact(document);
}

type CreateDocumentRouteAuth = Pick<
  AuthContext,
  "authMethod" | "clerkUserId" | "user"
>;

/**
 * The activity receipt for a newly created artifact, written on the create's own
 * transaction (ISS-10993) so a receipt that cannot be persisted refuses the
 * create instead of leaving the feed with no row to start from.
 */
function creationReceipt(
  auth: CreateDocumentRouteAuth,
  receipts: OperationReceiptRecorder
): RecordCreatedArtifact {
  // ISS-12552: the operation receipt commits with the create it describes.
  const recordReceipt = receipts.whenRecording<Document>((tx, created) =>
    receipts.record(tx, {
      operationKind: OperationKind.Create,
      outcome: OperationReceiptOutcome.Committed,
      targetArtifactId: created.id,
      createdArtifactId: created.id,
      versionNumber: 1,
    })
  );
  return async (tx, created) => {
    await captureArtifactCreation({
      tx,
      organizationId: auth.user.organizationId,
      artifactId: created.id,
      actor: { userId: auth.user.id, authMethod: auth.authMethod },
      after: { status: created.status, title: created.title },
    });
    await recordReceipt?.(tx, created);
  };
}
