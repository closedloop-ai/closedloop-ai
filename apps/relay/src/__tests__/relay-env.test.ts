import { afterEach, describe, expect, it, vi } from "vitest";

async function loadRelayPort(): Promise<number> {
  vi.resetModules();
  const { RELAY_PORT } = await import("../relay-env.js");
  return RELAY_PORT;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("RELAY_PORT", () => {
  it("prefers RELAY_PORT over MCP_PORT", async () => {
    vi.stubEnv("RELAY_PORT", "4100");
    vi.stubEnv("MCP_PORT", "4200");
    await expect(loadRelayPort()).resolves.toBe(4100);
  });

  it("falls back to MCP_PORT when RELAY_PORT is unset", async () => {
    vi.stubEnv("RELAY_PORT", undefined);
    vi.stubEnv("MCP_PORT", "4200");
    await expect(loadRelayPort()).resolves.toBe(4200);
  });

  it("defaults to 3020 when neither port variable is set", async () => {
    vi.stubEnv("RELAY_PORT", undefined);
    vi.stubEnv("MCP_PORT", undefined);
    await expect(loadRelayPort()).resolves.toBe(3020);
  });
});
