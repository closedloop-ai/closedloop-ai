// @vitest-environment node

/**
 * ISS-11210 requirement 10: the realtime keys in apps/api's env schema, driven
 * through the real schema with SKIP_ENV_VALIDATION cleared (under it
 * `createEnv` validates nothing).
 */

import { generateKeyPairSync } from "node:crypto";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";

const PUBLIC_URL_KEY = "REALTIME_PUBLIC_URL";
const INTERNAL_URL_KEY = "REALTIME_INTERNAL_URL";
const OIDC_AUDIENCE_KEY = "REALTIME_INTERNAL_OIDC_AUDIENCE";
const KMS_KEY_ID_KEY = "REALTIME_TOKEN_KMS_KEY_ID";
const SIGNER_ROLE_ARN_KEY = "REALTIME_TOKEN_SIGNER_ROLE_ARN";
const LOCAL_KEY_KEY = "REALTIME_TOKEN_LOCAL_PRIVATE_KEY";
const DOC_SYNC_CALLBACK_ROLE_ARN_KEY = "DOC_SYNC_CALLBACK_ROLE_ARN";
const VERCEL_ENV_KEY = "VERCEL_ENV";
const ECS_METADATA_URI_KEY = "ECS_CONTAINER_METADATA_URI_V4";
const SKIP_KEY = "SKIP_ENV_VALIDATION";
const MANAGED_KEYS = [
  PUBLIC_URL_KEY,
  INTERNAL_URL_KEY,
  OIDC_AUDIENCE_KEY,
  KMS_KEY_ID_KEY,
  SIGNER_ROLE_ARN_KEY,
  LOCAL_KEY_KEY,
  DOC_SYNC_CALLBACK_ROLE_ARN_KEY,
  VERCEL_ENV_KEY,
  ECS_METADATA_URI_KEY,
  SKIP_KEY,
] as const;
const INVALID_ENVIRONMENT_VARIABLES = /Invalid environment variables/;
const LOCAL_KID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const LOCAL_RSA = generateKeyPairSync("rsa", { modulusLength: 2048 });
const LOCAL_JWK = {
  ...LOCAL_RSA.privateKey.export({ format: "jwk" }),
  kid: LOCAL_KID,
};
const KMS_KEY_ID = "0b2c4d6e-1f3a-4b5c-8d7e-9f0a1b2c3d4e";
const KMS_KEY_ARN = `arn:aws:kms:eu-west-1:123456789012:key/${KMS_KEY_ID}`;
const SIGNER_ROLE_ARN =
  "arn:aws:iam::123456789012:role/example-stage-realtime-token-signer";
// The runtimes that refuse the local key. ECS sets no VERCEL_ENV; it injects
// the metadata URI into every container.
const DEPLOYED_RUNTIMES = [
  ["on Vercel production", { [VERCEL_ENV_KEY]: "production" }],
  [
    "on ECS",
    { [ECS_METADATA_URI_KEY]: "http://169.254.170.2/v4/0123456789abcdef" },
  ],
] as const;

let originalValues: ReadonlyMap<string, string | undefined>;
// t3-env prints the per-key issues, then throws a generic error; the printed
// issues are the only place that names the key.
let consoleError: MockInstance;

beforeEach(() => {
  originalValues = new Map(MANAGED_KEYS.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {
    // the expected validation report
  });
});

afterEach(() => {
  for (const [key, value] of originalValues) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  consoleError.mockRestore();
});

describe("apps/api's realtime env keys", () => {
  it("accepts both URLs when well formed", async () => {
    const env = await loadEnv({
      [PUBLIC_URL_KEY]: "wss://realtime.closedloop.ai",
      [INTERNAL_URL_KEY]: "https://realtime.closedloop.ai",
    });
    expect([env.REALTIME_PUBLIC_URL, env.REALTIME_INTERNAL_URL]).toEqual([
      "wss://realtime.closedloop.ai",
      "https://realtime.closedloop.ai",
    ]);
  });

  it("leaves both URLs and the local key undefined when unset", async () => {
    const env = await loadEnv({});
    expect([
      env.REALTIME_PUBLIC_URL,
      env.REALTIME_INTERNAL_URL,
      env.REALTIME_TOKEN_LOCAL_PRIVATE_KEY,
    ]).toEqual([undefined, undefined, undefined]);
  });

  it("refuses a public URL that is not a socket URL", async () => {
    await expect(
      loadEnv({ [PUBLIC_URL_KEY]: "https://realtime.closedloop.ai" })
    ).rejects.toThrow(INVALID_ENVIRONMENT_VARIABLES);
  });

  it("reads a public URL with a path as its origin", async () => {
    const env = await loadEnv({
      [PUBLIC_URL_KEY]: "wss://realtime.closedloop.ai/realtime",
    });
    expect(env.REALTIME_PUBLIC_URL).toBe("wss://realtime.closedloop.ai");
  });

  it("refuses an internal URL that is not an HTTP URL", async () => {
    await expect(
      loadEnv({ [INTERNAL_URL_KEY]: "wss://realtime.closedloop.ai" })
    ).rejects.toThrow(INVALID_ENVIRONMENT_VARIABLES);
  });

  it("reads the KMS key ARN into its region and kid when the signer role is set beside it", async () => {
    const env = await loadEnv({
      [KMS_KEY_ID_KEY]: KMS_KEY_ARN,
      [SIGNER_ROLE_ARN_KEY]: SIGNER_ROLE_ARN,
    });

    expect([
      env.REALTIME_TOKEN_KMS_KEY_ID,
      env.REALTIME_TOKEN_SIGNER_ROLE_ARN,
    ]).toEqual([
      { arn: KMS_KEY_ARN, region: "eu-west-1", kid: KMS_KEY_ID },
      SIGNER_ROLE_ARN,
    ]);
  });

  it("leaves the KMS key and signer role unset when neither is set", async () => {
    const env = await loadEnv({});

    expect([
      env.REALTIME_TOKEN_KMS_KEY_ID,
      env.REALTIME_TOKEN_SIGNER_ROLE_ARN,
    ]).toEqual([undefined, undefined]);
  });

  it.each([
    ["a bare key ID, which names no region", KMS_KEY_ID],
    ["an alias, which names no fixed kid", "alias/realtime-token-signer"],
  ])("refuses %s as the KMS key", async (_label, keyId) => {
    await expect(
      loadEnv({
        [KMS_KEY_ID_KEY]: keyId,
        [SIGNER_ROLE_ARN_KEY]: SIGNER_ROLE_ARN,
      })
    ).rejects.toThrow(INVALID_ENVIRONMENT_VARIABLES);
    expect(reportedIssueKeys()).toEqual([KMS_KEY_ID_KEY]);
  });

  it("refuses a key ARN pasted in place of the signer role", async () => {
    await expect(
      loadEnv({
        [KMS_KEY_ID_KEY]: KMS_KEY_ARN,
        [SIGNER_ROLE_ARN_KEY]: KMS_KEY_ARN,
      })
    ).rejects.toThrow(INVALID_ENVIRONMENT_VARIABLES);
    expect(reportedIssueKeys()).toEqual([SIGNER_ROLE_ARN_KEY]);
  });

  it.each([
    [
      "the KMS key without the signer role",
      KMS_KEY_ID_KEY,
      KMS_KEY_ARN,
      SIGNER_ROLE_ARN_KEY,
    ],
    [
      "the signer role without the KMS key",
      SIGNER_ROLE_ARN_KEY,
      SIGNER_ROLE_ARN,
      KMS_KEY_ID_KEY,
    ],
  ])(
    "refuses %s, naming the missing one",
    async (_label, setKey, value, missingKey) => {
      await expect(loadEnv({ [setKey]: value })).rejects.toThrow(
        INVALID_ENVIRONMENT_VARIABLES
      );
      expect(reportedIssueKeys()).toEqual([missingKey]);
    }
  );

  it("takes a realtime-only OIDC audience and refuses Vercel's default one, which AWS STS trusts", async () => {
    const env = await loadEnv({ [OIDC_AUDIENCE_KEY]: "realtime-internal" });
    expect(env.REALTIME_INTERNAL_OIDC_AUDIENCE).toBe("realtime-internal");

    await expect(
      loadEnv({ [OIDC_AUDIENCE_KEY]: "https://vercel.com/closed-loop" })
    ).rejects.toThrow(INVALID_ENVIRONMENT_VARIABLES);
  });
});

describe("DOC_SYNC_CALLBACK_ROLE_ARN (PLN-2200 T-7.7)", () => {
  it("takes a role ARN with a path", async () => {
    const roleArn = "arn:aws:iam::123456789012:role/service/doc-sync-task";

    const env = await loadEnv({ [DOC_SYNC_CALLBACK_ROLE_ARN_KEY]: roleArn });

    expect(env.DOC_SYNC_CALLBACK_ROLE_ARN).toBe(roleArn);
  });

  it("refuses a role ARN with a trailing slash, which no STS session matches", async () => {
    await expect(
      loadEnv({
        [DOC_SYNC_CALLBACK_ROLE_ARN_KEY]:
          "arn:aws:iam::123456789012:role/doc-sync-task/",
      })
    ).rejects.toThrow(INVALID_ENVIRONMENT_VARIABLES);
    expect(reportedIssueKeys()).toEqual([DOC_SYNC_CALLBACK_ROLE_ARN_KEY]);
  });
});

describe("REALTIME_TOKEN_LOCAL_PRIVATE_KEY (ISS-11966)", () => {
  it.each([
    ["off Vercel and off ECS, as in local dev and e2e compose", undefined],
    ["on Vercel preview", "preview"],
    ["in Vercel development", "development"],
  ])(
    "reads the key into its kid and RSA private key %s",
    async (_label, vercelEnv) => {
      const env = await loadEnv({
        [LOCAL_KEY_KEY]: JSON.stringify(LOCAL_JWK),
        ...(vercelEnv !== undefined && { [VERCEL_ENV_KEY]: vercelEnv }),
      });

      expect(env.REALTIME_TOKEN_LOCAL_PRIVATE_KEY?.kid).toBe(LOCAL_KID);
      expect(env.REALTIME_TOKEN_LOCAL_PRIVATE_KEY?.privateKey.type).toBe(
        "private"
      );
    }
  );

  it.each(DEPLOYED_RUNTIMES)(
    "refuses the key %s, naming it",
    async (_label, runtime) => {
      await expect(
        loadEnv({ [LOCAL_KEY_KEY]: JSON.stringify(LOCAL_JWK), ...runtime })
      ).rejects.toThrow(INVALID_ENVIRONMENT_VARIABLES);
      expect(reportedIssueKeys()).toEqual([LOCAL_KEY_KEY]);
    }
  );

  it.each(DEPLOYED_RUNTIMES)(
    "takes KMS %s with no local key set",
    async (_label, runtime) => {
      const env = await loadEnv({
        [KMS_KEY_ID_KEY]: KMS_KEY_ARN,
        [SIGNER_ROLE_ARN_KEY]: SIGNER_ROLE_ARN,
        ...runtime,
      });

      expect(env.REALTIME_TOKEN_KMS_KEY_ID?.kid).toBe(KMS_KEY_ID);
    }
  );

  it.each([
    [
      "the public half",
      { ...LOCAL_RSA.publicKey.export({ format: "jwk" }), kid: LOCAL_KID },
    ],
    ["a key with no kid", LOCAL_RSA.privateKey.export({ format: "jwk" })],
    ["a kid that is not a bare key ID", { ...LOCAL_JWK, kid: "alias/local" }],
    [
      "an EC key",
      {
        ...generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export(
          {
            format: "jwk",
          }
        ),
        kid: LOCAL_KID,
      },
    ],
  ])("refuses %s", async (_label, jwk) => {
    await expect(
      loadEnv({ [LOCAL_KEY_KEY]: JSON.stringify(jwk) })
    ).rejects.toThrow(INVALID_ENVIRONMENT_VARIABLES);
    expect(reportedIssueKeys()).toEqual([LOCAL_KEY_KEY]);
  });

  it("refuses a value that is not JSON", async () => {
    await expect(
      loadEnv({ [LOCAL_KEY_KEY]: "-----BEGIN PRIVATE KEY-----" })
    ).rejects.toThrow(INVALID_ENVIRONMENT_VARIABLES);
  });
});

async function loadEnv(values: Readonly<Record<string, string>>) {
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
  vi.resetModules();
  const module = await import("@/env");
  return module.env;
}

function reportedIssueKeys(): unknown[] {
  const issues = consoleError.mock.calls
    .flat()
    .find((argument): argument is { path: unknown[] }[] =>
      Array.isArray(argument)
    );
  return (issues ?? []).map((issue) => issue.path[0]);
}
