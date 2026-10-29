import assert from "node:assert/strict";
import { REALTIME_TOKEN_PATH } from "@repo/realtime-contract/protocol";
import { describe, test, vi } from "vitest";
import { fetchDesktopRealtimeToken } from "../src/main/realtime/desktop-realtime-token.js";

const API_ORIGIN = "https://api.example.test";
const HTTP_503 = /HTTP 503/;
const NEEDS_SIGN_IN = /signed-in/;

describe("fetchDesktopRealtimeToken (PLN-2162 decision 12)", () => {
  test("POSTs the token route with the session's bearer and reads the envelope", async () => {
    const fetch = vi.fn((_url: URL, _init?: RequestInit) =>
      Promise.resolve(
        Response.json({
          success: true,
          data: {
            token: "realtime-token",
            expiresAt: 5,
            url: "wss://realtime.example.test",
          },
        })
      )
    );

    const token = await fetchDesktopRealtimeToken(deps(fetch));

    assert.deepEqual(token, {
      token: "realtime-token",
      expiresAt: 5,
      url: "wss://realtime.example.test",
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    assert.equal(url?.toString(), `${API_ORIGIN}${REALTIME_TOKEN_PATH}`);
    assert.equal(init?.method, "POST");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer session-token"
    );
  });

  test("rejects a 503, so the realtime client backs off and the renderer polls", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        Response.json(
          { success: false, code: "realtime_not_configured" },
          { status: 503 }
        )
      )
    );

    await assert.rejects(fetchDesktopRealtimeToken(deps(fetch)), HTTP_503);
  });

  test("rejects a body that is not a token", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(Response.json({ success: true, data: { expiresAt: 5 } }))
    );

    await assert.rejects(fetchDesktopRealtimeToken(deps(fetch)));
  });

  test("sends nothing while signed out", async () => {
    const fetch = vi.fn();

    await assert.rejects(
      fetchDesktopRealtimeToken({
        ...deps(fetch),
        getAccessToken: async () => null,
      }),
      NEEDS_SIGN_IN
    );
    assert.equal(fetch.mock.calls.length, 0);
  });
});

function deps(fetch: (...args: never[]) => Promise<Response>) {
  return {
    getAccessToken: () => Promise.resolve("session-token"),
    getApiOrigin: () => API_ORIGIN,
    onUnauthorized: vi.fn(),
    fetch: fetch as unknown as typeof globalThis.fetch,
  };
}
