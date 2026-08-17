import {
  AttachmentUploadResponseErrorCode,
  CreateInlineImageAttachmentErrorCode,
  MAX_INLINE_IMAGE_ATTACHMENT_REQUEST_BODY_BYTES,
} from "@repo/api/src/types/attachment";
import { failure, type JsonObject } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { badRequestResponse, payloadTooLargeResponse } from "@/lib/route-utils";
import type { CreateInlineImageAttachmentError } from "./inline-image-attachment-contract";

/** Returns the shared MCP upload feature-flag denial response. */
export function forbiddenAttachmentUploadResponse() {
  return NextResponse.json(
    failure("MCP attachment upload is disabled", {
      code: AttachmentUploadResponseErrorCode.McpUploadDisabled,
    }),
    { status: 403 }
  );
}

/** Returns the shared attachment upload rate-limit response with retry metadata. */
export function attachmentUploadRateLimitResponse(retryAfterSeconds: number) {
  return NextResponse.json(
    failure("Attachment upload rate limit exceeded", {
      code: AttachmentUploadResponseErrorCode.RateLimited,
      details: { retryAfterSeconds },
    }),
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    }
  );
}

/** Returns the shared inline-image JSON request-size failure response. */
export function inlineImageRequestBodyTooLargeResponse() {
  return payloadTooLargeResponse(
    "Inline image attachment request is too large",
    {
      code: CreateInlineImageAttachmentErrorCode.PayloadTooLarge,
      details: {
        maxBytes: MAX_INLINE_IMAGE_ATTACHMENT_REQUEST_BODY_BYTES,
      },
    }
  );
}

/** Maps expected inline-image creation service failures to HTTP responses. */
export function mapCreateInlineImageAttachmentFailure(
  error: CreateInlineImageAttachmentError,
  additionalDetails?: JsonObject
) {
  switch (error.code) {
    case CreateInlineImageAttachmentErrorCode.DocumentNotFound:
      return NextResponse.json(
        failure(
          "Document not found",
          additionalDetails
            ? { code: error.code, details: additionalDetails }
            : undefined
        ),
        { status: 404 }
      );
    case CreateInlineImageAttachmentErrorCode.RateLimited:
      return inlineImageAttachmentRateLimitResponse(
        error.retryAfterSeconds ?? 1,
        additionalDetails
      );
    case CreateInlineImageAttachmentErrorCode.PayloadTooLarge:
      return payloadTooLargeResponse("Inline image attachment is too large", {
        code: error.code,
        details: mergeJsonDetails(
          {
            ...(error.actualBytes === undefined
              ? {}
              : { actualBytes: error.actualBytes }),
            ...(error.maxBytes === undefined
              ? {}
              : { maxBytes: error.maxBytes }),
          },
          additionalDetails
        ),
      });
    case CreateInlineImageAttachmentErrorCode.InvalidBase64:
    case CreateInlineImageAttachmentErrorCode.MimeMismatch:
    case CreateInlineImageAttachmentErrorCode.UnsupportedMimeType:
      return badRequestResponse(getBadRequestErrorMessage(error.code), {
        code: error.code,
        ...(additionalDetails ? { details: additionalDetails } : {}),
      });
    case CreateInlineImageAttachmentErrorCode.StorageUnconfigured:
      return NextResponse.json(
        failure("File attachment storage is not configured", {
          code: error.code,
          ...(additionalDetails ? { details: additionalDetails } : {}),
        }),
        { status: 503 }
      );
    case CreateInlineImageAttachmentErrorCode.StorageWriteFailed:
      return NextResponse.json(
        failure("Failed to store inline image attachment", {
          code: error.code,
          ...(additionalDetails ? { details: additionalDetails } : {}),
        }),
        { status: 502 }
      );
    case CreateInlineImageAttachmentErrorCode.PersistenceFailed:
      return NextResponse.json(
        failure("Failed to create inline image attachment", {
          code: error.code,
          ...(additionalDetails ? { details: additionalDetails } : {}),
        }),
        { status: 500 }
      );
    default:
      return badRequestResponse(
        getUnhandledCreateInlineImageFallback(error.code),
        {
          code: error.code,
          ...(additionalDetails ? { details: additionalDetails } : {}),
        }
      );
  }
}

type InlineImageBadRequestErrorCode =
  | typeof CreateInlineImageAttachmentErrorCode.InvalidBase64
  | typeof CreateInlineImageAttachmentErrorCode.MimeMismatch
  | typeof CreateInlineImageAttachmentErrorCode.UnsupportedMimeType;

function getBadRequestErrorMessage(
  code: InlineImageBadRequestErrorCode
): string {
  if (code === CreateInlineImageAttachmentErrorCode.InvalidBase64) {
    return "Inline image dataBase64 must be raw canonical base64";
  }
  if (code === CreateInlineImageAttachmentErrorCode.MimeMismatch) {
    return "Inline image bytes do not match the declared MIME type";
  }
  if (code === CreateInlineImageAttachmentErrorCode.UnsupportedMimeType) {
    return "Inline image MIME type is not supported";
  }
  return getUnhandledCreateInlineImageFallback(code);
}

function getUnhandledCreateInlineImageFallback(
  _code: never
): "Invalid inline image attachment" {
  return "Invalid inline image attachment";
}

function inlineImageAttachmentRateLimitResponse(
  retryAfterSeconds: number,
  additionalDetails: JsonObject | undefined
) {
  return NextResponse.json(
    failure("Attachment upload rate limit exceeded", {
      code: AttachmentUploadResponseErrorCode.RateLimited,
      details: mergeJsonDetails({ retryAfterSeconds }, additionalDetails),
    }),
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    }
  );
}

function mergeJsonDetails(
  baseDetails: JsonObject,
  additionalDetails: JsonObject | undefined
): JsonObject {
  return additionalDetails
    ? { ...baseDetails, ...additionalDetails }
    : baseDetails;
}
