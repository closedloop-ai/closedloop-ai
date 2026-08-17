import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAuthToken, mockSignerConstructor } = vi.hoisted(() => ({
  mockGetAuthToken: vi.fn(),
  mockSignerConstructor: vi.fn(),
}));

vi.mock("@aws-sdk/rds-signer", () => ({
  Signer: class {
    constructor(config: unknown) {
      mockSignerConstructor(config);
    }
    getAuthToken = mockGetAuthToken;
  },
}));

vi.mock("@vercel/functions/oidc", () => ({
  awsCredentialsProvider: (config: unknown) => config,
}));

import { createSchemaUrlMinter } from "../scripts/iam-database-url";

/**
 * ISS-5983 made this the ONE implementation of "sign a fresh RDS IAM token for
 * this schema", shared by the build migrate, the FEA-3071 preview-migrator walk
 * and the runtime ensure route. The URL it builds is what every one of them
 * connects with, so its shape is the contract under test.
 */

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
});
