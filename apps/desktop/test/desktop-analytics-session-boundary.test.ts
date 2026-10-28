import { createServer } from "node:http";
import { OnboardingAnalyticsEvent } from "@repo/api/src/types/onboarding-analytics";
import { describe, expect, it, vi } from "vitest";
import {
  createDesktopAnalyticsHttpLane,
  type DesktopAnalyticsLaneEvent,
} from "../src/main/cloud/desktop-analytics-http-lane.js";
import { deferred } from "./deferred.js";

const event: DesktopAnalyticsLaneEvent = {
  event: OnboardingAnalyticsEvent.ButtonClicked,
  occurredAt: "2026-09-30T00:00:00.000Z",
  properties: { page_name: "settings", button_name: "Sign out" },
};
const flushOptions = { timeoutMs: 1000 };

function fixture(getAccessToken: () => Promise<string | null>) {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () =>
      Response.json({ success: true, data: { captured: true } })
    );
  const lane = createDesktopAnalyticsHttpLane({
    getAccessToken,
    getApiOrigin: () => "https://api.example.test",
    getPluginVersion: () => "test",
    fetch,
  });
  return { lane, fetch };
}

describe("analytics auth boundary before HTTP egress", () => {
  it("closes a real in-flight HTTP request without waiting for its response", async () => {
    const arrived = deferred<void>();
    const closed = deferred<void>();
    const server = createServer((_request, response) => {
      response.on("close", () => closed.resolve());
      arrived.resolve();
      // Keep the response pending: reset, rather than a server ack, must end it.
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing local test server port");
      }
      let settled = false;
      const lane = createDesktopAnalyticsHttpLane({
        getAccessToken: async () => "old-token",
        getApiOrigin: () => `http://127.0.0.1:${address.port}`,
        getPluginVersion: () => "test",
        fetch: (...args) =>
          globalThis.fetch(...args).finally(() => {
            settled = true;
          }),
      });
      lane.send(event, "old-target");
      await arrived.promise;
      expect(settled).toBe(false);
      lane.resetForSession();
      await lane.flush(flushOptions);
      expect(settled).toBe(true);
      await closed.promise;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("cancels an already-dispatched request synchronously at the session boundary", async () => {
    const started = deferred<AbortSignal>();
    const response = deferred<Response>();
    const lane = createDesktopAnalyticsHttpLane({
      getAccessToken: async () => "old-token",
      getApiOrigin: () => "https://api.example.test",
      getPluginVersion: () => "test",
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation((_url, init) => {
          if (!init?.signal) {
            throw new Error("Expected a cancellable analytics request");
          }
          started.resolve(init.signal);
          return response.promise;
        }),
    });
    lane.send(event, "old-target");
    const signal = await started.promise;
    expect(signal.aborted).toBe(false);
    lane.resetForSession();
    const abortedAtBoundary = signal.aborted;
    response.resolve(
      Response.json({ success: true, data: { captured: true } })
    );
    await lane.flush(flushOptions);
    expect(abortedAtBoundary).toBe(true);
  });

  it("drops the captured sign-out click even when the cached token resolves immediately", async () => {
    const { lane, fetch } = fixture(async () => "old-token");
    lane.send(event, "old-target");
    // Auth subscribers run synchronously before the revoke request is sent.
    lane.resetForSession();
    await lane.flush(flushOptions);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops a pending token refresh when sign-out invalidates its session", async () => {
    const token = deferred<string | null>();
    const { lane, fetch } = fixture(() => token.promise);
    lane.send(event, "old-target");
    lane.resetForSession();
    token.resolve("old-token");
    await lane.flush(flushOptions);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows the same deferred send while its session is still current", async () => {
    const token = deferred<string | null>();
    const { lane, fetch } = fixture(() => token.promise);
    lane.send(event, "current-target");
    token.resolve("current-token");
    await lane.flush(flushOptions);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      new URL(
        "https://api.example.test/desktop/analytics?computeTargetId=current-target"
      ),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer current-token",
        }),
        body: JSON.stringify(event),
      })
    );
  });

  it("does not carry the old event into a new account, but allows new account events", async () => {
    const oldToken = deferred<string | null>();
    const getAccessToken = vi
      .fn<() => Promise<string | null>>()
      .mockImplementationOnce(() => oldToken.promise)
      .mockResolvedValue("new-token");
    const { lane, fetch } = fixture(getAccessToken);
    lane.send(event, "old-target");
    lane.resetForSession();
    lane.send(event, "new-target");
    oldToken.resolve("old-token");
    await lane.flush(flushOptions);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
    expect(fetch).toHaveBeenCalledWith(
      new URL(
        "https://api.example.test/desktop/analytics?computeTargetId=new-target"
      ),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer new-token" }),
      })
    );
  });
});
