import {
  DEFAULT_REALTIME_PG_PORT,
  ListenerAuth,
  type ListenerConnectionConfig,
} from "../../signal/listener-config";

/** The real services an integration suite needs, read from the shell. */
export const integrationRedisUrl = process.env.REDIS_URL;

/** Password auth against a Postgres the suite only ever LISTENs on. */
export const integrationListener: ListenerConnectionConfig | undefined =
  process.env.REALTIME_PG_HOST &&
  process.env.REALTIME_PG_USER &&
  process.env.REALTIME_PG_PASSWORD &&
  process.env.REALTIME_PG_DATABASE
    ? {
        auth: ListenerAuth.Password,
        host: process.env.REALTIME_PG_HOST,
        port: process.env.REALTIME_PG_PORT
          ? Number(process.env.REALTIME_PG_PORT)
          : DEFAULT_REALTIME_PG_PORT,
        user: process.env.REALTIME_PG_USER,
        password: process.env.REALTIME_PG_PASSWORD,
        database: process.env.REALTIME_PG_DATABASE,
      }
    : undefined;

type MissingDependency = { dependency: string; key: string };

export function missingIntegrationDependencies(): MissingDependency[] {
  const missing: MissingDependency[] = [];
  if (!integrationRedisUrl) {
    missing.push({ dependency: "Redis", key: "REDIS_URL" });
  }
  if (!integrationListener) {
    missing.push({
      dependency: "Postgres",
      key: "REALTIME_PG_HOST, REALTIME_PG_USER, REALTIME_PG_PASSWORD or REALTIME_PG_DATABASE",
    });
  }
  return missing;
}
