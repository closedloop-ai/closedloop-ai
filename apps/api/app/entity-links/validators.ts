import {
  EntityType,
  LinkDirection,
  LinkQueryMode,
  LinkType,
} from "@repo/api/src/types/entity-link";
import { z } from "zod";
import { jsonObjectValidator } from "@/lib/validators/json";

const entityTypeEnum = z.enum(EntityType);
const linkTypeEnum = z.enum(LinkType);

export const createEntityLinkValidator = z.object({
  sourceId: z.uuid(),
  sourceType: entityTypeEnum,
  sourceVersion: z.number().int().positive().optional(),
  targetId: z.uuid(),
  targetType: entityTypeEnum,
  targetVersion: z.number().int().positive().optional(),
  linkType: linkTypeEnum,
  metadata: jsonObjectValidator.nullable().optional(),
});

export const findEntityLinksQueryValidator = z.object({
  entityId: z.uuid(),
  entityType: entityTypeEnum,
  linkType: linkTypeEnum.optional(),
  direction: z.enum(LinkDirection).optional().default(LinkDirection.Both),
  mode: z.enum(LinkQueryMode).optional().default(LinkQueryMode.Direct),
  maxDepth: z.coerce.number().int().min(1).max(50).optional().default(10),
});
