import { keys as analytics } from "@repo/analytics/keys";
import { keys as auth } from "@repo/auth/keys";
import { keys as collaboration } from "@repo/collaboration/server/keys";
import { keys as email } from "@repo/email/keys";
import { clientKeys as github } from "@repo/github/keys";
import { keys as google } from "@repo/google/keys";
import { keys as linear } from "@repo/linear/keys";
import { keys as core } from "@repo/next-config/keys";
import { keys as observability } from "@repo/observability/keys";
import { keys as security } from "@repo/security/keys";
import { keys as webhooks } from "@repo/webhooks/keys";
import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  emptyStringAsUndefined: true,
  extends: [
    auth(),
    analytics(),
    collaboration(),
    core(),
    email(),
    github(),
    google(),
    linear(),
    observability(),
    security(),
    webhooks(),
  ],
  server: {
    INTERNAL_API_SECRET: z.string().min(1).optional(),
    RUM_VALIDATION_ROUTE_ENABLED: z.enum(["true", "false"]).optional(),
  },
  client: {
    NEXT_PUBLIC_APP_ENVIRONMENT: z
      .enum(["production", "stage", "development"])
      .optional(),
    NEXT_PUBLIC_DATADOG_RUM_APPLICATION_ID: z.string().min(1).optional(),
    NEXT_PUBLIC_DATADOG_RUM_CLIENT_TOKEN: z.string().min(1).optional(),
    NEXT_PUBLIC_DATADOG_RUM_SESSION_SAMPLE_RATE: z.string().optional(),
    NEXT_PUBLIC_DATADOG_RUM_SITE: z.string().min(1).optional(),
    NEXT_PUBLIC_MCP_SERVER_URL: z.string().url().optional(),
  },
  runtimeEnv: {
    INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET,
    NEXT_PUBLIC_APP_ENVIRONMENT: process.env.NEXT_PUBLIC_APP_ENVIRONMENT,
    NEXT_PUBLIC_DATADOG_RUM_APPLICATION_ID:
      process.env.NEXT_PUBLIC_DATADOG_RUM_APPLICATION_ID,
    NEXT_PUBLIC_DATADOG_RUM_CLIENT_TOKEN:
      process.env.NEXT_PUBLIC_DATADOG_RUM_CLIENT_TOKEN,
    NEXT_PUBLIC_DATADOG_RUM_SESSION_SAMPLE_RATE:
      process.env.NEXT_PUBLIC_DATADOG_RUM_SESSION_SAMPLE_RATE,
    NEXT_PUBLIC_DATADOG_RUM_SITE: process.env.NEXT_PUBLIC_DATADOG_RUM_SITE,
    NEXT_PUBLIC_MCP_SERVER_URL: process.env.NEXT_PUBLIC_MCP_SERVER_URL,
    RUM_VALIDATION_ROUTE_ENABLED: process.env.RUM_VALIDATION_ROUTE_ENABLED,
  },
});
