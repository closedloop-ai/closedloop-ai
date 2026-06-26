import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module re-import helper — instance-discovery caches nothing at module level,
// but we re-import per test group to ensure a clean module scope.
// ---------------------------------------------------------------------------

const LOCAL_ID_PATTERN = /^local-[0-9a-f]{8}$/;

function importModule() {
  return import("../instance-discovery");
}

// ---------------------------------------------------------------------------
// resolveInstanceId
// ---------------------------------------------------------------------------

describe("resolveInstanceId", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv("RELAY_INSTANCE_ID", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
  });

  it("returns RELAY_INSTANCE_ID env var when set", async () => {
    vi.stubEnv("RELAY_INSTANCE_ID", "explicit-instance-42");

    const { resolveInstanceId } = await importModule();
    const id = await resolveInstanceId();

    expect(id).toBe("explicit-instance-42");
  });

  it("reads ECS task metadata when RELAY_INSTANCE_ID is not set", async () => {
    vi.stubEnv("RELAY_INSTANCE_ID", "");
    vi.stubEnv(
      "ECS_CONTAINER_METADATA_URI_V4",
      "http://169.254.170.2/v4/abc123"
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            TaskARN:
              "arn:aws:ecs:us-east-1:123456789012:task/my-cluster/abc123def456",
          }),
      })
    );

    const { resolveInstanceId } = await importModule();
    const id = await resolveInstanceId();

    expect(id).toBe("abc123def456");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://169.254.170.2/v4/abc123/task"
    );
  });

  it("falls back to a random local- prefixed ID when both sources are unavailable", async () => {
    vi.stubEnv("RELAY_INSTANCE_ID", "");
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");

    const { resolveInstanceId } = await importModule();
    const id = await resolveInstanceId();

    expect(id).toMatch(LOCAL_ID_PATTERN);
  });

  it("falls back to random ID when ECS metadata fetch fails", async () => {
    vi.stubEnv("RELAY_INSTANCE_ID", "");
    vi.stubEnv(
      "ECS_CONTAINER_METADATA_URI_V4",
      "http://169.254.170.2/v4/abc123"
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error"))
    );

    const { resolveInstanceId } = await importModule();
    const id = await resolveInstanceId();

    expect(id).toMatch(LOCAL_ID_PATTERN);
  });

  it("falls back to random ID when ECS metadata returns non-ok response", async () => {
    vi.stubEnv("RELAY_INSTANCE_ID", "");
    vi.stubEnv(
      "ECS_CONTAINER_METADATA_URI_V4",
      "http://169.254.170.2/v4/abc123"
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      })
    );

    const { resolveInstanceId } = await importModule();
    const id = await resolveInstanceId();

    expect(id).toMatch(LOCAL_ID_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// resolvePrivateIp
// ---------------------------------------------------------------------------

describe("resolvePrivateIp", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
  });

  it("reads IP from ECS container metadata", async () => {
    vi.stubEnv(
      "ECS_CONTAINER_METADATA_URI_V4",
      "http://169.254.170.2/v4/abc123"
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            Networks: [{ IPv4Addresses: ["10.0.1.42"] }],
          }),
      })
    );

    const { resolvePrivateIp } = await importModule();
    const ip = await resolvePrivateIp();

    expect(ip).toBe("10.0.1.42");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://169.254.170.2/v4/abc123"
    );
  });

  it("returns null when ECS metadata is not available", async () => {
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "");

    const { resolvePrivateIp } = await importModule();
    const ip = await resolvePrivateIp();

    expect(ip).toBeNull();
  });

  it("returns null when ECS metadata fetch fails", async () => {
    vi.stubEnv(
      "ECS_CONTAINER_METADATA_URI_V4",
      "http://169.254.170.2/v4/abc123"
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error"))
    );

    const { resolvePrivateIp } = await importModule();
    const ip = await resolvePrivateIp();

    expect(ip).toBeNull();
  });

  it("returns null when Networks array is empty", async () => {
    vi.stubEnv(
      "ECS_CONTAINER_METADATA_URI_V4",
      "http://169.254.170.2/v4/abc123"
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ Networks: [] }),
      })
    );

    const { resolvePrivateIp } = await importModule();
    const ip = await resolvePrivateIp();

    expect(ip).toBeNull();
  });

  it("returns null when ECS metadata advertises a loopback address", async () => {
    vi.stubEnv(
      "ECS_CONTAINER_METADATA_URI_V4",
      "http://169.254.170.2/v4/abc123"
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            Networks: [{ IPv4Addresses: ["127.0.0.1"] }],
          }),
      })
    );

    const { resolvePrivateIp } = await importModule();
    const ip = await resolvePrivateIp();

    expect(ip).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isRoutablePrivateIpv4
// ---------------------------------------------------------------------------

describe("isRoutablePrivateIpv4", () => {
  it("accepts RFC1918 private ranges", async () => {
    const { isRoutablePrivateIpv4 } = await importModule();
    expect(isRoutablePrivateIpv4("10.0.0.5")).toBe(true);
    expect(isRoutablePrivateIpv4("172.16.0.1")).toBe(true);
    expect(isRoutablePrivateIpv4("172.31.255.254")).toBe(true);
    expect(isRoutablePrivateIpv4("192.168.1.1")).toBe(true);
  });

  it("rejects loopback, link-local, and public addresses", async () => {
    const { isRoutablePrivateIpv4 } = await importModule();
    expect(isRoutablePrivateIpv4("127.0.0.1")).toBe(false);
    expect(isRoutablePrivateIpv4("169.254.1.1")).toBe(false);
    expect(isRoutablePrivateIpv4("172.32.0.1")).toBe(false);
    expect(isRoutablePrivateIpv4("8.8.8.8")).toBe(false);
    expect(isRoutablePrivateIpv4("203.0.113.5")).toBe(false);
  });

  it("rejects malformed and out-of-range addresses", async () => {
    const { isRoutablePrivateIpv4 } = await importModule();
    expect(isRoutablePrivateIpv4("not-an-ip")).toBe(false);
    expect(isRoutablePrivateIpv4("10.0.0")).toBe(false);
    expect(isRoutablePrivateIpv4("10.0.0.256")).toBe(false);
    expect(isRoutablePrivateIpv4("")).toBe(false);
  });
});
