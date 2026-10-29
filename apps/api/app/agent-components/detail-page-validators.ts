import { z } from "zod";
import { decodeSessionTabCursor } from "./component-detail-cursor";
import { decodeInvocationReadCursor } from "./invocation-read-cursor";

export const sessionsPageQuerySchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(2048)
      .refine((value) => decodeSessionTabCursor(value) !== null)
      .optional(),
  })
  .strict();
export const invocationsPageQuerySchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => decodeInvocationReadCursor(value) !== null)
      .optional(),
  })
  .strict();
