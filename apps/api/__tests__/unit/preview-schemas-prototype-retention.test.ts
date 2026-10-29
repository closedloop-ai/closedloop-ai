/**
 * ISS-11924 (PRD-783 FR6): the daily sweep never drops a `functional-prototype/`
 * schema for inactivity, while every other branch and the merge-queue TTL
 * behave as before. ISS-12214 (Perrin Upcott, 2026-10-09): `prototype/` and
 * `functional-prototype/` schemas are kept exactly where a `vibe/` schema is,
 * so the orphan-branch pass and the null-branch fallback keep them too, and
 * `andy/` is not kept.
 *
 * Driven through `runDailySweep`, the cron route's entry point, against a
 * by-name registry fake so each assertion names exactly which schemas dropped.
 * Branch names are literals: they are git refs, not values this repo owns.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockWithDb, mockWithMigratorClient, mockListAllBranchNames } =
  vi.hoisted(() => ({
    mockWithDb: vi.fn(),
    mockWithMigratorClient: vi.fn(),
    mockListAllBranchNames: vi.fn(),
  }));

vi.mock("@/app/preview-schemas/service/migrator-connection", () => ({
  withMigratorClient: mockWithMigratorClient,
}));

vi.mock("@repo/database", () => ({
  withDb: mockWithDb,
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/github", () => ({
  listAllBranchNames: mockListAllBranchNames,
}));

import { readSqlText } from "@/__tests__/unit/preview-schemas-mocks";
import { previewSchemaCleanupService } from "@/app/preview-schemas/service";

const NOW = new Date("2026-10-03T06:17:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DROP_SCHEMA_NAME = /^DROP SCHEMA IF EXISTS "([^"]+)" CASCADE$/;
const POLICY_ENV_KEYS = [
  "PREVIEW_SCHEMA_TTL_DAYS",
  "PREVIEW_QUEUE_SCHEMA_TTL_HOURS",
  "PREVIEW_ORPHAN_GRACE_HOURS",
  "PREVIEW_SWEEP_BUDGET_MS",
] as const;

type RegistryRow = { last_seen_at: string; branch: string | null };

let registry: Map<string, RegistryRow>;
let dropped: string[];
let savedEnv: [string, string | undefined][];

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

/**
 * Seeds the registry and the live-branch list. Every schema has a registry
 * row, so none is an orphan and the grace-window path stays out of the way.
 */
function seed(rows: Record<string, RegistryRow>, liveBranches: string[]): void {
  registry = new Map(Object.entries(rows));
  mockListAllBranchNames.mockResolvedValue(liveBranches);
}

function fakeQueryRaw(query: { values?: unknown[] }): Promise<unknown[]> {
  const sql = readSqlText(query);
  if (sql.includes("FROM pg_namespace")) {
    return Promise.resolve(
      [...registry.keys()].map((nspname) => ({ nspname }))
    );
  }
  if (sql.includes("FROM public.preview_schemas")) {
    const row = registry.get(String(query.values?.[0]));
    return Promise.resolve(row ? [row] : []);
  }
  return Promise.reject(new Error(`unexpected $queryRaw: ${sql}`));
}

describe("runDailySweep — prototype-lane retention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    savedEnv = POLICY_ENV_KEYS.map((key) => [key, process.env[key]]);
    for (const key of POLICY_ENV_KEYS) {
      Reflect.deleteProperty(process.env, key);
    }
    dropped = [];
    mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
      fn({ $queryRaw: fakeQueryRaw, $executeRaw: () => Promise.resolve(0) })
    );
    mockWithMigratorClient.mockImplementation(
      (fn: (client: unknown) => unknown) =>
        fn({
          query: (sql: string) => {
            const name = DROP_SCHEMA_NAME.exec(sql)?.[1];
            if (name) {
              dropped.push(name);
            }
            return Promise.resolve({ rows: [] });
          },
        })
    );
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
    vi.useRealTimers();
  });

  it("keeps 30-day-old functional-prototype/ and prototype/ schemas while andy/, look-alike, and ordinary schemas of that age drop", async () => {
    seed(
      {
        preview_functional_prototype_x_1a2b3c4d: {
          last_seen_at: ago(30 * DAY_MS),
          branch: "functional-prototype/x",
        },
        preview_prototype_x_5e6f7a8b: {
          last_seen_at: ago(30 * DAY_MS),
          branch: "prototype/x",
        },
        preview_andy_x_0e1f2a3b: {
          last_seen_at: ago(30 * DAY_MS),
          branch: "andy/x",
        },
        preview_functional_prototype_x_look_alike_6a7b8c9d: {
          last_seen_at: ago(30 * DAY_MS),
          branch: "functional-prototype-x",
        },
        preview_feat_widget_9c0d1e2f: {
          last_seen_at: ago(30 * DAY_MS),
          branch: "feat/widget",
        },
      },
      [
        "main",
        "functional-prototype/x",
        "prototype/x",
        "andy/x",
        "functional-prototype-x",
        "feat/widget",
      ]
    );

    const dryRun = await previewSchemaCleanupService.runDryRun();
    expect([...dryRun.keptActive].sort()).toEqual([
      "preview_functional_prototype_x_1a2b3c4d",
      "preview_prototype_x_5e6f7a8b",
    ]);

    const result = await previewSchemaCleanupService.runDailySweep();

    expect(dropped).toEqual([
      "preview_andy_x_0e1f2a3b",
      "preview_functional_prototype_x_look_alike_6a7b8c9d",
      "preview_feat_widget_9c0d1e2f",
    ]);
    expect(result.counters["ttl-expired"]).toMatchObject({
      dropped: 3,
      kept: 2,
    });
    expect(result.exitCode).toBe(0);
  });

  it("keeps null-branch schemas named like either prototype lane past TTL while an andy-named null-branch schema drops", async () => {
    seed(
      {
        preview_functional_prototype_y_3a4b5c6d: {
          last_seen_at: ago(30 * DAY_MS),
          branch: null,
        },
        preview_prototype_y_7e8f9a0b: {
          last_seen_at: ago(30 * DAY_MS),
          branch: null,
        },
        preview_andy_y_8d9e0f1a: {
          last_seen_at: ago(30 * DAY_MS),
          branch: null,
        },
        preview_functional_prototype_x_1a2b3c4d: {
          last_seen_at: ago(30 * DAY_MS),
          branch: "functional-prototype/x",
        },
      },
      ["main", "functional-prototype/x"]
    );

    const result = await previewSchemaCleanupService.runDailySweep();

    expect(dropped).toEqual(["preview_andy_y_8d9e0f1a"]);
    expect(result.counters["ttl-expired"]).toMatchObject({
      dropped: 1,
      kept: 3,
    });
  });

  it("leaves the merge-queue TTL unchanged beside an exempt schema", async () => {
    seed(
      {
        preview_gh_readonly_queue_main_pr_7001_abc1234_0a1b2c3d: {
          last_seen_at: ago(13 * HOUR_MS),
          branch: "gh-readonly-queue/main/pr-7001-abc1234",
        },
        preview_gh_readonly_queue_main_pr_7002_abc1234_4e5f6a7b: {
          last_seen_at: ago(11 * HOUR_MS),
          branch: "gh-readonly-queue/main/pr-7002-abc1234",
        },
        preview_functional_prototype_x_1a2b3c4d: {
          last_seen_at: ago(30 * DAY_MS),
          branch: "functional-prototype/x",
        },
      },
      [
        "main",
        "gh-readonly-queue/main/pr-7001-abc1234",
        "gh-readonly-queue/main/pr-7002-abc1234",
        "functional-prototype/x",
      ]
    );

    const result = await previewSchemaCleanupService.runDailySweep();

    expect(dropped).toEqual([
      "preview_gh_readonly_queue_main_pr_7001_abc1234_0a1b2c3d",
    ]);
    expect(result.counters["ttl-expired"]).toMatchObject({
      dropped: 1,
      kept: 2,
    });
  });

  it("keeps functional-prototype/ and prototype/ schemas whose branch is gone while andy/ and look-alike schemas on deleted branches drop", async () => {
    seed(
      {
        preview_functional_prototype_gone_2b3c4d5e: {
          last_seen_at: ago(30 * DAY_MS),
          branch: "functional-prototype/gone",
        },
        preview_prototype_gone_5e6f7a8b: {
          last_seen_at: ago(1 * DAY_MS),
          branch: "prototype/gone",
        },
        preview_andy_gone_3c4d5e6f: {
          last_seen_at: ago(1 * DAY_MS),
          branch: "andy/gone",
        },
        preview_feat_functional_prototype_gone_4d5e6f7a: {
          last_seen_at: ago(1 * DAY_MS),
          branch: "feat/functional-prototype/gone",
        },
        preview_functional_prototype_x_1a2b3c4d: {
          last_seen_at: ago(30 * DAY_MS),
          branch: "functional-prototype/x",
        },
      },
      ["main", "functional-prototype/x"]
    );

    const result = await previewSchemaCleanupService.runDailySweep();

    expect(dropped).toEqual([
      "preview_andy_gone_3c4d5e6f",
      "preview_feat_functional_prototype_gone_4d5e6f7a",
    ]);
    expect(result.counters["orphan-branch"]).toMatchObject({
      dropped: 2,
      kept: 0,
    });
    expect(result.counters["ttl-expired"]).toMatchObject({
      dropped: 0,
      kept: 3,
    });
  });
});
