import { PostHog } from "posthog-node";

/**
 * PostHog feature flag gating prototype/parity MCP tools that are not yet
 * generally available (currently the agent-session reporting tools). Shares the
 * same `emergent` key the web app uses for early-access surfaces.
 */
export const EMERGENT_FEATURE_FLAG = "emergent";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST;

function positiveIntEnv(name: string, defaultValue: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : defaultValue;
}

const CACHE_TTL_MS = positiveIntEnv("MCP_FEATURE_FLAG_CACHE_TTL_MS", 60_000);
// Shorter TTL for negatively-cached failures so tools recover soon after a
// transient PostHog outage instead of staying dark for the full success TTL.
const FAILURE_CACHE_TTL_MS = Math.min(CACHE_TTL_MS, 10_000);
// Hard cap on how long a flag evaluation may block MCP session creation. The
// gate is on the session handshake hot path, so a slow/unreachable PostHog must
// never stall it — on timeout we fail closed.
const EVAL_TIMEOUT_MS = positiveIntEnv("MCP_FEATURE_FLAG_TIMEOUT_MS", 1500);

// `undefined` = not yet resolved, `null` = PostHog not configured (no key).
let cachedClient: PostHog | null | undefined;

function getClient(): PostHog | null {
  if (cachedClient !== undefined) {
    return cachedClient;
  }
  if (!POSTHOG_KEY) {
    cachedClient = null;
    return cachedClient;
  }
  cachedClient = new PostHog(POSTHOG_KEY, {
    host: POSTHOG_HOST,
    flushAt: 1,
    flushInterval: 0,
  });
  return cachedClient;
}

type FlagCacheEntry = { value: boolean; expiresAtMs: number };
const flagCache = new Map<string, FlagCacheEntry>();

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`feature flag evaluation timed out after ${timeoutMs}ms`)
        ),
      timeoutMs
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Evaluate a PostHog feature flag for a user from the MCP server.
 *
 * Fails **closed**: returns `false` when PostHog is not configured, the
 * evaluation errors, or it exceeds {@link EVAL_TIMEOUT_MS}, so prototype-gated
 * tools stay hidden unless the flag is explicitly enabled — and a slow PostHog
 * never stalls session creation. Results (including failures) are cached per
 * `flag:distinctId` for a short TTL so repeated MCP session handshakes from the
 * same user don't re-hit PostHog on every connection.
 */
export async function isMcpFeatureFlagEnabled(
  flag: string,
  distinctId: string
): Promise<boolean> {
  const cacheKey = `${flag}:${distinctId}`;
  const now = Date.now();
  const cached = flagCache.get(cacheKey);
  if (cached && cached.expiresAtMs > now) {
    return cached.value;
  }

  try {
    const client = getClient();
    if (!client) {
      return false;
    }
    const enabled =
      (await withTimeout(
        Promise.resolve(client.isFeatureEnabled(flag, distinctId)),
        EVAL_TIMEOUT_MS
      )) === true;
    flagCache.set(cacheKey, {
      value: enabled,
      expiresAtMs: now + CACHE_TTL_MS,
    });
    return enabled;
  } catch (error) {
    console.warn(
      `[mcp] feature flag "${flag}" evaluation failed; treating as disabled`,
      error
    );
    // Negatively cache so a persistently failing PostHog doesn't re-block every
    // subsequent session handshake within the failure window.
    flagCache.set(cacheKey, {
      value: false,
      expiresAtMs: now + FAILURE_CACHE_TTL_MS,
    });
    return false;
  }
}
