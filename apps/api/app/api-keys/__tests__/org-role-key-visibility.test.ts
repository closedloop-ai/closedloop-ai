/**
 * ISS-8661 — an org OWNER reaches the organization's API keys, not just its own.
 *
 * `service.ts` compared `orgRole` against the `"org:admin"` literal at both the
 * list and revoke sites and never against `"org:owner"`, so the owner — the
 * strictly higher role — saw and could revoke strictly less than an admin.
 *
 * The corpus deliberately holds a key minted by ANOTHER member: a single-key
 * fixture makes "sees the organization's keys" true for the own-keys branch too,
 * and so cannot fail. A third key in a DIFFERENT org holds the org-scoping line
 * that the widened visibility must not cross.
 *
 * Roles come from `ClerkOrgRoleFixture`, the suites' hand-written oracle for
 * Clerk's wire values, NOT from `OrgAdminRole`: a fixture derived from the set
 * under test would lose a case instead of failing one when a member is dropped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "org-1";
const OTHER_ORG_ID = "org-2";
const CALLER_ID = "user-caller";
const OTHER_MEMBER_ID = "user-other-member";

const OWN_KEY_ID = "0199a000-0000-7000-8000-000000000201";
const OTHER_MEMBER_KEY_ID = "0199a000-0000-7000-8000-000000000202";
const FOREIGN_ORG_KEY_ID = "0199a000-0000-7000-8000-000000000203";

type StoredKey = {
  id: string;
  organizationId: string;
  userId: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
};

const mocks = vi.hoisted(() => ({
  orgRole: undefined as string | undefined,
  capturedListWhere: undefined as Record<string, unknown> | undefined,
  capturedRevokeWhere: undefined as Record<string, unknown> | undefined,
  dispatchAuditEvent: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvent: mocks.dispatchAuditEvent,
  userAuditActor: (id: string) => ({ kind: "user", id }),
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(
        {
          user: { id: CALLER_ID, organizationId: ORG_ID },
          clerkUserId: "clerk-user-1",
          clerkOrgId: "clerk-org-1",
          orgRole: mocks.orgRole,
        },
        request,
        context?.params
      ),
}));

vi.mock("@repo/database", () => ({
  ApiKeySource: { USER_CREATED: "USER_CREATED", DESKTOP_MANAGED: "DESKTOP" },
  withDb: (callback: (db: unknown) => unknown) => callback(buildFakeDb()),
}));

import {
  ClerkOrgRoleFixture,
  createMockRequest,
} from "@/__tests__/utils/auth-helpers";
import { DELETE as revokeApiKey } from "@/app/api-keys/[id]/route";
import { GET as listApiKeys } from "@/app/api-keys/route";

let corpus: StoredKey[] = [];

function makeKey(overrides: Partial<StoredKey> & { id: string }): StoredKey {
  return {
    organizationId: ORG_ID,
    userId: CALLER_ID,
    name: "A key",
    keyPrefix: "sk_live_",
    scopes: ["read"],
    expiresAt: null,
    lastUsedAt: null,
    createdAt: new Date("2026-01-01"),
    revokedAt: null,
    ...overrides,
  };
}

function matches(key: StoredKey, where: Record<string, unknown>): boolean {
  if (where.id !== undefined && where.id !== key.id) {
    return false;
  }
  if (where.organizationId !== key.organizationId) {
    return false;
  }
  if (where.userId !== undefined && where.userId !== key.userId) {
    return false;
  }
  return !(where.revokedAt === null && key.revokedAt !== null);
}

function buildFakeDb() {
  return {
    apiKey: {
      findMany: (args: { where: Record<string, unknown> }) => {
        mocks.capturedListWhere = args.where;
        return Promise.resolve(
          corpus.filter((key) => matches(key, args.where))
        );
      },
      updateMany: (args: {
        where: Record<string, unknown>;
        data: { revokedAt: Date };
      }) => {
        mocks.capturedRevokeWhere = args.where;
        const hits = corpus.filter((key) => matches(key, args.where));
        for (const hit of hits) {
          hit.revokedAt = args.data.revokedAt;
        }
        return Promise.resolve({ count: hits.length });
      },
    },
  };
}

async function listKeyIds(orgRole: string | undefined): Promise<string[]> {
  mocks.orgRole = orgRole;
  const response = await listApiKeys(
    createMockRequest({ url: "https://api.test/api-keys" }),
    { params: Promise.resolve({}) }
  );
  const payload = await response.json();
  // Thrown rather than asserted: a helper's `expect` is invisible to the rule
  // that keeps assertions inside a case, and a message beats a bare mismatch.
  if (response.status !== 200 || payload.success !== true) {
    throw new Error(
      `GET /api-keys answered ${response.status}: ${JSON.stringify(payload)}`
    );
  }
  return payload.data.map((key: { id: string }) => key.id);
}

async function revokeOtherMemberKey(
  orgRole: string | undefined
): Promise<Response> {
  mocks.orgRole = orgRole;
  return await revokeApiKey(
    createMockRequest({
      url: `https://api.test/api-keys/${OTHER_MEMBER_KEY_ID}`,
      method: "DELETE",
    }),
    { params: Promise.resolve({ id: OTHER_MEMBER_KEY_ID }) }
  );
}

describe("GET /api-keys — organization role visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.capturedListWhere = undefined;
    mocks.capturedRevokeWhere = undefined;
    corpus = [
      makeKey({ id: OWN_KEY_ID }),
      makeKey({ id: OTHER_MEMBER_KEY_ID, userId: OTHER_MEMBER_ID }),
      makeKey({
        id: FOREIGN_ORG_KEY_ID,
        organizationId: OTHER_ORG_ID,
        userId: OTHER_MEMBER_ID,
      }),
    ];
  });

  it("returns another member's key to an org owner", async () => {
    const ids = await listKeyIds(ClerkOrgRoleFixture.Owner);

    expect(ids).toEqual(
      expect.arrayContaining([OWN_KEY_ID, OTHER_MEMBER_KEY_ID])
    );
    expect(mocks.capturedListWhere).not.toHaveProperty("userId");
  });

  it("returns another member's key to an org admin", async () => {
    const ids = await listKeyIds(ClerkOrgRoleFixture.Admin);

    expect(ids).toEqual(
      expect.arrayContaining([OWN_KEY_ID, OTHER_MEMBER_KEY_ID])
    );
    expect(mocks.capturedListWhere).not.toHaveProperty("userId");
  });

  it("returns only the caller's own key to a plain member", async () => {
    const ids = await listKeyIds(ClerkOrgRoleFixture.Member);

    expect(ids).toEqual([OWN_KEY_ID]);
    expect(mocks.capturedListWhere).toMatchObject({ userId: CALLER_ID });
  });

  it("returns only the caller's own key when no role resolved", async () => {
    const ids = await listKeyIds(undefined);

    expect(ids).toEqual([OWN_KEY_ID]);
    expect(mocks.capturedListWhere).toMatchObject({ userId: CALLER_ID });
  });

  it("never returns a key belonging to another organization", async () => {
    for (const role of [
      ClerkOrgRoleFixture.Owner,
      ClerkOrgRoleFixture.Admin,
      ClerkOrgRoleFixture.Member,
    ]) {
      expect(await listKeyIds(role)).not.toContain(FOREIGN_ORG_KEY_ID);
    }
  });
});

describe("DELETE /api-keys/[id] — organization role visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.capturedRevokeWhere = undefined;
    corpus = [
      makeKey({ id: OWN_KEY_ID }),
      makeKey({ id: OTHER_MEMBER_KEY_ID, userId: OTHER_MEMBER_ID }),
    ];
  });

  it("lets an org owner revoke another member's key", async () => {
    const response = await revokeOtherMemberKey(ClerkOrgRoleFixture.Owner);

    expect(response.status).toBe(200);
    expect(
      corpus.find((key) => key.id === OTHER_MEMBER_KEY_ID)?.revokedAt
    ).toBeInstanceOf(Date);
    expect(mocks.capturedRevokeWhere).not.toHaveProperty("userId");
  });

  it("lets an org admin revoke another member's key", async () => {
    const response = await revokeOtherMemberKey(ClerkOrgRoleFixture.Admin);

    expect(response.status).toBe(200);
    expect(
      corpus.find((key) => key.id === OTHER_MEMBER_KEY_ID)?.revokedAt
    ).toBeInstanceOf(Date);
  });

  it("answers 404 and leaves the key intact for a plain member", async () => {
    const response = await revokeOtherMemberKey(ClerkOrgRoleFixture.Member);

    expect(response.status).toBe(404);
    expect(
      corpus.find((key) => key.id === OTHER_MEMBER_KEY_ID)?.revokedAt
    ).toBeNull();
    expect(mocks.capturedRevokeWhere).toMatchObject({ userId: CALLER_ID });
    expect(mocks.dispatchAuditEvent).not.toHaveBeenCalled();
  });
});
