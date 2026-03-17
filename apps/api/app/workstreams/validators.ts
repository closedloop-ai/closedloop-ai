import { Priority } from "@repo/api/src/types/common";
import {
  WORKSTREAM_STATE_OPTIONS,
  WORKSTREAM_TYPE_OPTIONS,
} from "@repo/api/src/types/workstream";
import { z } from "zod";

const workstreamTypeEnum = z.enum(WORKSTREAM_TYPE_OPTIONS);
const workstreamStateEnum = z.enum(WORKSTREAM_STATE_OPTIONS);
const priorityEnum = z.enum(Priority);

export const createWorkstreamValidator = z.object({
  projectId: z.uuid(),
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  type: workstreamTypeEnum.optional(),
  assigneeId: z.uuid().nullable().optional(),
  priority: priorityEnum.optional(),
  slug: z.string().nullable().optional(),
  hasUIChanges: z.boolean().optional(),
});

export const updateWorkstreamValidator = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  state: workstreamStateEnum.optional(),
  type: workstreamTypeEnum.optional(),
  assigneeId: z.uuid().nullable().optional(),
  priority: priorityEnum.optional(),
  slug: z.string().nullable().optional(),
  hasUIChanges: z.boolean().optional(),
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
