import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  AttachmentPurpose,
  AttachmentPurposeSelector,
  IMAGE_MIME_TYPES,
  isImageMimeType,
  isMediaMimeType,
  MAX_ATTACHMENT_FILE_SIZE_BYTES,
  MAX_INLINE_IMAGE_RESOLVE_BATCH_SIZE,
  MAX_MEDIA_FILE_SIZE_BYTES,
} from "@repo/api/src/types/attachment";
import { z } from "zod";

// ISS-10415: the allow-list, the media split and the media ceiling are owned by
// `@closedloop-ai/loops-api/attachment`, not by this route directory. They started here,
// which is exactly why neither the attach-files picker nor the MCP upload tool
// could import them, and both kept gating media at the document ceiling.
// Callers import them from `@repo/api/src/types/attachment` directly rather
// than through a re-export here.
export const ALLOWED_MIME_TYPES: string[] = [...ALLOWED_ATTACHMENT_MIME_TYPES];

export const MAX_FILE_SIZE_BYTES = MAX_ATTACHMENT_FILE_SIZE_BYTES;
export const MAX_ATTACHMENT_FILENAME_LENGTH = 255;

export const createAttachmentValidator = z
  .object({
    filename: z.string().min(1).max(MAX_ATTACHMENT_FILENAME_LENGTH),
    mimeType: z.enum(ALLOWED_MIME_TYPES as [string, ...string[]]),
    // Bounded by the LARGER ceiling here and narrowed per type below, so a
    // document cannot borrow the media allowance.
    sizeBytes: z.number().int().positive().max(MAX_MEDIA_FILE_SIZE_BYTES),
    purpose: z
      .enum([AttachmentPurpose.Context, AttachmentPurpose.Inline])
      .default(AttachmentPurpose.Context),
  })
  .refine(
    (input) =>
      isMediaMimeType(input.mimeType) || input.sizeBytes <= MAX_FILE_SIZE_BYTES,
    {
      message: `non-media attachments are limited to ${MAX_FILE_SIZE_BYTES} bytes`,
      path: ["sizeBytes"],
    }
  )
  .refine(
    (input) =>
      input.purpose !== AttachmentPurpose.Inline ||
      isImageMimeType(input.mimeType),
    {
      message: `inline attachments must use one of: ${IMAGE_MIME_TYPES.join(
        ", "
      )}`,
      path: ["mimeType"],
    }
  );

export const listAttachmentsQueryValidator = z.object({
  purpose: z
    .enum([
      AttachmentPurposeSelector.Context,
      AttachmentPurposeSelector.Inline,
      AttachmentPurposeSelector.All,
    ])
    .default(AttachmentPurposeSelector.Context),
});

export const resolveInlineImagesValidator = z.object({
  attachmentIds: z
    .array(z.uuid())
    .min(1)
    .max(MAX_INLINE_IMAGE_RESOLVE_BATCH_SIZE),
});

export const createInlineImageAttachmentValidator = z.object({
  filename: z.string().min(1).max(MAX_ATTACHMENT_FILENAME_LENGTH),
  mimeType: z.string().min(1),
  dataBase64: z.string().min(1),
});

export type CreateAttachmentInput = z.infer<typeof createAttachmentValidator>;
export type CreateInlineImageAttachmentInput = z.infer<
  typeof createInlineImageAttachmentValidator
>;
