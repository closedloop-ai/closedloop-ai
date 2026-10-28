import { ARTIFACT_STATUS_ROOT_ORDER_FLAG_KEY } from "@repo/api/src/types/artifact-status-root-order-flag";
import { SessionStatusOrderingName } from "@repo/api/src/types/session-status-root-order";
import type { SharedAgentSessionsListRequest } from "../../shared/shared-agent-sessions-contract.js";
import { isDesktopMainFeatureFlagEnabled } from "../auth/desktop-feature-flag-assignment.js";
import type { DbHostAgentDatabase } from "../database/sqlite.js";
import { applyLocalSessionTranscriptProjection } from "../session/local-session-list-projection.js";
import { getOrgDirectorySnapshot } from "../session/org-directory-cache.js";
import {
  recordSessionListQueryObservation,
  sanitizeDbHostSessionListQueryObservation,
} from "../session/session-list-query-observability.js";
import { getSharedAgentSessions } from "../session/shared-agent-sessions-api.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "./agent-dashboard-runtime-options.js";
import { buildSharedAgentSessionsListOptions } from "./rebuild-sync-compute-target.js";

/** Uses the DB-host projection in production and the canonical fallback for fakes. */
export async function readAgentDashboardSessionList(
  agentDatabase: DbHostAgentDatabase,
  options: AgentDashboardDesignSystemRuntimeOptions,
  request: SharedAgentSessionsListRequest
) {
  const listOptions = buildSharedAgentSessionsListOptions(
    agentDatabase,
    options
  );
  const statusOrdering = isDesktopMainFeatureFlagEnabled(
    ARTIFACT_STATUS_ROOT_ORDER_FLAG_KEY
  )
    ? SessionStatusOrderingName.RootFirst
    : SessionStatusOrderingName.Vocabulary;
  if (!agentDatabase.syncSource.projectSessionList) {
    return getSharedAgentSessions(agentDatabase.syncSource, request, {
      ...listOptions,
      statusOrdering,
      onQueryObservation: recordSessionListQueryObservation,
    });
  }
  const response = await agentDatabase.syncSource.projectSessionList({
    request,
    statusOrdering,
    computeTargetId: listOptions.computeTargetId ?? null,
    users: [...getOrgDirectorySnapshot().values()],
  });
  const projected = await applyLocalSessionTranscriptProjection(
    response,
    listOptions.computeTargetId ?? null,
    listOptions.loadTranscriptBlobStates,
    listOptions.readSessionDeadLetterState
  );
  const {
    pendingOutboxAvailable: _pendingOutboxAvailable,
    queryExecution,
    queryMatchedCount,
    queryScannedCount,
    ...sharedResponse
  } = projected;
  const dbHostObservation = sanitizeDbHostSessionListQueryObservation({
    execution: queryExecution,
    matchedCount: queryMatchedCount,
    scannedCount: queryScannedCount,
  });
  recordSessionListQueryObservation(dbHostObservation);
  return sharedResponse;
}
