import { BrowserKeyTargetAccess } from "@repo/api/src/types/compute-target";
import { ApiKeySource } from "@repo/database";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const GATEWAY_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_TOKEN = "sk_live_owner";
const TEAMMATE_TOKEN = "sk_live_teammate";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  verifyKeyWithMetadata: vi.fn(),
  touchLastUsedAt: vi.fn(),
  findUserById: vi.fn(),
  findOrganizationById: vi.fn(),
  isFeatureEnabled: vi.fn(),
  waitUntil: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  ApiKeySource: {
    DESKTOP_MANAGED: "DESKTOP_MANAGED",
    USER_CREATED: "USER_CREATED",
  },
  withDb: mocks.withDb,
}));

vi.mock("@repo/analytics/feature-flags", () => ({
  isFeatureFlagEnabledForDistinctId: mocks.isFeatureEnabled,
}));

vi.mock("@repo/observability/error", () => ({
  parseError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: mocks.logDebug,
    error: mocks.logError,
    flush: vi.fn().mockResolvedValue(undefined),
    info: mocks.logInfo,
    warn: mocks.logWarn,
  },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: mocks.waitUntil,
}));

vi.mock("@/app/api-keys/service", () => ({
  apiKeysService: {
    verifyKeyWithMetadata: mocks.verifyKeyWithMetadata,
    touchLastUsedAt: mocks.touchLastUsedAt,
  },
}));

vi.mock("@/app/organizations/service", () => ({
  organizationsService: {
    findById: mocks.findOrganizationById,
  },
}));

vi.mock("@/app/users/service", () => ({
  usersService: {
    findById: mocks.findUserById,
  },
}));

import { GET } from "./route";

describe("GET /public-keys API-key auth boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isFeatureEnabled.mockResolvedValue(false);
    mocks.touchLastUsedAt.mockResolvedValue(undefined);
    mocks.verifyKeyWithMetadata.mockImplementation((token: string) => {
      if (token === OWNER_TOKEN) {
        return Promise.resolve(makeApiKeyContext("owner-user", "owner-key"));
      }
      if (token === TEAMMATE_TOKEN) {
        return Promise.resolve(
          makeApiKeyContext("teammate-user", "teammate-key")
        );
      }
      return Promise.resolve(null);
    });
    mocks.findUserById.mockImplementation((userId: string) =>
      Promise.resolve({
        id: userId,
        organizationId: "org-1",
        clerkId: `clerk-${userId}`,
        active: true,
      })
    );
    mocks.findOrganizationById.mockResolvedValue({
      id: "org-1",
      clerkId: "org_clerk_1",
      name: "Org",
    });
    installDb();
  });

  it("uses the Desktop API key owner as requester for target-scoped listing", async () => {
    const response = await GET(request(OWNER_TOKEN), routeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: [
        {
          id: "key-owner",
          userId: "owner-user",
          organizationId: "org-1",
          publicKeyBase64: "public-key",
          fingerprint: "cl:ownerfingerprint12",
          createdAt: "2026-05-08T22:00:00.000Z",
          ownerName: "Owner User",
          ownerEmail: "owner@example.com",
          targetContext: {
            computeTargetId: TARGET_ID,
            gatewayId: GATEWAY_ID,
            access: BrowserKeyTargetAccess.OwnedTarget,
          },
        },
      ],
    });
  });

  it("returns empty for a same-org Desktop API key owned by a different user", async () => {
    const response = await GET(request(TEAMMATE_TOKEN), routeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: [],
    });
  });
});

function request(token: string) {
  return new NextRequest(
    `http://localhost/public-keys?computeTargetId=${TARGET_ID}&gatewayId=${GATEWAY_ID}`,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
      },
    }
  );
}

function routeContext() {
  return { params: Promise.resolve({}) };
}

function makeApiKeyContext(userId: string, apiKeyId: string) {
  return {
    apiKeyId,
    userId,
    organizationId: "org-1",
    scopes: ["read"],
    source: ApiKeySource.DESKTOP_MANAGED,
    gatewayId: GATEWAY_ID,
    boundPublicKey: null,
  };
}

function installDb() {
  const db = {
    computeTarget: {
      findFirst: vi.fn(({ where }) => {
        if (
          where.id === TARGET_ID &&
          where.organizationId === "org-1" &&
          where.userId === "owner-user"
        ) {
          return Promise.resolve({
            id: TARGET_ID,
            gatewayId: GATEWAY_ID,
            isSharedWithOrg: false,
          });
        }
        return Promise.resolve(null);
      }),
    },
    userPublicKey: {
      findMany: vi.fn(({ where }) => {
        if (where.userId !== "owner-user") {
          return Promise.resolve([]);
        }
        return Promise.resolve([
          {
            id: "key-owner",
            userId: "owner-user",
            organizationId: "org-1",
            publicKeyBase64: "public-key",
            fingerprint: "cl:ownerfingerprint12",
            createdAt: new Date("2026-05-08T22:00:00.000Z"),
            user: {
              email: "owner@example.com",
              firstName: "Owner",
              lastName: "User",
            },
          },
        ]);
      }),
    },
  };
  mocks.withDb.mockImplementation(
    (callback: (database: typeof db) => unknown) => callback(db)
  );
}
