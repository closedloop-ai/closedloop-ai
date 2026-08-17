/**
 * The failure contract for the whole inline-image attachment workflow — the
 * union `attachmentsService.createInlineImageAttachment` can return, spanning
 * the document lookup, the upload rate limit, the S3 write, and the persistence
 * step as well as payload validation.
 *
 * It lives in its own module rather than in `attachments-service.ts` because
 * `attachment-route-responses.ts` maps these failures to HTTP and must not pull
 * the service's S3 and database import graph into a response translator; and it
 * is deliberately NOT in `inline-image-bytes.ts` (wongk, ISS-6320), which sniffs
 * magic numbers and knows nothing about lookups, limits, or storage. That module
 * emits its own narrower `InlineImageValidationError`, which widens into this
 * one.
 */

import type { CreateInlineImageAttachmentErrorCode } from "@repo/api/src/types/attachment";

export type CreateInlineImageAttachmentError = {
  code: CreateInlineImageAttachmentErrorCode;
  actualBytes?: number;
  maxBytes?: number;
  retryAfterSeconds?: number;
};
