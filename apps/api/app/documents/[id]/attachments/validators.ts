import {
  AttachmentPurpose,
  AttachmentPurposeSelector,
  IMAGE_MIME_TYPES,
  isImageMimeType,
  MAX_ATTACHMENT_FILE_SIZE_BYTES,
} from "@repo/api/src/types/attachment";
import { z } from "zod";

export const ALLOWED_MIME_TYPES: string[] = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "text/csv",
  "application/json",
  "text/plain",
  "text/markdown",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

export const MAX_FILE_SIZE_BYTES = MAX_ATTACHMENT_FILE_SIZE_BYTES;

export const createAttachmentValidator = z
  .object({
    filename: z.string().min(1),
    mimeType: z.enum(ALLOWED_MIME_TYPES as [string, ...string[]]),
    sizeBytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
    purpose: z
      .enum([AttachmentPurpose.Context, AttachmentPurpose.Inline])
      .default(AttachmentPurpose.Context),
  })
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
  attachmentIds: z.array(z.uuid()).min(1).max(50),
});

export type CreateAttachmentInput = z.infer<typeof createAttachmentValidator>;
