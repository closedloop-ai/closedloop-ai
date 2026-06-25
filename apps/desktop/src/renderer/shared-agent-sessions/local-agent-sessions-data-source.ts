import type {
  AgentSessionsChange,
  AgentSessionsDataSource,
} from "@repo/app/agents/data-source/agent-sessions-data-source";
import { ApiError } from "@repo/app/shared/api/api-error";
import {
  SHARED_AGENT_SESSIONS_NOT_FOUND_CODE,
  SHARED_AGENT_SESSIONS_SOURCE_ERROR_CODE,
} from "../../shared/shared-agent-sessions-contract";
import { runSource } from "../shared/run-source";
import type { DesktopApi } from "../types/desktop-api";

/**
 * The slice of the desktop preload API the local data source needs.
 * `onDbChanged` is optional: the live subscription is best-effort, and a preload
 * without it simply yields a source with no `subscribe`.
 */
type DesktopLocalAgentSessionsApi = Pick<DesktopApi, "agentSessionsApi"> &
  Partial<Pick<DesktopApi, "onDbChanged">>;

/**
 * The desktop-local `AgentSessionsDataSource` (FEA-1834 / PLN-941 Phase 3). It
 * routes the shared `@repo/app` read hooks straight to
 * `window.desktopApi.agentSessionsApi` over Electron IPC — no fake HTTP envelope
 * and no network — and exposes the local DB's `desktop:db:changed` push stream
 * as `subscribe` so the live bridge can refresh the Sessions views.
 *
 * Error contract (matches the former fake-HTTP transport so hook/component
 * behavior is unchanged): a missing detail rejects with a 404 `ApiError`
 * (`SHARED_AGENT_SESSIONS_NOT_FOUND_CODE`) rather than resolving `null`, and any
 * underlying source failure rejects with a sanitized 500 `ApiError`
 * (`SHARED_AGENT_SESSIONS_SOURCE_ERROR_CODE`) — the raw error is discarded so no
 * local filesystem/SQL detail leaks to the renderer. Throwing `ApiError` (vs a
 * bare `Error`) preserves the HTTP path's retry semantics: the shared query
 * client skips retries for any `ApiError`, so both the 404 (client error) and
 * the 500 (server error) opt out of retry — whereas a bare `Error` would be
 * retried once as transient network instability.
 */
export function createLocalAgentSessionsDataSource(
  desktopApi: DesktopLocalAgentSessionsApi
): AgentSessionsDataSource {
  const onDbChanged = desktopApi.onDbChanged;
  const sanitize = <T>(run: () => Promise<T>) =>
    runSource(
      run,
      "Agent sessions source failed.",
      SHARED_AGENT_SESSIONS_SOURCE_ERROR_CODE
    );

  return {
    scope: "local",
    list: (filters) =>
      sanitize(() => desktopApi.agentSessionsApi.list(filters)),
    detail: async (id) => {
      const data = await sanitize(() => desktopApi.agentSessionsApi.detail(id));
      if (!data) {
        throw new ApiError(
          "Agent session not found.",
          404,
          SHARED_AGENT_SESSIONS_NOT_FOUND_CODE
        );
      }
      return data;
    },
    usage: (filters) =>
      sanitize(() => desktopApi.agentSessionsApi.usage(filters)),
    analytics: (filters) =>
      sanitize(() => desktopApi.agentSessionsApi.analytics(filters)),
    subscribe: onDbChanged
      ? (onChange: (change: AgentSessionsChange) => void) =>
          onDbChanged((payload) => onChange(payload))
      : undefined,
  };
}
