import { keys as email } from "@repo/email/keys";
import { keys as core } from "@repo/next-config/keys";
import { keys as observability } from "@repo/observability/keys";
import { keys as security } from "@repo/security/keys";
import { createEnv } from "@t3-oss/env-nextjs";

export const env = createEnv({
  emptyStringAsUndefined: true,
  extends: [core(), email(), observability(), security()],
  server: {},
  client: {},
  runtimeEnv: {},
});
