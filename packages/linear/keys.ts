import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/**
 * Linear integration keys.
 * Made optional because Linear is an optional integration - validated at runtime
 * when the integration is actually used.
 *
 * - LINEAR_CLIENT_ID: Needed by both app (OAuth initiation) and API (token exchange)
 * - LINEAR_CLIENT_SECRET: Only needed by API (token exchange) - never expose to frontend
 */
export const keys = () =>
  createEnv({
    emptyStringAsUndefined: true,
    server: {
      LINEAR_CLIENT_ID: z.string().min(1).optional(),
      LINEAR_CLIENT_SECRET: z.string().min(1).optional(),
    },
    runtimeEnv: {
      LINEAR_CLIENT_ID: process.env.LINEAR_CLIENT_ID,
      LINEAR_CLIENT_SECRET: process.env.LINEAR_CLIENT_SECRET,
    },
  });
