import { Priority } from "@repo/api/src/types/common";
import { FeatureStatus } from "@repo/api/src/types/feature";
import { z } from "zod";
import { uuidOrSlug } from "@/lib/identifier-utils";

const featureStatusEnum = z.enum(FeatureStatus);
const priorityEnum = z.enum(Priority);

export const createFeatureValidator = z.object({
  workstreamId: uuidOrSlug().optional(),
  projectId: uuidOrSlug(),
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  status: featureStatusEnum.optional(),
  priority: priorityEnum.optional(),
  assigneeId: z.uuid().optional(),
});

export const updateFeatureValidator = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: featureStatusEnum.optional(),
  priority: priorityEnum.optional(),
  assigneeId: z.uuid().nullable().optional(),
  projectId: uuidOrSlug().optional(),
  customFields: z
    .record(
      z.uuid(),
      z.union([
        z.string().max(10_000),
        z.number(),
        z.array(z.uuid()).max(100),
        z.null(),
      ])
    )
    .optional(),
});

export const findFeaturesQueryValidator = z.object({
  workstreamId: uuidOrSlug().optional(),
  projectId: uuidOrSlug().optional(),
  status: featureStatusEnum.optional(),
  priority: priorityEnum.optional(),
  assigneeId: z.uuid().optional(),
});
