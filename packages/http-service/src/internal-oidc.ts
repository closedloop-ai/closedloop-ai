import { log } from "@repo/observability/log";
import { isRealtimeOnlyOidcAudience } from "@repo/realtime-contract/internal";
import {
  createRemoteJWKSet,
  customFetch,
  errors,
  type FetchImplementation,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";
import { z } from "zod";
import { describeCause } from "./describe-cause";

/**
 * ISS-11966 item 2 (Perrin Upcott, 2026-10-05): the claims `apps/api`'s Vercel
 * OIDC bearer token must carry for `/internal/*`.
 */
export type InternalOidcConfig = {
  issuer: string;
  audience: string;
  ownerId: string;
  projectId: string;
  environment: string;
};

export const InternalOidcVerdict = {
  Verified: "verified",
  Rejected: "rejected",
  /** The issuer's JWKS could not be fetched, so the token was not judged. */
  Unavailable: "unavailable",
} as const;
export type InternalOidcVerdict =
  (typeof InternalOidcVerdict)[keyof typeof InternalOidcVerdict];

export type InternalOidcVerification =
  | { verdict: typeof InternalOidcVerdict.Verified }
  /** `reason` is the failed claim's name, or the error code; never the token. */
  | { verdict: typeof InternalOidcVerdict.Rejected; reason: string }
  | { verdict: typeof InternalOidcVerdict.Unavailable };

/** Never throws. */
export type InternalOidcVerifier = (
  token: string
) => Promise<InternalOidcVerification>;

export type InternalOidcVerifierOptions = {
  /** The `event` of the error logged when the JWKS cannot be fetched. */
  unavailableEvent: string;
  fetch?: FetchImplementation;
  now?: () => number;
};

/**
 * Reads `${keyPrefix}_ISSUER`, `_AUDIENCE`, `_OWNER_ID`, `_PROJECT_ID` and
 * `_ENVIRONMENT`. Every key is required: the bearer is the only credential
 * `/internal/*` accepts (ISS-11966). On ECS (`ECS_CONTAINER_METADATA_URI_V4`,
 * which Fargate injects into every container) a `development` environment is
 * refused, so a token minted for a laptop is never accepted there.
 */
export function internalOidcConfigFromEnv(
  env: Readonly<Record<string, unknown>>,
  keyPrefix: string
): z.ZodSafeParseResult<InternalOidcConfig> {
  const schemas = configSchemas(keyPrefix);
  return (
    env.ECS_CONTAINER_METADATA_URI_V4 === undefined
      ? schemas.offEcs
      : schemas.onEcs
  ).safeParse(env);
}

/**
 * Verifies against the issuer's JWKS. jose caches the one key set, refetching
 * it once it is 10 minutes old, or for an unknown `kid` at most every 30 s. A
 * failed fetch is tried {@link JWKS_FETCH_ATTEMPTS} times in all, then the
 * token is not accepted: the answer is `unavailable`. For
 * {@link JWKS_OUTAGE_COOLDOWN_MS} after that, a verification that needs a
 * fetch fails without one and without another log. A token the cached key set
 * can verify still verifies until that set is 10 minutes old; from then on
 * jose must refetch it first, so the outage fails every token closed.
 */
export function createInternalOidcVerifier(
  config: InternalOidcConfig,
  options: InternalOidcVerifierOptions
): InternalOidcVerifier {
  const now = options.now ?? (() => performance.now());
  const fetchJwks = options.fetch ?? fetch;
  let unavailableUntil = Number.NEGATIVE_INFINITY;
  const jwks = createRemoteJWKSet(new URL(`${config.issuer}${JWKS_PATH}`), {
    timeoutDuration: JWKS_FETCH_TIMEOUT_MS,
    [customFetch]: (url, init) =>
      now() < unavailableUntil
        ? Promise.reject(new Error("JWKS fetch cooling down"))
        : fetchJwks(url, init),
  });
  const getKey: JWTVerifyGetKey = async (header, token) => {
    try {
      return await jwks(header, token);
    } catch (error) {
      throw isKeyMismatch(error) ? error : new JwksUnavailableError(error);
    }
  };
  return async (token) => {
    let unavailable: JwksUnavailableError | undefined;
    for (let attempt = 1; attempt <= JWKS_FETCH_ATTEMPTS; attempt += 1) {
      try {
        const { payload } = await jwtVerify(token, getKey, {
          issuer: config.issuer,
          audience: config.audience,
          algorithms: [VERCEL_OIDC_ALGORITHM],
          requiredClaims: ["exp"],
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
        });
        const mismatch = mismatchedVercelClaim(payload, config);
        return mismatch === undefined
          ? { verdict: InternalOidcVerdict.Verified }
          : { verdict: InternalOidcVerdict.Rejected, reason: mismatch };
      } catch (error) {
        if (!(error instanceof JwksUnavailableError)) {
          return {
            verdict: InternalOidcVerdict.Rejected,
            reason: reasonOf(error),
          };
        }
        unavailable = error;
      }
    }
    if (now() >= unavailableUntil) {
      unavailableUntil = now() + JWKS_OUTAGE_COOLDOWN_MS;
      log.error("Internal OIDC verification failed closed: JWKS unavailable", {
        event: options.unavailableEvent,
        attempts: JWKS_FETCH_ATTEMPTS,
        cause: describeCause(unavailable?.cause),
      });
    }
    return { verdict: InternalOidcVerdict.Unavailable };
  };
}

class JwksUnavailableError extends Error {
  constructor(cause: unknown) {
    super("JWKS unavailable", { cause });
    this.name = "JwksUnavailableError";
  }
}

/** A key set that was fetched but holds no key for this token is the token's fault. */
function isKeyMismatch(error: unknown): boolean {
  return (
    error instanceof errors.JWKSNoMatchingKey ||
    error instanceof errors.JWKSMultipleMatchingKeys
  );
}

function reasonOf(error: unknown): string {
  return error instanceof errors.JWTClaimValidationFailed ||
    error instanceof errors.JWTExpired
    ? error.claim
    : describeCause(error);
}

/** Vercel's own claims, which jose does not check. */
function mismatchedVercelClaim(
  payload: JWTPayload,
  config: InternalOidcConfig
): string | undefined {
  if (payload.owner_id !== config.ownerId) {
    return VercelClaim.OwnerId;
  }
  if (payload.project_id !== config.projectId) {
    return VercelClaim.ProjectId;
  }
  if (payload.environment !== config.environment) {
    return VercelClaim.Environment;
  }
  return undefined;
}

const VercelClaim = {
  OwnerId: "owner_id",
  ProjectId: "project_id",
  Environment: "environment",
} as const;

const DEVELOPMENT_ENVIRONMENT = "development";

const requiredString = (key: string) =>
  z.string({ error: `${key} is required and must not be blank` });

/** One template for every prefix, so each service's issue messages name its own keys. */
function configSchemas(keyPrefix: string) {
  const keys = {
    issuer: `${keyPrefix}_ISSUER`,
    audience: `${keyPrefix}_AUDIENCE`,
    ownerId: `${keyPrefix}_OWNER_ID`,
    projectId: `${keyPrefix}_PROJECT_ID`,
    environment: `${keyPrefix}_ENVIRONMENT`,
  };
  const shape = {
    [keys.issuer]: requiredString(keys.issuer).refine(
      (value) =>
        URL.canParse(value) &&
        new URL(value).protocol === "https:" &&
        !value.endsWith("/"),
      {
        message: `${keys.issuer} must be an https URL with no trailing slash, as the token's iss`,
      }
    ),
    [keys.audience]: requiredString(keys.audience).refine(
      isRealtimeOnlyOidcAudience,
      { message: `${keys.audience} must not be Vercel's default audience` }
    ),
    [keys.ownerId]: requiredString(keys.ownerId),
    [keys.projectId]: requiredString(keys.projectId),
  };
  const toConfig = (env: Record<string, string>): InternalOidcConfig => ({
    issuer: env[keys.issuer],
    audience: env[keys.audience],
    ownerId: env[keys.ownerId],
    projectId: env[keys.projectId],
    environment: env[keys.environment],
  });
  return {
    offEcs: z
      .object({
        ...shape,
        [keys.environment]: requiredString(keys.environment),
      })
      .transform(toConfig),
    onEcs: z
      .object({
        ...shape,
        [keys.environment]: requiredString(keys.environment).refine(
          (value) => value !== DEVELOPMENT_ENVIRONMENT,
          { message: `${keys.environment} must not be development on ECS` }
        ),
      })
      .transform(toConfig),
  };
}

/** Vercel's discovery documents publish `jwks_uri` as the issuer plus this. */
const JWKS_PATH = "/.well-known/jwks";
const VERCEL_OIDC_ALGORITHM = "RS256";
const CLOCK_TOLERANCE_SECONDS = 5;

/** Both attempts fit inside the caller's 2 s timeout (`REALTIME_INTERNAL_CALL_TIMEOUT_MS`). */
export const JWKS_FETCH_ATTEMPTS = 2;
/** Matches jose's own pause between refetches for an unknown `kid`. */
export const JWKS_OUTAGE_COOLDOWN_MS = 30_000;
const JWKS_FETCH_TIMEOUT_MS = 750;
