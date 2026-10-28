import Module from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedRequestHandler, CONTROL_PLANE_BOUNDS } from "./request-handler";

const { credentialsProvider } = vi.hoisted(() => ({
  credentialsProvider: vi.fn(() => async () => ({
    accessKeyId: "oidc-access-key",
    secretAccessKey: "oidc-secret-key",
  })),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
  credentialsProvider.mockClear();
});

describe("getAwsCredentials", () => {
  it("uses the default AWS credential chain when no role is configured", async () => {
    vi.stubEnv("AWS_ROLE_ARN", "");
    const { getAwsCredentials } = await import("./credentials");

    expect(getAwsCredentials()).toBeUndefined();
    expect(credentialsProvider).not.toHaveBeenCalled();
  });

  it("creates and caches a Vercel OIDC provider for the configured role and region", async () => {
    mockOidcModule();
    vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/app");
    vi.stubEnv("AWS_REGION", "eu-west-1");
    const { getAwsCredentials } = await import("./credentials");

    const first = getAwsCredentials();
    const second = getAwsCredentials();

    expect(first).toBe(second);
    expect(credentialsProvider).toHaveBeenCalledOnce();
    expect(credentialsProvider).toHaveBeenCalledWith({
      roleArn: "arn:aws:iam::123456789012:role/app",
      clientConfig: { region: "eu-west-1" },
    });
  });

  it("defaults the OIDC client region when AWS_REGION is absent", async () => {
    mockOidcModule();
    vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/app");
    vi.stubEnv("AWS_REGION", undefined);
    const { getAwsCredentials } = await import("./credentials");

    getAwsCredentials();

    expect(credentialsProvider).toHaveBeenCalledWith(
      expect.objectContaining({ clientConfig: { region: "us-east-1" } })
    );
  });
});

describe("vercelOidcRoleCredentials", () => {
  it("assumes the role it is given, not AWS_ROLE_ARN (ISS-11966 signer role)", async () => {
    mockOidcModule();
    vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/app");
    vi.stubEnv("AWS_REGION", "us-east-1");
    const { vercelOidcRoleCredentials } = await import("./credentials");

    vercelOidcRoleCredentials(
      "arn:aws:iam::123456789012:role/realtime-token-signer"
    );

    expect(credentialsProvider.mock.calls).toEqual([
      [
        {
          roleArn: "arn:aws:iam::123456789012:role/realtime-token-signer",
          clientConfig: { region: "us-east-1" },
        },
      ],
    ]);
  });

  // Runs the real @vercel/functions provider and the real fromWebToken, and
  // stops at the STS role assumer, whose options become the STS client's
  // config (nested-clients defaultStsRoleAssumers: `new STSClient({
  // ...stsOptions, requestHandler })`).
  it("hands the bounded request handler to the STS client that assumes the role (ISS-11966 review)", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", "header.payload.signature");
    vi.stubEnv("AWS_REGION", "us-east-1");
    const stsOptions: unknown[] = [];
    interceptModule("@aws-sdk/nested-clients/sts", {
      getDefaultRoleAssumerWithWebIdentity: (options: unknown) => {
        stsOptions.push(options);
        return () =>
          Promise.resolve({ accessKeyId: "sts", secretAccessKey: "sts" });
      },
    });
    const { vercelOidcRoleCredentials } = await import("./credentials");
    const bounded = boundedRequestHandler(CONTROL_PLANE_BOUNDS);

    const provider = vercelOidcRoleCredentials(
      "arn:aws:iam::123456789012:role/realtime-token-signer",
      bounded
    );
    if (typeof provider !== "function") {
      throw new Error("expected a credential provider function");
    }
    await provider();

    expect(stsOptions).toEqual([
      expect.objectContaining({ region: "us-east-1", requestHandler: bounded }),
    ]);
  });
});

function mockOidcModule(): void {
  interceptModule("@vercel/functions/oidc", {
    awsCredentialsProvider: credentialsProvider,
  });
}

function interceptModule(name: string, exports: unknown): void {
  type ModuleLoader = (
    request: string,
    parent: unknown,
    isMain: boolean
  ) => unknown;
  const nodeModule = Module as unknown as { _load: ModuleLoader };
  const originalLoad = nodeModule._load;
  vi.spyOn(nodeModule, "_load").mockImplementation((request, parent, isMain) =>
    request === name ? exports : originalLoad(request, parent, isMain)
  );
}
