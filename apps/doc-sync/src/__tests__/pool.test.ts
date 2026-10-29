import { log } from "@repo/observability/log";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocSyncPgAuth, type DocSyncPgConfig } from "../env";
import {
  createPool,
  createProbePool,
  PG_POOL_ERROR_EVENT,
  poolConfig,
} from "../storage/pool";

const signer = vi.hoisted(() => {
  let minted = 0;
  return {
    options: [] as unknown[],
    getAuthToken: vi.fn(() => {
      minted += 1;
      return Promise.resolve(`iam-token-${minted}`);
    }),
  };
});

vi.mock("@aws-sdk/rds-signer", () => ({
  Signer: vi.fn(function Signer(options: unknown) {
    signer.options.push(options);
    return { getAuthToken: signer.getAuthToken };
  }),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const ENDPOINT = {
  host: "doc-sync.cluster-abc.us-east-1.rds.amazonaws.com",
  port: 5432,
  user: "doc_sync",
  database: "doc_sync",
  poolMax: 7,
};

const PASSWORD_CONFIG: DocSyncPgConfig = {
  ...ENDPOINT,
  auth: DocSyncPgAuth.Password,
  password: "secret",
};

describe("poolConfig", () => {
  it.each(["localhost", "127.0.0.1", "::1", "[::1]"])(
    "connects to local host %s without TLS, with the password as a string",
    (host) => {
      expect(poolConfig({ ...PASSWORD_CONFIG, host })).toMatchObject({
        host,
        port: 5432,
        user: "doc_sync",
        database: "doc_sync",
        password: "secret",
        ssl: false,
        keepAlive: true,
        application_name: "doc-sync",
        max: 7,
      });
    }
  );

  it("verifies a remote server's certificate against the default trust store, where the image adds the RDS CA", () => {
    // A `ca` would replace the store NODE_EXTRA_CA_CERTS extends.
    expect(poolConfig(PASSWORD_CONFIG).ssl).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("mints a fresh IAM token for every connect, signed for the configured endpoint", async () => {
    const config = poolConfig({
      ...ENDPOINT,
      auth: DocSyncPgAuth.Iam,
      region: "us-east-1",
    });
    const password = config.password;
    if (typeof password !== "function") {
      throw new Error("expected a per-connect password function");
    }

    expect(await password()).toBe("iam-token-1");
    expect(await password()).toBe("iam-token-2");
    expect(signer.options).toEqual([
      expect.objectContaining({
        hostname: ENDPOINT.host,
        port: 5432,
        username: "doc_sync",
        region: "us-east-1",
      }),
    ]);
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
  });
});

describe("createProbePool", () => {
  it("holds one connection, with a query timeout, on the stores' endpoint", async () => {
    const pool = createProbePool(PASSWORD_CONFIG);

    expect(pool.options).toMatchObject({
      host: ENDPOINT.host,
      max: 1,
      query_timeout: expect.any(Number),
    });
    expect(pool.listenerCount("error")).toBe(1);
    await pool.end();
  });
});

describe("createPool", () => {
  it("logs an idle client's error by code instead of crashing the process", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const pool = createPool(PASSWORD_CONFIG);

    pool.emit(
      "error",
      Object.assign(new Error("terminated"), { code: "57P01" })
    );

    expect(error).toHaveBeenCalledWith(expect.any(String), {
      event: PG_POOL_ERROR_EVENT,
      code: "57P01",
    });
    await pool.end();
  });
});
