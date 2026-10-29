import { Signer } from "@aws-sdk/rds-signer";
import { log } from "@repo/observability/log";
import pg from "pg";
import { DocSyncPgAuth, type DocSyncPgConfig } from "../env";
import { errorCode } from "./error-code";

export const PG_POOL_ERROR_EVENT = "doc_sync.pg_pool_error";

// lc-debt: duplicates apps/realtime/src/signal/pg-connection.ts auth/TLS selection; extract a shared pg-connect package when a third service needs it
/**
 * A local host gets no TLS; any other gets TLS that verifies the server
 * certificate against Node's default trust store, into which the image loads
 * the repo's RDS CA bundle through `NODE_EXTRA_CA_CERTS`
 * (apps/doc-sync/Dockerfile). No `ca` is passed, because one would replace
 * that store rather than add to it. With IAM auth the password is a function,
 * which pg calls on every connect, so each new connection presents a freshly
 * minted token.
 */
export function poolConfig(config: DocSyncPgConfig): pg.PoolConfig {
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    database: config.database,
    password: poolPassword(config),
    ssl: LOCAL_HOSTS.has(config.host) ? false : { rejectUnauthorized: true },
    keepAlive: true,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    application_name: APPLICATION_NAME,
    max: config.poolMax,
  };
}

export function createPool(config: DocSyncPgConfig): pg.Pool {
  return watchPoolErrors(new pg.Pool(poolConfig(config)));
}

/**
 * The health probe's pool: one connection, apart from the stores', and a
 * query timeout, on which pg discards the client, so a ping on a stalled
 * connection does not keep it.
 */
export function createProbePool(config: DocSyncPgConfig): pg.Pool {
  return watchPoolErrors(
    new pg.Pool({
      ...poolConfig(config),
      max: 1,
      query_timeout: PROBE_QUERY_TIMEOUT_MS,
    })
  );
}

/** An idle client's error is emitted on the pool; unhandled, it would crash the process. */
export function watchPoolErrors(pool: pg.Pool): pg.Pool {
  pool.on("error", (error) => {
    log.error("Doc sync Postgres pool error", {
      event: PG_POOL_ERROR_EVENT,
      code: errorCode(error),
    });
  });
  return pool;
}

function poolPassword(
  config: DocSyncPgConfig
): string | (() => Promise<string>) {
  if (config.auth === DocSyncPgAuth.Password) {
    return config.password;
  }
  // No `credentials`: the signer resolves the task role through the AWS
  // SDK's default provider chain.
  const signer = new Signer({
    hostname: config.host,
    port: config.port,
    username: config.user,
    region: config.region,
  });
  return () => signer.getAuthToken();
}

/** Hosts reached without TLS, as the database package's pools treat them. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);
const CONNECT_TIMEOUT_MS = 10_000;
const PROBE_QUERY_TIMEOUT_MS = 5000;
const APPLICATION_NAME = "doc-sync";
