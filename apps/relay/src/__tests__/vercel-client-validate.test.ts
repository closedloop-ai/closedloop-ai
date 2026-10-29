import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const VERIFY_URL = "https://api.test/internal/api-keys/verify";
const VALID_BODY = {
  success: true,
  data: { organizationId: "org-1", userId: "user-1", scopes: ["write"] },
};

let forwardSocketEvent: typeof import("../vercel-client.js").forwardSocketEvent;
const fetchMock = vi.fn();

beforeEach(async () => {
  vi.stubEnv("CLOSEDLOOP_API_URL", "https://api.test");
  vi.stubEnv("INTERNAL_API_SECRET", "secret");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.resetModules();
  ({ forwardSocketEvent } = await import("../vercel-client.js"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("forwardSocketEvent _relay.validate", () => {
  it("disconnects without calling the API when the payload has no string apiKey", async () => {
    await expect(
      forwardSocketEvent("_relay.validate", { apiKey: 42 })
    ).resolves.toEqual({ emit: [], disconnect: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("disconnects without calling the API when the payload is not an object", async () => {
    await expect(
      forwardSocketEvent("_relay.validate", "sk_live_raw")
    ).resolves.toEqual({ emit: [], disconnect: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends no desktop PoP headers when desktopPopHeaders is not an object", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VALID_BODY));

    const result = await forwardSocketEvent("_relay.validate", {
      apiKey: "sk_live_abc",
      desktopPopHeaders: "not-an-object",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(VERIFY_URL);
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "x-internal-secret": "secret",
    });
    expect(result).toEqual({
      emit: [
        {
          event: "_relay.auth",
          payload: { organizationId: "org-1", userId: "user-1" },
        },
      ],
    });
  });

  it("disconnects without calling the API when the payload is null", async () => {
    await expect(forwardSocketEvent("_relay.validate", null)).resolves.toEqual({
      emit: [],
      disconnect: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends no desktop PoP headers when desktopPopHeaders is null", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VALID_BODY));

    await forwardSocketEvent("_relay.validate", {
      apiKey: "sk_live_abc",
      desktopPopHeaders: null,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(Object.keys(init.headers as Record<string, string>)).toEqual([
      "Content-Type",
      "x-internal-secret",
    ]);
  });

  it("redacts the API key from the stack of an Error rejection", async () => {
    const error = new Error("socket hang up");
    error.stack = "Error: posting sk_live_supersecretkey12345\n    at fetch";
    fetchMock.mockRejectedValue(error);

    const caught = await forwardSocketEvent("_relay.validate", {
      apiKey: "sk_live_supersecretkey12345",
    }).catch((e: unknown) => e);

    expect(caught).toBe(error);
    expect(error.stack).not.toContain("sk_live_supersecretkey12345");
    expect(error.stack).toContain("at fetch");
  });

  it("sends no desktop PoP headers when the payload omits them", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VALID_BODY));

    await forwardSocketEvent("_relay.validate", { apiKey: "sk_live_abc" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(Object.keys(init.headers as Record<string, string>)).toEqual([
      "Content-Type",
      "x-internal-secret",
    ]);
  });

  it("rethrows a non-Error transport rejection unchanged", async () => {
    const rejection = { code: "ECONNRESET" };
    fetchMock.mockRejectedValue(rejection);

    await expect(
      forwardSocketEvent("_relay.validate", { apiKey: "sk_live_abc" })
    ).rejects.toBe(rejection);
  });

  it("redacts the message of an Error rejection that carries no stack", async () => {
    const error = new Error("failed posting sk_live_supersecretkey12345");
    Reflect.deleteProperty(error, "stack");
    Object.defineProperty(error, "stack", { value: undefined });
    fetchMock.mockRejectedValue(error);

    const caught = await forwardSocketEvent("_relay.validate", {
      apiKey: "sk_live_supersecretkey12345",
    }).catch((e: unknown) => e);

    expect(caught).toBe(error);
    expect(error.message).not.toContain("sk_live_supersecretkey12345");
    expect(error.stack).toBeUndefined();
  });
});
