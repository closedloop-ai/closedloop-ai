import { afterEach, describe, expect, it, vi } from "vitest";
import { ListenerAuth } from "../signal/listener-config";
import { listenerClientConfig } from "../signal/pg-connection";

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
});

const ENDPOINT = {
  host: "db.cluster-abc.us-east-1.rds.amazonaws.com",
  port: 5432,
  user: "realtime_listener",
  database: "app",
};

describe("listenerClientConfig", () => {
  it("connects to a local Postgres with the configured password and no TLS", () => {
    const config = listenerClientConfig({
      ...ENDPOINT,
      host: "localhost",
      auth: ListenerAuth.Password,
      password: "local-password",
    });

    expect(config).toMatchObject({
      host: "localhost",
      port: 5432,
      user: "realtime_listener",
      database: "app",
      password: "local-password",
      ssl: false,
      keepAlive: true,
    });
  });

  it("verifies a remote server's certificate against the default trust store, where the image adds the RDS CA", () => {
    const config = listenerClientConfig({
      ...ENDPOINT,
      auth: ListenerAuth.Password,
      password: "secret",
    });

    // A `ca` would replace the store NODE_EXTRA_CA_CERTS extends.
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
  });

  it("mints a fresh IAM token for every connect, signed for the listener's endpoint", async () => {
    const config = listenerClientConfig({
      ...ENDPOINT,
      auth: ListenerAuth.Iam,
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
        username: "realtime_listener",
        region: "us-east-1",
      }),
    ]);
    expect(config.ssl).toMatchObject({ rejectUnauthorized: true });
  });
});
