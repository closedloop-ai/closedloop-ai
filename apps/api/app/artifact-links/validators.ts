import {
  LinkDirection,
  LinkQueryMode,
  LinkType,
} from "@repo/api/src/types/artifact";
import { z } from "zod";
import { uuidOrSlug } from "@/lib/identifier-utils";
import { jsonObjectValidator } from "@/lib/validators/json";

const linkTypeEnum = z.enum(LinkType);
const MAX_PARENT_TARGET_IDS = 100;

export const createArtifactLinkValidator = z.object({
  sourceId: uuidOrSlug(),
  targetId: uuidOrSlug(),
  linkType: linkTypeEnum,
  metadata: jsonObjectValidator.nullable().optional(),
});

export const findArtifactLinksQueryValidator = z.object({
  artifactId: uuidOrSlug(),
  linkType: linkTypeEnum.optional(),
  direction: z.enum(LinkDirection).optional().default(LinkDirection.Both),
  mode: z.enum(LinkQueryMode).optional().default(LinkQueryMode.Direct),
  maxDepth: z.coerce.number().int().min(1).max(50).optional().default(10),
});

/**
 * Query shape for the selected direct-parent projection endpoint. The endpoint
 * accepts artifact UUIDs only because callers already resolved document rows.
 */
export const findArtifactParentsQueryValidator = z.object({
  targetIds: z.preprocess(
    (value) => (typeof value === "string" ? [value] : value),
    z
      .array(z.uuid({ error: "targetIds must contain UUIDs only" }))
      .min(1, "targetIds must contain at least one id")
      .max(
        MAX_PARENT_TARGET_IDS,
        `targetIds must contain at most ${MAX_PARENT_TARGET_IDS} ids`
      )
  ),
  linkType: linkTypeEnum.optional().default(LinkType.Produces),
});

export const batchMoveArtifactsValidator = z.object({
  artifactId: z.uuid(),
  targetProjectId: z.uuid(),
  includeDownstream: z.boolean(),
});
