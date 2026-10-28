import {
  OperationKind,
  type OperationReceipt,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import { type ApiResult, failure } from "@repo/api/src/types/common";
import type { DocumentDetail } from "@repo/api/src/types/document";
import {
  CreateDocumentVersionErrorCode,
  type CreatedDocumentVersionInlineImage,
  MAX_CREATE_DOCUMENT_VERSION_REQUEST_BODY_BYTES,
} from "@repo/api/src/types/document-version";
import { log } from "@repo/observability/log";
import { type NextRequest, NextResponse } from "next/server";
import type { z } from "zod";
import {
  forbiddenAttachmentUploadResponse,
  mapCreateInlineImageAttachmentFailure,
} from "@/app/documents/attachment-route-responses";
import { isMcpAttachmentUploadEnabled } from "@/app/documents/attachment-upload-feature";
import { documentService } from "@/app/documents/document-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import type {
  AuthContext,
  AuthenticatedJsonResponse,
  RouteContext,
} from "@/lib/auth/with-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  type OperationReceiptRecorder,
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  errorResponse,
  formatZodErrors,
  notFoundResponse,
  payloadTooLargeResponse,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import {
  type CreateDocumentVersionError,
  type DocumentVersionListItem,
  documentVersionService,
  type RecordVersionCreated,
} from "../../document-version-service";
import {
  hasInlineImageInputs,
  readInlineImageAwareRequestText,
} from "../../inline-image-request-body";
import { resetDocumentRoom } from "../../room-utils";
import { newVersionValidator } from "../../validators";

export const GET = withAnyAuth<
  DocumentVersionListItem[],
  "/documents/[id]/versions"
>(async ({ user }, _, params) => {
  try {
    const { id } = await params;
    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    // Verify artifact exists and belongs to org
    const artifact = await documentService.findByIdSimple(
      resolvedId,
      user.organizationId
    );
    if (!artifact) {
      return notFoundResponse("Artifact");
    }

    const versions = await documentVersionService.listVersions(resolvedId);
    return successResponse(versions);
  } catch (error) {
    return errorResponse("Failed to fetch artifact versions", error);
  }
});

export const POST = withAnyAuth<
  CreateDocumentVersionResponse,
  "/documents/[id]/versions"
>(withOperationReceipts(OperationKind.CreateVersion, createVersionResponse), {
  requiredScopes: ["write"],
});

async function createVersionResponse(
  { authMethod, clerkUserId, user }: AuthContext,
  request: NextRequest,
  params: RouteContext<"/documents/[id]/versions">["params"],
  receipts: OperationReceiptRecorder
): Promise<AuthenticatedJsonResponse<CreateDocumentVersionResponse>> {
  try {
    const { id } = await params;
    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    const { body, errorResponse: parseError } =
      await parseCreateDocumentVersionBody(request);
    if (parseError) {
      return parseError;
    }

    const inlineImages = body.inlineImages ?? [];
    const hasInlineImages = inlineImages.length > 0;
    if (
      hasInlineImages &&
      authMethod === "api_key" &&
      !(await isMcpAttachmentUploadEnabled({
        clerkUserId,
        userId: user.id,
      }))
    ) {
      return forbiddenAttachmentUploadResponse();
    }

    // Undefined when the request records nothing, so the save skips the
    // previous-version read it only needs for a receipt (flag-off parity).
    const recordVersion = receipts.whenRecording(versionReceipt(receipts));
    const versionResult = hasInlineImages
      ? await documentVersionService.createNewVersionWithInlineImages(
          resolvedId,
          user.organizationId,
          user.id,
          body.content,
          inlineImages,
          recordVersion
        )
      : await createContentOnlyVersion(
          resolvedId,
          user.organizationId,
          user.id,
          body.content,
          recordVersion
        );
    if (versionResult.ok === false) {
      return mapCreateDocumentVersionFailure(versionResult.error);
    }
    const { document: updatedArtifact, versionContent } = versionResult.value;

    // Put the new version into the live document on both transports and
    // signal open editors. `reset-room=false` (Save Version) leaves the live
    // draft as it is.
    const resetRoom =
      request.nextUrl.searchParams.get("reset-room") !== "false";
    if (resetRoom) {
      log.info("[document-room] Resetting room after version create", {
        documentId: resolvedId,
        version: updatedArtifact.latestVersion,
      });
      // The stored content: an inline-image publish's `versionContent` is
      // the body before `createVersion` sanitized it.
      const storedContent =
        updatedArtifact.latestVersionContent ?? versionContent;
      await resetDocumentRoom(updatedArtifact, user.id, storedContent).catch(
        (error) => {
          log.error(
            "[document-room] Failed to reset room after version create",
            {
              documentId: resolvedId,
              version: updatedArtifact.latestVersion,
              error: error instanceof Error ? error.message : String(error),
            }
          );
          scheduleLogFlush();
        }
      );
    }

    scheduleLogFlush();
    return successResponse(
      withOperationReceipt(
        shapeCreateDocumentVersionResponse(
          updatedArtifact,
          versionResult.value
        ),
        receipts
      )
    );
  } catch (error) {
    return errorResponse("Failed to create new version", error);
  }
}

/**
 * ISS-12552: the version save's operation receipt, written inside the save's
 * transaction. An identical save is a no-op: it still creates the version row,
 * but changes no content, so it never qualifies as a revision.
 */
function versionReceipt(
  receipts: OperationReceiptRecorder
): RecordVersionCreated {
  return (tx, info) =>
    receipts.record(tx, {
      operationKind: OperationKind.CreateVersion,
      outcome: info.contentChanged
        ? OperationReceiptOutcome.Committed
        : OperationReceiptOutcome.NoOp,
      targetArtifactId: info.documentId,
      versionNumber: info.versionNumber,
      changedFields: info.contentChanged ? ["content"] : [],
      ...(info.contentDigestBefore
        ? { contentDigestBefore: info.contentDigestBefore }
        : {}),
      ...(info.contentDigestAfter
        ? { contentDigestAfter: info.contentDigestAfter }
        : {}),
    });
}

async function createContentOnlyVersion(
  resolvedId: string,
  organizationId: string,
  userId: string,
  content: string,
  recordVersion: RecordVersionCreated | undefined
): Promise<CreateDocumentVersionRouteResult> {
  const document = await documentVersionService.createNewVersion(
    resolvedId,
    organizationId,
    userId,
    content,
    recordVersion
  );
  if (!document) {
    return {
      ok: false,
      error: { code: CreateDocumentVersionErrorCode.DocumentNotFound },
    };
  }
  return {
    ok: true,
    value: {
      document,
      inlineImages: [],
      versionContent: document.latestVersionContent ?? content,
    },
  };
}

function shapeCreateDocumentVersionResponse(
  document: DocumentDetail,
  result: CreateDocumentVersionRouteSuccess
): CreateDocumentVersionResponse {
  if (result.inlineImages.length === 0) {
    return document;
  }
  return {
    ...document,
    inlineImages: result.inlineImages,
    versionContent: result.versionContent,
  };
}

function mapCreateDocumentVersionFailure(
  error: CreateDocumentVersionRouteError
) {
  switch (error.code) {
    case CreateDocumentVersionErrorCode.DocumentNotFound:
      return notFoundResponse("Artifact");
    case CreateDocumentVersionErrorCode.DuplicateInlineImagePlaceholder:
      return badInlineImageVersionResponse(
        "Inline image placeholders must be unique",
        error
      );
    case CreateDocumentVersionErrorCode.MissingInlineImagePlaceholder:
      return badInlineImageVersionResponse(
        "Inline image placeholder must appear in content",
        error
      );
    case CreateDocumentVersionErrorCode.OverlappingInlineImagePlaceholder:
      return badInlineImageVersionResponse(
        "Inline image placeholders must not overlap",
        error
      );
    case CreateDocumentVersionErrorCode.RequestBodyTooLarge:
      return payloadTooLargeResponse(
        "Document version inline image request is too large",
        {
          code: error.code,
          details: buildCreateDocumentVersionErrorDetails(error),
        }
      );
    case CreateDocumentVersionErrorCode.ExpandedContentTooLarge:
      return payloadTooLargeResponse(
        "Expanded document version content is too large",
        {
          code: error.code,
          details: buildCreateDocumentVersionErrorDetails(error),
        }
      );
    case CreateDocumentVersionErrorCode.InlineImageCreationFailed:
      return error.inlineImageError
        ? mapCreateInlineImageAttachmentFailure(error.inlineImageError)
        : NextResponse.json(
            failure("Inline image creation failed", {
              code: error.code,
              details: buildCreateDocumentVersionErrorDetails(error),
            }),
            { status: 500 }
          );
    case CreateDocumentVersionErrorCode.VersionCreationFailed:
      return NextResponse.json(
        failure("Failed to create document version", {
          code: error.code,
          details: buildCreateDocumentVersionErrorDetails(error),
        }),
        { status: 500 }
      );
    default:
      return badInlineImageVersionResponse(
        getUnhandledCreateDocumentVersionFallback(error.code),
        error
      );
  }
}

function badInlineImageVersionResponse(
  message: string,
  error: CreateDocumentVersionRouteError
) {
  return NextResponse.json(
    failure(message, {
      code: error.code,
      details: buildCreateDocumentVersionErrorDetails(error),
    }),
    { status: 400 }
  );
}

function buildCreateDocumentVersionErrorDetails(
  error: CreateDocumentVersionRouteError
) {
  return {
    ...(error.placeholder === undefined
      ? {}
      : { placeholder: error.placeholder }),
    ...(error.cleanupFailed === undefined
      ? {}
      : { cleanupFailed: error.cleanupFailed }),
    ...(error.cleanupFailedCount === undefined
      ? {}
      : { cleanupFailedCount: error.cleanupFailedCount }),
    ...(error.estimatedContentChars === undefined
      ? {}
      : { estimatedContentChars: error.estimatedContentChars }),
    ...(error.maxContentChars === undefined
      ? {}
      : { maxContentChars: error.maxContentChars }),
    ...(error.requestBodyBytes === undefined
      ? {}
      : { requestBodyBytes: error.requestBodyBytes }),
    ...(error.maxBytes === undefined ? {} : { maxBytes: error.maxBytes }),
  };
}

function getUnhandledCreateDocumentVersionFallback(
  _code: never
): "Invalid document version request" {
  return "Invalid document version request";
}

type CreateDocumentVersionRouteSuccess = {
  document: DocumentDetail;
  versionContent: string;
  inlineImages: CreatedDocumentVersionInlineImage[];
};

type CreateDocumentVersionRouteError = CreateDocumentVersionError;

type CreateDocumentVersionRouteResult =
  | { ok: true; value: CreateDocumentVersionRouteSuccess }
  | { ok: false; error: CreateDocumentVersionRouteError };

type CreateDocumentVersionResponse = DocumentDetail & {
  versionContent?: string;
  inlineImages?: CreatedDocumentVersionInlineImage[];
  /** ISS-12552: present on API-key writes only. */
  operationReceipt?: OperationReceipt;
};

type CreateDocumentVersionRequestBody = z.infer<typeof newVersionValidator>;

type CreateDocumentVersionBodyResult =
  | {
      body: CreateDocumentVersionRequestBody;
      errorResponse: null;
    }
  | {
      body: null;
      errorResponse: NextResponse<ApiResult<never>>;
    };

async function parseCreateDocumentVersionBody(
  request: Request
): Promise<CreateDocumentVersionBodyResult> {
  const bodyTextResult = await readInlineImageAwareRequestText(
    request,
    MAX_CREATE_DOCUMENT_VERSION_REQUEST_BODY_BYTES
  );
  if (!bodyTextResult.ok) {
    return {
      body: null,
      errorResponse: mapCreateDocumentVersionFailure({
        code: CreateDocumentVersionErrorCode.RequestBodyTooLarge,
        maxBytes: MAX_CREATE_DOCUMENT_VERSION_REQUEST_BODY_BYTES,
        requestBodyBytes: bodyTextResult.requestBodyBytes,
      }),
    };
  }

  let rawBody: unknown;
  try {
    rawBody = JSON.parse(bodyTextResult.value) as unknown;
  } catch {
    return {
      body: null,
      errorResponse: NextResponse.json(failure("Invalid JSON body"), {
        status: 400,
      }),
    };
  }

  if (
    hasInlineImageInputs(rawBody) &&
    bodyTextResult.requestBodyBytes >
      MAX_CREATE_DOCUMENT_VERSION_REQUEST_BODY_BYTES
  ) {
    return {
      body: null,
      errorResponse: mapCreateDocumentVersionFailure({
        code: CreateDocumentVersionErrorCode.RequestBodyTooLarge,
        maxBytes: MAX_CREATE_DOCUMENT_VERSION_REQUEST_BODY_BYTES,
        requestBodyBytes: bodyTextResult.requestBodyBytes,
      }),
    };
  }

  const parseResult = newVersionValidator.safeParse(rawBody);
  if (!parseResult.success) {
    return {
      body: null,
      errorResponse: NextResponse.json(
        failure(formatZodErrors(parseResult.error.issues)),
        { status: 400 }
      ),
    };
  }

  return { body: parseResult.data, errorResponse: null };
}
