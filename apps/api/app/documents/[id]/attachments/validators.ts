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

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export const createAttachmentValidator = z.object({
  filename: z.string().min(1),
  mimeType: z.enum(ALLOWED_MIME_TYPES as [string, ...string[]]),
  sizeBytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
});

export type CreateAttachmentInput = z.infer<typeof createAttachmentValidator>;
