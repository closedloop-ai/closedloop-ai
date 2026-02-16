import {
  ENTITY_TYPE_OPTIONS,
  LINK_TYPE_OPTIONS,
} from "@repo/api/src/types/entity-link";
import { z } from "zod";
import { jsonObjectValidator } from "@/lib/validators/json";

const entityTypeEnum = z.enum(ENTITY_TYPE_OPTIONS);
const linkTypeEnum = z.enum(LINK_TYPE_OPTIONS);

export const createEntityLinkValidator = z.object({
  sourceId: z.uuidv7(),
  sourceType: entityTypeEnum,
  sourceVersion: z.number().int().positive().optional(),
  targetId: z.uuidv7(),
  targetType: entityTypeEnum,
  targetVersion: z.number().int().positive().optional(),
  linkType: linkTypeEnum,
  metadata: jsonObjectValidator.nullable().optional(),
});

export const findEntityLinksQueryValidator = z.object({
  entityId: z.uuidv7(),
  entityType: entityTypeEnum,
  linkType: linkTypeEnum.optional(),
  direction: z.enum(["source", "target", "both"]).optional().default("both"),
});
