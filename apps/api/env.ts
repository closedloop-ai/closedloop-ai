import { keys as ai } from "@repo/ai/keys";
import { keys as analytics } from "@repo/analytics/keys";
import { keys as auth } from "@repo/auth/keys";
import { keys as database } from "@repo/database/keys";
import { keys as email } from "@repo/email/keys";
import { keys as google } from "@repo/google/keys";
import { keys as linear } from "@repo/linear/keys";
import { keys as core } from "@repo/next-config/keys";
import { keys as observability } from "@repo/observability/keys";
import { keys as payments } from "@repo/payments/keys";
import { keys as rateLimit } from "@repo/rate-limit/keys";
import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

// Note: @repo/github and @repo/aws keys are validated at runtime (not build time)
// because they're optional integrations. See isGitHubConfigured() / isS3Configured().
// @repo/linear keys are now optional and extended here.

export const env = createEnv({
  extends: [
    ai(),
    auth(),
    analytics(),
    core(),
    database(),
    email(),
    google(),
    linear(),
    observability(),
    payments(),
    rateLimit(),
  ],
  server: {
    INTERNAL_API_SECRET: z.string().min(1),
    RELAY_API_URL: z.url().optional(),
    SLACK_SIGNING_SECRET: z.string().optional(),
  },
  client: {},
  runtimeEnv: {
    INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET,
    RELAY_API_URL: process.env.RELAY_API_URL,
    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
  },
});
