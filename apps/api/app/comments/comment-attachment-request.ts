import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_MEDIA_FILE_SIZE_BYTES,
  maxAttachmentSizeBytesForMimeType,
} from "@repo/api/src/types/attachment";
import { z } from "zod";
import { MAX_ATTACHMENT_FILENAME_LENGTH } from "@/app/documents/[id]/attachments/validators";

/**
 * PLN-2187 T-2.3: `POST /comments/:commentId/attachments`, held to the document
 * attachment allow-list, name length and per-type size ceiling.
 */
export const createCommentAttachmentRequestSchema = z
  .object({
    name: z.string().min(1).max(MAX_ATTACHMENT_FILENAME_LENGTH),
    mimeType: z.enum(ALLOWED_ATTACHMENT_MIME_TYPES),
    size: z.number().int().positive().max(MAX_MEDIA_FILE_SIZE_BYTES),
  })
  .refine(
    (input) => input.size <= maxAttachmentSizeBytesForMimeType(input.mimeType),
    { path: ["size"] }
  );

export type CreateCommentAttachmentRequest = z.infer<
  typeof createCommentAttachmentRequestSchema
>;
