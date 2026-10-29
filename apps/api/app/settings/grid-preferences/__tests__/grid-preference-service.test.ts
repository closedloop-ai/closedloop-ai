import {
  GRID_PREFERENCE_CONTRACT_VERSION,
  GridPreferenceErrorCode,
  GridPreferenceGridKey,
  GridPreferenceKind,
  GridPreferenceResetStatus,
  GridPreferenceScopeKey,
} from "@repo/api/src/types/grid-preferences";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createDatabaseMockModule } from "../../../../__tests__/fixtures/mock-modules";

const databaseMocks = vi.hoisted(() => {
  const withDb = Object.assign(vi.fn(), { tx: vi.fn() });
  return { withDb };
});

vi.mock("@repo/database", () =>
  createDatabaseMockModule({ withDb: databaseMocks.withDb })
);

import { gridPreferenceService } from "../grid-preference-service";

type RawQuery = { strings: readonly string[]; values: unknown[] };

const SELECTOR = {
  organizationId: "11111111-1111-7111-8111-111111111111",
  userId: "22222222-2222-7222-8222-222222222222",
  gridKey: GridPreferenceGridKey.Sessions,
  preferenceKind: GridPreferenceKind.ViewState,
  scopeKey: GridPreferenceScopeKey.Default,
};

const ROW = {
  gridKey: GridPreferenceGridKey.Sessions,
  preferenceKind: GridPreferenceKind.ViewState,
  scopeKey: GridPreferenceScopeKey.Default,
  value: { columns: ["name"], viewStateVersions: { columns: 1 } },
  revision: 3,
  createdAt: new Date("2026-09-11T00:00:00.000Z"),
  updatedAt: new Date("2026-09-11T00:01:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("gridPreferenceService reads", () => {
  it("lists preferences through the authenticated organization and user only", async () => {
    const rawQueries: RawQuery[] = [];
    installDb([[ROW]], rawQueries);

    const preferences = await gridPreferenceService.listPreferences({
      organizationId: SELECTOR.organizationId,
      userId: SELECTOR.userId,
    });

    expect(preferences).toEqual([
      {
        gridKey: GridPreferenceGridKey.Sessions,
        preferenceKind: GridPreferenceKind.ViewState,
        scopeKey: GridPreferenceScopeKey.Default,
        value: ROW.value,
        revision: 3,
        createdAt: "2026-09-11T00:00:00.000Z",
        updatedAt: "2026-09-11T00:01:00.000Z",
        contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
      },
    ]);
    expect(rawQueries).toHaveLength(1);
    expect(sqlText(rawQueries[0])).toContain('"organization_id" = ?::uuid');
    expect(sqlText(rawQueries[0])).toContain('"user_id" = ?::uuid');
    expect(sqlText(rawQueries[0])).toContain('"deleted_at" IS NULL');
    expect(rawQueries[0].values).toEqual([
      SELECTOR.organizationId,
      SELECTOR.userId,
    ]);
  });

  it("rejects invalid persisted selector rows instead of casting unchecked text", async () => {
    const rawQueries: RawQuery[] = [];
    installDb([[{ ...ROW, gridKey: "retired-grid" }]], rawQueries);

    await expect(
      gridPreferenceService.listPreferences({
        organizationId: SELECTOR.organizationId,
        userId: SELECTOR.userId,
      })
    ).rejects.toThrow("Invalid persisted grid preference gridKey");
  });
});

describe("gridPreferenceService writes", () => {
  it("upserts one selector with organization and user in the conflict identity", async () => {
    const rawQueries: RawQuery[] = [];
    installDb([[ROW]], rawQueries);

    const result = await gridPreferenceService.upsertPreference({
      ...SELECTOR,
      value: { columns: ["name"] },
    });

    expect(result.ok).toBe(true);
    expect(databaseMocks.withDb.tx).not.toHaveBeenCalled();
    const upsertQuery = rawQueries.find((query) =>
      sqlText(query).includes('INSERT INTO "grid_preferences"')
    );
    expect(upsertQuery).toBeDefined();
    expect(sqlText(upsertQuery)).toContain(
      'ON CONFLICT ( "organization_id", "user_id", "grid_key", "preference_kind", "scope_key" )'
    );
    expect(sqlText(upsertQuery)).toContain(
      '"revision" = "grid_preferences"."revision" + 1'
    );
    expect(sqlText(upsertQuery)).toContain('"deleted_at" = NULL');
    expect(upsertQuery?.values).toContain(SELECTOR.organizationId);
    expect(upsertQuery?.values).toContain(SELECTOR.userId);
    expect(upsertQuery?.values).toContain(
      JSON.stringify({ columns: ["name"] })
    );
  });

  it("returns a stale conflict with the current row when expectedRevision lost the race", async () => {
    const rawQueries: RawQuery[] = [];
    installDb([[], [ROW]], rawQueries);

    const result = await gridPreferenceService.upsertPreference({
      ...SELECTOR,
      value: { columns: ["status"] },
      expectedRevision: 2,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        status: Status.Conflict,
        conflict: {
          code: GridPreferenceErrorCode.StaleRevision,
          selector: {
            gridKey: GridPreferenceGridKey.Sessions,
            preferenceKind: GridPreferenceKind.ViewState,
            scopeKey: GridPreferenceScopeKey.Default,
          },
          expectedRevision: 2,
          currentRevision: 3,
          current: {
            gridKey: GridPreferenceGridKey.Sessions,
            preferenceKind: GridPreferenceKind.ViewState,
            scopeKey: GridPreferenceScopeKey.Default,
            value: ROW.value,
            revision: 3,
            createdAt: "2026-09-11T00:00:00.000Z",
            updatedAt: "2026-09-11T00:01:00.000Z",
            contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
          },
          contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
        },
      },
    });
    expect(rawQueries).toHaveLength(2);
  });

  it("treats an expectedRevision against a missing row as stale without creating it", async () => {
    const rawQueries: RawQuery[] = [];
    installDb([[], []], rawQueries);

    const result = await gridPreferenceService.upsertPreference({
      ...SELECTOR,
      value: {},
      expectedRevision: 5,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.conflict).toEqual({
        code: GridPreferenceErrorCode.StaleRevision,
        selector: {
          gridKey: GridPreferenceGridKey.Sessions,
          preferenceKind: GridPreferenceKind.ViewState,
          scopeKey: GridPreferenceScopeKey.Default,
        },
        expectedRevision: 5,
        contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
      });
    }
    const upsertQuery = rawQueries.find((query) =>
      sqlText(query).includes('INSERT INTO "grid_preferences"')
    );
    expect(sqlText(upsertQuery)).toContain("candidate AS");
    expect(sqlText(upsertQuery)).toContain("OR EXISTS");
    expect(sqlText(upsertQuery)).toContain('"deleted_at" IS NULL');
  });

  it("soft-resets an existing row or reports a missing reset without manufacturing state", async () => {
    const deletedQueries: RawQuery[] = [];
    installDb([[{ previousRevision: 8 }]], deletedQueries);

    const deleted = await gridPreferenceService.resetPreference(SELECTOR);

    expect(deleted).toEqual({
      ok: true,
      value: {
        status: GridPreferenceResetStatus.Deleted,
        selector: {
          gridKey: GridPreferenceGridKey.Sessions,
          preferenceKind: GridPreferenceKind.ViewState,
          scopeKey: GridPreferenceScopeKey.Default,
        },
        previousRevision: 8,
        contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
      },
    });
    expect(databaseMocks.withDb.tx).not.toHaveBeenCalled();
    expect(sqlText(deletedQueries[0])).toContain('UPDATE "grid_preferences"');
    expect(sqlText(deletedQueries[0])).toContain('"deleted_at" = now()');
    expect(sqlText(deletedQueries[0])).toContain(
      'RETURNING "revision" - 1 AS "previousRevision"'
    );

    const missingQueries: RawQuery[] = [];
    installDb([[]], missingQueries);
    const missing = await gridPreferenceService.resetPreference(SELECTOR);

    expect(missing).toEqual({
      ok: true,
      value: {
        status: GridPreferenceResetStatus.Missing,
        selector: {
          gridKey: GridPreferenceGridKey.Sessions,
          preferenceKind: GridPreferenceKind.ViewState,
          scopeKey: GridPreferenceScopeKey.Default,
        },
        contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
      },
    });
  });
});

function installDb(responses: unknown[][], rawQueries: RawQuery[]): void {
  (databaseMocks.withDb as Mock).mockImplementation(
    (fn: (db: { $queryRaw: Mock }) => Promise<unknown>) => {
      let calls = 0;
      return fn({
        $queryRaw: vi.fn((query: RawQuery) => {
          rawQueries.push(query);
          const response = responses[calls] ?? [];
          calls += 1;
          return Promise.resolve(response);
        }),
      });
    }
  );
}

function sqlText(query: RawQuery | undefined): string {
  if (!query) {
    return "";
  }
  return query.strings.join("?").replaceAll(/\s+/g, " ").trim();
}
