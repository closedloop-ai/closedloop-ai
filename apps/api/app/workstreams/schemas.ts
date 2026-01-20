import {
  WORKSTREAM_STATE_OPTIONS,
  WORKSTREAM_TYPE_OPTIONS,
} from "@repo/api/src/types/workstream";
import { z } from "zod";

const workstreamTypeEnum = z.enum(WORKSTREAM_TYPE_OPTIONS);
const workstreamStateEnum = z.enum(WORKSTREAM_STATE_OPTIONS);

export const createWorkstreamSchema = z.object({
  projectId: z.string().min(1, "projectId is required"),
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  type: workstreamTypeEnum.optional(),
  assignedToId: z.string().optional(),
  hasUIChanges: z.boolean().optional(),
});

export const updateWorkstreamSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  state: workstreamStateEnum.optional(),
  type: workstreamTypeEnum.optional(),
  assignedToId: z.string().nullable().optional(),
  hasUIChanges: z.boolean().optional(),
});
