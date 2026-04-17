import {
  CURRENT_DESKTOP_API_NAMESPACE,
  LEGACY_DESKTOP_API_NAMESPACE,
} from "@repo/api/src/desktop-api-namespace";
import { z } from "zod";
import { repoSchema } from "@/app/loops/validators";
import { COMMAND_MAP } from "./run-loop-helpers";

const loopCommands = Object.keys(COMMAND_MAP) as (keyof typeof COMMAND_MAP)[];

export const runLoopSchema = z.object({
  command: z.enum(loopCommands),
  prompt: z.string().max(100_000).optional(),
  repo: repoSchema.optional(),
  computeTargetId: z.uuid().nullable().optional(),
  desktopApiNamespace: z
    .enum([CURRENT_DESKTOP_API_NAMESPACE, LEGACY_DESKTOP_API_NAMESPACE])
    .optional(),
  backendOverride: z.boolean().optional(),
});

export type RunLoopBody = z.infer<typeof runLoopSchema>;
