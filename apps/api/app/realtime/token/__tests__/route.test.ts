import {
  constants,
  createHash,
  generateKeyPairSync,
  privateEncrypt,
} from "node:crypto";
import type { User } from "@repo/api/src/types/user";
import { ApproverRole } from "@repo/api/src/types/user";
import {
  boundedRequestHandler,
  CONTROL_PLANE_BOUNDS,
} from "@repo/aws/request-handler";
import { ChannelKind } from "@repo/realtime-contract/channels";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { GrantAccess, matchGrant } from "@repo/realtime-contract/grants";
import {
  parseRealtimeTokenKmsKeyArn,
  type RealtimeTokenKmsKey,
  verifyRealtimeToken,
} from "@repo/realtime-contract/token";
import { decodeProtectedHeader } from "jose";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTokenLocalKey } from "@/env";
import { buildRealtimeGrants } from "../../grant-policy";
import {
  REALTIME_TOKEN_ISSUED_EVENT,
  RealtimeTokenErrorCode,
} from "../realtime-token-contract";
import { KMS_SIGN_DURATION_ATTRIBUTE } from "../token-signing";

const mocks = vi.hoisted(() => ({
  env: {
    REALTIME_TOKEN_LOCAL_PRIVATE_KEY: undefined as
      | RealtimeTokenLocalKey
      | undefined,
    REALTIME_PUBLIC_URL: undefined as string | undefined,
    REALTIME_TOKEN_KMS_KEY_ID: undefined as RealtimeTokenKmsKey | undefined,
    REALTIME_TOKEN_SIGNER_ROLE_ARN: undefined as string | undefined,
  },
  kmsSend: vi.fn(),
  oidcCredentials: vi.fn(() =>
    Promise.resolve({ accessKeyId: "oidc", secretAccessKey: "oidc" })
  ),
  runsOnEcs: vi.fn(() => false),
  setSpanAttributes: vi.fn(),
  auth: vi.fn(),
  findOrCreateUser: vi.fn(),
  apiKeyUser: undefined as unknown,
  desktopUser: undefined as unknown,
  apiKeyOptions: [] as unknown[],
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/env", () => ({ env: mocks.env, runsOnEcs: mocks.runsOnEcs }));
vi.mock("@aws-sdk/client-kms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-kms")>()),
  // Each send carries the config of the client it went through, so the
  // assertions hold whichever test built the signer's cached client.
  KMSClient: class {
    readonly config: KmsClientConfig;
    constructor(config: KmsClientConfig) {
      this.config = config;
    }
    send = (command: unknown) => mocks.kmsSend(command, this.config);
  },
}));
vi.mock("@repo/aws/credentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/aws/credentials")>()),
  vercelOidcRoleCredentials: (roleArn: string, requestHandler: unknown) =>
    Object.assign(() => mocks.oidcCredentials(), { roleArn, requestHandler }),
}));
vi.mock("@repo/observability/tracing/spans", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@repo/observability/tracing/spans")
  >()),
  setAppSpanAttributes: mocks.setSpanAttributes,
}));
vi.mock("@repo/observability/log", () => ({ log: mocks.log }));
vi.mock("@repo/auth/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/auth/find-or-create-user", () => ({
  findOrCreateUser: mocks.findOrCreateUser,
}));
vi.mock("@repo/auth/desktop-session-jwt", () => ({
  isDesktopSessionToken: (token: string) => token === DESKTOP_TOKEN,
}));
// The API-key and desktop wrappers are covered by their own suites; here they
// hand the handler the identity their transport would resolve, so this suite
// pins what the ROUTE does with each transport's identity.
vi.mock("@/lib/auth/with-api-key-auth", () => ({
  withApiKeyAuth:
    (handler: TransportHandler, options: unknown) =>
    (request: NextRequest, context: { params: Promise<unknown> }) => {
      mocks.apiKeyOptions.push(options);
      return handler(
        { user: mocks.apiKeyUser, authMethod: "api_key" },
        request,
        context.params
      );
    },
}));
vi.mock("@/lib/auth/with-desktop-session-auth", () => ({
  withDesktopSessionAuth:
    (handler: TransportHandler) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(
        { user: mocks.desktopUser, authMethod: "desktop_session" },
        request,
        context.params
      ),
}));

const { POST } = await import("../route");

type TransportHandler = (
  context: { user: unknown; authMethod: string },
  request: NextRequest,
  params: Promise<unknown>
) => Promise<Response>;

const DESKTOP_TOKEN = "desktop-session-token";
const API_KEY_TOKEN = "sk_live_realtime_test";
const LOCAL_KID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const LOCAL_KEY_PAIR = generateKeyPairSync("rsa", { modulusLength: 2048 });
const LOCAL_KEY: RealtimeTokenLocalKey = {
  kid: LOCAL_KID,
  privateKey: LOCAL_KEY_PAIR.privateKey,
};
const LOCAL_PUBLIC_KEYS = new Map([[LOCAL_KID, LOCAL_KEY_PAIR.publicKey]]);
const SESSION_ORG = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const DESKTOP_ORG = "0190a1b2-c3d4-7e5f-8a9b-1c1d2e3f4a5b";
const API_KEY_ORG = "0190a1b2-c3d4-7e5f-8a9b-2c1d2e3f4a5b";
const CALLER_ORGS = [SESSION_ORG, DESKTOP_ORG, API_KEY_ORG];
const PUBLIC_URL = "wss://realtime.example.test";
const KMS_KEY_ID = "0b2c4d6e-1f3a-4b5c-8d7e-9f0a1b2c3d4e";
const KMS_KEY_ARN = `arn:aws:kms:eu-west-1:123456789012:key/${KMS_KEY_ID}`;
const SIGNER_ROLE_ARN =
  "arn:aws:iam::123456789012:role/example-stage-realtime-token-signer";
const KMS_KEY_PAIR = generateKeyPairSync("rsa", { modulusLength: 2048 });
// RFC 8017 §9.2: the DER DigestInfo prefix KMS prepends to a SHA-256 DIGEST.
const SHA256_DIGEST_INFO = Buffer.from(
  "3031300d060960864801650304020105000420",
  "hex"
);
/** The key and value of the HS256 secret ISS-11966 retired. */
const RETIRED_TOKEN_SECRETS_KEY = "REALTIME_TOKEN_SECRETS";
const RETIRED_TOKEN_SECRETS = "realtime-test-secret-0123456789abcdef";
type KmsClientConfig = {
  region?: string;
  requestHandler?: unknown;
  credentials?: (() => Promise<unknown>) & {
    roleArn?: string;
    requestHandler?: unknown;
  };
};

describe("POST /realtime/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.REALTIME_TOKEN_LOCAL_PRIVATE_KEY = LOCAL_KEY;
    mocks.env.REALTIME_PUBLIC_URL = undefined;
    mocks.env.REALTIME_TOKEN_KMS_KEY_ID = undefined;
    mocks.env.REALTIME_TOKEN_SIGNER_ROLE_ARN = undefined;
    mocks.kmsSend.mockImplementation(signLikeKms);
    mocks.apiKeyOptions.length = 0;
    mocks.auth.mockResolvedValue({
      userId: "clerk_user",
      orgId: "clerk_org",
      orgRole: "org:member",
      sessionId: "sess_1",
    });
    mocks.findOrCreateUser.mockResolvedValue(
      createUser("user-session", SESSION_ORG)
    );
    mocks.desktopUser = createUser("user-desktop", DESKTOP_ORG);
    mocks.apiKeyUser = createUser("user-api-key", API_KEY_ORG);
  });

  it("answers 401 without credentials and mints nothing", async () => {
    mocks.auth.mockResolvedValue({ userId: null, orgId: null });

    const response = await callRoute();

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ success: false });
    expect(mocks.findOrCreateUser).not.toHaveBeenCalled();
    expect(issuanceLogs()).toEqual([]);
  });

  it.each([
    { transport: "Clerk session", authorization: undefined, org: SESSION_ORG },
    {
      transport: "desktop session bearer",
      authorization: `Bearer ${DESKTOP_TOKEN}`,
      org: DESKTOP_ORG,
    },
    {
      transport: "API key",
      authorization: `Bearer ${API_KEY_TOKEN}`,
      org: API_KEY_ORG,
    },
  ])(
    "grants a $transport caller its own organization only",
    async ({ authorization, org }) => {
      const response = await callRoute(authorization);

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        success: true;
        data: { token: string; expiresAt: number };
      };
      expect(decodeProtectedHeader(body.data.token)).toEqual({
        alg: "RS256",
        kid: LOCAL_KID,
      });
      const claims = await verifyRealtimeToken(body.data.token, {
        publicKeys: LOCAL_PUBLIC_KEYS,
      });
      expect(claims.org).toBe(org);
      expect(body.data.expiresAt).toBe(claims.exp * 1000);
      expect(claims.grants).toEqual([
        {
          pattern: `${ChannelKind.Branches}:${org}:*`,
          access: GrantAccess.Read,
        },
        {
          pattern: `${ChannelKind.Comments}:${org}:*`,
          access: GrantAccess.Read,
        },
        {
          pattern: `${ChannelKind.DocumentVersions}:${org}:*`,
          access: GrantAccess.Read,
        },
      ]);
      for (const otherOrg of CALLER_ORGS.filter((id) => id !== org)) {
        expect(
          claims.grants.some((grant) => grant.pattern.includes(otherOrg))
        ).toBe(false);
        for (const kind of [
          ChannelKind.Comments,
          ChannelKind.DocumentVersions,
        ]) {
          expect(
            matchGrant(
              claims.grants,
              `${kind}:${otherOrg}:doc-1`,
              GrantAccess.Read,
              claims.org
            )
          ).toBe(false);
        }
      }
      expect(
        matchGrant(
          claims.grants,
          `${ChannelKind.DocumentVersions}:${org}:doc-1`,
          GrantAccess.Read,
          claims.org
        )
      ).toBe(true);
      expect(
        matchGrant(
          claims.grants,
          `${ChannelKind.DocumentVersions}:${org}:doc-1:deeper`,
          GrantAccess.Read,
          claims.org
        )
      ).toBe(false);
      expect(
        matchGrant(
          claims.grants,
          `${ChannelKind.Comments}:${org}:thread-1`,
          GrantAccess.Read,
          claims.org
        )
      ).toBe(true);
    }
  );

  it("hands clients REALTIME_PUBLIC_URL as url when it is set", async () => {
    mocks.env.REALTIME_PUBLIC_URL = PUBLIC_URL;

    const response = await callRoute();

    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data.url).toBe(PUBLIC_URL);
  });

  it("omits the url key entirely when REALTIME_PUBLIC_URL is unset", async () => {
    const response = await callRoute();

    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data).not.toHaveProperty("url");
    expect(body.data).toHaveProperty("token");
  });

  it("requires only the read scope from an API key", async () => {
    await callRoute(`Bearer ${API_KEY_TOKEN}`);

    expect(mocks.apiKeyOptions).toEqual([{ requiredScopes: ["read"] }]);
  });

  it("answers 503 with a stable code when no signing key is set", async () => {
    mocks.env.REALTIME_TOKEN_LOCAL_PRIVATE_KEY = undefined;

    const response = await callRoute();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      code: RealtimeTokenErrorCode.NotConfigured,
    });
    expect(issuanceLogs()).toEqual([]);
  });

  it("signs nothing with the retired REALTIME_TOKEN_SECRETS, even when it is the only key left set (ISS-11966)", async () => {
    mocks.env.REALTIME_TOKEN_LOCAL_PRIVATE_KEY = undefined;
    Reflect.set(mocks.env, RETIRED_TOKEN_SECRETS_KEY, RETIRED_TOKEN_SECRETS);

    try {
      const response = await callRoute();

      expect(response.status).toBe(503);
      expect(issuanceLogs()).toEqual([]);
    } finally {
      Reflect.deleteProperty(mocks.env, RETIRED_TOKEN_SECRETS_KEY);
    }
  });

  it("fails loudly instead of minting a grant for an org id the address grammar rejects", async () => {
    mocks.findOrCreateUser.mockResolvedValue(
      createUser("user-session", SESSION_ORG.toUpperCase())
    );

    const response = await callRoute();

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false });
    expect(mocks.log.error).toHaveBeenCalled();
    expect(issuanceLogs()).toEqual([]);
  });

  it("logs the issuance without the token", async () => {
    const response = await callRoute();
    const body = (await response.json()) as { data: { token: string } };

    expect(issuanceLogs()).toEqual([
      [
        REALTIME_TOKEN_ISSUED_EVENT,
        expect.objectContaining({ organizationId: SESSION_ORG }),
      ],
    ]);
    expect(
      JSON.stringify([mocks.log.debug.mock.calls, mocks.log.info.mock.calls])
    ).not.toContain(body.data.token);
  });

  it("never grants a document channel, which only /doc-sync/token issues (PLN-2099 E4)", async () => {
    const response = await callRoute();
    const body = (await response.json()) as { data: { token: string } };

    const claims = await verifyRealtimeToken(body.data.token, {
      publicKeys: LOCAL_PUBLIC_KEYS,
    });
    expect(claims.grants.length).toBeGreaterThan(0);
    expect(
      claims.grants.filter((grant) =>
        grant.pattern.startsWith(`${ChannelKind.Document}:`)
      )
    ).toEqual([]);
  });

  it("only ever grants read, because the route requires only the read scope", () => {
    const grants = buildRealtimeGrants({
      organizationId: SESSION_ORG,
      userId: "user-session",
    });

    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((grant) => grant.access === GrantAccess.Read)).toBe(
      true
    );
  });
});

describe("POST /realtime/token with the KMS signer (ISS-11966)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.REALTIME_TOKEN_LOCAL_PRIVATE_KEY = LOCAL_KEY;
    mocks.env.REALTIME_TOKEN_KMS_KEY_ID =
      parseRealtimeTokenKmsKeyArn(KMS_KEY_ARN);
    mocks.env.REALTIME_TOKEN_SIGNER_ROLE_ARN = SIGNER_ROLE_ARN;
    mocks.kmsSend.mockImplementation(signLikeKms);
    mocks.auth.mockResolvedValue({
      userId: "clerk_user",
      orgId: "clerk_org",
      orgRole: "org:member",
      sessionId: "sess_1",
    });
    mocks.findOrCreateUser.mockResolvedValue(
      createUser("user-session", SESSION_ORG)
    );
  });

  it("signs RS256 through kms:Sign as the signer role, ahead of the local key", async () => {
    const response = await callRoute();

    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: { token: string } };
    expect(decodeProtectedHeader(data.token)).toEqual({
      alg: "RS256",
      kid: KMS_KEY_ID,
    });
    const claims = await verifyRealtimeToken(data.token, {
      publicKeys: new Map([[KMS_KEY_ID, KMS_KEY_PAIR.publicKey]]),
    });
    expect(claims.org).toBe(SESSION_ORG);
    await expect(
      verifyRealtimeToken(data.token, { publicKeys: LOCAL_PUBLIC_KEYS })
    ).rejects.toMatchObject({ code: RealtimeErrorCode.Unauthorized });
    const signingInput = data.token.slice(0, data.token.lastIndexOf("."));
    expect(mocks.kmsSend.mock.calls.map(([command]) => command.input)).toEqual([
      {
        KeyId: KMS_KEY_ARN,
        Message: createHash("sha256").update(signingInput).digest(),
        MessageType: "DIGEST",
        SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
      },
    ]);
    const [[, client]] = mocks.kmsSend.mock.calls as [
      [unknown, KmsClientConfig],
    ];
    const bounded = boundedRequestHandler(CONTROL_PLANE_BOUNDS);
    expect({
      region: client.region,
      kmsHandler: client.requestHandler,
      roleArn: client.credentials?.roleArn,
      stsHandler: client.credentials?.requestHandler,
    }).toEqual({
      region: "eu-west-1",
      kmsHandler: bounded,
      roleArn: SIGNER_ROLE_ARN,
      stsHandler: bounded,
    });
    expect(mocks.setSpanAttributes).toHaveBeenCalledWith({
      [KMS_SIGN_DURATION_ATTRIBUTE]: expect.any(Number),
    });
  });

  it("signs through KMS with no local key configured, as on Vercel production", async () => {
    mocks.env.REALTIME_TOKEN_LOCAL_PRIVATE_KEY = undefined;

    const response = await callRoute();

    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: { token: string } };
    expect(decodeProtectedHeader(data.token).alg).toBe("RS256");
  });

  it("fails the request on a KMS error rather than sign with the local key", async () => {
    mocks.kmsSend.mockRejectedValue(new Error("AccessDeniedException"));

    const response = await callRoute();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: "Unable to issue realtime token",
    });
    expect(mocks.kmsSend).toHaveBeenCalledOnce();
    expect(mocks.log.error).toHaveBeenCalledWith(
      "Unable to issue realtime token",
      { error: expect.objectContaining({ message: "AccessDeniedException" }) }
    );
    expect(issuanceLogs()).toEqual([]);
  });

  describe("credential source by runtime (ISS-12365)", () => {
    it("on Vercel, signs as the signer role through Vercel OIDC", async () => {
      mocks.runsOnEcs.mockReturnValue(false);

      const response = await callRoute();

      expect(response.status).toBe(200);
      expect(sentCredentials()).toEqual({
        viaOidc: true,
        roleArn: SIGNER_ROLE_ARN,
        stsHandler: boundedRequestHandler(CONTROL_PLANE_BOUNDS),
      });
      expect(mocks.oidcCredentials).toHaveBeenCalledOnce();
    });

    it("on ECS, signs as the task role through the SDK default chain, never Vercel OIDC", async () => {
      mocks.runsOnEcs.mockReturnValue(true);

      const response = await callRoute();

      expect(response.status).toBe(200);
      const { data } = (await response.json()) as { data: { token: string } };
      await expect(
        verifyRealtimeToken(data.token, {
          publicKeys: new Map([[KMS_KEY_ID, KMS_KEY_PAIR.publicKey]]),
        })
      ).resolves.toMatchObject({ org: SESSION_ORG });
      const [[command, client]] = mocks.kmsSend.mock.calls as [
        [{ input: { KeyId: string } }, KmsClientConfig],
      ];
      expect(command.input.KeyId).toBe(KMS_KEY_ARN);
      expect({
        credentials: client.credentials,
        region: client.region,
        kmsHandler: client.requestHandler,
      }).toEqual({
        credentials: undefined,
        region: "eu-west-1",
        kmsHandler: boundedRequestHandler(CONTROL_PLANE_BOUNDS),
      });
      expect(mocks.oidcCredentials).not.toHaveBeenCalled();
    });

    it("on neither, takes the Vercel OIDC path and fails the request rather than sign through the default chain", async () => {
      mocks.runsOnEcs.mockReturnValue(false);
      mocks.oidcCredentials.mockRejectedValue(
        new Error("no Vercel OIDC token in this runtime")
      );

      const response = await callRoute();

      expect(response.status).toBe(500);
      expect(sentCredentials()).toMatchObject({
        viaOidc: true,
        roleArn: SIGNER_ROLE_ARN,
      });
      expect(issuanceLogs()).toEqual([]);
    });
  });
});

/**
 * What KMS does for RSASSA_PKCS1_V1_5_SHA_256 over a precomputed DIGEST, after
 * resolving the client's credentials as the SDK does before it sends.
 */
async function signLikeKms(
  command: { input: { Message: Uint8Array } },
  config: KmsClientConfig
) {
  await config.credentials?.();
  return {
    Signature: privateEncrypt(
      { key: KMS_KEY_PAIR.privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.concat([SHA256_DIGEST_INFO, command.input.Message])
    ),
  };
}

function issuanceLogs(): unknown[][] {
  return mocks.log.debug.mock.calls.filter(
    ([event]) => event === REALTIME_TOKEN_ISSUED_EVENT
  );
}

function callRoute(authorization?: string): Promise<Response> {
  const headers = new Headers();
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  const request = new NextRequest("http://localhost:3002/realtime/token", {
    method: "POST",
    headers,
  });
  return POST(request, { params: Promise.resolve({}) });
}

function createUser(id: string, organizationId: string): User {
  return {
    id,
    clerkId: `clerk_${id}`,
    organizationId,
    email: `${id}@example.com`,
    firstName: null,
    lastName: null,
    avatarUrl: null,
    phoneNumber: null,
    role: ApproverRole.Engineer,
    linearId: null,
    slackId: null,
    githubUsername: null,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** The credentials of the client the one KMS send went through. */
function sentCredentials() {
  const [[, client]] = mocks.kmsSend.mock.calls as [[unknown, KmsClientConfig]];
  return {
    viaOidc: typeof client.credentials === "function",
    roleArn: client.credentials?.roleArn,
    stsHandler: client.credentials?.requestHandler,
  };
}
