import { log } from "@repo/observability/log";
import { loadDocSyncEnvOrExit } from "./env";
import { installProcessFaultHandlers } from "./lifecycle/process-faults";
import { createDocSyncServer, HTTP_SERVER_ERROR_EVENT } from "./server";
import { pgDocumentStorage } from "./storage/document-storage";
import { MIGRATIONS_DIR, runMigrationsOrExit } from "./storage/migrate";
import { createPool, createProbePool } from "./storage/pool";

const env = await loadDocSyncEnvOrExit(process.env);
const pool = env ? createPool(env.pg) : undefined;
const migrated = pool ? await runMigrationsOrExit(pool, MIGRATIONS_DIR) : false;

if (env && pool && migrated) {
  const { server, shutdown } = createDocSyncServer(
    env,
    pgDocumentStorage(pool, createProbePool(env.pg))
  );
  const exitAfterShutdown = (code: number): void => {
    shutdown().finally(() => process.exit(code));
  };
  installProcessFaultHandlers({ onFatal: () => exitAfterShutdown(1) });
  const onServerError = (error: unknown): void => {
    log.error("Doc sync HTTP server error", {
      event: HTTP_SERVER_ERROR_EVENT,
      error,
    });
    exitAfterShutdown(1);
  };

  server.httpServer.on("error", onServerError);
  server.listen().then(() => {
    log.info("Doc sync service listening", {
      event: "doc_sync.listening",
      port: server.address.port,
    });
  }, onServerError);

  // One instance and nowhere to drain to (PLN-2099 E2): SIGTERM alone starts
  // the shutdown, and SIGINT is the same stop run locally. `on`, not `once`:
  // a repeated signal must reach the idempotent shutdown, not Node's default
  // handler, which would kill the process mid-flush.
  process.on("SIGTERM", () => exitAfterShutdown(0));
  process.on("SIGINT", () => exitAfterShutdown(0));
}
