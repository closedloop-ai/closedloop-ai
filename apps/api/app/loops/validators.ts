import { z } from "zod";

export const createLoopValidator = z.object({
  command: z.enum(["PLAN", "EXECUTE", "CHAT", "EXPLORE", "REQUEST_CHANGES"]),
  artifactId: z.string().uuid().optional(),
  workstreamId: z.string().uuid().optional(),
  prompt: z.string().optional(),
  repo: z
    .object({
      fullName: z.string(),
      branch: z.string(),
    })
    .optional(),
  contextRefs: z
    .array(
      z.object({
        artifactId: z.string().uuid(),
        include: z.enum(["full", "summary"]),
      })
    )
    .optional(),
});

export const resumeLoopValidator = z.object({
  prompt: z.string().optional(),
});

export const loopEventValidator = z.object({
  type: z.string(),
  data: z.record(z.string(), z.unknown()).default({}),
});

export const listLoopsQueryValidator = z.object({
  status: z
    .enum([
      "PENDING",
      "CLAIMED",
      "RUNNING",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "TIMED_OUT",
    ])
    .optional(),
  command: z
    .enum(["PLAN", "EXECUTE", "CHAT", "EXPLORE", "REQUEST_CHANGES"])
    .optional(),
  artifactId: z.string().uuid().optional(),
  workstreamId: z.string().uuid().optional(),
  limit: z.coerce.number().min(1).max(100).default(50).optional(),
  offset: z.coerce.number().min(0).default(0).optional(),
});
