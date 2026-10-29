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

export const DEFAULT_DOC_SYNC_PORT = 3050;

/** Below the task's `stopTimeout`, which ISS-12512 sets to at least 30 s. */
export const DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS = 20_000;

export const DEFAULT_DOC_SYNC_PG_PORT = 5432;
export const DEFAULT_DOC_SYNC_PG_POOL_MAX = 5;
export const MAX_DOC_SYNC_PG_POOL_MAX = 50;

export const DOC_SYNC_ENV_INVALID_EVENT = "doc_sync.env_invalid";

export const MAX_TCP_PORT = 65_535;
/** Node's timer ceiling; a longer delay fires after 1 ms. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** `DOC_SYNC_PG_AUTH`: a password locally, RDS IAM tokens on ECS (AGENTS.md -> Credentials). */
export const DocSyncPgAuth = {
  Password: "password",
  Iam: "iam",
} as const;
export type DocSyncPgAuth = (typeof DocSyncPgAuth)[keyof typeof DocSyncPgAuth];

export type DocSyncPgConfig = {
  host: string;
  port: number;
  user: string;
  database: string;
  poolMax: number;
} & (
  | { auth: typeof DocSyncPgAuth.Password; password: string }
  | { auth: typeof DocSyncPgAuth.Iam; region: string }
);

export type DocSyncEnv = {
  /** One port for the WebSocket and `/health`. */
  port: number;
  shutdownDeadlineMs: number;
  pg: DocSyncPgConfig;
  /** RS256 keys by `kid` for the API's document tokens (PLN-2099 E4). */
  tokenPublicKeys: RealtimeTokenPublicKeys;
  /** Exact browser origins; an upgrade with no `Origin` is always allowed. */
  allowedOrigins: readonly string[];
  /**
   * ISS-12506: the claims the API's Vercel OIDC bearer on `/internal/*` must
   * carry, the only credential it accepts. Every DOC_SYNC_INTERNAL_OIDC_* key
   * is required.
   */
  internalOidc: InternalOidcConfig;
  /**
   * PLN-2200 T-7.6: where change callbacks go, signed with the task role in
   * `region`. Absent while `DOC_SYNC_CALLBACK_URL` is unset: callbacks are off.
   */
  callbacks?: DocSyncCallbackConfig;
};

export type DocSyncCallbackConfig = { url: string; region: string };

/**
 * A blank value is read as unset, the convention every env schema in this
 * repo follows. Issues name the key and never echo the value. Storage is not
 * optional: every `DOC_SYNC_PG_*` key the auth mode needs is required, and
 * each missing one is its own issue.
 */
export function parseDocSyncEnv(source: EnvSource): DocSyncEnv {
  const schema =
    blankAsUndefined(source.DOC_SYNC_PG_AUTH) === DocSyncPgAuth.Iam
      ? iamEnvSchema
      : passwordEnvSchema;
  const parsed = schema.safeParse(source);
  const internalOidc = internalOidcEnvSchema.safeParse(source);
  const callbacks = callbacksEnvSchema.safeParse(source);
  if (!(parsed.success && internalOidc.success && callbacks.success)) {
    throw new EnvValidationError(
      "doc-sync",
      envIssuesFrom([
        ...(parsed.error?.issues ?? []),
        ...(internalOidc.error?.issues ?? []),
        ...(callbacks.error?.issues ?? []),
      ])
    );
  }
  return {
    ...parsed.data,
    internalOidc: internalOidc.data,
    ...(callbacks.data === undefined ? {} : { callbacks: callbacks.data }),
  };
}

/** Boot entry: an invalid value logs a structured fatal and exits 1. */
export function loadDocSyncEnvOrExit(
  source: EnvSource,
  deps?: FatalExitDeps
): Promise<DocSyncEnv | undefined> {
  return loadEnvOrExit(
    () => parseDocSyncEnv(source),
    {
      message: "Doc sync service refused to boot: invalid environment",
      event: DOC_SYNC_ENV_INVALID_EVENT,
    },
    deps
  );
}

const boundedInt = (min: number, max: number, fallback: number) =>
  z.preprocess(
    blankAsUndefined,
    z.coerce.number().int().min(min).max(max).default(fallback)
  );

const requiredString = (key: string) =>
  z.preprocess(blankAsUndefined, z.string({ error: `${key} is required` }));

const pgAuth = <Auth extends DocSyncPgAuth>(auth: Auth) =>
  z.preprocess(
    blankAsUndefined,
    z.literal(auth, {
      error: `DOC_SYNC_PG_AUTH must be "${DocSyncPgAuth.Password}" or "${DocSyncPgAuth.Iam}"`,
    })
  );

const sharedShape = {
  DOC_SYNC_PORT: boundedInt(1, MAX_TCP_PORT, DEFAULT_DOC_SYNC_PORT),
  DOC_SYNC_SHUTDOWN_DEADLINE_MS: boundedInt(
    1,
    MAX_TIMER_DELAY_MS,
    DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS
  ),
  DOC_SYNC_PG_HOST: requiredString("DOC_SYNC_PG_HOST"),
  DOC_SYNC_PG_PORT: boundedInt(1, MAX_TCP_PORT, DEFAULT_DOC_SYNC_PG_PORT),
  DOC_SYNC_PG_USER: requiredString("DOC_SYNC_PG_USER"),
  DOC_SYNC_PG_DATABASE: requiredString("DOC_SYNC_PG_DATABASE"),
  DOC_SYNC_PG_POOL_MAX: boundedInt(
    1,
    MAX_DOC_SYNC_PG_POOL_MAX,
    DEFAULT_DOC_SYNC_PG_POOL_MAX
  ),
  REALTIME_TOKEN_PUBLIC_KEYS: z
    .preprocess(blankAsUndefined, z.string().optional())
    .transform((raw, ctx): RealtimeTokenPublicKeys => {
      const keys = tokenPublicKeysOrIssue(raw);
      if (typeof keys === "string") {
        ctx.addIssue({ code: "custom", message: keys });
        return z.NEVER;
      }
      return keys;
    }),
  DOC_SYNC_ALLOWED_ORIGINS: exactOriginListSchema("DOC_SYNC_ALLOWED_ORIGINS"),
};

type SharedEnv = z.output<z.ZodObject<typeof sharedShape>>;

function sharedConfig(env: SharedEnv) {
  return {
    port: env.DOC_SYNC_PORT,
    shutdownDeadlineMs: env.DOC_SYNC_SHUTDOWN_DEADLINE_MS,
    tokenPublicKeys: env.REALTIME_TOKEN_PUBLIC_KEYS,
    allowedOrigins: env.DOC_SYNC_ALLOWED_ORIGINS,
    endpoint: {
      host: env.DOC_SYNC_PG_HOST,
      port: env.DOC_SYNC_PG_PORT,
      user: env.DOC_SYNC_PG_USER,
      database: env.DOC_SYNC_PG_DATABASE,
      poolMax: env.DOC_SYNC_PG_POOL_MAX,
    },
  };
}

/** Also the schema for an unset `DOC_SYNC_PG_AUTH`, so its issues name every key password auth needs. */
const passwordEnvSchema = z
  .object({
    ...sharedShape,
    DOC_SYNC_PG_AUTH: pgAuth(DocSyncPgAuth.Password),
    DOC_SYNC_PG_PASSWORD: requiredString("DOC_SYNC_PG_PASSWORD"),
  })
  .transform((env): ServiceEnv => {
    const { endpoint, ...server } = sharedConfig(env);
    return {
      ...server,
      pg: {
        ...endpoint,
        auth: DocSyncPgAuth.Password,
        password: env.DOC_SYNC_PG_PASSWORD,
      },
    };
  });

const iamEnvSchema = z
  .object({
    ...sharedShape,
    DOC_SYNC_PG_AUTH: pgAuth(DocSyncPgAuth.Iam),
    AWS_REGION: requiredString("AWS_REGION"),
  })
  .transform((env): ServiceEnv => {
    const { endpoint, ...server } = sharedConfig(env);
    return {
      ...server,
      pg: { ...endpoint, auth: DocSyncPgAuth.Iam, region: env.AWS_REGION },
    };
  });

type ServiceEnv = Omit<DocSyncEnv, "internalOidc">;

const optionalString = z.preprocess(blankAsUndefined, z.string().optional());

/** Parsed apart from the rest, which only adds its issues. */
const internalOidcEnvSchema = z
  .object({
    DOC_SYNC_INTERNAL_OIDC_ISSUER: optionalString,
    DOC_SYNC_INTERNAL_OIDC_AUDIENCE: optionalString,
    DOC_SYNC_INTERNAL_OIDC_OWNER_ID: optionalString,
    DOC_SYNC_INTERNAL_OIDC_PROJECT_ID: optionalString,
    DOC_SYNC_INTERNAL_OIDC_ENVIRONMENT: optionalString,
    ECS_CONTAINER_METADATA_URI_V4: optionalString,
  })
  .transform((env, ctx) => {
    const config = internalOidcConfigFromEnv(env, "DOC_SYNC_INTERNAL_OIDC");
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

const HTTP_PROTOCOL = /^https?$/;

/** Parsed apart from the rest, which only adds its issues. */
const callbacksEnvSchema = z
  .object({
    DOC_SYNC_CALLBACK_URL: z.preprocess(
      blankAsUndefined,
      z
        .url({
          protocol: HTTP_PROTOCOL,
          error: "DOC_SYNC_CALLBACK_URL must be an http(s) URL",
        })
        .optional()
    ),
    AWS_REGION: optionalString,
  })
  .transform((env, ctx): DocSyncCallbackConfig | undefined => {
    if (env.DOC_SYNC_CALLBACK_URL === undefined) {
      return;
    }
    if (env.AWS_REGION === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["AWS_REGION"],
        message: "AWS_REGION is required when DOC_SYNC_CALLBACK_URL is set",
      });
      return z.NEVER;
    }
    return { url: env.DOC_SYNC_CALLBACK_URL, region: env.AWS_REGION };
  });

/** The parsed keys, or the issue message: a parse error, or the key missing. */
function tokenPublicKeysOrIssue(
  raw: string | undefined
): RealtimeTokenPublicKeys | string {
  try {
    return (
      parseRealtimeTokenPublicKeys(raw) ??
      "REALTIME_TOKEN_PUBLIC_KEYS is required"
    );
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "REALTIME_TOKEN_PUBLIC_KEYS is invalid";
  }
}
