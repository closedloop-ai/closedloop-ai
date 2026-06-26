import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getMock, warnMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock("@vercel/edge-config", () => ({ get: getMock }));
vi.mock("@repo/observability/log", () => ({
  log: { warn: warnMock, info: vi.fn(), error: vi.fn() },
}));

const SHA = "abc123def456abc123def456abc123def456abcd";
const EDGE_CONFIG_CONNECTION =
  "https://edge-config.vercel.com/ecfg_test?token=t";
const API_DEPLOYMENT_UID = "dpl_apiDeployment123";

// The module memoizes a successful resolution at module scope, so each case
// re-imports against a fresh module registry to isolate that state.
async function loadResolver() {
  vi.resetModules();
  const mod = await import("./deployment-pin");
  return mod.resolveApiDeploymentPin;
}

describe("resolveApiDeploymentPin (FEA-1485)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    getMock.mockReset();
    warnMock.mockReset();
    process.env.VERCEL_GIT_COMMIT_SHA = SHA;
    process.env.EDGE_CONFIG = EDGE_CONFIG_CONNECTION;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns the api deployment uid stored for the build's commit sha", async () => {
    getMock.mockResolvedValue(API_DEPLOYMENT_UID);
    const resolve = await loadResolver();

    await expect(resolve()).resolves.toBe(API_DEPLOYMENT_UID);
    expect(getMock).toHaveBeenCalledWith(SHA);
  });

  it("returns null when VERCEL_GIT_COMMIT_SHA is unset (no build sha to pin)", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "";
    const resolve = await loadResolver();

    await expect(resolve()).resolves.toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("returns null off app-prod when no EDGE_CONFIG connection is configured", async () => {
    process.env.EDGE_CONFIG = "";
    const resolve = await loadResolver();

    await expect(resolve()).resolves.toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("returns null when the sha has no pin entry yet", async () => {
    getMock.mockResolvedValue(undefined);
    const resolve = await loadResolver();

    await expect(resolve()).resolves.toBeNull();
  });

  it("returns null when the stored value is an empty string", async () => {
    getMock.mockResolvedValue("");
    const resolve = await loadResolver();

    await expect(resolve()).resolves.toBeNull();
  });

  it("returns null when the stored value is not a string", async () => {
    getMock.mockResolvedValue(42);
    const resolve = await loadResolver();

    await expect(resolve()).resolves.toBeNull();
  });

  it("fails open to null when the Edge Config read throws", async () => {
    getMock.mockRejectedValue(new Error("edge config unavailable"));
    const resolve = await loadResolver();

    await expect(resolve()).resolves.toBeNull();
  });

  it("memoizes a successful resolution and does not re-read Edge Config", async () => {
    getMock.mockResolvedValue(API_DEPLOYMENT_UID);
    const resolve = await loadResolver();

    await resolve();
    await resolve();

    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a miss, so a request after the producer writes resolves", async () => {
    getMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(API_DEPLOYMENT_UID);
    const resolve = await loadResolver();

    await expect(resolve()).resolves.toBeNull();
    await expect(resolve()).resolves.toBe(API_DEPLOYMENT_UID);
    expect(getMock).toHaveBeenCalledTimes(2);
  });
});
