import { AgentSessionCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import type { ListQueryExecution } from "@repo/api/src/types/list-query-observability";
import type { SessionAttributionResolverCache } from "../agent-sync/agent-session-attribution.js";
import type { ReadSessionDeadLetterState } from "../agent-sync/agent-session-dead-letter-sync-state.js";
import type {
  LocalSessionListProjectionRequest,
  LocalSessionListProjectionResponse,
} from "../agent-sync/agent-session-read-model.js";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import type {
  AgentSessionSyncSource,
  SyncedSessionLoadOptions,
} from "../agent-sync/agent-session-sync-source.js";
import {
  buildLocalCloudSyncDisclosure,
  type LoadTranscriptBlobStates,
  loadLocalTranscriptVerdicts,
} from "./local-transcript-cloud-sync.js";
import {
  outboxLookupWithoutPendingRead,
  resolveOutboxDisclosureInput,
} from "./pending-outbox-lookup.js";
import { getSharedAgentSessions } from "./shared-agent-sessions-api.js";

type LoadListRows = (
  ids: string[],
  cache: SessionAttributionResolverCache,
  options?: SyncedSessionLoadOptions
) => Promise<SyncedAgentSession[]>;

/** Runs the canonical list projection wholly inside the DB host. */
export function projectLocalSessionList(
  source: AgentSessionSyncSource,
  input: LocalSessionListProjectionRequest,
  loadListRows: LoadListRows
): Promise<LocalSessionListProjectionResponse> {
  const projectionSource: AgentSessionSyncSource = {
    ...source,
    loadSyncedSessions: loadListRows,
  };
  let pendingOutboxAvailable = false;
  // The DB-host projection is the first boundary that has both the local row
  // and this account's target identity; stamp it here so cloud/local tuple
  // reconciliation can recognize one session without guessing when the target
  // is unavailable.
  let queryExecution: ListQueryExecution | undefined;
  let queryMatchedCount: number | undefined;
  let queryScannedCount: number | undefined;
  return getSharedAgentSessions(projectionSource, input.request, {
    statusOrdering: input.statusOrdering,
    computeTargetId: input.computeTargetId,
    orgDirectory: new Map(input.users.map((user) => [user.id, user])),
    onPendingOutboxAvailability: (available) => {
      pendingOutboxAvailable = available;
    },
    onQueryObservation: (observation) => {
      queryExecution = observation.execution ?? queryExecution;
      queryMatchedCount = observation.matchedCount ?? queryMatchedCount;
      queryScannedCount = observation.scannedCount ?? queryScannedCount;
    },
  }).then((response) => ({
    ...response,
    items: response.items.map((item) => ({
      ...item,
      computeTarget: {
        ...item.computeTarget,
        id: input.computeTargetId ?? item.computeTarget.id,
      },
    })),
    pendingOutboxAvailable,
    ...(queryExecution === undefined ? {} : { queryExecution }),
    ...(queryMatchedCount === undefined ? {} : { queryMatchedCount }),
    ...(queryScannedCount === undefined ? {} : { queryScannedCount }),
  }));
}

/** Adds the page-scoped transcript verdict after the compact list crosses IPC. */
export async function applyLocalSessionTranscriptProjection(
  response: LocalSessionListProjectionResponse,
  computeTargetId: string | null,
  loadTranscriptBlobStates: LoadTranscriptBlobStates | undefined,
  readDeadLetterState?: ReadSessionDeadLetterState
): Promise<LocalSessionListProjectionResponse> {
  const lookup = await loadLocalTranscriptVerdicts(
    computeTargetId,
    loadTranscriptBlobStates,
    response.items.map((item) => item.externalSessionId)
  );
  return {
    ...response,
    items: response.items.map((item) => {
      if (item.cloudSyncState === AgentSessionCloudSyncState.Pending) {
        return item;
      }
      // ISS-11427: the DB host cannot see the session lane, so its dead-letter
      // verdict is folded in here, through the same disclosure.
      return {
        ...withoutTranscriptDisclosure(item),
        ...buildLocalCloudSyncDisclosure(
          resolveOutboxDisclosureInput(
            response.pendingOutboxAvailable
              ? outboxLookupWithoutPendingRead(readDeadLetterState)
              : { available: false },
            item.externalSessionId
          ),
          lookup.available
            ? {
                available: true,
                verdict: lookup.byId.get(item.externalSessionId),
              }
            : { available: false }
        ),
      };
    }),
  };
}

function withoutTranscriptDisclosure(
  item: LocalSessionListProjectionResponse["items"][number]
): LocalSessionListProjectionResponse["items"][number] {
  const result = { ...item };
  Reflect.deleteProperty(result, "cloudSyncState");
  Reflect.deleteProperty(result, "transcriptDisposition");
  Reflect.deleteProperty(result, "transcriptDispositionReason");
  return result;
}
