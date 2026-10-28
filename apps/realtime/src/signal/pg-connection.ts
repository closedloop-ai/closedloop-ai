import { Signer } from "@aws-sdk/rds-signer";
import pg from "pg";
import { type ListenOnlyClient, listenOnly } from "./listen-only-client";
import { ListenerAuth, type ListenerConnectionConfig } from "./listener-config";

/**
 * The `pg.Client` options for the LISTEN connection. A local host gets no TLS;
 * any other gets TLS that verifies the server certificate
 * (`rejectUnauthorized: true`) against Node's default trust store, into which
 * the image loads the repo's bundled RDS CA through `NODE_EXTRA_CA_CERTS`
 * (apps/realtime/Dockerfile). No `ca` is passed here, because one would
 * replace that store rather than add to it. With IAM auth the password is a
 * function, which pg calls on every connect, so each reconnect presents a
 * freshly minted token.
 */
export function listenerClientConfig(
  config: ListenerConnectionConfig
): pg.ClientConfig {
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    database: config.database,
    password: listenerPassword(config),
    ssl: LOCAL_HOSTS.has(config.host) ? false : { rejectUnauthorized: true },
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    application_name: LISTENER_APPLICATION_NAME,
  };
}

/** A new listen-only client per (re)connect. */
export function listenerClientFactory(
  config: ListenerConnectionConfig
): () => ListenOnlyClient {
  const clientConfig = listenerClientConfig(config);
  return () => listenOnly(new pg.Client(clientConfig));
}

function listenerPassword(
  config: ListenerConnectionConfig
): string | (() => Promise<string>) {
  if (config.auth === ListenerAuth.Password) {
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
const KEEPALIVE_INITIAL_DELAY_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
const LISTENER_APPLICATION_NAME = "realtime-listener";
