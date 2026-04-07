import { EXTERNAL_LINK_TYPE_OPTIONS } from "@repo/api/src/types/external-link";
import { z } from "zod";
import { uuidOrSlug } from "@/lib/identifier-utils";
import { jsonObjectValidator } from "@/lib/validators/json";

const externalLinkTypeEnum = z.enum(EXTERNAL_LINK_TYPE_OPTIONS);

export const createExternalLinkValidator = z
  .object({
    workstreamId: uuidOrSlug().optional(),
    artifactId: uuidOrSlug().optional(),
    projectId: uuidOrSlug(),
    type: externalLinkTypeEnum,
    title: z.string().min(1, "Title is required"),
    externalUrl: z.url(),
    metadata: jsonObjectValidator.nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.workstreamId !== undefined && data.artifactId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either workstreamId or artifactId, not both",
        path: ["artifactId"],
      });
    }
  });

export const updateExternalLinkValidator = z.object({
  title: z.string().min(1).optional(),
  externalUrl: z.url().optional(),
  metadata: jsonObjectValidator.nullable().optional(),
});

export const findExternalLinksQueryValidator = z.object({
  workstreamId: uuidOrSlug().optional(),
  projectId: uuidOrSlug().optional(),
  type: externalLinkTypeEnum.optional(),
});
