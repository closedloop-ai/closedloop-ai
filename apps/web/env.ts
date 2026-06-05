import { keys as email } from "@repo/email/keys";
import { keys as core } from "@repo/next-config/keys";
import { keys as observability } from "@repo/observability/keys";
import { createEnv } from "@t3-oss/env-nextjs";

export const env = createEnv({
  extends: [core(), email(), observability()],
  server: {},
  client: {},
  runtimeEnv: {},
});
