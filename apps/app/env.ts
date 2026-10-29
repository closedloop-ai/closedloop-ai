import { keys as analytics } from "@repo/analytics/keys";
import { keys as auth } from "@repo/auth/keys";
import { keys as collaboration } from "@repo/collaboration/server/keys";
import { keys as email } from "@repo/email/keys";
import { clientKeys as github } from "@repo/github/keys";
import { keys as google } from "@repo/google/keys";
import { keys as linear } from "@repo/linear/keys";
import { keys as core } from "@repo/next-config/keys";
import { keys as observability } from "@repo/observability/keys";
import { realtimeServiceUrlSchema } from "@repo/realtime-contract/protocol";
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
    // ISS-9244: server-only on purpose — see `lib/analytics/feature-flag-bootstrap`.
    E2E_SUPPRESS_FEATURE_FLAG_BOOTSTRAP: z.enum(["true", "false"]).optional(),
    // ISS-6996: gates the deliberately-throwing route the error-boundary e2e
    // needs, and (ISS-10078) the per-request root-layout throw. Unset
    // everywhere a real user can reach, so the route 404s there.
    ERROR_BOUNDARY_VALIDATION_ROUTE_ENABLED: z
      .enum(["true", "false"])
      .optional(),
    // ISS-11929 (tamsinb review): "false" turns the X-POSTHOG-* headers off.
    // While on, rolling api back past its CORS allowance for them fails every
    // app→api preflight.
    POSTHOG_TRACING_HEADERS_ENABLED: z.enum(["true", "false"]).optional(),
    /**
     * ISS-11210 requirement 11: the realtime service's public socket URL, whose
     * origin joins the CSP's connect-src. CSP_EXTRA_CONNECT_SRC takes only
     * https:// origins, so it gets its own key.
     */
    REALTIME_PUBLIC_URL: realtimeServiceUrlSchema.optional(),
    /**
     * PLN-2189 T-4.1: the document sync service's public socket URL, whose
     * origin joins the CSP's connect-src. Set per environment once ISS-12512
     * provides the stage and prod hosts.
     */
    DOC_SYNC_PUBLIC_URL: realtimeServiceUrlSchema.optional(),
    RUM_VALIDATION_ROUTE_ENABLED: z.enum(["true", "false"]).optional(),
    SERVER_API_URL: z.string().url().optional(),
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
    E2E_SUPPRESS_FEATURE_FLAG_BOOTSTRAP:
      process.env.E2E_SUPPRESS_FEATURE_FLAG_BOOTSTRAP,
    ERROR_BOUNDARY_VALIDATION_ROUTE_ENABLED:
      process.env.ERROR_BOUNDARY_VALIDATION_ROUTE_ENABLED,
    NEXT_PUBLIC_APP_ENVIRONMENT: process.env.NEXT_PUBLIC_APP_ENVIRONMENT,
    NEXT_PUBLIC_DATADOG_RUM_APPLICATION_ID:
      process.env.NEXT_PUBLIC_DATADOG_RUM_APPLICATION_ID,
    NEXT_PUBLIC_DATADOG_RUM_CLIENT_TOKEN:
      process.env.NEXT_PUBLIC_DATADOG_RUM_CLIENT_TOKEN,
    NEXT_PUBLIC_DATADOG_RUM_SESSION_SAMPLE_RATE:
      process.env.NEXT_PUBLIC_DATADOG_RUM_SESSION_SAMPLE_RATE,
    NEXT_PUBLIC_DATADOG_RUM_SITE: process.env.NEXT_PUBLIC_DATADOG_RUM_SITE,
    NEXT_PUBLIC_MCP_SERVER_URL: process.env.NEXT_PUBLIC_MCP_SERVER_URL,
    POSTHOG_TRACING_HEADERS_ENABLED:
      process.env.POSTHOG_TRACING_HEADERS_ENABLED,
    REALTIME_PUBLIC_URL: process.env.REALTIME_PUBLIC_URL,
    DOC_SYNC_PUBLIC_URL: process.env.DOC_SYNC_PUBLIC_URL,
    RUM_VALIDATION_ROUTE_ENABLED: process.env.RUM_VALIDATION_ROUTE_ENABLED,
    SERVER_API_URL: process.env.SERVER_API_URL,
  },
});
