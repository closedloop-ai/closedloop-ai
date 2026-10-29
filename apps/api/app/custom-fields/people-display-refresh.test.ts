import { CustomFieldType } from "@repo/api/src/types/custom-field";
import type { TransactionClient } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({ withDb: vi.fn() }));

vi.mock("@repo/database", () => ({
  withDb: databaseMocks.withDb,
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
}));

import {
  PEOPLE_DISPLAY_REFRESH_MAX_RETRIES,
  PEOPLE_DISPLAY_REFRESH_PAGE_SIZE,
  refreshPeopleDisplayValuesForUser,
  refreshPeopleDisplayValuesForUserWithDb,
} from "./people-display-refresh";

const ORG = "org-1";

function makeDb(pages: unknown[][]) {
  const findMany = vi.fn();
  for (const page of pages) {
    findMany.mockResolvedValueOnce(page);
  }
  findMany.mockResolvedValue([]);
  const userFindMany = vi.fn().mockResolvedValue([]);
  const queryRaw = vi.fn().mockResolvedValue([]);
  const db = {
    customFieldValue: { findMany },
    user: { findMany: userFindMany },
    $queryRaw: queryRaw,
  } as unknown as TransactionClient;
  // `resolvePeopleMap` opens its own `withDb`; hand it the same fake client.
  databaseMocks.withDb.mockImplementation((fn: (client: unknown) => unknown) =>
    fn(db)
  );
  return { db, findMany, userFindMany, queryRaw };
}

const ADA_AND_BOB = [
  {
    id: "u-0",
    email: "a@x",
    firstName: "Ada",
    lastName: "Byron",
    avatarUrl: null,
  },
  {
    id: "u-1",
    email: "b@x",
    firstName: "Bob",
    lastName: "Ross",
    avatarUrl: null,
  },
];

const STALE_ROWS_MESSAGE = /1 row\(s\) stale/;

/**
 * The real rewrite is pinned against Postgres in the integration suite; this
 * file covers the two bounds no fixture can reach cheaply: the person-id
 * chunking under the bind ceiling and the keyset paging over value rows.
 */
describe("refreshPeopleDisplayValuesForUser — bounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("chunks a page's distinct person ids under the bind ceiling before the user lookup", async () => {
    // 40,000 distinct ids on ONE value row: past 32,767 in a single `IN (...)`.
    const ids = Array.from({ length: 40_000 }, (_, i) => `u-${i}`);
    const { db, userFindMany } = makeDb([
      [{ id: "v-1", peopleValueIds: ids, displayValue: "" }],
    ]);

    await refreshPeopleDisplayValuesForUserWithDb(db, "u-0", ORG);

    expect(userFindMany).toHaveBeenCalledTimes(2);
    const sizes = userFindMany.mock.calls.map(
      (call) => call[0].where.id.in.length
    );
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(40_000);
    for (const size of sizes) {
      expect(size).toBeLessThan(32_767);
    }
    for (const call of userFindMany.mock.calls) {
      expect(call[0].where.organizationId).toBe(ORG);
    }
  });

  it("pages by a strict id keyset and stops on a short page", async () => {
    const full = Array.from(
      { length: PEOPLE_DISPLAY_REFRESH_PAGE_SIZE },
      (_, i) => ({
        id: `v-${String(i).padStart(5, "0")}`,
        peopleValueIds: ["u-0"],
        displayValue: "",
      })
    );
    const { db, findMany } = makeDb([full, [full[0]]]);

    await refreshPeopleDisplayValuesForUserWithDb(db, "u-0", ORG);

    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[0][0].where.id).toBeUndefined();
    expect(findMany.mock.calls[1][0].where.id).toEqual({
      gt: full.at(-1)?.id,
    });
    for (const call of findMany.mock.calls) {
      expect(call[0].where.customField).toEqual({
        fieldType: CustomFieldType.People,
        organizationId: ORG,
      });
      expect(call[0].take).toBe(PEOPLE_DISPLAY_REFRESH_PAGE_SIZE);
    }
  });

  it("issues no UPDATE when every recomputed key matches, treating NULL and an empty key as equal", async () => {
    const { db, queryRaw } = makeDb([
      [{ id: "v-1", peopleValueIds: ["u-0"], displayValue: null }],
    ]);

    // No users resolve, so the recomputed key is "" — the same nothing the
    // NULL column already says.
    const rewritten = await refreshPeopleDisplayValuesForUserWithDb(
      db,
      "u-0",
      ORG
    );

    expect(rewritten).toBe(0);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("the public entry point runs the same body under withDb", async () => {
    const { findMany } = makeDb([]);

    const rewritten = await refreshPeopleDisplayValuesForUser("u-0", ORG);

    expect(rewritten).toBe(0);
    expect(databaseMocks.withDb).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("stops after an empty first page without looking up any user", async () => {
    const { db, findMany, userFindMany, queryRaw } = makeDb([]);

    await refreshPeopleDisplayValuesForUserWithDb(db, "u-0", ORG);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(userFindMany).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("reads one more page after an exactly-full page, then stops", async () => {
    const full = Array.from(
      { length: PEOPLE_DISPLAY_REFRESH_PAGE_SIZE },
      (_, i) => ({ id: `v-${i}`, peopleValueIds: ["u-0"], displayValue: "" })
    );
    const { db, findMany } = makeDb([full, []]);

    await refreshPeopleDisplayValuesForUserWithDb(db, "u-0", ORG);

    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("writes every changed row of a page in ONE statement, keyed by id and the stored id array", async () => {
    const { db, userFindMany, queryRaw } = makeDb([
      [
        { id: "v-1", peopleValueIds: ["u-0", "u-1"], displayValue: "stale" },
        { id: "v-2", peopleValueIds: ["u-0"], displayValue: "Ada B." },
        { id: "v-3", peopleValueIds: ["u-1", "u-0"], displayValue: "old" },
      ],
    ]);
    userFindMany.mockResolvedValue(ADA_AND_BOB);
    queryRaw.mockResolvedValue([{ id: "v-1" }, { id: "v-3" }]);

    const rewritten = await refreshPeopleDisplayValuesForUserWithDb(
      db,
      "u-0",
      ORG
    );

    expect(rewritten).toBe(2);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const { values } = queryRaw.mock.calls[0][0];
    // updatedAt, ids, idsKeys, previous, displays, organizationId — v-2
    // already matches and is left out.
    expect(values[1]).toEqual(["v-1", "v-3"]);
    expect(values[2]).toEqual(["u-0,u-1", "u-1,u-0"]);
    expect(values[3]).toEqual(["stale", "old"]);
    expect(values[4]).toEqual(["Ada B., Bob R.", "Bob R., Ada B."]);
    expect(values[5]).toBe(ORG);
  });

  it("re-reads ONLY the rows the compare-and-set missed and retries them against what is stored now", async () => {
    const { db, findMany, userFindMany, queryRaw } = makeDb([
      [
        { id: "v-1", peopleValueIds: ["u-0"], displayValue: "stale" },
        { id: "v-2", peopleValueIds: ["u-0"], displayValue: "stale" },
      ],
    ]);
    userFindMany.mockResolvedValue(ADA_AND_BOB);
    // v-2 was moved by another writer between the read and the UPDATE; the
    // re-read finds it already holding the key this refresh would write.
    queryRaw.mockResolvedValueOnce([{ id: "v-1" }]);
    findMany.mockReset();
    findMany
      .mockResolvedValueOnce([
        { id: "v-1", peopleValueIds: ["u-0"], displayValue: "stale" },
        { id: "v-2", peopleValueIds: ["u-0"], displayValue: "stale" },
      ])
      .mockResolvedValueOnce([
        { id: "v-2", peopleValueIds: ["u-0"], displayValue: "Ada B." },
      ]);

    const rewritten = await refreshPeopleDisplayValuesForUserWithDb(
      db,
      "u-0",
      ORG
    );

    expect(rewritten).toBe(1);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[1][0].where).toEqual({
      id: { in: ["v-2"] },
      organizationId: ORG,
    });
  });

  it("throws instead of reporting success when a row is still stale after the retry bound", async () => {
    const { db, findMany, userFindMany, queryRaw } = makeDb([
      [{ id: "v-1", peopleValueIds: ["u-0"], displayValue: "stale" }],
    ]);
    userFindMany.mockResolvedValue(ADA_AND_BOB);
    queryRaw.mockResolvedValue([]);
    findMany.mockResolvedValue([
      { id: "v-1", peopleValueIds: ["u-0"], displayValue: "stale" },
    ]);

    await expect(
      refreshPeopleDisplayValuesForUserWithDb(db, "u-0", ORG)
    ).rejects.toThrow(STALE_ROWS_MESSAGE);

    expect(queryRaw).toHaveBeenCalledTimes(
      1 + PEOPLE_DISPLAY_REFRESH_MAX_RETRIES
    );
  });
});
