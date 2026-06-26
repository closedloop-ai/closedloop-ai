import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/**
 * Google OAuth integration keys.
 * Made optional because Google OAuth is an optional integration - validated at runtime
 * when the integration is actually used.
 *
 * - GOOGLE_CLIENT_ID: Needed by both app (OAuth initiation) and API (token exchange)
 * - GOOGLE_CLIENT_SECRET: Only needed by API (token exchange) - never expose to frontend
 */
export const keys = () =>
  createEnv({
    emptyStringAsUndefined: true,
    server: {
      GOOGLE_CLIENT_ID: z.string().min(1).optional(),
      GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    },
    runtimeEnv: {
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    },
  });
