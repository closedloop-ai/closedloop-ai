import type {
  AgentSessionListItem,
  AgentSessionListResponse,
} from "@repo/api/src/types/agent-session";
import { ReadSource } from "@repo/api/src/types/read-source";
import { isRecord } from "@repo/lib/harness/type-guards";

/** The stores represented by one Desktop Sessions list result. */
export const DesktopSessionsListSource = {
  CachedCloud: "cached-cloud",
  Cloud: "cloud",
  Local: "local",
  Mixed: "mixed",
  Unknown: "unknown",
} as const;
export type DesktopSessionsListSource =
  (typeof DesktopSessionsListSource)[keyof typeof DesktopSessionsListSource];

/** Whether the rows came from a read that just completed or retained evidence. */
export const DesktopSessionsListFreshness = {
  Fresh: "fresh",
  Stale: "stale",
} as const;
export type DesktopSessionsListFreshness =
  (typeof DesktopSessionsListFreshness)[keyof typeof DesktopSessionsListFreshness];

/** Whether a result establishes the whole population for its requested scope. */
export const DesktopSessionsListCompleteness = {
  Complete: "complete",
  Partial: "partial",
} as const;
export type DesktopSessionsListCompleteness =
  (typeof DesktopSessionsListCompleteness)[keyof typeof DesktopSessionsListCompleteness];

/** Desktop-only provenance carried beside a list without widening the wire type. */
export type DesktopSessionsListSourceState = {
  completeness: DesktopSessionsListCompleteness;
  freshness: DesktopSessionsListFreshness;
  hasKnownTotal: boolean;
  source: DesktopSessionsListSource;
};

export const CLOUD_FRESH_SESSIONS_SOURCE_STATE = {
  completeness: DesktopSessionsListCompleteness.Complete,
  freshness: DesktopSessionsListFreshness.Fresh,
  hasKnownTotal: true,
  source: DesktopSessionsListSource.Cloud,
} as const satisfies DesktopSessionsListSourceState;

export const LOCAL_FALLBACK_SESSIONS_SOURCE_STATE = {
  completeness: DesktopSessionsListCompleteness.Partial,
  freshness: DesktopSessionsListFreshness.Fresh,
  hasKnownTotal: true,
  source: DesktopSessionsListSource.Local,
} as const satisfies DesktopSessionsListSourceState;

export const CACHED_CLOUD_SESSIONS_SOURCE_STATE = {
  completeness: DesktopSessionsListCompleteness.Partial,
  freshness: DesktopSessionsListFreshness.Stale,
  hasKnownTotal: true,
  source: DesktopSessionsListSource.CachedCloud,
} as const satisfies DesktopSessionsListSourceState;

export const MIXED_SESSIONS_SOURCE_STATE = {
  completeness: DesktopSessionsListCompleteness.Partial,
  freshness: DesktopSessionsListFreshness.Stale,
  hasKnownTotal: false,
  source: DesktopSessionsListSource.Mixed,
} as const satisfies DesktopSessionsListSourceState;

const MIXED_KNOWN_TOTAL_SESSIONS_SOURCE_STATE = {
  ...MIXED_SESSIONS_SOURCE_STATE,
  hasKnownTotal: true,
} as const satisfies DesktopSessionsListSourceState;

export const CLOUD_PARTIAL_SESSIONS_SOURCE_STATE = {
  completeness: DesktopSessionsListCompleteness.Partial,
  freshness: DesktopSessionsListFreshness.Fresh,
  hasKnownTotal: true,
  source: DesktopSessionsListSource.Cloud,
} as const satisfies DesktopSessionsListSourceState;

const UNKNOWN_SESSIONS_SOURCE_STATE = {
  completeness: DesktopSessionsListCompleteness.Partial,
  freshness: DesktopSessionsListFreshness.Stale,
  hasKnownTotal: false,
  source: DesktopSessionsListSource.Unknown,
} as const satisfies DesktopSessionsListSourceState;

const DESKTOP_SESSIONS_SOURCE_STATE_PROPERTY =
  "__closedloopDesktopSessionsSourceState";

const DesktopSessionsListSourceStateMarker = {
  CachedCloud: "cached-cloud-stale-partial",
  Cloud: "cloud-fresh-complete",
  CloudPartial: "cloud-fresh-partial",
  Local: "local-fresh-partial",
  Mixed: "mixed-stale-partial",
  MixedUnknownTotal: "mixed-stale-partial-unknown-total",
} as const;
type DesktopSessionsListSourceStateMarker =
  (typeof DesktopSessionsListSourceStateMarker)[keyof typeof DesktopSessionsListSourceStateMarker];

const sourceStateByResponse = new WeakMap<
  AgentSessionListResponse,
  DesktopSessionsListSourceState
>();

/** A producer returned rows that cannot be reconciled without lying. */
export class DesktopSessionsStableIdentityError extends Error {}

/** A safely renderable page plus any quarantined-row finding. */
export type DesktopSessionsListValidation = {
  issue: DesktopSessionsStableIdentityError | undefined;
  response: AgentSessionListResponse;
};

/**
 * Validates trimmed tuple identity and rejects ambiguity inside one producer.
 * Repeating an external id across compute targets is valid; repeating the full
 * tuple is not safe to cache, reconcile, or route.
 */
export function validateDesktopSessionsList(
  response: AgentSessionListResponse
): AgentSessionListResponse {
  const validation = quarantineInvalidDesktopSessionsRows(response);
  if (validation.issue) {
    throw validation.issue;
  }
  return response;
}

/**
 * Removes blank and ambiguous tuple identities while retaining valid siblings.
 * All rows in a duplicate tuple are quarantined because neither is safe to
 * cache or route. The caller reports the returned issue at its monitored
 * boundary and rejects a non-empty page only when no safe row remains.
 */
export function quarantineInvalidDesktopSessionsRows(
  response: AgentSessionListResponse
): DesktopSessionsListValidation {
  const invalidIndexes = new Set<number>();
  const indexesByIdentity = new Map<string, number[]>();

  for (const [index, item] of response.items.entries()) {
    try {
      const key = reconciliationIdentity(item);
      const indexes = indexesByIdentity.get(key);
      if (indexes) {
        indexes.push(index);
      } else {
        indexesByIdentity.set(key, [index]);
      }
    } catch (error) {
      if (!(error instanceof DesktopSessionsStableIdentityError)) {
        throw error;
      }
      invalidIndexes.add(index);
    }
  }

  for (const indexes of indexesByIdentity.values()) {
    if (indexes.length > 1) {
      for (const index of indexes) {
        invalidIndexes.add(index);
      }
    }
  }

  if (invalidIndexes.size === 0) {
    return { issue: undefined, response };
  }

  return {
    issue: new DesktopSessionsStableIdentityError(
      `Sessions source returned ${invalidIndexes.size} row(s) without a unique stable identity.`
    ),
    response: {
      ...response,
      items: response.items.filter(
        (_item, index) => !invalidIndexes.has(index)
      ),
    },
  };
}

/** Records renderer-only provenance so React Query structural sharing retains it. */
export function markDesktopSessionsListSourceState(
  response: AgentSessionListResponse,
  state: DesktopSessionsListSourceState
): AgentSessionListResponse {
  sourceStateByResponse.set(response, state);
  Reflect.defineProperty(response, DESKTOP_SESSIONS_SOURCE_STATE_PROPERTY, {
    configurable: true,
    enumerable: true,
    value: markerForSourceState(state),
  });
  return response;
}

/**
 * Reads Desktop provenance, conservatively deriving older responses from their
 * existing `readSource` discriminator when no renderer metadata is available.
 */
export function getDesktopSessionsListSourceState(
  response: AgentSessionListResponse | undefined
): DesktopSessionsListSourceState | undefined {
  if (!response) {
    return undefined;
  }
  const recorded = sourceStateByResponse.get(response);
  if (recorded) {
    return recorded;
  }
  const durableState = sourceStateFromMarker(
    Reflect.get(response, DESKTOP_SESSIONS_SOURCE_STATE_PROPERTY)
  );
  if (durableState) {
    return durableState;
  }
  if (response.readSource === ReadSource.Cloud) {
    return CLOUD_FRESH_SESSIONS_SOURCE_STATE;
  }
  if (response.readSource === ReadSource.Local) {
    return LOCAL_FALLBACK_SESSIONS_SOURCE_STATE;
  }
  return UNKNOWN_SESSIONS_SOURCE_STATE;
}

/** Builds a partial local result while retaining every operand the row supplies. */
export function toDesktopLocalFallbackList(
  response: AgentSessionListResponse
): AgentSessionListResponse {
  validateDesktopSessionsList(response);
  const fallback = {
    items: response.items,
    pageInfo: response.pageInfo,
    readSource: ReadSource.Local,
    total: response.total,
    viewerScope: response.viewerScope,
  };
  return markDesktopSessionsListSourceState(
    fallback,
    LOCAL_FALLBACK_SESSIONS_SOURCE_STATE
  );
}

/** Builds a stale partial result from the last fully valid cloud response. */
export function toDesktopCachedCloudFallbackList(
  response: AgentSessionListResponse
): AgentSessionListResponse {
  validateDesktopSessionsList(response);
  const fallback = {
    items: response.items,
    pageInfo: response.pageInfo,
    readSource: ReadSource.Cloud,
    total: response.total,
    viewerScope: response.viewerScope,
  };
  return markDesktopSessionsListSourceState(
    fallback,
    CACHED_CLOUD_SESSIONS_SOURCE_STATE
  );
}

/**
 * Reconciles fresh local evidence into a cached cloud page. Cloud order remains
 * stable, the fresher row replaces overlaps, and local-only rows fill free page slots.
 */
export function reconcileDesktopSessionsFallback({
  cachedCloud,
  limit,
  local,
}: {
  cachedCloud: AgentSessionListResponse;
  limit: number;
  local: AgentSessionListResponse;
}): AgentSessionListResponse {
  validateDesktopSessionsList(cachedCloud);
  validateDesktopSessionsList(local);
  const cachedByIdentity = indexByReconciliationIdentity(cachedCloud.items);
  const localByIdentity = indexByReconciliationIdentity(local.items);
  const reconciled: AgentSessionListItem[] = [];

  for (const cloudItem of cachedCloud.items) {
    const key = reconciliationIdentity(cloudItem);
    const localItem = localByIdentity.get(key);
    reconciled.push(selectFresherRow(cloudItem, localItem));
    localByIdentity.delete(key);
    if (reconciled.length === limit) {
      break;
    }
  }

  const localOnly = [...localByIdentity.entries()].filter(
    ([key]) => !cachedByIdentity.has(key)
  );
  if (reconciled.length < limit) {
    for (const [, item] of localOnly) {
      reconciled.push(item);
      if (reconciled.length === limit) {
        break;
      }
    }
  }

  const result = {
    items: reconciled,
    pageInfo: cachedCloud.pageInfo ?? local.pageInfo,
    total: Math.max(cachedCloud.total, local.total, reconciled.length),
    viewerScope: cachedCloud.viewerScope,
  };
  return markDesktopSessionsListSourceState(
    result,
    localOnly.length === 0
      ? MIXED_KNOWN_TOTAL_SESSIONS_SOURCE_STATE
      : MIXED_SESSIONS_SOURCE_STATE
  );
}

function indexByReconciliationIdentity(
  items: readonly AgentSessionListItem[]
): Map<string, AgentSessionListItem> {
  const indexed = new Map<string, AgentSessionListItem>();
  for (const item of items) {
    const key = reconciliationIdentity(item);
    if (indexed.has(key)) {
      throw new DesktopSessionsStableIdentityError(
        "Sessions source returned duplicate stable session identities."
      );
    }
    indexed.set(key, item);
  }
  return indexed;
}

function reconciliationIdentity(item: AgentSessionListItem): string {
  return JSON.stringify([
    stableComputeTargetId(item),
    stableExternalSessionId(item),
  ]);
}

function selectFresherRow(
  cloudItem: AgentSessionListItem,
  localItem: AgentSessionListItem | undefined
): AgentSessionListItem {
  if (!localItem) {
    return cloudItem;
  }
  const cloudUpdatedAt =
    cloudItem.updatedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const localUpdatedAt =
    localItem.updatedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  return localUpdatedAt > cloudUpdatedAt ? localItem : cloudItem;
}

function stableExternalSessionId(item: AgentSessionListItem): string {
  const candidate: unknown = item.externalSessionId;
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new DesktopSessionsStableIdentityError(
      "Sessions source returned a row without a stable external session identity."
    );
  }
  return candidate.trim();
}

function stableComputeTargetId(item: AgentSessionListItem): string {
  const computeTarget: unknown = item.computeTarget;
  if (!isRecord(computeTarget)) {
    throw new DesktopSessionsStableIdentityError(
      "Sessions source returned a row without a stable compute-target identity."
    );
  }
  const candidate: unknown = computeTarget.id;
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new DesktopSessionsStableIdentityError(
      "Sessions source returned a row without a stable compute-target identity."
    );
  }
  return candidate.trim();
}

function markerForSourceState(
  state: DesktopSessionsListSourceState
): DesktopSessionsListSourceStateMarker {
  if (state === CLOUD_FRESH_SESSIONS_SOURCE_STATE) {
    return DesktopSessionsListSourceStateMarker.Cloud;
  }
  if (state === CLOUD_PARTIAL_SESSIONS_SOURCE_STATE) {
    return DesktopSessionsListSourceStateMarker.CloudPartial;
  }
  if (state === LOCAL_FALLBACK_SESSIONS_SOURCE_STATE) {
    return DesktopSessionsListSourceStateMarker.Local;
  }
  if (state === CACHED_CLOUD_SESSIONS_SOURCE_STATE) {
    return DesktopSessionsListSourceStateMarker.CachedCloud;
  }
  if (state === MIXED_KNOWN_TOTAL_SESSIONS_SOURCE_STATE) {
    return DesktopSessionsListSourceStateMarker.Mixed;
  }
  return DesktopSessionsListSourceStateMarker.MixedUnknownTotal;
}

function sourceStateFromMarker(
  marker: unknown
): DesktopSessionsListSourceState | undefined {
  if (marker === DesktopSessionsListSourceStateMarker.Cloud) {
    return CLOUD_FRESH_SESSIONS_SOURCE_STATE;
  }
  if (marker === DesktopSessionsListSourceStateMarker.CloudPartial) {
    return CLOUD_PARTIAL_SESSIONS_SOURCE_STATE;
  }
  if (marker === DesktopSessionsListSourceStateMarker.Local) {
    return LOCAL_FALLBACK_SESSIONS_SOURCE_STATE;
  }
  if (marker === DesktopSessionsListSourceStateMarker.CachedCloud) {
    return CACHED_CLOUD_SESSIONS_SOURCE_STATE;
  }
  if (marker === DesktopSessionsListSourceStateMarker.Mixed) {
    return MIXED_KNOWN_TOTAL_SESSIONS_SOURCE_STATE;
  }
  if (marker === DesktopSessionsListSourceStateMarker.MixedUnknownTotal) {
    return MIXED_SESSIONS_SOURCE_STATE;
  }
  return undefined;
}
