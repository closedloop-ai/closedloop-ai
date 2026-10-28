import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { formatUrl } from "@aws-sdk/util-format-url";
import { describeCause } from "@repo/http-service/describe-cause";
import { log } from "@repo/observability/log";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { z } from "zod";

export type RedisIamConfig = {
  cacheName: string;
  userId: string;
  region: string;
};

export type RedisIamAuth = {
  userId: string;
  /** A token valid for {@link TOKEN_TTL_SECONDS} from now. */
  mintToken(): Promise<string>;
};

type CredentialProvider = ReturnType<typeof fromNodeProviderChain>;
type AwsCredentials = Awaited<ReturnType<CredentialProvider>>;

/**
 * Builds the token as AWS's `IAMAuthTokenRequest` does
 * (https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/auth-iam.html,
 * "Connect with token as password"): `GET http://<cache name>/` with
 * `Action=connect`, `User=<user id>` and `ResourceType=ServerlessCache`,
 * SigV4-presigned for `elasticache` with a 900 s expiry, minus the scheme.
 * Signing is local; the only AWS call is resolving the task role, through the
 * SDK's default provider chain, as the LISTEN connection's RDS signer does.
 * The credentials that sign a token always outlive {@link CREDENTIALS_FLOOR_MS}.
 */
export function createRedisIamAuth(
  config: RedisIamConfig,
  deps: { credentials?: CredentialProvider; now?: () => Date } = {}
): RedisIamAuth {
  const credentials = deps.credentials ?? fromNodeProviderChain();
  const now = deps.now ?? (() => new Date());
  const signer = new SignatureV4({
    service: ELASTICACHE_SIGNING_NAME,
    region: config.region,
    credentials: () => credentialsOutlivingFloor(credentials, now()),
    sha256: Hash.bind(null, "sha256"),
  });
  return {
    userId: config.userId,
    async mintToken() {
      const presigned = await signer.presign(
        {
          method: "GET",
          protocol: TOKEN_PROTOCOL,
          hostname: config.cacheName,
          path: "/",
          query: {
            Action: "connect",
            User: config.userId,
            ResourceType: "ServerlessCache",
          },
          headers: { host: config.cacheName },
        },
        { expiresIn: TOKEN_TTL_SECONDS, signingDate: now() }
      );
      return formatUrl(presigned).replace(`${TOKEN_PROTOCOL}//`, "");
    },
  };
}

/** The ioredis surface IAM auth drives. */
export type IamRedisClient = {
  readonly options: { username?: string; password?: string; db?: number };
  condition: { select: number; subscriber: unknown } | null;
  /** ioredis: `subscriber` and `monitor` refuse AUTH. */
  readonly mode: string;
  auth(username: string, password: string): Promise<unknown>;
  connect(): Promise<void>;
  disconnect(reconnect?: boolean): void;
  on(event: "ready" | "close" | "end", listener: () => void): unknown;
};

/**
 * Connects `client` as the IAM user once its first token is minted. ioredis
 * reads `options.password` on every (re)connect, so a token re-minted every
 * {@link TOKEN_REFRESH_MS} keeps any reconnect inside the token's 15 minutes.
 * ElastiCache closes an IAM connection 12 hours after its last AUTH, so
 * {@link MAX_CONNECTION_AGE_MS} after a connection became ready it AUTHs again
 * in place with a new token. A subscribed connection cannot run AUTH, so it
 * reconnects instead, and the bus replays the revocation log on its
 * resubscribe.
 */
export function connectWithIamAuth(
  client: IamRedisClient,
  auth: RedisIamAuth
): void {
  client.options.username = auth.userId;
  let ended = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let ageTimer: ReturnType<typeof setTimeout> | undefined;
  let tokenMinted: () => void = () => undefined;
  const firstToken = new Promise<void>((resolve) => {
    tokenMinted = resolve;
  });
  // ioredis also connects on a command sent while it waits, taking AUTH from
  // `options` there and then, and queues that command against the
  // `condition` only connect() sets (Redis.js sendCommand). So every connect
  // until a token exists joins one held connect, and the queue gets the
  // condition early; ioredis's own reconnects then call connect directly.
  client.condition ??= { select: client.options.db ?? 0, subscriber: false };
  const connectNow = client.connect.bind(client);
  const firstConnect = firstToken.then(() => {
    client.connect = connectNow;
    return connectNow();
  });
  client.connect = () => firstConnect;

  const refresh = (): void => {
    auth.mintToken().then(
      (token) => {
        if (ended) {
          return;
        }
        client.options.password = token;
        tokenMinted();
        refreshTimer = setTimeout(refresh, TOKEN_REFRESH_MS).unref();
      },
      (error: unknown) => {
        if (ended) {
          return;
        }
        log.warn("Realtime Redis IAM token mint failed", {
          event: REDIS_IAM_TOKEN_FAILED_EVENT,
          cause: describeCause(error),
        });
        refreshTimer = setTimeout(refresh, TOKEN_RETRY_MS).unref();
      }
    );
  };

  const armRenewal = (): void => {
    clearTimeout(ageTimer);
    ageTimer = setTimeout(renew, MAX_CONNECTION_AGE_MS).unref();
  };
  const renew = (): void => {
    if (client.mode !== NORMAL_MODE) {
      log.info("Realtime Redis IAM connection renewed", {
        event: REDIS_IAM_RECONNECT_EVENT,
      });
      client.disconnect(true);
      return;
    }
    auth
      .mintToken()
      .then((token) => client.auth(auth.userId, token))
      .then(armRenewal, (error: unknown) => {
        log.warn("Realtime Redis IAM re-authentication failed", {
          event: REDIS_IAM_REAUTH_FAILED_EVENT,
          cause: describeCause(error),
        });
      });
  };

  client.on("ready", armRenewal);
  client.on("close", () => clearTimeout(ageTimer));
  client.on("end", () => {
    ended = true;
    clearTimeout(ageTimer);
    clearTimeout(refreshTimer);
  });
  client.connect().catch(() => undefined);
  refresh();
}

const requiredOnceConfigured = (key: string) =>
  z.string({
    error: `${key} is required once REALTIME_REDIS_IAM_CACHE_NAME or REALTIME_REDIS_IAM_USER_ID is set`,
  });

const redisIamSchema = z
  .object({
    REALTIME_REDIS_IAM_CACHE_NAME: requiredOnceConfigured(
      "REALTIME_REDIS_IAM_CACHE_NAME"
    ).refine((name) => name === name.toLowerCase(), {
      message:
        "REALTIME_REDIS_IAM_CACHE_NAME must be lowercase, as ElastiCache stores it",
    }),
    REALTIME_REDIS_IAM_USER_ID: requiredOnceConfigured(
      "REALTIME_REDIS_IAM_USER_ID"
    ),
    AWS_REGION: requiredOnceConfigured("AWS_REGION"),
    // ElastiCache IAM auth requires TLS, and @repo/redis turns TLS on by this prefix.
    REDIS_URL: z.string().refine((url) => url.startsWith("rediss://"), {
      message: "REDIS_URL must be rediss:// when Redis IAM auth is configured",
    }),
  })
  .transform(
    (env): RedisIamConfig => ({
      cacheName: env.REALTIME_REDIS_IAM_CACHE_NAME,
      userId: env.REALTIME_REDIS_IAM_USER_ID,
      region: env.AWS_REGION,
    })
  );

/**
 * Undefined when neither REALTIME_REDIS_IAM_* key is set, which keeps the
 * URL-only connection; otherwise both keys, AWS_REGION and a TLS REDIS_URL
 * are required.
 */
export function redisIamConfigFromEnv(
  env: Readonly<Record<string, unknown>>
): z.ZodSafeParseResult<RedisIamConfig> | undefined {
  if (
    env.REALTIME_REDIS_IAM_CACHE_NAME === undefined &&
    env.REALTIME_REDIS_IAM_USER_ID === undefined
  ) {
    return undefined;
  }
  return redisIamSchema.safeParse(env);
}

const ELASTICACHE_SIGNING_NAME = "elasticache";
const TOKEN_PROTOCOL = "http:";
export const TOKEN_TTL_SECONDS = 900;
/**
 * Inside the token's 15 minutes, and inside {@link CREDENTIALS_FLOOR_MS}: a
 * token expires with the temporary credentials that signed it
 * (AmazonElastiCache/latest/dg/connecting-public-endpoint.html).
 */
export const TOKEN_REFRESH_MS = 4 * 60 * 1000;
/** The least life left on credentials that sign a token. */
export const CREDENTIALS_FLOOR_MS = 5 * 60 * 1000;
export const TOKEN_RETRY_MS = 30 * 1000;
/** An hour inside ElastiCache's 12-hour limit on an IAM connection. */
export const MAX_CONNECTION_AGE_MS = 11 * 60 * 60 * 1000;

export const REDIS_IAM_TOKEN_FAILED_EVENT = "realtime.redis_iam_token_failed";
export const REDIS_IAM_RECONNECT_EVENT = "realtime.redis_iam_reconnect";
export const REDIS_IAM_REAUTH_FAILED_EVENT = "realtime.redis_iam_reauth_failed";
export const CREDENTIALS_EXPIRING_CODE = "credentials_expiring";
const NORMAL_MODE = "normal";

/**
 * The SDK's chain hands out its cached credentials while it refreshes them in
 * the background, until they have expired (memoizeChain), so credentials near
 * the floor are refreshed here before they sign.
 */
async function credentialsOutlivingFloor(
  provider: CredentialProvider,
  now: Date
): Promise<AwsCredentials> {
  const cached = await provider();
  if (outlivesFloor(cached, now)) {
    return cached;
  }
  const refreshed = await provider({ forceRefresh: true });
  if (outlivesFloor(refreshed, now)) {
    return refreshed;
  }
  throw Object.assign(
    new Error("AWS credentials expire inside the token refresh floor"),
    { code: CREDENTIALS_EXPIRING_CODE }
  );
}

function outlivesFloor(credentials: AwsCredentials, now: Date): boolean {
  return (
    credentials.expiration === undefined ||
    credentials.expiration.getTime() - now.getTime() >= CREDENTIALS_FLOOR_MS
  );
}
