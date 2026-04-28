import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /.well-known/closedloop-desktop.json", () => {
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
