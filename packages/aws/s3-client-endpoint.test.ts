import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boundedRequestHandler, STREAMING_BOUNDS } from "./request-handler";

/**
 * ISS-12017: `AWS_S3_ENDPOINT` points the shared client at a local
 * S3-compatible store. Unset, the client is built from exactly the keys it was
 * built from before the variable existed, so production and stage cannot pick
 * up path-style addressing or a custom endpoint by accident.
 */

type S3ClientConfig = Record<string, unknown>;

const { s3ClientConfigs, env } = vi.hoisted(() => ({
  s3ClientConfigs: [] as S3ClientConfig[],
  env: {} as Record<string, string | undefined>,
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class S3ClientMock {
    middlewareStack = { add: vi.fn() };
    constructor(config: S3ClientConfig) {
      s3ClientConfigs.push(config);
    }
  },
  StorageClass: { INTELLIGENT_TIERING: "INTELLIGENT_TIERING" },
}));

vi.mock("server-only", () => ({}));

vi.mock("./credentials", () => ({
  getAwsCredentials: () => "default-credential-chain",
}));

vi.mock("./keys", () => ({
  keys: () => env,
}));

const LOCAL_ENDPOINT = "http://127.0.0.1:9390";

async function buildClientConfigs(
  overrides: Record<string, string | undefined>
): Promise<S3ClientConfig[]> {
  for (const key of Object.keys(env)) {
    Reflect.deleteProperty(env, key);
  }
  Object.assign(env, { AWS_REGION: "us-east-1" }, overrides);
  await import("./s3-client");
  return s3ClientConfigs;
}

describe("s3Client endpoint", () => {
  beforeEach(() => {
    s3ClientConfigs.length = 0;
    vi.resetModules();
  });

  it("is the AWS config, with no endpoint keys, when AWS_S3_ENDPOINT is unset", async () => {
    const configs = await buildClientConfigs({});

    expect(configs).toHaveLength(1);
    expect(configs[0]).toStrictEqual({
      region: "us-east-1",
      credentials: "default-credential-chain",
      requestHandler: boundedRequestHandler(STREAMING_BOUNDS),
    });
  });

  it("targets the configured endpoint with path-style addressing when set", async () => {
    const configs = await buildClientConfigs({
      AWS_S3_ENDPOINT: LOCAL_ENDPOINT,
      AWS_ACCESS_KEY_ID: "AKIAVIBELOCALSTORE01",
      AWS_SECRET_ACCESS_KEY: "local-secret",
    });

    expect(configs).toHaveLength(1);
    expect(configs[0]).toStrictEqual({
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIAVIBELOCALSTORE01",
        secretAccessKey: "local-secret",
      },
      requestHandler: boundedRequestHandler(STREAMING_BOUNDS),
      endpoint: LOCAL_ENDPOINT,
      forcePathStyle: true,
    });
  });
});

describe("AWS_S3_ENDPOINT key", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads an empty value as unset", async () => {
    vi.stubEnv("AWS_S3_ENDPOINT", "");
    const { keys: realKeys } =
      await vi.importActual<typeof import("./keys")>("./keys");

    expect(realKeys().AWS_S3_ENDPOINT).toBeUndefined();
  });

  it("keeps a URL", async () => {
    vi.stubEnv("AWS_S3_ENDPOINT", LOCAL_ENDPOINT);
    const { keys: realKeys } =
      await vi.importActual<typeof import("./keys")>("./keys");

    expect(realKeys().AWS_S3_ENDPOINT).toBe(LOCAL_ENDPOINT);
  });

  it("rejects a value that is not a URL", async () => {
    vi.stubEnv("AWS_S3_ENDPOINT", "minio");
    const { keys: realKeys } =
      await vi.importActual<typeof import("./keys")>("./keys");

    expect(() => realKeys()).toThrow();
  });
});
