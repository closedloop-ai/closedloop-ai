import { EXTERNAL_LINK_TYPE_OPTIONS } from "@repo/api/src/types/external-link";
import { z } from "zod";
import { jsonObjectValidator } from "@/lib/validators/json";

const externalLinkTypeEnum = z.enum(EXTERNAL_LINK_TYPE_OPTIONS);

export const createExternalLinkValidator = z.object({
  workstreamId: z.uuidv7().optional(),
  projectId: z.uuidv7(),
  type: externalLinkTypeEnum,
  title: z.string().min(1, "Title is required"),
  externalUrl: z.url(),
  metadata: jsonObjectValidator.nullable().optional(),
});

export const updateExternalLinkValidator = z.object({
  title: z.string().min(1).optional(),
  externalUrl: z.url().optional(),
  metadata: jsonObjectValidator.nullable().optional(),
});

export const findExternalLinksQueryValidator = z.object({
  workstreamId: z.uuidv7().optional(),
  projectId: z.uuidv7().optional(),
  type: externalLinkTypeEnum.optional(),
});
