import { keys as ai } from "@repo/ai/keys";
import { keys as analytics } from "@repo/analytics/keys";
import { keys as auth } from "@repo/auth/keys";
import { keys as database } from "@repo/database/keys";
import { keys as email } from "@repo/email/keys";
import { keys as core } from "@repo/next-config/keys";
import { keys as observability } from "@repo/observability/keys";
import { keys as payments } from "@repo/payments/keys";
import { keys as rateLimit } from "@repo/rate-limit/keys";
import { createEnv } from "@t3-oss/env-nextjs";

// Note: @repo/github, @repo/aws, and @repo/linear keys are validated at runtime (not build time)
// because they're optional integrations. See isGitHubConfigured() / isS3Configured() / isLinearConfigured().

export const env = createEnv({
  extends: [
    ai(),
    auth(),
    analytics(),
    core(),
    database(),
    email(),
    observability(),
    payments(),
    rateLimit(),
  ],
  server: {},
  client: {},
  runtimeEnv: {},
});
