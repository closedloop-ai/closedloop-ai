import { CURRENT_DESKTOP_API_NAMESPACE } from "@repo/api/src/desktop-api-namespace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureLocalGatewayApiNamespace,
  resetLocalGatewayApiNamespaceForTests,
} from "@/lib/engineer/local-gateway-api-namespace";

describe("local-gateway-api-namespace", () => {
  beforeEach(() => {
    resetLocalGatewayApiNamespaceForTests();
    vi.restoreAllMocks();
    if (globalThis.window === undefined) {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        writable: true,
        value: globalThis,
      });
    }
  });

  afterEach(() => {
    resetLocalGatewayApiNamespaceForTests();
    vi.restoreAllMocks();
  });

  it("returns undefined without probing legacy engineer namespace when gateway version is missing", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));

    const namespace = await ensureLocalGatewayApiNamespace(
      19_432,
      "session-token"
    );

    expect(namespace).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://localhost:19432/api/gateway/version"
    );
  });

  it("caches the detected namespace per port", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ version: "current" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const first = await ensureLocalGatewayApiNamespace(19_432, "session-token");
    const second = await ensureLocalGatewayApiNamespace(
      19_432,
      "session-token"
    );

    expect(first).toBe(CURRENT_DESKTOP_API_NAMESPACE);
    expect(second).toBe(CURRENT_DESKTOP_API_NAMESPACE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns undefined and does not cache an inconclusive probe result", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("upstream error", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: "current" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    const first = await ensureLocalGatewayApiNamespace(19_432, "session-token");
    const second = await ensureLocalGatewayApiNamespace(
      19_432,
      "session-token"
    );

    expect(first).toBeUndefined();
    expect(second).toBe(CURRENT_DESKTOP_API_NAMESPACE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
