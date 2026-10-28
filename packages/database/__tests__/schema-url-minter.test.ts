import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthToken,
  mockSignerConstructor,
  mockAwsCredentialsProvider,
  mockOidcProvider,
  mockDefaultProvider,
  mockChainProvider,
} = vi.hoisted(() => ({
  mockGetAuthToken: vi.fn(),
  mockSignerConstructor: vi.fn(),
  mockAwsCredentialsProvider: vi.fn(),
  mockOidcProvider: vi.fn(),
  mockDefaultProvider: vi.fn(),
  mockChainProvider: vi.fn(),
}));

vi.mock("@aws-sdk/rds-signer", () => ({
  Signer: class {
    constructor(config: unknown) {
      mockSignerConstructor(config);
    }
    getAuthToken = mockGetAuthToken;
  },
}));

// Both providers return a distinguishable secret so an assertion below cannot
// be satisfied by "the other one happened to resolve too" (ISS-9108).
vi.mock("@vercel/functions/oidc", () => ({
  awsCredentialsProvider: (config: unknown) => {
    mockAwsCredentialsProvider(config);
    return mockOidcProvider;
  },
}));

vi.mock("@aws-sdk/credential-provider-node", () => ({
  defaultProvider: (config: unknown) => {
    mockDefaultProvider(config);
    return mockChainProvider;
  },
}));

import { createSchemaUrlMinter } from "../scripts/iam-database-url";

/**
 * ISS-5983 made this the ONE implementation of "sign a fresh RDS IAM token for
 * this schema", shared by the build migrate, the FEA-3071 preview-migrator walk
 * and the runtime ensure route. The URL it builds is what every one of them
 * connects with, so its shape is the contract under test.
 */

const OIDC_CREDENTIALS = { accessKeyId: "AKIA-OIDC-ONLY" };
const CHAIN_CREDENTIALS = { accessKeyId: "AKIA-CHAIN-ONLY" };

const CONFIG = {
  roleArn: "arn:aws:iam::1:role/vercel",
  region: "us-east-1",
  host: "stage.rds.amazonaws.com",
  port: "5432",
  user: "vercel_iam",
  database: "closedloop",
};

describe("createSchemaUrlMinter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthToken.mockResolvedValue("token/with+reserved=chars");
    mockOidcProvider.mockResolvedValue(OIDC_CREDENTIALS);
    mockChainProvider.mockResolvedValue(CHAIN_CREDENTIALS);
  });

  it("builds a schema-scoped, TLS-required URL with the signed token", async () => {
    const url = await createSchemaUrlMinter(CONFIG)("preview_demo_1234abcd");

    expect(url).toBe(
      `postgresql://vercel_iam:${encodeURIComponent("token/with+reserved=chars")}@stage.rds.amazonaws.com:5432/closedloop?sslmode=require&schema=preview_demo_1234abcd`
    );
  });

  it("omits the schema parameter for the public schema", async () => {
    const url = await createSchemaUrlMinter(CONFIG)(null);

    expect(url).toBe(
      `postgresql://vercel_iam:${encodeURIComponent("token/with+reserved=chars")}@stage.rds.amazonaws.com:5432/closedloop?sslmode=require`
    );
  });

  it("signs a FRESH token per call while reusing one signer", async () => {
    mockGetAuthToken
      .mockResolvedValueOnce("first-token")
      .mockResolvedValueOnce("second-token");
    const mint = createSchemaUrlMinter(CONFIG);

    const first = await mint("preview_demo_1234abcd");
    const second = await mint("preview_demo_1234abcd");

    // ISS-5285's re-mint exists because the token expires after 15 minutes; a
    // cached URL would defeat it entirely.
    expect(first).toContain("first-token");
    expect(second).toContain("second-token");
    expect(mockSignerConstructor).toHaveBeenCalledOnce();
  });

  it("signs against the configured host, port and role", () => {
    createSchemaUrlMinter({ ...CONFIG, port: "6543" });

    expect(mockSignerConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: CONFIG.host,
        port: 6543,
        username: CONFIG.user,
        region: CONFIG.region,
      })
    );
  });

  // ISS-9108. The cases above stub `getAuthToken`, so the real `Signer` never
  // invokes the credentials callback and none of them can tell
  // `createRdsCredentialsProvider` from the `awsCredentialsProvider` it
  // replaced. These two execute the callback, which is the only thing that
  // holds this caller to the fallback.
  it("prefers Vercel OIDC for the credentials it signs with", async () => {
    createSchemaUrlMinter(CONFIG);

    await expect(capturedCredentialsProvider()()).resolves.toEqual(
      OIDC_CREDENTIALS
    );
    expect(mockAwsCredentialsProvider).toHaveBeenCalledWith({
      roleArn: CONFIG.roleArn,
      clientConfig: { region: CONFIG.region },
    });
    expect(mockDefaultProvider).not.toHaveBeenCalled();
  });

  it("falls back to the AWS credential chain when OIDC is unavailable", async () => {
    // A role ARN is set, but assuming it throws: the off-Vercel shape when the
    // variable is present. Without an ARN (an ECS task role, ISS-9122) the
    // minter runs too, and OIDC is never attempted at all.
    mockOidcProvider.mockRejectedValue(
      new Error("no OIDC token in this runtime")
    );

    createSchemaUrlMinter(CONFIG);

    await expect(capturedCredentialsProvider()()).resolves.toEqual(
      CHAIN_CREDENTIALS
    );
    expect(mockDefaultProvider).toHaveBeenCalledWith({
      clientConfig: { region: CONFIG.region },
    });
  });

  it("does not sign with credentials that would expire before the 15-minute token", async () => {
    // The minted URL is handed to later steps, and a token stops authenticating
    // when the credentials that signed it expire.
    const expiringFirst = {
      ...OIDC_CREDENTIALS,
      expiration: new Date(Date.now() + 14 * 60 * 1000),
    };
    const fresh = {
      accessKeyId: "AKIA-OIDC-FRESH",
      expiration: new Date(Date.now() + 60 * 60 * 1000),
    };
    mockOidcProvider
      .mockResolvedValueOnce(expiringFirst)
      .mockResolvedValueOnce(fresh);
    createSchemaUrlMinter(CONFIG);
    const credentials = capturedCredentialsProvider();

    await expect(credentials()).resolves.toBe(expiringFirst);
    await expect(credentials()).resolves.toBe(fresh);
  });
});

function capturedCredentialsProvider(): () => Promise<unknown> {
  const config: { credentials: () => Promise<unknown> } =
    mockSignerConstructor.mock.calls[0][0];
  return config.credentials;
}
