import { z } from "zod";
import type { listenerEnvSchema } from "../env";

/** `REALTIME_PG_AUTH` (PLN-2105 decision 3); ISS-11210 picks production's. */
export const ListenerAuth = {
  Password: "password",
  Iam: "iam",
} as const;
export type ListenerAuth = (typeof ListenerAuth)[keyof typeof ListenerAuth];

export type ListenerConnectionConfig = {
  host: string;
  port: number;
  user: string;
  database: string;
} & (
  | { auth: typeof ListenerAuth.Password; password: string }
  | { auth: typeof ListenerAuth.Iam; region: string }
);

export const DEFAULT_REALTIME_PG_PORT = 5432;

/**
 * Builds the listener from env values already read one key at a time.
 * Undefined when no REALTIME_PG_* key is set; otherwise the auth mode's schema
 * decides, and each key it still needs is an issue on that key.
 */
export function listenerConfigFromEnv(
  env: Readonly<Record<string, unknown>>
): z.ZodSafeParseResult<ListenerConnectionConfig> | undefined {
  if (Object.keys(LISTENER_KEYS).every((key) => env[key] === undefined)) {
    return undefined;
  }
  return env.REALTIME_PG_AUTH === ListenerAuth.Iam
    ? iamListenerSchema.safeParse(env)
    : passwordListenerSchema.safeParse(env);
}

/**
 * Setting any of these configures the listener. AWS_REGION is not one: ECS
 * sets it on every task whether or not the listener uses IAM. Keyed by the
 * env schema's shape, so a key added there fails tsc until it is listed here.
 */
const LISTENER_KEYS: Record<
  Exclude<keyof typeof listenerEnvSchema.shape, "AWS_REGION">,
  true
> = {
  REALTIME_PG_AUTH: true,
  REALTIME_PG_HOST: true,
  REALTIME_PG_PORT: true,
  REALTIME_PG_USER: true,
  REALTIME_PG_DATABASE: true,
  REALTIME_PG_PASSWORD: true,
};

const requiredOnceConfigured = (key: string) =>
  z.string({ error: `${key} is required once any REALTIME_PG_* key is set` });

const authOnceConfigured = <Auth extends ListenerAuth>(auth: Auth) =>
  z.literal(auth, {
    error: "REALTIME_PG_AUTH is required once any REALTIME_PG_* key is set",
  });

const endpointShape = {
  REALTIME_PG_HOST: requiredOnceConfigured("REALTIME_PG_HOST"),
  REALTIME_PG_PORT: z.number().default(DEFAULT_REALTIME_PG_PORT),
  REALTIME_PG_USER: requiredOnceConfigured("REALTIME_PG_USER"),
  REALTIME_PG_DATABASE: requiredOnceConfigured("REALTIME_PG_DATABASE"),
};

/** Also the schema for an unset REALTIME_PG_AUTH, so its issues name every key password auth needs. */
const passwordListenerSchema = z
  .object({
    REALTIME_PG_AUTH: authOnceConfigured(ListenerAuth.Password),
    ...endpointShape,
    REALTIME_PG_PASSWORD: requiredOnceConfigured("REALTIME_PG_PASSWORD"),
  })
  .transform(
    (env): ListenerConnectionConfig => ({
      auth: ListenerAuth.Password,
      host: env.REALTIME_PG_HOST,
      port: env.REALTIME_PG_PORT,
      user: env.REALTIME_PG_USER,
      database: env.REALTIME_PG_DATABASE,
      password: env.REALTIME_PG_PASSWORD,
    })
  );

const iamListenerSchema = z
  .object({
    REALTIME_PG_AUTH: authOnceConfigured(ListenerAuth.Iam),
    ...endpointShape,
    AWS_REGION: requiredOnceConfigured("AWS_REGION"),
  })
  .transform(
    (env): ListenerConnectionConfig => ({
      auth: ListenerAuth.Iam,
      host: env.REALTIME_PG_HOST,
      port: env.REALTIME_PG_PORT,
      user: env.REALTIME_PG_USER,
      database: env.REALTIME_PG_DATABASE,
      region: env.AWS_REGION,
    })
  );
