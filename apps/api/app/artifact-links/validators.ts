import {
  LinkDirection,
  LinkQueryMode,
  LinkType,
} from "@repo/api/src/types/artifact";
import { z } from "zod";
import { uuidOrSlug } from "@/lib/identifier-utils";
import { jsonObjectValidator } from "@/lib/validators/json";

const linkTypeEnum = z.enum(LinkType);

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

export const batchMoveArtifactsValidator = z.object({
  artifactId: z.uuid(),
  targetProjectId: z.uuid(),
  includeDownstream: z.boolean(),
});
