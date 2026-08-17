import Module from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

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

function mockOidcModule(): void {
  type ModuleLoader = (
    request: string,
    parent: unknown,
    isMain: boolean
  ) => unknown;
  const nodeModule = Module as unknown as { _load: ModuleLoader };
  const originalLoad = nodeModule._load;
  vi.spyOn(nodeModule, "_load").mockImplementation(
    (request, parent, isMain) => {
      if (request === "@vercel/functions/oidc") {
        return { awsCredentialsProvider: credentialsProvider };
      }
      return originalLoad(request, parent, isMain);
    }
  );
}
