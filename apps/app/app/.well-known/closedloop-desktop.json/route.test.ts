import { afterEach, describe, expect, it, vi } from "vitest";

describe("GET /.well-known/closedloop-desktop.json", () => {
  afterEach(() => {
    vi.doUnmock("@/env");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses the local API origin as relay origin when no relay env is configured", async () => {
    const { GET } = await importRouteWithEnv({
      NEXT_PUBLIC_API_URL: "http://localhost:3002",
      NEXT_PUBLIC_RELAY_ORIGIN: "",
      CL_RELAY_ORIGIN: "",
      RELAY_API_URL: "",
    });

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
    const { GET } = await importRouteWithEnv({
      NEXT_PUBLIC_API_URL: "http://localhost:3002",
      NEXT_PUBLIC_RELAY_ORIGIN: "",
      CL_RELAY_ORIGIN: "",
      RELAY_API_URL: "",
    });

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
    const { GET } = await importRouteWithEnv({
      NEXT_PUBLIC_RELAY_ORIGIN: "https://public-relay.example.test",
      CL_RELAY_ORIGIN: "https://server-relay.example.test",
      RELAY_API_URL: "http://localhost:3020",
    });

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
    const { GET } = await importRouteWithEnv({
      NEXT_PUBLIC_API_URL: "http://localhost:3002",
      NEXT_PUBLIC_RELAY_ORIGIN: "",
      CL_RELAY_ORIGIN: "",
      RELAY_API_URL: "http://localhost:3020",
    });

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
    const { GET } = await importRouteWithEnv();

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
    const { GET } = await importRouteWithEnv({
      NEXT_PUBLIC_RELAY_ORIGIN: "relay.closedloop.ai",
      CL_RELAY_ORIGIN: "",
    });

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

async function importRouteWithEnv(
  overrides: {
    NEXT_PUBLIC_API_URL?: string;
    NEXT_PUBLIC_RELAY_ORIGIN?: string;
    CL_RELAY_ORIGIN?: string;
    RELAY_API_URL?: string;
  } = {}
) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_API_URL", overrides.NEXT_PUBLIC_API_URL ?? undefined);
  vi.stubEnv(
    "NEXT_PUBLIC_RELAY_ORIGIN",
    overrides.NEXT_PUBLIC_RELAY_ORIGIN ?? undefined
  );
  vi.stubEnv("CL_RELAY_ORIGIN", overrides.CL_RELAY_ORIGIN ?? undefined);
  vi.stubEnv("RELAY_API_URL", overrides.RELAY_API_URL ?? undefined);
  vi.doMock("@/env", () => ({
    env: {
      NEXT_PUBLIC_API_URL: overrides.NEXT_PUBLIC_API_URL,
      NEXT_PUBLIC_RELAY_ORIGIN: overrides.NEXT_PUBLIC_RELAY_ORIGIN,
      CL_RELAY_ORIGIN: overrides.CL_RELAY_ORIGIN,
      RELAY_API_URL: overrides.RELAY_API_URL,
    },
  }));
  return await import("./route");
}
