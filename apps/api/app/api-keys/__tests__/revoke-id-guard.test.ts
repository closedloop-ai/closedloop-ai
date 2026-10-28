/**
 * `apiKeysService.revoke` — behaviour lock plus the ISS-8880 malformed-id guard.
 *
 * `revoke`'s own docstring promises "Returns false if the key was not found or
 * already revoked", but `ApiKey.id` is `@db.Uuid`: a malformed path segment
 * reaches the `updateMany` comparand and Postgres raises, so the route's
 * `notFoundResponse("API key")` one line away was unreachable for exactly the
 * input the docstring describes.
 *
 * The org-scoping and boolean-return cases below pin what a VALID id already
 * does today and must keep doing byte-identically. The malformed-id cases are
 * the guard ISS-8880 adds.
 */
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", () => ({
  ApiKeySource: {
    USER_CREATED: "USER_CREATED",
    DESKTOP_MANAGED: "DESKTOP_MANAGED",
  },
  withDb: mocks.withDb,
}));

vi.mock("@repo/observability/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ClerkOrgRoleFixture } from "@/__tests__/utils/auth-helpers";
import { apiKeysService } from "../service";

const ORG_ID = "org-abc";
const USER_ID = "user-xyz";
const VALID_KEY_ID = "0199a000-0000-7000-8000-00000000000a";

type DbCall = { apiKey: { updateMany: Mock } };

function wireDb(count: number): DbCall {
  const db: DbCall = {
    apiKey: { updateMany: vi.fn().mockResolvedValue({ count }) },
  };
  mocks.withDb.mockImplementation((fn: (client: DbCall) => unknown) => fn(db));
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("apiKeysService.revoke — valid id (behaviour lock)", () => {
  it("returns true when a row was revoked", async () => {
    wireDb(1);

    await expect(
      apiKeysService.revoke(VALID_KEY_ID, ORG_ID, USER_ID)
    ).resolves.toBe(true);
  });

  it("returns false when no row matched — already revoked or another org", async () => {
    wireDb(0);

    await expect(
      apiKeysService.revoke(VALID_KEY_ID, ORG_ID, USER_ID)
    ).resolves.toBe(false);
  });

  it("scopes a non-privileged caller to their own key", async () => {
    const db = wireDb(1);

    await apiKeysService.revoke(VALID_KEY_ID, ORG_ID, USER_ID);

    expect(db.apiKey.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: VALID_KEY_ID,
          organizationId: ORG_ID,
          userId: USER_ID,
          revokedAt: null,
        },
      })
    );
  });

  it("drops the userId predicate for an org-wide-visibility role", async () => {
    const db = wireDb(1);

    await apiKeysService.revoke(
      VALID_KEY_ID,
      ORG_ID,
      USER_ID,
      ClerkOrgRoleFixture.Admin
    );

    expect(db.apiKey.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: VALID_KEY_ID, organizationId: ORG_ID, revokedAt: null },
      })
    );
  });

  it("stamps revokedAt rather than deleting the row", async () => {
    const db = wireDb(1);

    await apiKeysService.revoke(VALID_KEY_ID, ORG_ID, USER_ID);

    expect(db.apiKey.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { revokedAt: expect.any(Date) } })
    );
  });
});

describe("apiKeysService.revoke — malformed id (ISS-8880 guard)", () => {
  const MALFORMED = [
    "not-a-uuid",
    "",
    "  ",
    "0199a000-0000-7000-8000",
    "'; --",
  ];

  it.each(MALFORMED)(
    "returns false for %j without issuing a query",
    async (id) => {
      const db = wireDb(1);

      // `1` above is deliberate: if the guard were absent the mock would report
      // a successful revocation, so a passing assertion here can only come from
      // the guard and never from the stub.
      await expect(apiKeysService.revoke(id, ORG_ID, USER_ID)).resolves.toBe(
        false
      );
      expect(db.apiKey.updateMany).not.toHaveBeenCalled();
    }
  );

  it("still refuses a malformed id for an org-wide-visibility role", async () => {
    const db = wireDb(1);

    await expect(
      apiKeysService.revoke(
        "not-a-uuid",
        ORG_ID,
        USER_ID,
        ClerkOrgRoleFixture.Admin
      )
    ).resolves.toBe(false);
    expect(db.apiKey.updateMany).not.toHaveBeenCalled();
  });

  it("accepts a uuid v7, the format ApiKey.id is actually generated in", async () => {
    const db = wireDb(1);

    await expect(
      apiKeysService.revoke(VALID_KEY_ID, ORG_ID, USER_ID)
    ).resolves.toBe(true);
    expect(db.apiKey.updateMany).toHaveBeenCalledTimes(1);
  });
});
