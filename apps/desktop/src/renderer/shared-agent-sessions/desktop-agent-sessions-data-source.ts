import { DEFAULT_TABLE_PAGE_SIZE } from "@closedloop-ai/design-system/components/ui/table-page-size-select";
import { stableStringify } from "@closedloop-ai/loops-api/stable-stringify";
import type {
  AgentSessionListResponse,
  AgentSessionsPageData,
} from "@repo/api/src/types/agent-session";
import type { AgentSessionEventsPageRequest } from "@repo/api/src/types/agent-session-events-page";
import {
  CollaboratorArtifactType,
  unavailableArtifactCollaboratorBatchResponse,
} from "@repo/api/src/types/artifact-collaborators";
import type {
  AgentSessionCapabilities,
  AgentSessionQueryFilters,
  AgentSessionsDataSource,
  AgentSessionsReadOptions,
  AgentSessionUsageQueryFilters,
} from "@repo/app/agents/data-source/agent-sessions-data-source";
import {
  AgentSessionCapability,
  agentSessionSourceSupports,
} from "@repo/app/agents/data-source/agent-sessions-data-source";
import { ApiError } from "@repo/app/shared/api/api-error";
import {
  CLOUD_FRESH_SESSIONS_SOURCE_STATE,
  CLOUD_PARTIAL_SESSIONS_SOURCE_STATE,
  DesktopSessionsStableIdentityError,
  markDesktopSessionsListSourceState,
  quarantineInvalidDesktopSessionsRows,
  reconcileDesktopSessionsFallback,
  toDesktopCachedCloudFallbackList,
  toDesktopLocalFallbackList,
  validateDesktopSessionsList,
} from "./desktop-session-source-precedence";

const MAX_CACHED_SESSION_SCOPES = 16;
const MAX_REMEMBERED_ROW_SOURCES = 8000;
export const DESKTOP_CLOUD_PRIMARY_SESSIONS_SCOPE_PREFIX =
  "desktop-cloud-primary";
const desktopCloudPrimarySources = new WeakSet<AgentSessionsDataSource>();
let desktopCloudPrimarySourceSequence = 0;

/**
 * Composes the existing cloud and local ports for Desktop cloud mode. Cloud is
 * authoritative when it succeeds; local and last-good cloud rows are retained
 * only as explicitly partial evidence after a cloud failure.
 */
export function createDesktopCloudPrimaryAgentSessionsDataSource({
  cloudSource,
  identity,
  localSource,
  reportCloudReadFailure,
}: {
  cloudSource: AgentSessionsDataSource;
  identity: {
    organizationId: string | null;
    userId: string | null;
  };
  localSource: AgentSessionsDataSource;
  reportCloudReadFailure?: (error: Error) => void;
}): AgentSessionsDataSource {
  const identityKey = stableStringify(identity);
  const cachedCloudLists = new Map<string, AgentSessionListResponse>();
  const rowSourceById = new Map<string, AgentSessionsDataSource>();
  const currentGenerationByScope = new Map<string, number>();
  let nextGeneration = 0;

  const readCloudList = async (
    filters: AgentSessionQueryFilters,
    options: AgentSessionsReadOptions | undefined,
    request: SessionsListRequest
  ): Promise<AgentSessionListResponse> => {
    const response = acceptDesktopSessionsList(
      await cloudSource.list(filters, options),
      reportCloudReadFailure
    );
    options?.signal?.throwIfAborted();
    markDesktopSessionsListSourceState(
      response.response,
      response.issue
        ? CLOUD_PARTIAL_SESSIONS_SOURCE_STATE
        : CLOUD_FRESH_SESSIONS_SOURCE_STATE
    );
    if (isCurrentSessionsListRequest(currentGenerationByScope, request)) {
      if (!response.issue) {
        rememberCloudList(
          cachedCloudLists,
          identityKey,
          filters,
          response.response
        );
      }
      rememberRows(rowSourceById, response.response, cloudSource);
    }
    return response.response;
  };

  const readFallbackList = async (
    filters: AgentSessionQueryFilters,
    options: AgentSessionsReadOptions | undefined,
    cloudError: unknown,
    request: SessionsListRequest
  ): Promise<AgentSessionListResponse> => {
    options?.signal?.throwIfAborted();
    let cachedCloud: AgentSessionListResponse | undefined;
    try {
      cachedCloud = readRememberedCloudList(
        cachedCloudLists,
        identityKey,
        filters,
        reportCloudReadFailure
      );
    } catch (cacheError) {
      reportCloudReadFailure?.(asError(cacheError));
      throw cacheError;
    }
    try {
      const localResponse = acceptDesktopSessionsList(
        await localSource.list(filters, options),
        reportCloudReadFailure
      ).response;
      options?.signal?.throwIfAborted();
      if (!cachedCloud) {
        const fallback = toDesktopLocalFallbackList(localResponse);
        rememberRowsForCurrentRequest({
          currentGenerationByScope,
          request,
          response: localResponse,
          rowSourceById,
          source: localSource,
        });
        return fallback;
      }
      const fallback = reconcileDesktopSessionsFallback({
        cachedCloud,
        limit: boundedPageLimit(filters.limit),
        local: localResponse,
      });
      rememberReconciledRowsForCurrentRequest({
        cloudSource,
        currentGenerationByScope,
        localResponse,
        localSource,
        request,
        response: fallback,
        rowSourceById,
      });
      return fallback;
    } catch (localError) {
      options?.signal?.throwIfAborted();
      if (isStableIdentityError(localError)) {
        reportCloudReadFailure?.(asError(localError));
        throw localError;
      }
      if (cachedCloud) {
        rememberRowsForCurrentRequest({
          currentGenerationByScope,
          request,
          response: cachedCloud,
          rowSourceById,
          source: cloudSource,
        });
        return toDesktopCachedCloudFallbackList(cachedCloud);
      }
      throw cloudError;
    }
  };

  const list = async (
    filters: AgentSessionQueryFilters,
    options?: AgentSessionsReadOptions
  ): Promise<AgentSessionListResponse> => {
    const request = beginSessionsListRequest(
      currentGenerationByScope,
      identityKey,
      filters,
      () => ++nextGeneration
    );
    try {
      return await readCloudList(filters, options, request);
    } catch (cloudError) {
      options?.signal?.throwIfAborted();
      if (isAuthenticationOrAuthorizationError(cloudError)) {
        throw cloudError;
      }
      reportCloudReadFailure?.(asError(cloudError));
      if (isStableIdentityError(cloudError)) {
        throw cloudError;
      }
      return readFallbackList(filters, options, cloudError, request);
    }
  };

  const pageData = async (
    filters: AgentSessionUsageQueryFilters,
    options?: AgentSessionsReadOptions
  ): Promise<AgentSessionsPageData> => {
    const request = beginSessionsListRequest(
      currentGenerationByScope,
      identityKey,
      filters,
      () => ++nextGeneration
    );
    try {
      const response = await cloudSource.pageData(filters, options);
      const validatedList = acceptDesktopSessionsList(
        response.list,
        reportCloudReadFailure
      );
      options?.signal?.throwIfAborted();
      markDesktopSessionsListSourceState(
        validatedList.response,
        validatedList.issue
          ? CLOUD_PARTIAL_SESSIONS_SOURCE_STATE
          : CLOUD_FRESH_SESSIONS_SOURCE_STATE
      );
      if (isCurrentSessionsListRequest(currentGenerationByScope, request)) {
        if (!validatedList.issue) {
          rememberCloudList(
            cachedCloudLists,
            identityKey,
            filters,
            validatedList.response
          );
        }
        rememberRows(rowSourceById, validatedList.response, cloudSource);
      }
      return { ...response, list: validatedList.response };
    } catch (cloudError) {
      options?.signal?.throwIfAborted();
      if (isAuthenticationOrAuthorizationError(cloudError)) {
        throw cloudError;
      }
      reportCloudReadFailure?.(asError(cloudError));
      if (isStableIdentityError(cloudError)) {
        throw cloudError;
      }
      const { comparison: _comparison, ...listFilters } = filters;
      const fallback = await readFallbackList(
        listFilters,
        options,
        cloudError,
        request
      );
      return { list: fallback, usageError: true };
    }
  };

  desktopCloudPrimarySourceSequence += 1;
  const dataSource: AgentSessionsDataSource = {
    ...cloudSource,
    scope: `${DESKTOP_CLOUD_PRIMARY_SESSIONS_SCOPE_PREFIX}:${desktopCloudPrimarySourceSequence}`,
    cancelsInFlightReads:
      (cloudSource.cancelsInFlightReads ?? true) &&
      (localSource.cancelsInFlightReads ?? true),
    capabilitiesForSession: (id) => {
      const source = sourceForSessionId(rowSourceById, cloudSource, id);
      const capabilities = capabilitiesForSource(source, id);
      if (source === localSource) {
        return {
          ...capabilities,
          [AgentSessionCapability.UpdatePriority]: false,
        };
      }
      return capabilities;
    },
    list,
    pageData,
    detail: (id, options) =>
      sourceForSessionId(rowSourceById, cloudSource, id).detail(id, options),
    collaborators:
      cloudSource.collaborators || localSource.collaborators
        ? (artifactIds) =>
            readCollaboratorsBySource({
              artifactIds,
              cloudSource,
              rowSourceById,
            })
        : undefined,
    activityPage:
      cloudSource.activityPage || localSource.activityPage
        ? (request) => {
            const source = sourceForSessionId(
              rowSourceById,
              cloudSource,
              request.sessionId
            );
            return requiredSourceCapability(
              source.activityPage?.bind(source),
              "activity"
            )(request);
          }
        : undefined,
    customFieldValues:
      cloudSource.customFieldValues || localSource.customFieldValues
        ? (id) => {
            const source = sourceForSessionId(rowSourceById, cloudSource, id);
            return requiredSourceCapability(
              source.customFieldValues?.bind(source),
              "custom fields"
            )(id);
          }
        : undefined,
    eventsPage:
      cloudSource.eventsPage || localSource.eventsPage
        ? (request: AgentSessionEventsPageRequest) => {
            const source = sourceForSessionId(
              rowSourceById,
              cloudSource,
              request.id
            );
            return requiredSourceCapability(
              source.eventsPage?.bind(source),
              "events"
            )(request);
          }
        : undefined,
    renameSession:
      cloudSource.renameSession || localSource.renameSession
        ? (id, input) => {
            const source = sourceForSessionId(rowSourceById, cloudSource, id);
            return requiredSourceCapability(
              source.renameSession?.bind(source),
              "rename"
            )(id, input);
          }
        : undefined,
    sessionInvocationTree:
      cloudSource.sessionInvocationTree || localSource.sessionInvocationTree
        ? (request) => {
            const source = sourceForSessionId(
              rowSourceById,
              cloudSource,
              request.sessionId
            );
            return requiredSourceCapability(
              source.sessionInvocationTree?.bind(source),
              "invocation tree"
            )(request);
          }
        : undefined,
    updatePriority: cloudSource.updatePriority
      ? (id, input) => {
          const source = sourceForSessionId(rowSourceById, cloudSource, id);
          return requiredSourceCapability(
            source === cloudSource
              ? cloudSource.updatePriority?.bind(cloudSource)
              : undefined,
            "priority update"
          )(id, input);
        }
      : undefined,
  };
  desktopCloudPrimarySources.add(dataSource);
  return dataSource;
}

/** True only for the flag-on Desktop composite, never for legacy HTTP. */
export function isDesktopCloudPrimaryAgentSessionsDataSource(
  source: AgentSessionsDataSource
): boolean {
  return desktopCloudPrimarySources.has(source);
}

function rememberCloudList(
  cache: Map<string, AgentSessionListResponse>,
  identityKey: string,
  filters: AgentSessionQueryFilters,
  response: AgentSessionListResponse
): void {
  validateDesktopSessionsList(response);
  const key = sessionsListCacheKey(identityKey, filters);
  cache.delete(key);
  cache.set(key, response);
  while (cache.size > MAX_CACHED_SESSION_SCOPES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    cache.delete(oldestKey);
  }
}

function readRememberedCloudList(
  cache: Map<string, AgentSessionListResponse>,
  identityKey: string,
  filters: AgentSessionQueryFilters,
  reportFailure: ((error: Error) => void) | undefined
): AgentSessionListResponse | undefined {
  const key = sessionsListCacheKey(identityKey, filters);
  const response = cache.get(key);
  if (!response) {
    return undefined;
  }
  const validated = acceptDesktopSessionsList(response, reportFailure).response;
  cache.delete(key);
  cache.set(key, validated);
  return validated;
}

function acceptDesktopSessionsList(
  response: AgentSessionListResponse,
  reportFailure: ((error: Error) => void) | undefined
) {
  const validation = quarantineInvalidDesktopSessionsRows(response);
  if (!validation.issue) {
    return validation;
  }
  if (response.items.length > 0 && validation.response.items.length === 0) {
    throw validation.issue;
  }
  reportFailure?.(validation.issue);
  return validation;
}

function sessionsListCacheKey(
  identityKey: string,
  filters: AgentSessionUsageQueryFilters
): string {
  const { comparison: _comparison, ...listFilters } = filters;
  return `${identityKey}:${stableStringify(listFilters)}`;
}

function rememberRows(
  remembered: Map<string, AgentSessionsDataSource>,
  response: AgentSessionListResponse,
  source: AgentSessionsDataSource
): void {
  for (const item of response.items) {
    remembered.delete(item.id);
    remembered.set(item.id, source);
  }
  while (remembered.size > MAX_REMEMBERED_ROW_SOURCES) {
    const oldestId = remembered.keys().next().value;
    if (oldestId === undefined) {
      break;
    }
    remembered.delete(oldestId);
  }
}

function boundedPageLimit(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value === undefined) {
    return DEFAULT_TABLE_PAGE_SIZE;
  }
  return Math.max(1, value);
}

function isStableIdentityError(error: unknown): boolean {
  return error instanceof DesktopSessionsStableIdentityError;
}

type SessionsListRequest = {
  generation: number;
  scope: string;
};

function beginSessionsListRequest(
  currentGenerationByScope: Map<string, number>,
  identityKey: string,
  filters: AgentSessionUsageQueryFilters,
  nextGeneration: () => number
): SessionsListRequest {
  const scope = sessionsListCacheKey(identityKey, filters);
  const generation = nextGeneration();
  currentGenerationByScope.delete(scope);
  currentGenerationByScope.set(scope, generation);
  while (currentGenerationByScope.size > MAX_CACHED_SESSION_SCOPES) {
    const oldestScope = currentGenerationByScope.keys().next().value;
    if (oldestScope === undefined) {
      break;
    }
    currentGenerationByScope.delete(oldestScope);
  }
  return { generation, scope };
}

function isCurrentSessionsListRequest(
  currentGenerationByScope: ReadonlyMap<string, number>,
  request: SessionsListRequest
): boolean {
  return currentGenerationByScope.get(request.scope) === request.generation;
}

function rememberRowsForCurrentRequest({
  currentGenerationByScope,
  request,
  response,
  rowSourceById,
  source,
}: {
  currentGenerationByScope: ReadonlyMap<string, number>;
  request: SessionsListRequest;
  response: AgentSessionListResponse;
  rowSourceById: Map<string, AgentSessionsDataSource>;
  source: AgentSessionsDataSource;
}): void {
  if (isCurrentSessionsListRequest(currentGenerationByScope, request)) {
    rememberRows(rowSourceById, response, source);
  }
}

function rememberReconciledRowsForCurrentRequest({
  cloudSource,
  currentGenerationByScope,
  localResponse,
  localSource,
  request,
  response,
  rowSourceById,
}: {
  cloudSource: AgentSessionsDataSource;
  currentGenerationByScope: ReadonlyMap<string, number>;
  localResponse: AgentSessionListResponse;
  localSource: AgentSessionsDataSource;
  request: SessionsListRequest;
  response: AgentSessionListResponse;
  rowSourceById: Map<string, AgentSessionsDataSource>;
}): void {
  if (!isCurrentSessionsListRequest(currentGenerationByScope, request)) {
    return;
  }
  const localRows = new Set(localResponse.items);
  for (const item of response.items) {
    rowSourceById.delete(item.id);
    rowSourceById.set(item.id, localRows.has(item) ? localSource : cloudSource);
  }
  while (rowSourceById.size > MAX_REMEMBERED_ROW_SOURCES) {
    const oldestId = rowSourceById.keys().next().value;
    if (oldestId === undefined) {
      break;
    }
    rowSourceById.delete(oldestId);
  }
}

function sourceForSessionId(
  rowSourceById: ReadonlyMap<string, AgentSessionsDataSource>,
  cloudSource: AgentSessionsDataSource,
  id: string
): AgentSessionsDataSource {
  return rowSourceById.get(id) ?? cloudSource;
}

function capabilitiesForSource(
  source: AgentSessionsDataSource,
  id: string
): AgentSessionCapabilities {
  return {
    [AgentSessionCapability.ActivityPage]: agentSessionSourceSupports(
      source,
      id,
      AgentSessionCapability.ActivityPage
    ),
    [AgentSessionCapability.Collaborators]: agentSessionSourceSupports(
      source,
      id,
      AgentSessionCapability.Collaborators
    ),
    [AgentSessionCapability.CustomFieldValues]: agentSessionSourceSupports(
      source,
      id,
      AgentSessionCapability.CustomFieldValues
    ),
    [AgentSessionCapability.EventsPage]: agentSessionSourceSupports(
      source,
      id,
      AgentSessionCapability.EventsPage
    ),
    [AgentSessionCapability.LinkedArtifacts]: agentSessionSourceSupports(
      source,
      id,
      AgentSessionCapability.LinkedArtifacts
    ),
    [AgentSessionCapability.Rename]: agentSessionSourceSupports(
      source,
      id,
      AgentSessionCapability.Rename
    ),
    [AgentSessionCapability.SessionInvocationTree]: agentSessionSourceSupports(
      source,
      id,
      AgentSessionCapability.SessionInvocationTree
    ),
    [AgentSessionCapability.UpdatePriority]: agentSessionSourceSupports(
      source,
      id,
      AgentSessionCapability.UpdatePriority
    ),
  };
}

async function readCollaboratorsBySource({
  artifactIds,
  cloudSource,
  rowSourceById,
}: {
  artifactIds: readonly string[];
  cloudSource: AgentSessionsDataSource;
  rowSourceById: ReadonlyMap<string, AgentSessionsDataSource>;
}) {
  const idsBySource = new Map<AgentSessionsDataSource, string[]>();
  for (const artifactId of artifactIds) {
    const source = sourceForSessionId(rowSourceById, cloudSource, artifactId);
    const ids = idsBySource.get(source);
    if (ids) {
      ids.push(artifactId);
    } else {
      idsBySource.set(source, [artifactId]);
    }
  }
  const batches = await Promise.all(
    [...idsBySource].map(async ([source, ids]) => {
      const read = source.collaborators?.bind(source);
      if (!read) {
        return unavailableArtifactCollaboratorBatchResponse(
          CollaboratorArtifactType.Session,
          ids
        );
      }
      return (
        (await read(ids)) ??
        unavailableArtifactCollaboratorBatchResponse(
          CollaboratorArtifactType.Session,
          ids
        )
      );
    })
  );
  return { results: batches.flatMap((batch) => batch.results) };
}

function requiredSourceCapability<
  TArguments extends readonly unknown[],
  TResult,
>(
  capability: ((...arguments_: TArguments) => TResult) | undefined,
  label: string
): (...arguments_: TArguments) => TResult {
  if (!capability) {
    throw new Error(`The selected Sessions source cannot serve ${label}.`);
  }
  return capability;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAuthenticationOrAuthorizationError(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.isUnauthorized() || error.isForbidden())
  );
}
