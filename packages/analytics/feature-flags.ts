import {
  isPinnedFeatureFlagEnabled,
  isPostHogFlagValueEnabled,
  type PinnedFeatureFlags,
} from "./feature-flag-value";

/**
 * ISS-4556: the return type admits `undefined`, because posthog-node's does.
 * `isFeatureEnabled(): Promise<boolean | undefined>` — "undefined if not found"
 * — and its failure path resolves rather than rejects: on a request failure
 * `getFeatureFlagDetailsStateless` returns `undefined` ("Request failed, return
 * undefined"), `_getFeatureFlagResult` records an internal `UNKNOWN_ERROR` and
 * leaves the result undefined, and that propagates out untouched. Declaring the
 * narrower `boolean` here is what made an outage indistinguishable from an
 * evaluated OFF below.
 */
type FeatureFlagAnalyticsClient = {
  isFeatureEnabled?: (
    flag: string,
    distinctId: string,
    options?: {
      groups?: Record<string, string>;
      sendFeatureFlagEvents?: boolean;
    }
  ) => boolean | undefined | Promise<boolean | undefined>;
  /**
   * posthog-node's whole-assignment read. Its values are `boolean` for a plain
   * flag and the variant `string` for a multivariate one, which is the same
   * shape the browser SDK returns and which `client.ts` normalizes identically
   * (a variant string means ENABLED).
   */
  getAllFlags?: (
    distinctId: string
  ) =>
    | Record<string, boolean | string>
    | undefined
    | Promise<Record<string, boolean | string> | undefined>;
};

/**
 * Evaluates a PostHog feature flag from server runtimes that may or may not be
 * allowed to import Next's server-only analytics entrypoint.
 *
 * @returns `true`/`false` when PostHog actually ANSWERED, and `null` when it did
 *   not — no analytics client is configured, or the client resolved `undefined`
 *   (flag unknown to the project, evaluation failed, or the request to PostHog
 *   failed outright).
 *
 * ISS-4556: that `undefined` case used to be folded into `false` by a bare
 * `=== true`. Every caller that only asks "is it on?" is unaffected — they all
 * compare `=== true` and so still fail CLOSED — but a caller that needs several
 * reads in one page load to AGREE has to be able to tell "PostHog said no" from
 * "PostHog said nothing", and the collapse made the UNAVAILABLE branch of
 * `evaluateFeatureFlagForAnyIdentity` unreachable for the outage it exists to
 * absorb: only a thrown evaluation or a wholly unconfigured client ever reached
 * it, and a real outage does neither.
 */
export async function isFeatureFlagEnabledForDistinctId(
  flag: string,
  distinctId: string
): Promise<boolean | null> {
  const analytics = await loadFeatureFlagAnalyticsClient();
  if (typeof analytics?.isFeatureEnabled !== "function") {
    return null;
  }

  const result = await analytics.isFeatureEnabled(flag, distinctId);
  return result === undefined ? null : result === true;
}

/**
 * ISS-8024: evaluates the caller's ENTIRE flag assignment in one round trip,
 * for a consumer that needs every key rather than one — the desktop shell, which
 * resolves its whole gate set per user instead of asking per gate.
 *
 * @returns the per-key verdict, or `null` when the assignment could not be read
 *   at all: no analytics client is configured, the client exposes no
 *   whole-assignment read, or it resolved nothing. `null` is UNKNOWN, never "all
 *   off" — the distinction {@link isFeatureFlagEnabledForDistinctId} exists to
 *   preserve (ISS-4556), kept here for the same reason.
 * @throws whatever `getAllFlags` throws. A REJECTED read is NOT folded into
 *   `null` here, deliberately and identically to
 *   {@link isFeatureFlagEnabledForDistinctId}: this helper is a thin read of one
 *   distinct id, and per-id isolation belongs to the caller that knows how many
 *   ids are in play. `getAllFeatureFlagsForAnyIdentity` is that caller — its
 *   `Promise.allSettled` keeps one id's rejection from discarding another id's
 *   answer, and logs the failure. Swallowing the throw here would make that
 *   branch unreachable and leave a multi-id caller unable to tell a failed read
 *   from a genuinely empty one. A DIRECT consumer must handle rejection itself.
 *
 * Enabled-ness comes from {@link isPostHogFlagValueEnabled}, the SAME predicate
 * `client.ts` applies to the browser SDK's identical shape — imported, not
 * restated, so a multivariate flag cannot read as enabled on one surface and
 * unknown on the other.
 *
 * KNOWN LIMIT, stated rather than hidden: posthog-node resolves its own request
 * failures to an EMPTY record rather than throwing, so "the project has no
 * flags" and "the request failed" both arrive here as `{}` and both report
 * `resolved`. Every key still evaluates CLOSED, which is the required posture;
 * the only consequence is that a consumer's no-flash gate settles rather than
 * waiting. That is the safe direction — a settled-closed gate renders the
 * default UI, where a never-settling one would hold a route in loading forever.
 */
export async function getAllFeatureFlagsForDistinctId(
  distinctId: string
): Promise<Record<string, boolean> | null> {
  const analytics = await loadFeatureFlagAnalyticsClient();
  if (typeof analytics?.getAllFlags !== "function") {
    return null;
  }

  const result = await analytics.getAllFlags(distinctId);
  if (!result) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(result).map(([flag, value]) => [
      flag,
      isPostHogFlagValueEnabled(value),
    ])
  );
}

export type PinnedFeatureFlagsProvider =
  () => Promise<PinnedFeatureFlags | null>;

/**
 * Installs the source of pinned flags. `apps/api` installs one that reads its
 * preview schema's stored snapshot and answers `null` everywhere else
 * (`apps/api/lib/feature-flags/feature-flag-snapshot.ts`); with none installed
 * every read is live, exactly as before.
 *
 * On a `Symbol.for` slot rather than a module binding, so the instrumentation
 * entry that installs it and a route bundle that reads it share one value even
 * when the bundler gives each its own copy of this module.
 */
export function setPinnedFeatureFlagsProvider(
  provider: PinnedFeatureFlagsProvider | null
): void {
  pinnedProviderSlot()[PINNED_FEATURE_FLAGS_PROVIDER] = provider ?? undefined;
}

/**
 * The pinned flags in force, or `null`. A provider that throws pins nothing:
 * the snapshot is a preview convenience and must never take a live read down.
 */
export async function readPinnedFeatureFlags(): Promise<PinnedFeatureFlags | null> {
  const provider = pinnedProviderSlot()[PINNED_FEATURE_FLAGS_PROVIDER];
  if (!provider) {
    return null;
  }
  try {
    return await provider();
  } catch {
    return null;
  }
}

const PINNED_FEATURE_FLAGS_PROVIDER = Symbol.for(
  "closedloop.analytics.pinnedFeatureFlagsProvider"
);

type PinnedProviderGlobal = typeof globalThis & {
  [PINNED_FEATURE_FLAGS_PROVIDER]?: PinnedFeatureFlagsProvider;
};

function pinnedProviderSlot(): PinnedProviderGlobal {
  return globalThis as PinnedProviderGlobal;
}

/**
 * A client answering from pinned flags, the same two reads the live clients
 * expose, so every caller above pins without knowing a snapshot exists.
 */
function createPinnedFeatureFlagClient(
  pinned: PinnedFeatureFlags
): FeatureFlagAnalyticsClient {
  return {
    isFeatureEnabled: (flag) => isPinnedFeatureFlagEnabled(pinned, flag),
    getAllFlags: () => ({ ...pinned }),
  };
}

async function loadFeatureFlagAnalyticsClient(): Promise<FeatureFlagAnalyticsClient | null> {
  const pinned = await readPinnedFeatureFlags();
  if (pinned) {
    return createPinnedFeatureFlagClient(pinned);
  }
  try {
    const serverAnalytics = await import("./server");
    return serverAnalytics.analytics as FeatureFlagAnalyticsClient;
  } catch {
    try {
      const nodeAnalytics = await import("./node");
      return nodeAnalytics.nodeAnalytics as FeatureFlagAnalyticsClient;
    } catch {
      return null;
    }
  }
}

/**
 * The PostHog group type an organization is identified under: the Clerk
 * organization webhooks `groupIdentify` it as `company`, keyed by its Clerk id.
 */
export const POSTHOG_ORGANIZATION_GROUP_TYPE = "company";

/**
 * Evaluates a flag for one PostHog group alone (PLN-2187 T-2.6), so a
 * percentage rollout buckets by the group, never by a person. The group key
 * stands in as the distinct id, and no `$feature_flag_called` event is
 * captured under it.
 *
 * @returns `true`/`false` when PostHog answered, `null` when it did not, as
 *   {@link isFeatureFlagEnabledForDistinctId} does.
 */
export async function isFeatureFlagEnabledForGroup(
  flag: string,
  group: { type: string; key: string }
): Promise<boolean | null> {
  const analytics = await loadFeatureFlagAnalyticsClient();
  if (typeof analytics?.isFeatureEnabled !== "function") {
    return null;
  }

  const result = await analytics.isFeatureEnabled(flag, group.key, {
    groups: { [group.type]: group.key },
    sendFeatureFlagEvents: false,
  });
  return result === undefined ? null : result === true;
}
