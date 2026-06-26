import { TagColor, TagEntityType } from "@repo/api/src/types/tag";
import { z } from "zod";

const TAG_NAME_REGEX = /^[a-zA-Z0-9 -]+$/;

const tagColorEnum = z.enum(TagColor);
const tagEntityTypeEnum = z.enum(TagEntityType);

export const createTagValidator = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(
      TAG_NAME_REGEX,
      "Name may only contain letters, numbers, spaces, and hyphens"
    ),
  color: tagColorEnum.optional(),
});

export const updateTagValidator = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(
      TAG_NAME_REGEX,
      "Name may only contain letters, numbers, spaces, and hyphens"
    )
    .optional(),
  color: tagColorEnum.optional(),
});

export const entityTagValidator = z.object({
  tagId: z.uuid(),
  entityType: tagEntityTypeEnum,
  entityId: z.uuid(),
});

export const batchEntityTagValidator = z.object({
  tagId: z.uuid(),
  // Batch apply is artifact-only — the service writes `tagArtifact` rows only.
  entityType: z.literal(TagEntityType.Artifact),
  entityIds: z
    .array(z.uuid())
    .min(1, "At least one entity ID required")
    .max(500),
});
