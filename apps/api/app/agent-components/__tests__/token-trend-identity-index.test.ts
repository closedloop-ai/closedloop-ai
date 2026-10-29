/**
 * ISS-6756 — the org-scoped token-trend identity read must be expressible as an
 * INDEXED equality, and it must survive being combined with a content scope.
 *
 * Its own file rather than an addition to `token-trend.test.ts`: that suite is
 * on the `noExcessiveLinesPerFile` grandfather list, which is shrink-only.
 * Scoping this file to the identity PREDICATE — not to the trend's arithmetic —
 * also keeps it readable as one idea.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

import { analyticsService } from "../analytics-service";

const ORG = "org-trend-1111";
describe("ISS-6756: indexable identity predicate on the token-trend read", () => {
  /** A 64-hex fingerprint routes the slug down the content-hash path. */
  const FINGERPRINT = "a".repeat(64);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function installHashRouteDb(): { findMany: ReturnType<typeof vi.fn> } {
    const findMany = vi.fn().mockResolvedValue([]);
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        agentComponentSessionUsage: { findMany },
        agentComponentVersion: {
          findMany: vi
            .fn()
            // The exact `definitionHash` route resolves; the coarse fallback is
            // never reached.
            .mockResolvedValue([
              { componentKey: "Reviewer", contentHash: "hash-a" },
              { componentKey: "reviewer-alias", contentHash: "hash-b" },
            ]),
        },
      })
    );
    return { findMany };
  }

  it("matches the identity on the persisted fold, never on an ILIKE", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({ agentComponentSessionUsage: { findMany } })
    );

    await analyticsService.fetchTokenTrend(ORG, "skill::deploy", {});

    const where = findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.componentKeyNormalized).toEqual({ in: ["deploy"] });
    // The mutation this test exists to catch: reinstating `mode: "insensitive"`
    // would still return the right rows, so only the absence of the raw-key
    // predicate distinguishes the indexable spelling from the scanning one.
    expect(where).not.toHaveProperty("componentKey");
    expect(JSON.stringify(where)).not.toContain("insensitive");
  });

  it("keeps the identity predicate when a content scope is also applied", async () => {
    const { findMany } = installHashRouteDb();

    await analyticsService.fetchTokenTrend(ORG, `skill::${FINGERPRINT}`, {});

    const where = findMany.mock.calls[0][0].where as Record<string, unknown>;
    // Every name the content is installed under, folded and de-duplicated —
    // pre-fix this key was absent entirely on a content-hash route.
    expect(where.componentKeyNormalized).toEqual({
      in: ["reviewer", "reviewer-alias"],
    });
    // …and the content scope is still applied, nested under `AND` so it cannot
    // collide with any sibling `OR`.
    expect(where.AND).toEqual([
      {
        OR: [
          { componentVersionHash: { in: ["hash-a", "hash-b"] } },
          { definitionVersion: { definitionHash: FINGERPRINT } },
        ],
      },
    ]);
    expect(where).not.toHaveProperty("OR");
  });

  it("keeps the content scope when a cursor is applied to the same read", async () => {
    // ISS-9851. Both predicates own an `OR`, so both have to live in ONE `AND`
    // array. Added as a second conditional `{ AND: [...] }` spread, the cursor
    // would REPLACE the content scope — and every page after the first of a
    // content-hash component would silently read every version's usage.
    const { findMany } = installHashRouteDb();

    await analyticsService.fetchTokenTrend(ORG, `skill::${FINGERPRINT}`, {
      cursor: {
        sessionStartedAtMs: Date.parse("2026-07-01T00:00:00.000Z"),
        agentSessionId: "01a08753-c74c-7349-8010-5d07ee4f8bd4",
      },
    });

    const where = findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.AND).toEqual([
      {
        OR: [
          { componentVersionHash: { in: ["hash-a", "hash-b"] } },
          { definitionVersion: { definitionHash: FINGERPRINT } },
        ],
      },
      {
        OR: [
          {
            session: {
              sessionStartedAt: { lt: new Date("2026-07-01T00:00:00.000Z") },
            },
          },
          {
            session: {
              sessionStartedAt: new Date("2026-07-01T00:00:00.000Z"),
            },
            agentSessionId: { gt: "01a08753-c74c-7349-8010-5d07ee4f8bd4" },
          },
        ],
      },
    ]);
  });

  it("asks for no rows at all when the slug carries no name", async () => {
    // `decodeComponentSlug("subagent::")` yields an EMPTY key and the route does
    // not reject it. `IN ('')` would match every row still carrying the column's
    // `ADD COLUMN … DEFAULT ''` value — a fabricated trend assembled from other
    // components — where the `ILIKE ''` this replaces returned nothing. Failing
    // closed is the safe direction for a predicate whose job is to narrow.
    const findMany = vi.fn().mockResolvedValue([]);
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({ agentComponentSessionUsage: { findMany } })
    );

    await analyticsService.fetchTokenTrend(ORG, "skill::", {});

    const where = findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.componentKeyNormalized).toEqual({ in: [] });
  });

  it("drops an alias that folds to nothing rather than emitting it", async () => {
    // `resolveContentHashIdentity` builds `keys` with
    // `(componentKey ?? "").toLowerCase().trim()`, so a version row carrying no
    // key at all contributes `""` to an otherwise-populated alias set. One `""`
    // inside the `IN` widens the whole predicate to every default-valued row.
    const findMany = vi.fn().mockResolvedValue([]);
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        agentComponentSessionUsage: { findMany },
        agentComponentVersion: {
          findMany: vi.fn().mockResolvedValue([
            { componentKey: "Reviewer", contentHash: "hash-a" },
            { componentKey: null, contentHash: "hash-b" },
          ]),
        },
      })
    );

    await analyticsService.fetchTokenTrend(ORG, `skill::${FINGERPRINT}`, {});

    const where = findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.componentKeyNormalized).toEqual({ in: ["reviewer"] });
  });

  it("leaves the rolled-up general-purpose arm on its raw-key OR", async () => {
    // That arm is a PREFIX probe for the instance-unique `Claude subagent <hex>`
    // spelling, not an identity equality; no btree serves a prefix LIKE here
    // either way, and folding it would silently widen the exact
    // `general-purpose` arm from case-sensitive to case-insensitive.
    const findMany = vi.fn().mockResolvedValue([]);
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({ agentComponentSessionUsage: { findMany } })
    );

    await analyticsService.fetchTokenTrend(
      ORG,
      "subagent::general-purpose",
      {}
    );

    const where = findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.OR).toEqual([
      { componentKey: "general-purpose" },
      {
        componentKey: {
          startsWith: "claude subagent ",
          mode: "insensitive",
        },
      },
    ]);
    expect(where).not.toHaveProperty("componentKeyNormalized");
  });
});
