import { generateKeyPairSync } from "node:crypto";
import { ApiKeyScope } from "@repo/api/src/types/api-key";
import type { User } from "@repo/api/src/types/user";
import { ApproverRole } from "@repo/api/src/types/user";
import { ApiKeySource } from "@repo/database";
import { ChannelKind } from "@repo/realtime-contract/channels";
import {
  DocSyncInternalErrorCode,
  FirstOpenSeedState,
} from "@repo/realtime-contract/doc-sync-internal";
import { GrantAccess } from "@repo/realtime-contract/grants";
import { DocSyncFirstOpenSeed } from "@repo/realtime-contract/protocol";
import { verifyRealtimeToken } from "@repo/realtime-contract/token";
import { InternalCallFailure } from "@repo/realtime-server/internal-call";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocSyncClientErrorCode } from "@/app/doc-sync/internal/internal-client";
import type { RealtimeTokenLocalKey } from "@/env";
import {
  DOC_SYNC_TOKEN_ISSUED_EVENT,
  DocSyncTokenErrorCode,
} from "../doc-sync-token-contract";

const mocks = vi.hoisted(() => ({
  env: {
    REALTIME_TOKEN_LOCAL_PRIVATE_KEY: undefined as
      | RealtimeTokenLocalKey
      | undefined,
    REALTIME_TOKEN_KMS_KEY_ID: undefined,
    REALTIME_TOKEN_SIGNER_ROLE_ARN: undefined,
    DOC_SYNC_PUBLIC_URL: undefined as string | undefined,
  },
  auth: vi.fn(),
  findOrCreateUser: vi.fn(),
  findCanonicalSlugAndId: vi.fn(),
  probeFirstOpenSeed: vi.fn(),
  seedIfNeverStored: vi.fn(),
  getLatestVersion: vi.fn(),
  verifyKeyWithMetadata: vi.fn(),
  findUserById: vi.fn(),
  findOrganizationById: vi.fn(),
  isOrganizationActive: vi.fn(),
  desktopUser: undefined as unknown,
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/env", () => ({ env: mocks.env }));
vi.mock("@repo/observability/log", () => ({ log: mocks.log }));
vi.mock("@repo/auth/server", () => ({ auth: mocks.auth }));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/auth/find-or-create-user", () => ({
  findOrCreateUser: mocks.findOrCreateUser,
}));
vi.mock("@/app/documents/document-service", () => ({
  documentService: { findCanonicalSlugAndId: mocks.findCanonicalSlugAndId },
}));
vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: { getLatest: mocks.getLatestVersion },
}));
// The real first-open seed runs; only the doc-sync client under it is stubbed.
vi.mock("@/app/doc-sync/internal/internal-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  docSyncInternalClient: () => ({
    probeFirstOpenSeed: mocks.probeFirstOpenSeed,
    seedIfNeverStored: mocks.seedIfNeverStored,
  }),
}));
// The API-key path runs the real wrapper, so its scope check is what refuses
// a read-only key; only the stores it reads are stubbed.
vi.mock("@/app/api-keys/service", () => ({
  apiKeysService: {
    verifyKeyWithMetadata: mocks.verifyKeyWithMetadata,
    touchLastUsedAt: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock("@/app/users/service", () => ({
  usersService: { findById: mocks.findUserById },
}));
vi.mock("@/app/organizations/service", () => ({
  organizationsService: {
    findById: mocks.findOrganizationById,
    isActive: mocks.isOrganizationActive,
  },
}));
vi.mock("@/lib/auth/desktop-managed-pop", () => ({
  getDesktopManagedPopRequestFailure: () => Promise.resolve(null),
}));
vi.mock("@repo/auth/desktop-session-jwt", () => ({
  isDesktopSessionToken: (token: string) => token === DESKTOP_TOKEN,
}));
// The desktop wrapper has its own suite; here it hands the handler the
// identity its transport would resolve.
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

const ORG = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const OTHER_ORG = "0190a1b2-c3d4-7e5f-8a9b-9c1d2e3f4a5b";
const SLUG = "PLN-1";
const DOCUMENT_ID = "0190a1b2-c3d4-7e5f-8a9b-1c1d2e3f4a5b";
const ROOM = `${ORG}:artifact:${SLUG}`;
const PUBLIC_URL = "wss://doc-sync.example.test";
const DESKTOP_TOKEN = "desktop-session-token";
const API_KEY_TOKEN = "sk_live_doc_sync_test";
const LOCAL_KID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const LOCAL_KEY_PAIR = generateKeyPairSync("rsa", { modulusLength: 2048 });
const LOCAL_PUBLIC_KEYS = new Map([[LOCAL_KID, LOCAL_KEY_PAIR.publicKey]]);

type TokenBody = {
  success: boolean;
  code?: string;
  data: {
    token: string;
    expiresAt: number;
    url?: string;
    firstOpenSeed?: string;
  };
};

describe("POST /doc-sync/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.REALTIME_TOKEN_LOCAL_PRIVATE_KEY = {
      kid: LOCAL_KID,
      privateKey: LOCAL_KEY_PAIR.privateKey,
    };
    mocks.env.DOC_SYNC_PUBLIC_URL = PUBLIC_URL;
    mocks.auth.mockResolvedValue({
      userId: "clerk_user",
      orgId: "clerk_org",
      orgRole: "org:member",
      sessionId: "sess_1",
    });
    mocks.findOrCreateUser.mockResolvedValue(createUser("user-session", ORG));
    mocks.desktopUser = createUser("user-desktop", ORG);
    mocks.findUserById.mockImplementation(
      (id: string, organizationId: string) =>
        Promise.resolve(createUser(id, organizationId))
    );
    mocks.findOrganizationById.mockResolvedValue({ clerkId: "clerk_org" });
    mocks.isOrganizationActive.mockResolvedValue(true);
    mocks.findCanonicalSlugAndId.mockResolvedValue({
      id: DOCUMENT_ID,
      slug: SLUG,
    });
    mocks.probeFirstOpenSeed.mockResolvedValue({
      ok: true,
      value: { state: FirstOpenSeedState.NeedsSeed },
    });
    mocks.getLatestVersion.mockResolvedValue({
      version: 2,
      content: "# Latest",
    });
    mocks.seedIfNeverStored.mockResolvedValue({
      ok: true,
      value: { applied: true, updateBytes: 10 },
    });
  });

  it("mints one write grant on the canonical document address, with the service url", async () => {
    const response = await callRoute({ room: ROOM });

    expect(response.status).toBe(200);
    const body = (await response.json()) as TokenBody;
    const claims = await verifyRealtimeToken(body.data.token, {
      publicKeys: LOCAL_PUBLIC_KEYS,
    });
    expect(claims.org).toBe(ORG);
    expect(claims.sub).toBe("user-session");
    expect(claims.grants).toEqual([
      {
        pattern: `${ChannelKind.Document}:${ORG}:${SLUG}`,
        access: GrantAccess.Write,
      },
    ]);
    expect(body.data.expiresAt).toBe(claims.exp * 1000);
    expect(body.data.url).toBe(PUBLIC_URL);
    expect(body.data).not.toHaveProperty("firstOpenSeed");
    expect(mocks.findCanonicalSlugAndId).toHaveBeenCalledWith(SLUG, ORG);
    expect(mocks.findUserById).toHaveBeenCalledWith("user-session", ORG);
    expect(mocks.isOrganizationActive).toHaveBeenCalledWith(ORG);
  });

  it("answers 403 without a token when the organization is deactivated", async () => {
    mocks.isOrganizationActive.mockResolvedValue(false);

    const response = await callRoute({ room: ROOM });

    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty("data.token");
    expect(issuanceLogCalls()).toEqual([]);
  });

  it("answers 403 when the user is deactivated while the slug lookup is pending", async () => {
    let resolveSlug: (stored: { id: string; slug: string }) => void = () =>
      undefined;
    mocks.findCanonicalSlugAndId.mockReturnValue(
      new Promise<{ id: string; slug: string }>((resolve) => {
        resolveSlug = resolve;
      })
    );

    const pending = callRoute({ room: ROOM });
    await vi.waitFor(() =>
      expect(mocks.findCanonicalSlugAndId).toHaveBeenCalled()
    );
    mocks.findUserById.mockResolvedValue({
      ...createUser("user-session", ORG),
      active: false,
    });
    resolveSlug({ id: DOCUMENT_ID, slug: SLUG });
    const response = await pending;

    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty("data.token");
    expect(issuanceLogCalls()).toEqual([]);
    expect(mocks.probeFirstOpenSeed).not.toHaveBeenCalled();
  });

  it("awaits the first-open seed before it responds", async () => {
    let answerProbe: (result: unknown) => void = () => undefined;
    mocks.probeFirstOpenSeed.mockReturnValue(
      new Promise((resolve) => {
        answerProbe = resolve;
      })
    );
    let responded = false;

    const pending = callRoute({ room: ROOM }).then((response) => {
      responded = true;
      return response;
    });
    await vi.waitFor(() => expect(mocks.probeFirstOpenSeed).toHaveBeenCalled());
    await new Promise((resolve) => setImmediate(resolve));
    expect(responded).toBe(false);
    answerProbe({
      ok: true,
      value: { state: FirstOpenSeedState.NeedsSeed },
    });
    const response = await pending;

    expect(response.status).toBe(200);
    expect(mocks.probeFirstOpenSeed).toHaveBeenCalledWith(ROOM, {
      timeoutMs: expect.any(Number),
    });
    expect(mocks.getLatestVersion).toHaveBeenCalledWith(DOCUMENT_ID);
    expect(mocks.seedIfNeverStored).toHaveBeenCalledWith(
      ROOM,
      { markdown: "# Latest", version: 2 },
      { timeoutMs: expect.any(Number) }
    );
  });

  it("runs the first-open seed on every mint", async () => {
    await callRoute({ room: ROOM });
    await callRoute({ room: ROOM });

    expect(mocks.probeFirstOpenSeed).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "an unreachable service or a timeout",
      { ok: false, failure: InternalCallFailure.Unreachable },
    ],
    [
      "an unconfigured client",
      { ok: false, failure: InternalCallFailure.NotConfigured },
    ],
    [
      "a 404 from a service without the route",
      { ok: false, failure: InternalCallFailure.Rejected, status: 404 },
    ],
    [
      "a 410",
      {
        ok: false,
        failure: InternalCallFailure.Rejected,
        status: 410,
        code: DocSyncInternalErrorCode.DocumentDeleted,
      },
    ],
    [
      "a 500",
      { ok: false, failure: InternalCallFailure.Rejected, status: 500 },
    ],
    [
      "an invalid response",
      {
        ok: false,
        failure: InternalCallFailure.Rejected,
        status: 200,
        code: DocSyncClientErrorCode.InvalidResponse,
      },
    ],
  ])(
    "still issues the token after %s from either call, reporting the seed unconfirmed",
    async (_label, failure) => {
      mocks.probeFirstOpenSeed.mockResolvedValueOnce(failure);
      mocks.seedIfNeverStored.mockResolvedValueOnce(failure);

      const refusedProbe = await callRoute({ room: ROOM });
      const refusedApply = await callRoute({ room: ROOM });

      for (const response of [refusedProbe, refusedApply]) {
        expect(response.status).toBe(200);
        const { data } = (await response.json()) as TokenBody;
        expect(data.token).toBeTypeOf("string");
        expect(data.firstOpenSeed).toBe(DocSyncFirstOpenSeed.Unconfirmed);
      }
      expect(mocks.seedIfNeverStored).toHaveBeenCalledTimes(1);
    }
  );

  it("logs the issuance without the token", async () => {
    const response = await callRoute({ room: ROOM });
    const body = (await response.json()) as TokenBody;

    expect(issuanceLogCalls()).toEqual([
      [
        DOC_SYNC_TOKEN_ISSUED_EVENT,
        expect.objectContaining({ organizationId: ORG, slug: SLUG }),
      ],
    ]);
    expect(
      JSON.stringify([mocks.log.debug.mock.calls, mocks.log.info.mock.calls])
    ).not.toContain(body.data.token);
  });

  it("refuses the legacy document namespace for the same document", async () => {
    const response = await callRoute({ room: `${ORG}:document:${SLUG}` });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: DocSyncTokenErrorCode.InvalidRoom,
    });
    expect(mocks.findCanonicalSlugAndId).not.toHaveBeenCalled();
  });

  it("refuses an alias slug of a stored document", async () => {
    mocks.findCanonicalSlugAndId.mockResolvedValue({
      id: DOCUMENT_ID,
      slug: "FEA-1",
    });

    const response = await callRoute({ room: `${ORG}:artifact:ISS-1` });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: DocSyncTokenErrorCode.InvalidRoom,
    });
  });

  it("refuses a room id that does not parse", async () => {
    const response = await callRoute({ room: "not-a-room" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: DocSyncTokenErrorCode.InvalidRoom,
    });
  });

  it("answers 403 for a room in another org", async () => {
    const response = await callRoute({
      room: `${OTHER_ORG}:artifact:${SLUG}`,
    });

    expect(response.status).toBe(403);
    expect(mocks.findCanonicalSlugAndId).not.toHaveBeenCalled();
  });

  it("answers 404 for a slug with no document in the org", async () => {
    mocks.findCanonicalSlugAndId.mockResolvedValue(null);

    const response = await callRoute({ room: ROOM });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: DocSyncTokenErrorCode.DocumentNotFound,
    });
  });

  it("answers 503 when no token signer is configured", async () => {
    mocks.env.REALTIME_TOKEN_LOCAL_PRIVATE_KEY = undefined;

    const response = await callRoute({ room: ROOM });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: DocSyncTokenErrorCode.NotConfigured,
    });
    expect(mocks.findCanonicalSlugAndId).not.toHaveBeenCalled();
  });

  it("answers 503 when DOC_SYNC_PUBLIC_URL is unset", async () => {
    mocks.env.DOC_SYNC_PUBLIC_URL = undefined;

    const response = await callRoute({ room: ROOM });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: DocSyncTokenErrorCode.NotConfigured,
    });
  });

  it.each([
    ["no room", {}],
    ["an empty room", { room: "" }],
  ])("answers 400 for a body with %s", async (_label, body) => {
    const response = await callRoute(body);

    expect(response.status).toBe(400);
    // Refused by the body schema, before any room is read as one.
    expect(await response.json()).not.toHaveProperty("code");
    expect(mocks.findCanonicalSlugAndId).not.toHaveBeenCalled();
  });

  it("refuses an API key without the write scope", async () => {
    mocks.verifyKeyWithMetadata.mockResolvedValue(apiKey([ApiKeyScope.Read]));

    const response = await callRoute({ room: ROOM }, `Bearer ${API_KEY_TOKEN}`);

    expect(response.status).toBe(403);
    expect(mocks.findCanonicalSlugAndId).not.toHaveBeenCalled();
  });

  it("admits an API key with the write scope", async () => {
    mocks.verifyKeyWithMetadata.mockResolvedValue(apiKey([ApiKeyScope.Write]));

    const response = await callRoute({ room: ROOM }, `Bearer ${API_KEY_TOKEN}`);

    expect(response.status).toBe(200);
  });

  it("admits a desktop session", async () => {
    const response = await callRoute({ room: ROOM }, `Bearer ${DESKTOP_TOKEN}`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as TokenBody;
    const claims = await verifyRealtimeToken(body.data.token, {
      publicKeys: LOCAL_PUBLIC_KEYS,
    });
    expect(claims.sub).toBe("user-desktop");
  });
});

function apiKey(scopes: ApiKeyScope[]) {
  return {
    apiKeyId: "api-key-1",
    userId: "user-api-key",
    organizationId: ORG,
    scopes,
    source: ApiKeySource.USER_CREATED,
    gatewayId: null,
    boundPublicKey: null,
  };
}

function issuanceLogCalls() {
  return mocks.log.debug.mock.calls.filter(
    ([event]) => event === DOC_SYNC_TOKEN_ISSUED_EVENT
  );
}

function callRoute(body: unknown, authorization?: string): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  const request = new NextRequest("http://localhost:3002/doc-sync/token", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
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
