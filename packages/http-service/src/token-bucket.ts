export type TokenBucket = {
  /** Spends one token; false when none is left. */
  take(): boolean;
};

export type TokenBucketLimit = {
  burst: number;
  refillPerSecond: number;
};

/** Starts full, so a fresh bucket may spend its whole burst at once. */
export function createTokenBucket(
  limit: TokenBucketLimit,
  now: () => number
): TokenBucket {
  let tokens = limit.burst;
  let refilledAt = now();
  return {
    take() {
      const at = now();
      const elapsedMs = Math.max(0, at - refilledAt);
      refilledAt = at;
      tokens = Math.min(
        limit.burst,
        tokens + (elapsedMs * limit.refillPerSecond) / MS_PER_SECOND
      );
      if (tokens < 1) {
        return false;
      }
      tokens -= 1;
      return true;
    },
  };
}

const MS_PER_SECOND = 1000;
