import {
  type InternalOidcConfig,
  internalOidcConfigFromEnv,
} from "@repo/http-service/internal-oidc";
import {
  blankAsUndefined,
  type EnvSource,
  EnvValidationError,
  envIssuesFrom,
  exactOriginListSchema,
  type FatalExitDeps,
  loadEnvOrExit,
} from "@repo/observability/boot-env";
import type { RealtimeTokenPublicKeys } from "@repo/realtime-contract/token";
import { parseRealtimeTokenPublicKeys } from "@repo/realtime-contract/token-public-keys";
import { z } from "zod";
import type { ConnectionCaps } from "./redis/connections";
import { type RedisIamConfig, redisIamConfigFromEnv } from "./redis/iam-auth";
import {
  ListenerAuth,
  type ListenerConnectionConfig,
  listenerConfigFromEnv,
} from "./signal/listener-config";

export const DEFAULT_REALTIME_PORT = 3040;

/**
 * A SIGTERM-triggered drain runs inside ECS's default 30 s stop timeout; this
 * leaves 10 s of it for closing stragglers, ending the LISTEN connection
 * (bounded at 2 s) and the flush (bounded at 5 s). Stays well under the load
 * balancer's deregistration delay (ISS-11210).
 */
export const DEFAULT_DRAIN_WINDOW_MS = 20_000;

/** ISS-11210 AC6 (Perrin Upcott, 2026-10-07): prod's 30-day peak of 13 tabs + 2 desktops, doubled for the INSTANCE_TTL_MS in which a crashed task's counts still count. */
export const DEFAULT_MAX_CONNECTIONS_PER_USER = 30;
/** ISS-11210 AC6 (Perrin Upcott, 2026-10-07): 2,000 sockets per task × max_capacity 6 × (1 − 50% headroom). */
export const DEFAULT_MAX_CONNECTIONS_PER_ORG = 6000;

export const REALTIME_ENV_INVALID_EVENT = "realtime.env_invalid";

export type RealtimeEnv = {
  port: number;
  /** RS256 keys by `kid`, the only grant tokens accepted (ISS-11966). */
  tokenPublicKeys: RealtimeTokenPublicKeys;
  redisUrl: string;
  /** ElastiCache IAM auth for every Redis connection; unset connects with `redisUrl` alone. */
  redisIam: RedisIamConfig | undefined;
  /** Exact browser origins; a request with no `Origin` is always allowed. */
  allowedOrigins: readonly string[];
  /** Unset leaves the socket server's default in force. */
  pingTimeoutMs: number | undefined;
  drainWindowMs: number;
  /** Set by ECS on a task; unset elsewhere, where SIGTERM alone starts the drain. */
  ecsMetadataUri: string | undefined;
  connectionCaps: ConnectionCaps;
  /**
   * The dedicated `LISTEN realtime_signal` connection (PLN-2105 step 1).
   * Unset when no REALTIME_PG_* key is: the service runs and never becomes
   * ready. Any key set requires the rest.
   */
  listener: ListenerConnectionConfig | undefined;
  /**
   * ISS-11966: the claims the Vercel OIDC bearer on `/internal/*` must carry,
   * the only credential it accepts. Every REALTIME_INTERNAL_OIDC_* key is
   * required.
   */
  internalOidc: InternalOidcConfig;
};

/**
 * Validates the service's environment. A blank value is read as unset, the
 * convention every env schema in this repo follows. Issues name the key and
 * never echo the value, since most of these are secrets.
 */
export function parseRealtimeEnv(source: EnvSource): RealtimeEnv {
  const parsed = realtimeEnvSchema.safeParse(source);
  const internalOidc = internalOidcEnvSchema.safeParse(source);
  if (!(parsed.success && internalOidc.success)) {
    throw new EnvValidationError(
      "realtime",
      envIssuesFrom([
        ...(parsed.error?.issues ?? []),
        ...(internalOidc.error?.issues ?? []),
      ])
    );
  }
  const env = parsed.data;
  return {
    port: env.REALTIME_PORT,
    tokenPublicKeys: env.REALTIME_TOKEN_PUBLIC_KEYS,
    redisUrl: env.REDIS_URL,
    redisIam: env.redisIam,
    allowedOrigins: env.REALTIME_ALLOWED_ORIGINS,
    pingTimeoutMs: env.REALTIME_PING_TIMEOUT_MS,
    drainWindowMs: env.DRAIN_WINDOW_MS,
    ecsMetadataUri: env.ECS_CONTAINER_METADATA_URI_V4,
    connectionCaps: {
      perUser: env.REALTIME_MAX_CONNECTIONS_PER_USER,
      perOrg: env.REALTIME_MAX_CONNECTIONS_PER_ORG,
    },
    listener: env.listener,
    internalOidc: internalOidc.data,
  };
}

/** Boot entry: a missing, blank or invalid value logs a structured fatal and exits 1. */
export function loadRealtimeEnvOrExit(
  source: EnvSource,
  deps?: FatalExitDeps
): Promise<RealtimeEnv | undefined> {
  return loadEnvOrExit(
    () => parseRealtimeEnv(source),
    {
      message: "Realtime service refused to boot: invalid environment",
      event: REALTIME_ENV_INVALID_EVENT,
    },
    deps
  );
}

const requiredString = (key: string) =>
  z.preprocess(
    blankAsUndefined,
    z.string({ error: `${key} is required and must not be blank` })
  );

const connectionCapSchema = (fallback: number) =>
  z.preprocess(
    blankAsUndefined,
    z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .default(fallback)
  );

const MAX_TCP_PORT = 65_535;
/** Node's timer ceiling; a longer delay fires after 1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const envSchema = z.object({
  REALTIME_TOKEN_PUBLIC_KEYS: z
    .preprocess(blankAsUndefined, z.string().optional())
    .transform((raw, ctx): RealtimeTokenPublicKeys | undefined => {
      try {
        return parseRealtimeTokenPublicKeys(raw);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message:
            error instanceof Error
              ? error.message
              : "REALTIME_TOKEN_PUBLIC_KEYS is invalid",
        });
        return z.NEVER;
      }
    }),
  REDIS_URL: requiredString("REDIS_URL").refine(URL.canParse, {
    message: "REDIS_URL must be a URL",
  }),
  REALTIME_ALLOWED_ORIGINS: exactOriginListSchema("REALTIME_ALLOWED_ORIGINS"),
  REALTIME_PING_TIMEOUT_MS: z.preprocess(
    blankAsUndefined,
    z.coerce.number().int().positive().optional()
  ),
  REALTIME_PORT: z.preprocess(
    blankAsUndefined,
    z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_TCP_PORT)
      .default(DEFAULT_REALTIME_PORT)
  ),
  DRAIN_WINDOW_MS: z.preprocess(
    blankAsUndefined,
    z.coerce
      .number()
      .int()
      .positive()
      .max(MAX_TIMER_DELAY_MS)
      .default(DEFAULT_DRAIN_WINDOW_MS)
  ),
  REALTIME_MAX_CONNECTIONS_PER_USER: connectionCapSchema(
    DEFAULT_MAX_CONNECTIONS_PER_USER
  ),
  REALTIME_MAX_CONNECTIONS_PER_ORG: connectionCapSchema(
    DEFAULT_MAX_CONNECTIONS_PER_ORG
  ),
  ECS_CONTAINER_METADATA_URI_V4: z.preprocess(
    blankAsUndefined,
    z
      .string()
      .refine(URL.canParse, {
        message: "ECS_CONTAINER_METADATA_URI_V4 must be a URL",
      })
      .optional()
  ),
});

const optionalString = z.preprocess(blankAsUndefined, z.string().optional());

/**
 * Each optional on its own: `listenerConfigFromEnv` requires the set
 * together, or none of it.
 */
export const listenerEnvSchema = z.object({
  REALTIME_PG_AUTH: z.preprocess(
    blankAsUndefined,
    z
      .enum([ListenerAuth.Password, ListenerAuth.Iam], {
        error: "REALTIME_PG_AUTH must be password or iam",
      })
      .optional()
  ),
  REALTIME_PG_HOST: optionalString,
  REALTIME_PG_PORT: z.preprocess(
    blankAsUndefined,
    z.coerce.number().int().min(1).max(MAX_TCP_PORT).optional()
  ),
  REALTIME_PG_USER: optionalString,
  REALTIME_PG_DATABASE: optionalString,
  /** Required when REALTIME_PG_AUTH=password. */
  REALTIME_PG_PASSWORD: optionalString,
  /** Required when REALTIME_PG_AUTH=iam; ECS sets it on every task. */
  AWS_REGION: optionalString,
});

const redisIamEnvSchema = z.object({
  REALTIME_REDIS_IAM_CACHE_NAME: optionalString,
  REALTIME_REDIS_IAM_USER_ID: optionalString,
});

const realtimeEnvSchema = envSchema
  .extend(listenerEnvSchema.shape)
  .extend(redisIamEnvSchema.shape)
  .transform((env, ctx) => {
    const tokenPublicKeys = env.REALTIME_TOKEN_PUBLIC_KEYS;
    if (tokenPublicKeys === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["REALTIME_TOKEN_PUBLIC_KEYS"],
        message: "REALTIME_TOKEN_PUBLIC_KEYS is required and must not be blank",
      });
    }
    const listener = listenerConfigFromEnv(env);
    const redisIam = redisIamConfigFromEnv(env);
    if (listener?.success !== false && redisIam?.success !== false) {
      return tokenPublicKeys === undefined
        ? z.NEVER
        : {
            ...env,
            REALTIME_TOKEN_PUBLIC_KEYS: tokenPublicKeys,
            listener: listener?.data,
            redisIam: redisIam?.data,
          };
    }
    for (const issue of [
      ...(listener?.error?.issues ?? []),
      ...(redisIam?.error?.issues ?? []),
    ]) {
      ctx.addIssue({
        code: "custom",
        path: issue.path,
        message: issue.message,
      });
    }
    return z.NEVER;
  });

const internalOidcEnvShape = z.object({
  REALTIME_INTERNAL_OIDC_ISSUER: optionalString,
  REALTIME_INTERNAL_OIDC_AUDIENCE: optionalString,
  REALTIME_INTERNAL_OIDC_OWNER_ID: optionalString,
  REALTIME_INTERNAL_OIDC_PROJECT_ID: optionalString,
  REALTIME_INTERNAL_OIDC_ENVIRONMENT: optionalString,
  ECS_CONTAINER_METADATA_URI_V4: optionalString,
});

/** Parsed apart from the rest, which only adds its issues. */
const internalOidcEnvSchema = internalOidcEnvShape.transform((env, ctx) => {
  const config = internalOidcConfigFromEnv(env, "REALTIME_INTERNAL_OIDC");
  if (config.success) {
    return config.data;
  }
  for (const issue of config.error.issues) {
    ctx.addIssue({
      code: "custom",
      path: issue.path,
      message: issue.message,
    });
  }
  return z.NEVER;
});
