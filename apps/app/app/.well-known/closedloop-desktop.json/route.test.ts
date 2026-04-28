import { afterEach, describe, expect, it, vi } from "vitest";

describe("GET /.well-known/closedloop-desktop.json", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses the local API origin as relay origin when no relay env is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:3002");
    vi.stubEnv("NEXT_PUBLIC_RELAY_ORIGIN", "");
    vi.stubEnv("CL_RELAY_ORIGIN", "");
    vi.stubEnv("RELAY_API_URL", "");
    const { GET } = await import("./route");

    const response = GET(
      new Request("http://localhost:3000/.well-known/closedloop-desktop.json")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      apiOrigin: "http://localhost:3002",
      relayOrigin: "http://localhost:3002",
    });
  });

  it("treats blank relay env values as unset for local development", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:3002");
    vi.stubEnv("NEXT_PUBLIC_RELAY_ORIGIN", "");
    vi.stubEnv("CL_RELAY_ORIGIN", "");
    vi.stubEnv("RELAY_API_URL", "");
    const { GET } = await import("./route");

    const response = GET(
      new Request("http://localhost:3000/.well-known/closedloop-desktop.json")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      apiOrigin: "http://localhost:3002",
      relayOrigin: "http://localhost:3002",
    });
  });

  it("prefers the server-only relay override over the public fallback", async () => {
    vi.stubEnv("NEXT_PUBLIC_RELAY_ORIGIN", "https://public-relay.example.test");
    vi.stubEnv("CL_RELAY_ORIGIN", "https://server-relay.example.test");
    vi.stubEnv("RELAY_API_URL", "http://localhost:3020");
    const { GET } = await import("./route");

    const response = GET(
      new Request(
        "https://app.closedloop.ai/.well-known/closedloop-desktop.json"
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      relayOrigin: "https://server-relay.example.test",
    });
  });

  it("uses local RELAY_API_URL as the relay origin when app runs in local dev", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:3002");
    vi.stubEnv("NEXT_PUBLIC_RELAY_ORIGIN", "");
    vi.stubEnv("CL_RELAY_ORIGIN", "");
    vi.stubEnv("RELAY_API_URL", "http://localhost:3020");
    const { GET } = await import("./route");

    const response = GET(
      new Request("http://localhost:3000/.well-known/closedloop-desktop.json")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      apiOrigin: "http://localhost:3002",
      relayOrigin: "http://localhost:3020",
    });
  });

  it("returns the exact trusted Desktop config contract", async () => {
    const { GET } = await import("./route");

    const response = GET(
      new Request(
        "https://app.closedloop.ai/.well-known/closedloop-desktop.json"
      )
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(await response.json()).sort()).toEqual([
      "apiOrigin",
      "onboardingProtocolVersion",
      "relayOrigin",
    ]);
  });

  it("falls back to the default relay origin when relay env is malformed", async () => {
    vi.stubEnv("NEXT_PUBLIC_RELAY_ORIGIN", "relay.closedloop.ai");
    vi.stubEnv("CL_RELAY_ORIGIN", "");
    const { GET } = await import("./route");

    const response = GET(
      new Request(
        "https://app.closedloop.ai/.well-known/closedloop-desktop.json"
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      relayOrigin: "https://relay.closedloop.ai",
    });
  });
});
