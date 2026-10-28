import { startDevCronScheduler } from "./lib/dev-cron-scheduler";
import { startApiServer } from "./lib/start-api-server";

/**
 * The DEVELOPMENT entrypoint: `server:dev` (`tsx watch server-dev.ts`).
 *
 * The same server as `server.ts`, plus ISS-8152's local cron scheduler. The
 * split exists so the production entrypoint does not carry this import at all
 * — the scheduler's own three-condition guard still applies here, and this file
 * is never the production command, so the two are belt and braces rather than
 * one standing in for the other.
 *
 * Deliberately NO SIGINT/SIGTERM handler. Registering one replaces Node's
 * default signal disposition, so the first Ctrl-C would stop leaving this
 * process (whitlockk, #6048). The scheduler's timers are unref'd, so they cannot
 * hold it open and there is nothing a handler needs to do here.
 */

startApiServer()
  .then(({ server, port }) => {
    // After `listen`, so the boot tick cannot race the loopback it calls, and
    // handed the address the server actually bound rather than an assumed one.
    startDevCronScheduler({ address: server.address(), fallbackPort: port });
  })
  .catch((error) => {
    console.error("Failed to start API server", error);
    process.exit(1);
  });
