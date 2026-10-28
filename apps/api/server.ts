import { startApiServer } from "./lib/start-api-server";

/**
 * The PRODUCTION entrypoint: `server:start`, which the Dockerfile CMD reaches
 * through `pnpm --filter api start`.
 *
 * It must not import anything development-only. ISS-8152's dev cron scheduler
 * is started by the sibling `server-dev.ts` instead, so it is absent from this
 * file's import graph rather than merely inert inside it (davetho, #6048).
 * `lib/__tests__/dev-cron-production-exclusion.test.ts` holds that split.
 */

startApiServer().catch((error) => {
  console.error("Failed to start API server", error);
  process.exit(1);
});
