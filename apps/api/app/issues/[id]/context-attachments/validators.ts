import { z } from "zod";

import { ALLOWED_MIME_TYPES } from "@/app/artifacts/[id]/attachments/validators";

export const CONTEXT_ATTACHMENT_MIME_TYPES = [
  ...ALLOWED_MIME_TYPES,
  "video/mp4",
  "video/webm",
  "video/quicktime",
] as const;

export const CONTEXT_ATTACHMENT_MAX_SIZE_BYTES = 500 * 1024 * 1024;

export const createContextAttachmentValidator = z.object({
  filename: z.string().min(1),
  mimeType: z.enum(
    CONTEXT_ATTACHMENT_MIME_TYPES as unknown as [string, ...string[]]
  ),
  sizeBytes: z.number().int().positive().max(CONTEXT_ATTACHMENT_MAX_SIZE_BYTES),
  projectId: z.string().uuid().optional(),
});

export type CreateContextAttachmentInput = z.infer<
  typeof createContextAttachmentValidator
>;

export const importGDriveContextValidator = z.object({
  docIds: z.array(z.string().min(1)).min(1).max(100),
  projectId: z.string().uuid(),
});

export type ImportGDriveContextInput = z.infer<
  typeof importGDriveContextValidator
>;
