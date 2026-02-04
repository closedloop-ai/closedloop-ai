import { keys as analytics } from "@repo/analytics/keys";
import { keys as auth } from "@repo/auth/keys";
import { keys as collaboration } from "@repo/collaboration/keys";
import { keys as email } from "@repo/email/keys";
import { keys as flags } from "@repo/feature-flags/keys";
import { keys as linear } from "@repo/linear/keys";
import { keys as core } from "@repo/next-config/keys";
import { keys as notifications } from "@repo/notifications/keys";
import { keys as observability } from "@repo/observability/keys";
import { keys as security } from "@repo/security/keys";
import { keys as webhooks } from "@repo/webhooks/keys";
import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  extends: [
    auth(),
    analytics(),
    collaboration(),
    core(),
    email(),
    flags(),
    linear(),
    notifications(),
    observability(),
    security(),
    webhooks(),
  ],
  server: {
    API_URL: z.url().default("http://localhost:3002"),
  },
  client: {
    NEXT_PUBLIC_API_URL: z.url().default("http://localhost:3002"),
    // GitHub App slug for install URL - optional since GitHub integration is optional
    NEXT_PUBLIC_GITHUB_APP_SLUG: z.string().min(1).optional(),
  },
  runtimeEnv: {
    API_URL: process.env.API_URL,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_GITHUB_APP_SLUG: process.env.NEXT_PUBLIC_GITHUB_APP_SLUG,
  },
});
