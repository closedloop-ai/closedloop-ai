import { CURRENT_DESKTOP_API_NAMESPACE } from "@repo/api/src/desktop-api-namespace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureLocalGatewayApiNamespace,
  invalidateLocalGatewayApiNamespace,
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

  it("returns undefined without probing when no session token is available", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const namespace = await ensureLocalGatewayApiNamespace(19_432, null);

    expect(namespace).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-probes once the cached namespace entry has expired past the TTL", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ version: "current" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const first = await ensureLocalGatewayApiNamespace(
        19_432,
        "session-token"
      );
      expect(first).toBe(CURRENT_DESKTOP_API_NAMESPACE);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 60_000);

      const second = await ensureLocalGatewayApiNamespace(
        19_432,
        "session-token"
      );
      expect(second).toBe(CURRENT_DESKTOP_API_NAMESPACE);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dedupes concurrent probes for the same port into a single fetch", async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );

    const firstCall = ensureLocalGatewayApiNamespace(19_432, "session-token");
    const secondCall = ensureLocalGatewayApiNamespace(19_432, "session-token");

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(
      new Response(JSON.stringify({ version: "current" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const [first, second] = await Promise.all([firstCall, secondCall]);
    expect(first).toBe(CURRENT_DESKTOP_API_NAMESPACE);
    expect(second).toBe(CURRENT_DESKTOP_API_NAMESPACE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the raw global fetch when window is undefined (server-side call)", async () => {
    vi.stubGlobal("window", undefined);
    try {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ version: "current" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const namespace = await ensureLocalGatewayApiNamespace(
        19_432,
        "session-token"
      );

      expect(namespace).toBe(CURRENT_DESKTOP_API_NAMESPACE);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe("invalidateLocalGatewayApiNamespace", () => {
    it("clears only the given port, leaving other cached ports intact", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ version: "current" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      await ensureLocalGatewayApiNamespace(19_432, "session-token");
      await ensureLocalGatewayApiNamespace(19_433, "session-token");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      invalidateLocalGatewayApiNamespace(19_432);

      await ensureLocalGatewayApiNamespace(19_432, "session-token");
      await ensureLocalGatewayApiNamespace(19_433, "session-token");

      // Port 19432 was invalidated so it re-probes; port 19433 stays cached.
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("clears every cached port when called with no argument", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ version: "current" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      await ensureLocalGatewayApiNamespace(19_432, "session-token");
      await ensureLocalGatewayApiNamespace(19_433, "session-token");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      invalidateLocalGatewayApiNamespace();

      await ensureLocalGatewayApiNamespace(19_432, "session-token");
      await ensureLocalGatewayApiNamespace(19_433, "session-token");

      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });
});
