import { POSTGRES_INT4_MAX } from "@closedloop-ai/loops-api/column-limits";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * The kinds a `CatalogItem` can target. "pack" is the container kind; the rest
 * are the component kinds a Pack holds.
 *
 * Exported because `catalog_items.target_kind` has more than one producer and
 * had grown more than one spelling of this list — an inline `z.enum` here and a
 * private const in `service/update-authorization.ts`. One owner, derived
 * everywhere else.
 */
export const CatalogTargetKind = {
  Agent: "agent",
  Command: "command",
  Hook: "hook",
  Mcp: "mcp",
  Pack: "pack",
  Plugin: "plugin",
  Skill: "skill",
} as const;
export type CatalogTargetKind =
  (typeof CatalogTargetKind)[keyof typeof CatalogTargetKind];

export const catalogTargetKindSchema = z.enum(CatalogTargetKind);

/**
 * `CatalogItem.sortOrder` is a Prisma `Int` (int4). The floor was already here;
 * the ceiling stops an out-of-range value reaching Prisma as an uncaught 500.
 */
const catalogSortOrderSchema = z
  .number()
  .int()
  .min(0)
  .max(POSTGRES_INT4_MAX)
  .optional();

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
    targetKind: catalogTargetKindSchema,
    name: z.string().min(1).max(256),
    description: z.string().max(2048).optional(),
    sortOrder: catalogSortOrderSchema,
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
    sortOrder: catalogSortOrderSchema,
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
