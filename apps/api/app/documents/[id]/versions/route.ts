import { type ApiResult, failure } from "@repo/api/src/types/common";
import type { DocumentDetail } from "@repo/api/src/types/document";
import {
  CreateDocumentVersionErrorCode,
  type CreatedDocumentVersionInlineImage,
  type DocumentVersion,
  MAX_CREATE_DOCUMENT_VERSION_REQUEST_BODY_BYTES,
} from "@repo/api/src/types/document-version";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import type { z } from "zod";
import {
  forbiddenAttachmentUploadResponse,
  mapCreateInlineImageAttachmentFailure,
} from "@/app/documents/attachment-route-responses";
import { isMcpAttachmentUploadEnabled } from "@/app/documents/attachment-upload-feature";
import { documentService } from "@/app/documents/document-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
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
  documentVersionService,
} from "../../document-version-service";
import {
  hasInlineImageInputs,
  readInlineImageAwareRequestText,
} from "../../inline-image-request-body";
import { resetDocumentRoom } from "../../room-utils";
import { newVersionValidator } from "../../validators";

export const GET = withAnyAuth<
  Pick<
    DocumentVersion,
    "id" | "documentId" | "version" | "createdById" | "createdAt"
  >[],
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
>(
  async ({ authMethod, clerkUserId, user }, request, params) => {
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

      const versionResult = hasInlineImages
        ? await documentVersionService.createNewVersionWithInlineImages(
            resolvedId,
            user.organizationId,
            user.id,
            body.content,
            inlineImages
          )
        : await createContentOnlyVersion(
            resolvedId,
            user.organizationId,
            user.id,
            body.content
          );
      if (versionResult.ok === false) {
        return mapCreateDocumentVersionFailure(versionResult.error);
      }
      const { document: updatedArtifact } = versionResult.value;

      // Reset the Liveblocks room when a new version is created.
      // This allows the room to be reset with the new content the next time a user opens the
      // artifact editor.
      const resetRoom =
        request.nextUrl.searchParams.get("reset-room") !== "false";
      if (resetRoom) {
        log.info("[liveblocks] Resetting room after version create", {
          documentId: resolvedId,
          version: updatedArtifact.latestVersion,
        });
        await resetDocumentRoom(updatedArtifact, user.id).catch((error) => {
          log.error("[liveblocks] Failed to reset room after version create", {
            documentId: resolvedId,
            version: updatedArtifact.latestVersion,
            error: error instanceof Error ? error.message : String(error),
          });
          scheduleLogFlush();
        });
      }

      scheduleLogFlush();
      return successResponse(
        shapeCreateDocumentVersionResponse(updatedArtifact, versionResult.value)
      );
    } catch (error) {
      return errorResponse("Failed to create new version", error);
    }
  },
  { requiredScopes: ["write"] }
);

async function createContentOnlyVersion(
  resolvedId: string,
  organizationId: string,
  userId: string,
  content: string
): Promise<CreateDocumentVersionRouteResult> {
  const document = await documentVersionService.createNewVersion(
    resolvedId,
    organizationId,
    userId,
    content
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
