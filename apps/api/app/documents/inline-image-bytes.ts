/**
 * Decoding and format-sniffing for an inline image upload: is the payload
 * canonical base64, is it within the size cap, and do its leading bytes agree
 * with the MIME type the caller claimed.
 *
 * Split out of `attachments-service.ts`, which owns attachment persistence and
 * signed URLs. Nothing here touches the database or S3 — it is pure byte
 * inspection over the request payload, and the magic-number table is the reason
 * a caller cannot pass `image/png` for a GIF.
 *
 * Accordingly it emits only `InlineImageValidationError`, the four codes byte
 * inspection can produce. The workflow-wide contract that also covers document
 * lookup, rate limiting, storage, and persistence is
 * `CreateInlineImageAttachmentError` in `./inline-image-attachment-contract`.
 */

import type { ImageMimeType } from "@repo/api/src/types/attachment";
import {
  CreateInlineImageAttachmentErrorCode as CreateInlineImageAttachmentErrorCodeContract,
  isImageMimeType,
  MAX_INLINE_IMAGE_ATTACHMENT_BYTES,
} from "@repo/api/src/types/attachment";
import {
  Result,
  type Result as ServiceResult,
} from "@repo/api/src/types/result";

const CANONICAL_BASE64_REGEX =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * The four codes this module can actually emit. The wider workflow contract —
 * document lookup, rate limit, storage, persistence — is
 * `CreateInlineImageAttachmentError` in `./inline-image-attachment-contract`,
 * which this widens into at the call site.
 */
export type InlineImageValidationErrorCode =
  | typeof CreateInlineImageAttachmentErrorCodeContract.InvalidBase64
  | typeof CreateInlineImageAttachmentErrorCodeContract.MimeMismatch
  | typeof CreateInlineImageAttachmentErrorCodeContract.PayloadTooLarge
  | typeof CreateInlineImageAttachmentErrorCodeContract.UnsupportedMimeType;

export type InlineImageValidationError = {
  code: InlineImageValidationErrorCode;
  actualBytes?: number;
  maxBytes?: number;
};

export function decodeInlineImageBase64(
  dataBase64: string
): ServiceResult<Uint8Array, InlineImageValidationError> {
  if (!(dataBase64.length > 0 && CANONICAL_BASE64_REGEX.test(dataBase64))) {
    return Result.err({
      code: CreateInlineImageAttachmentErrorCodeContract.InvalidBase64,
    });
  }

  const decoded = Buffer.from(dataBase64, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== dataBase64) {
    return Result.err({
      code: CreateInlineImageAttachmentErrorCodeContract.InvalidBase64,
    });
  }
  if (decoded.byteLength > MAX_INLINE_IMAGE_ATTACHMENT_BYTES) {
    return Result.err({
      actualBytes: decoded.byteLength,
      code: CreateInlineImageAttachmentErrorCodeContract.PayloadTooLarge,
      maxBytes: MAX_INLINE_IMAGE_ATTACHMENT_BYTES,
    });
  }
  return Result.ok(decoded);
}

export function validateInlineImageBytes(
  mimeType: string,
  bytes: Uint8Array
): ServiceResult<void, InlineImageValidationError> {
  if (!isImageMimeType(mimeType)) {
    return Result.err({
      code: CreateInlineImageAttachmentErrorCodeContract.UnsupportedMimeType,
    });
  }
  if (!matchesImageMimeType(mimeType, bytes)) {
    return Result.err({
      code: CreateInlineImageAttachmentErrorCodeContract.MimeMismatch,
    });
  }
  return Result.ok(undefined);
}

function matchesImageMimeType(
  mimeType: ImageMimeType,
  bytes: Uint8Array
): boolean {
  switch (mimeType) {
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png":
      return startsWithBytes(bytes, PNG_SIGNATURE);
    case "image/gif":
      return (
        startsWithAscii(bytes, "GIF87a") || startsWithAscii(bytes, "GIF89a")
      );
    case "image/webp":
      return (
        startsWithAscii(bytes, "RIFF") &&
        bytes.length >= 12 &&
        startsWithAscii(bytes.subarray(8, 12), "WEBP")
      );
    default:
      return assertUnhandledImageMimeType(mimeType);
  }
}

function assertUnhandledImageMimeType(mimeType: never): never {
  throw new Error(`Unhandled image MIME type: ${mimeType}`);
}

function startsWithBytes(
  bytes: Uint8Array,
  prefix: readonly number[]
): boolean {
  if (bytes.length < prefix.length) {
    return false;
  }
  return prefix.every((value, index) => bytes[index] === value);
}

function startsWithAscii(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) {
    return false;
  }
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}
