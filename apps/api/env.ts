import { keys as ai } from "@repo/ai/keys";
import { keys as analytics } from "@repo/analytics/keys";
import { keys as auth } from "@repo/auth/keys";
import { keys as collaboration } from "@repo/collaboration/server/keys";
import { keys as database } from "@repo/database/keys";
import { keys as email } from "@repo/email/keys";
import { keys as google } from "@repo/google/keys";
import { keys as linear } from "@repo/linear/keys";
import { keys as core } from "@repo/next-config/keys";
import { keys as observability } from "@repo/observability/keys";
import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";
import {
  hasStrongLocalGatewayJwtSecret,
  LOCAL_GATEWAY_JWT_MIN_SECRET_LENGTH,
  LOCAL_GATEWAY_JWT_MIN_UNIQUE_SECRET_CHARS,
} from "@/lib/auth/local-gateway-jwt-config";

// Note: @repo/github and @repo/aws keys are validated at runtime (not build time)
// because they're optional integrations. See isGitHubConfigured() / isS3Configured().
// @repo/linear keys are now optional and extended here.

export const env = createEnv({
  emptyStringAsUndefined: true,
  extends: [
    ai(),
    auth(),
    analytics(),
    collaboration(),
    core(),
    database(),
    email(),
    google(),
    linear(),
    observability(),
  ],
  server: {
    INTERNAL_API_SECRET: z.string().min(1).optional(),
    LOCAL_GATEWAY_JWT_SECRET: z
      .string()
      .min(LOCAL_GATEWAY_JWT_MIN_SECRET_LENGTH)
      .refine(hasStrongLocalGatewayJwtSecret, {
        message: `LOCAL_GATEWAY_JWT_SECRET must include at least ${LOCAL_GATEWAY_JWT_MIN_UNIQUE_SECRET_CHARS} unique characters`,
      })
      .optional(),
    RELAY_API_URL: z.url().optional(),
    SLACK_BOT_TOKEN: z.string().optional(),
    SLACK_SIGNING_SECRET: z.string().optional(),
  },
  client: {},
  runtimeEnv: {
    INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET,
    LOCAL_GATEWAY_JWT_SECRET: process.env.LOCAL_GATEWAY_JWT_SECRET,
    RELAY_API_URL: process.env.RELAY_API_URL,
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
  },
});
