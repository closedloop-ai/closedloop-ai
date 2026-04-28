import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /.well-known/closedloop-desktop.json", () => {
  it("uses the local API origin as relay origin when no relay env is configured", async () => {
    const originalPublicRelayOrigin = process.env.NEXT_PUBLIC_RELAY_ORIGIN;
    const originalRelayOrigin = process.env.CL_RELAY_ORIGIN;
    const originalRelayApiUrl = process.env.RELAY_API_URL;
    Reflect.deleteProperty(process.env, "NEXT_PUBLIC_RELAY_ORIGIN");
    Reflect.deleteProperty(process.env, "CL_RELAY_ORIGIN");
    Reflect.deleteProperty(process.env, "RELAY_API_URL");

    try {
      const response = GET(
        new Request("http://localhost:3000/.well-known/closedloop-desktop.json")
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        apiOrigin: "http://localhost:3002",
        relayOrigin: "http://localhost:3002",
      });
    } finally {
      restoreProcessEnv("NEXT_PUBLIC_RELAY_ORIGIN", originalPublicRelayOrigin);
      restoreProcessEnv("CL_RELAY_ORIGIN", originalRelayOrigin);
      restoreProcessEnv("RELAY_API_URL", originalRelayApiUrl);
    }
  });

  it("treats blank relay env values as unset for local development", async () => {
    const originalPublicRelayOrigin = process.env.NEXT_PUBLIC_RELAY_ORIGIN;
    const originalRelayOrigin = process.env.CL_RELAY_ORIGIN;
    const originalRelayApiUrl = process.env.RELAY_API_URL;
    process.env.NEXT_PUBLIC_RELAY_ORIGIN = "";
    process.env.CL_RELAY_ORIGIN = "";
    Reflect.deleteProperty(process.env, "RELAY_API_URL");

    try {
      const response = GET(
        new Request("http://localhost:3000/.well-known/closedloop-desktop.json")
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        apiOrigin: "http://localhost:3002",
        relayOrigin: "http://localhost:3002",
      });
    } finally {
      restoreProcessEnv("NEXT_PUBLIC_RELAY_ORIGIN", originalPublicRelayOrigin);
      restoreProcessEnv("CL_RELAY_ORIGIN", originalRelayOrigin);
      restoreProcessEnv("RELAY_API_URL", originalRelayApiUrl);
    }
  });

  it("prefers the server-only relay override over the public fallback", async () => {
    const originalPublicRelayOrigin = process.env.NEXT_PUBLIC_RELAY_ORIGIN;
    const originalRelayOrigin = process.env.CL_RELAY_ORIGIN;
    const originalRelayApiUrl = process.env.RELAY_API_URL;
    process.env.NEXT_PUBLIC_RELAY_ORIGIN = "https://public-relay.example.test";
    process.env.CL_RELAY_ORIGIN = "https://server-relay.example.test";
    process.env.RELAY_API_URL = "http://localhost:3020";

    try {
      const response = GET(
        new Request(
          "https://app.closedloop.ai/.well-known/closedloop-desktop.json"
        )
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        relayOrigin: "https://server-relay.example.test",
      });
    } finally {
      restoreProcessEnv("NEXT_PUBLIC_RELAY_ORIGIN", originalPublicRelayOrigin);
      restoreProcessEnv("CL_RELAY_ORIGIN", originalRelayOrigin);
      restoreProcessEnv("RELAY_API_URL", originalRelayApiUrl);
    }
  });

  it("uses local RELAY_API_URL as the relay origin when app runs in local dev", async () => {
    const originalPublicRelayOrigin = process.env.NEXT_PUBLIC_RELAY_ORIGIN;
    const originalRelayOrigin = process.env.CL_RELAY_ORIGIN;
    const originalRelayApiUrl = process.env.RELAY_API_URL;
    Reflect.deleteProperty(process.env, "NEXT_PUBLIC_RELAY_ORIGIN");
    Reflect.deleteProperty(process.env, "CL_RELAY_ORIGIN");
    process.env.RELAY_API_URL = "http://localhost:3020";

    try {
      const response = GET(
        new Request("http://localhost:3000/.well-known/closedloop-desktop.json")
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        apiOrigin: "http://localhost:3002",
        relayOrigin: "http://localhost:3020",
      });
    } finally {
      restoreProcessEnv("NEXT_PUBLIC_RELAY_ORIGIN", originalPublicRelayOrigin);
      restoreProcessEnv("CL_RELAY_ORIGIN", originalRelayOrigin);
      restoreProcessEnv("RELAY_API_URL", originalRelayApiUrl);
    }
  });

  it("returns the exact trusted Desktop config contract", async () => {
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
    const originalPublicRelayOrigin = process.env.NEXT_PUBLIC_RELAY_ORIGIN;
    const originalRelayOrigin = process.env.CL_RELAY_ORIGIN;
    process.env.NEXT_PUBLIC_RELAY_ORIGIN = "relay.closedloop.ai";
    Reflect.deleteProperty(process.env, "CL_RELAY_ORIGIN");

    try {
      const response = GET(
        new Request(
          "https://app.closedloop.ai/.well-known/closedloop-desktop.json"
        )
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        relayOrigin: "https://relay.closedloop.ai",
      });
    } finally {
      restoreProcessEnv("NEXT_PUBLIC_RELAY_ORIGIN", originalPublicRelayOrigin);
      restoreProcessEnv("CL_RELAY_ORIGIN", originalRelayOrigin);
    }
  });
});

function restoreProcessEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}
