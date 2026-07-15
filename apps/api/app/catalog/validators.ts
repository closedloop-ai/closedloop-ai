import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

const coachingConfigSchema = z.object({
  signals: z.array(z.string().min(1)).min(1),
});

// ---------------------------------------------------------------------------
// GET /catalog query params
// ---------------------------------------------------------------------------

export const listCatalogQuerySchema = z.object({
  includeArchived: z
    .string()
    .transform((v) => v === "true")
    .optional(),
});

// ---------------------------------------------------------------------------
// POST /catalog body
// ---------------------------------------------------------------------------

export const createCatalogItemBodySchema = z
  .object({
    // "pack" is the container kind; the rest are the component kinds a Pack holds.
    targetKind: z.enum([
      "pack",
      "plugin",
      "skill",
      "command",
      "agent",
      "hook",
      "mcp",
    ]),
    name: z.string().min(1).max(256),
    description: z.string().max(2048).optional(),
    sortOrder: z.number().int().min(0).optional(),
    coaching: z.boolean().optional(),
    coachingConfig: coachingConfigSchema.optional(),
    /** Parent Pack id when creating a component inside a Pack. */
    parentPackId: z.string().uuid().optional(),
    /** Authored `.md` / config body persisted as the item's first version. */
    content: z.string().max(1_048_576).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// PATCH /catalog/:id body
// ---------------------------------------------------------------------------

export const updateCatalogItemBodySchema = z
  .object({
    name: z.string().min(1).max(256).optional(),
    description: z.string().max(2048).optional(),
    sortOrder: z.number().int().min(0).optional(),
    enabled: z.boolean().optional(),
    coaching: z.boolean().optional(),
    coachingConfig: coachingConfigSchema.optional(),
    /** New authored body; appended as a new version when present. */
    content: z.string().max(1_048_576).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// POST /catalog/upload-intent body
// ---------------------------------------------------------------------------

export const uploadIntentBodySchema = z
  .object({
    catalogItemId: z.string().uuid(),
    fileType: z.enum(["zip", "logo"]),
    contentType: z.string().min(1).max(128),
    fileSizeBytes: z.number().int().positive(),
  })
  .strict();

// ---------------------------------------------------------------------------
// POST /catalog/confirm body
// ---------------------------------------------------------------------------

export const confirmUploadBodySchema = z
  .object({
    catalogItemId: z.string().uuid(),
    fileType: z.enum(["zip", "logo"]),
    s3Key: z.string().min(1).max(1024),
  })
  .strict();

// ---------------------------------------------------------------------------
// POST /catalog/:id/import-repo body
// ---------------------------------------------------------------------------

export const importPackRepoBodySchema = z
  .object({
    repoFullName: z
      .string()
      .min(3)
      .max(256)
      .regex(/^[^/\s]+\/[^/\s]+$/, "Expected owner/name"),
    ref: z.string().min(1).max(256).optional(),
    subPath: z.string().max(512).optional(),
  })
  .strict();
