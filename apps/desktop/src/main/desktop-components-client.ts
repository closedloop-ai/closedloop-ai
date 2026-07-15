/**
 * @file desktop-components-client.ts
 * @description Typed client for the component-inventory control-plane route
 * (`POST /desktop/components/sync`), consumed by the component sync lane in
 * {@link AgentSessionSyncService} (Gap B / #2570 follow-up).
 *
 * Mirrors the {@link createDesktopTranscriptsClient} transport: a Bearer token
 * from `DesktopSessionManager` + the configured API origin. Unlike the session
 * sync lane (which rides the socket via `CloudSocketService.sendAgentSessions`),
 * the component inventory endpoint is a plain authenticated HTTP POST, so this
 * lane uses the same first-party HTTP transport the transcript control plane
 * uses.
 *
 * The `sync` method resolves to `true` only on a 2xx response and `false` on any
 * transport/status failure or when the caller is not signed in / has no compute
 * target. It never throws: the sync service treats a `false`/thrown result the
 * same (skip the cursor advance and retry next tick), and swallowing failures to
 * `false` keeps the component lane from crashing the shared 5s sync tick.
 */
import type { DesktopAgentComponentsPayload } from "./agent-session-sync-service.js";
import { gatewayLog } from "./gateway-logger.js";

const COMPONENTS_SYNC_REQUEST_TIMEOUT_MS = 30_000;

const TAG = "components-sync-client";

export type DesktopComponentsClientOptions = {
  fetch?: typeof fetch;
  getAccessToken: () => Promise<string | null>;
  getApiOrigin: () => string | undefined;
  /**
   * The relay-scoped compute target the inventory rows belong to. Returns `null`
   * when none is known yet (offline / pre-auth) → the POST is skipped and `sync`
   * resolves to `false`, matching the sync service's "not-connected → no-op".
   */
  getComputeTargetId: () => string | null;
};

export type DesktopComponentsClient = {
  /**
   * POST a component inventory batch to `/desktop/components/sync`. Resolves to
   * `true` on a 2xx response, `false` on any failure (not signed in, no compute
   * target, transport error, or non-2xx status).
   */
  sync(payload: DesktopAgentComponentsPayload): Promise<boolean>;
};

export function createDesktopComponentsClient(
  options: DesktopComponentsClientOptions
): DesktopComponentsClient {
  const fetchImpl = options.fetch ?? fetch;

  return {
    async sync(payload: DesktopAgentComponentsPayload): Promise<boolean> {
      const computeTargetId = options.getComputeTargetId();
      if (!computeTargetId) {
        return false;
      }

      let token: string | null;
      try {
        token = await options.getAccessToken();
      } catch {
        return false;
      }
      const origin = options.getApiOrigin();
      if (!(token && origin)) {
        return false;
      }

      let url: URL;
      try {
        url = new URL("/desktop/components/sync", origin);
      } catch {
        return false;
      }
      url.searchParams.set("computeTargetId", computeTargetId);

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(COMPONENTS_SYNC_REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        gatewayLog.debug(
          TAG,
          `component sync request failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return false;
      }

      if (!response.ok) {
        gatewayLog.debug(
          TAG,
          `component sync returned HTTP ${response.status}`
        );
        return false;
      }
      return true;
    },
  };
}
