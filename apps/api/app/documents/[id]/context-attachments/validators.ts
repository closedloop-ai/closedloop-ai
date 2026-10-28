import { MAX_MEDIA_FILE_SIZE_BYTES } from "@repo/api/src/types/attachment";
import { z } from "zod";
import { ALLOWED_MIME_TYPES } from "@/app/documents/[id]/attachments/validators";

// ISS-10415: `video/mp4` and `video/quicktime` moved INTO the base list when
// artifact attachments learned to accept media, so spreading them again here
// would be a silent duplicate. `video/webm` is the one type this lane still adds
// on its own — no artifact-attachment case has asked for it.
export const CONTEXT_ATTACHMENT_MIME_TYPES = [
  ...ALLOWED_MIME_TYPES,
  "video/webm",
] as const;

// Aliases the artifact-attachment media ceiling rather than restating the
// literal: the two lanes accept the same media, so two independent `500 * 1024 *
// 1024` would drift silently the first time either one moved.
export const CONTEXT_ATTACHMENT_MAX_SIZE_BYTES = MAX_MEDIA_FILE_SIZE_BYTES;

export const createContextAttachmentValidator = z.object({
  filename: z.string().min(1),
  mimeType: z.enum(
    CONTEXT_ATTACHMENT_MIME_TYPES as unknown as [string, ...string[]]
  ),
  sizeBytes: z.number().int().positive().max(CONTEXT_ATTACHMENT_MAX_SIZE_BYTES),
  projectId: z.uuid().optional(),
});

export type CreateContextAttachmentInput = z.infer<
  typeof createContextAttachmentValidator
>;

export const importGDriveContextValidator = z.object({
  docIds: z.array(z.string().min(1)).min(1).max(100),
  projectId: z.uuid(),
});

export type ImportGDriveContextInput = z.infer<
  typeof importGDriveContextValidator
>;
