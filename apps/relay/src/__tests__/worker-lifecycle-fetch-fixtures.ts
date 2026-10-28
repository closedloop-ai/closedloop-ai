/**
 * Fetch doubles shared by the two worker-lifecycle suites.
 *
 * `worker-registration-lifecycle.test.ts` and
 * `worker-hello-heartbeat-lifecycle.test.ts` drive the same
 * `POST /internal/relay/socket-event` boundary, but each keeps its own hoisted
 * socket.io mock and its own API URL (see gateway-harness.ts), so the doubles
 * are bound per suite rather than exported as free functions.
 */

import { vi } from "vitest";
import type {
  createGatewayHarness,
  MockRelaySocket,
} from "./gateway-harness.js";

type GatewayHarness = ReturnType<typeof createGatewayHarness>;

export function createWorkerLifecycleFetchFixtures(
  apiUrl: string,
  harness: GatewayHarness
) {
  const socketEventUrl = `${apiUrl}/internal/relay/socket-event`;

  function makeOkResponse(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      url: socketEventUrl,
      headers: { get: () => "application/json" },
      text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response;
  }

  /** A non-2xx reply, as the API returns when a hello stage blows up. */
  function makeErrorResponse(
    status: number,
    body = "upstream failure"
  ): Response {
    return {
      ok: false,
      status,
      url: socketEventUrl,
      headers: { get: () => "text/plain" },
      text: () => Promise.resolve(body),
    } as unknown as Response;
  }

  /**
   * Stubs fetch so hello resolves with the targetId in the request payload
   * and all other events (presence, disconnect) resolve with an empty response.
   */
  function stubSmartFetch(extraResponses: Record<string, unknown> = {}) {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const body = JSON.parse(String((init as RequestInit).body)) as {
          event: string;
          payload?: { targetId?: string };
          targetId?: string;
        };
        const targetId =
          body.payload?.targetId ?? body.targetId ?? "unknown-target";
        const base = { emit: [], targetId, gatewaySessionId: `gw-${targetId}` };
        const override = extraResponses[body.event];
        return Promise.resolve(
          makeOkResponse(
            override === undefined ? base : { ...base, ...override }
          )
        );
      })
    );
  }

  async function registerSocket(
    socket: MockRelaySocket,
    targetId: string
  ): Promise<void> {
    stubSmartFetch();
    await harness.registerSocketTarget(socket, targetId);
  }

  return {
    makeOkResponse,
    makeErrorResponse,
    stubSmartFetch,
    registerSocket,
  };
}
