import RedisClient from "ioredis";

type Redis = RedisClient;

// Minimal structured-logger shape so consumers can route lifecycle events
// through their own logger (e.g. @repo/observability) instead of raw console.
type RedisLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

type RedisClientOptions = {
  url: string;
  keyPrefix?: string;
  onError?: (error: Error) => void;
  logger?: RedisLogger;
};

const consoleLogger: RedisLogger = {
  info: (message, meta) =>
    meta ? console.log(message, meta) : console.log(message),
  warn: (message, meta) =>
    meta ? console.warn(message, meta) : console.warn(message),
};

export function createRedisClient(options: RedisClientOptions): RedisClient {
  const { url, keyPrefix, onError, logger = consoleLogger } = options;

  const client = new RedisClient(url, {
    keyPrefix,
    tls: url.startsWith("rediss://") ? {} : undefined,
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      return Math.min(times * 200, 5000);
    },
    lazyConnect: true,
  });

  client.on("error", (error) => {
    if (onError) {
      onError(error);
    } else {
      logger.warn("[redis] connection error", { error: error.message });
    }
  });

  client.on("connect", () => {
    logger.info("[redis] connected", keyPrefix ? { keyPrefix } : undefined);
  });

  client.on("close", () => {
    logger.info("[redis] connection closed");
  });

  return client;
}

export async function checkRedisHealth(client: RedisClient): Promise<boolean> {
  try {
    const result = await client.ping();
    return result === "PONG";
  } catch {
    return false;
  }
}

export type { Redis, RedisClientOptions };
