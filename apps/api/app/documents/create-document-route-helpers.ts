import {
  type ApiResult,
  failure,
  type JsonObject,
} from "@repo/api/src/types/common";
import {
  CreateDocumentErrorCode,
  type CreateDocumentRequestBody,
  type CreateDocumentResponse,
  type CreatedDocumentInlineImage,
  type Document,
  MAX_CREATE_DOCUMENT_INLINE_IMAGE_REQUEST_BODY_BYTES,
} from "@repo/api/src/types/document";
import { NextResponse } from "next/server";
import { mapCreateInlineImageAttachmentFailure } from "@/app/documents/attachment-route-responses";
import type {
  CreateDocumentError,
  CreateDocumentWithInlineImagesSuccess,
} from "@/app/documents/document-service";
import {
  badRequestResponse,
  formatZodErrors,
  payloadTooLargeResponse,
} from "@/lib/route-utils";
import {
  hasInlineImageInputs,
  readInlineImageAwareRequestText,
} from "./inline-image-request-body";
import { createDocumentValidator } from "./validators";

export function shapeCreateDocumentResponse(
  document: Document,
  result: CreateDocumentWithInlineImagesSuccess
): CreateDocumentResponse {
  if (result.inlineImages.length === 0) {
    return document;
  }
  return {
    ...document,
    inlineImages: result.inlineImages.map(toCreatedDocumentInlineImageResponse),
    versionContent: result.versionContent,
  };
}

export function mapCreateDocumentFailure(error: CreateDocumentError) {
  switch (error.code) {
    case CreateDocumentErrorCode.DocumentCreateFailed:
      return badRequestResponse("Failed to create document", {
        code: error.code,
        details: buildCreateDocumentErrorDetails(error),
      });
    case CreateDocumentErrorCode.DuplicateInlineImagePlaceholder:
      return badInlineImageCreateResponse(
        "Inline image placeholders must be unique",
        error
      );
    case CreateDocumentErrorCode.MissingInlineImagePlaceholder:
      return badInlineImageCreateResponse(
        "Inline image placeholder must appear in content",
        error
      );
    case CreateDocumentErrorCode.OverlappingInlineImagePlaceholder:
      return badInlineImageCreateResponse(
        "Inline image placeholders must not overlap",
        error
      );
    case CreateDocumentErrorCode.RequestBodyTooLarge:
      return payloadTooLargeResponse(
        "Create document inline image request is too large",
        {
          code: error.code,
          details: buildCreateDocumentErrorDetails(error),
        }
      );
    case CreateDocumentErrorCode.ExpandedContentTooLarge:
      return payloadTooLargeResponse("Expanded document content is too large", {
        code: error.code,
        details: buildCreateDocumentErrorDetails(error),
      });
    case CreateDocumentErrorCode.InlineImageCreationFailed:
      return error.inlineImageError
        ? mapCreateInlineImageAttachmentFailure(
            error.inlineImageError,
            buildCreateDocumentErrorDetails(error)
          )
        : NextResponse.json(
            failure("Inline image creation failed", {
              code: error.code,
              details: buildCreateDocumentErrorDetails(error),
            }),
            { status: 500 }
          );
    case CreateDocumentErrorCode.VersionContentUpdateFailed:
      return NextResponse.json(
        failure("Failed to update created document content", {
          code: error.code,
          details: buildCreateDocumentErrorDetails(error),
        }),
        { status: 500 }
      );
    default:
      return badInlineImageCreateResponse(
        getUnhandledCreateDocumentFallback(error.code),
        error
      );
  }
}

export async function parseCreateDocumentBody(
  request: Request
): Promise<CreateDocumentBodyResult> {
  const bodyTextResult = await readInlineImageAwareRequestText(
    request,
    MAX_CREATE_DOCUMENT_INLINE_IMAGE_REQUEST_BODY_BYTES
  );
  if (!bodyTextResult.ok) {
    return {
      body: null,
      errorResponse: mapCreateDocumentFailure({
        code: CreateDocumentErrorCode.RequestBodyTooLarge,
        maxBytes: MAX_CREATE_DOCUMENT_INLINE_IMAGE_REQUEST_BODY_BYTES,
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
      MAX_CREATE_DOCUMENT_INLINE_IMAGE_REQUEST_BODY_BYTES
  ) {
    return {
      body: null,
      errorResponse: mapCreateDocumentFailure({
        code: CreateDocumentErrorCode.RequestBodyTooLarge,
        maxBytes: MAX_CREATE_DOCUMENT_INLINE_IMAGE_REQUEST_BODY_BYTES,
        requestBodyBytes: bodyTextResult.requestBodyBytes,
      }),
    };
  }

  const parseResult = createDocumentValidator.safeParse(rawBody);
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

function badInlineImageCreateResponse(
  message: string,
  error: CreateDocumentError
) {
  return NextResponse.json(
    failure(message, {
      code: error.code,
      details: buildCreateDocumentErrorDetails(error),
    }),
    { status: 400 }
  );
}

function buildCreateDocumentErrorDetails(
  error: CreateDocumentError
): JsonObject {
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
    ...(error.documentCleanupFailed === undefined
      ? {}
      : { documentCleanupFailed: error.documentCleanupFailed }),
    ...(error.documentCleanupSkipped === undefined
      ? {}
      : { documentCleanupSkipped: error.documentCleanupSkipped }),
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

function getUnhandledCreateDocumentFallback(
  _code: never
): "Invalid create document request" {
  return "Invalid create document request";
}

function toCreatedDocumentInlineImageResponse(
  inlineImage: CreatedDocumentInlineImage
): CreatedDocumentInlineImage {
  return {
    attachmentId: inlineImage.attachmentId,
    attachmentRef: inlineImage.attachmentRef,
    markdownImage: inlineImage.markdownImage,
    placeholder: inlineImage.placeholder,
  };
}

type CreateDocumentBodyResult =
  | {
      body: CreateDocumentRequestBody;
      errorResponse: null;
    }
  | {
      body: null;
      errorResponse: NextResponse<ApiResult<never>>;
    };
