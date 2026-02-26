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
  projectId: z.uuidv7(),
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  type: workstreamTypeEnum.optional(),
  assigneeId: z.uuidv7().nullable().optional(),
  priority: priorityEnum.optional(),
  slug: z.string().nullable().optional(),
  hasUIChanges: z.boolean().optional(),
});

export const updateWorkstreamValidator = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  state: workstreamStateEnum.optional(),
  type: workstreamTypeEnum.optional(),
  assigneeId: z.uuidv7().nullable().optional(),
  priority: priorityEnum.optional(),
  slug: z.string().nullable().optional(),
  hasUIChanges: z.boolean().optional(),
});
