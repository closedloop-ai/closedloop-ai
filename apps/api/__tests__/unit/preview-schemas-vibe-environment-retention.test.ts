/**
 * ISS-12135 (vibe meeting requirement A5, Daveth Oakhurst): the daily sweep never
 * drops a `vibe/` schema, neither for inactivity nor because its branch is
 * gone, while every other schema expires as before and the mass-drop cap still
 * counts only the schemas it did. The manual branch cleanup still drops one.
 *
 * Driven through `runDailySweep`, `runDryRun` and `dropSchemaForBranch`
 * against a by-name registry fake so each assertion names exactly which
 * schemas dropped. Branch names are literals: they are git refs, not values
 * this repo owns.
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

import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import {
  formatVibeEnvironmentMarker,
  VibeEnvironmentMode,
  VibeEnvironmentState,
} from "@repo/database/scripts/vibe-environment";
import { readSqlText } from "@/__tests__/unit/preview-schemas-mocks";
import { previewSchemaCleanupService } from "@/app/preview-schemas/service";

const NOW = new Date("2026-10-07T06:17:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const DROP_SCHEMA_NAME = /^DROP SCHEMA IF EXISTS "([^"]+)" CASCADE$/;
const POLICY_ENV_KEYS = [
  "PREVIEW_SCHEMA_TTL_DAYS",
  "PREVIEW_QUEUE_SCHEMA_TTL_HOURS",
  "PREVIEW_ORPHAN_GRACE_HOURS",
  "PREVIEW_SWEEP_BUDGET_MS",
] as const;

type RegistryRow = { last_seen_at: string; branch: string | null };

let registry: Map<string, RegistryRow>;
let schemaComments: Map<string, string | null>;
let dropped: string[];
let savedEnv: [string, string | undefined][];

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

/**
 * Unregistered schemas may carry a marker, or be residue created before one.
 */
function seed(
  rows: Record<string, RegistryRow>,
  liveBranches: string[],
  unregistered: Record<string, string | null> = {}
): void {
  registry = new Map(Object.entries(rows));
  schemaComments = new Map([
    ...Object.keys(rows).map((name): [string, null] => [name, null]),
    ...Object.entries(unregistered),
  ]);
  mockListAllBranchNames.mockResolvedValue(liveBranches);
}

function fakeQueryRaw(query: { values?: unknown[] }): Promise<unknown[]> {
  const sql = readSqlText(query);
  if (sql.includes("FROM pg_namespace") && sql.includes("nspname =")) {
    const name = String(query.values?.[0]);
    return Promise.resolve(schemaComments.has(name) ? [{ nspname: name }] : []);
  }
  if (sql.includes("FROM pg_namespace")) {
    return Promise.resolve(
      [...schemaComments].map(([nspname, comment]) => ({ nspname, comment }))
    );
  }
  if (sql.includes("FROM public.preview_schemas_observations")) {
    const requested = query.values?.[0];
    if (Array.isArray(requested)) {
      return Promise.resolve(
        requested.map((schemaName) => ({
          schema_name: schemaName,
          first_observed_at: ago(72 * 60 * 60 * 1000),
        }))
      );
    }
    return Promise.resolve([{ first_observed_at: ago(72 * 60 * 60 * 1000) }]);
  }
  if (sql.includes("FROM public.preview_schemas")) {
    const row = registry.get(String(query.values?.[0]));
    return Promise.resolve(row ? [row] : []);
  }
  return Promise.reject(new Error(`unexpected $queryRaw: ${sql}`));
}

/** `count` schemas of one kind, each on its own branch `${prefix}${i}`. */
function schemasOn(
  prefix: string,
  count: number,
  lastSeenAt: string
): Record<string, RegistryRow> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => {
      const branch = `${prefix}${i}`;
      return [
        normalizePreviewSchemaName(branch),
        { last_seen_at: lastSeenAt, branch },
      ];
    })
  );
}

describe("preview schema cleanup: vibe environments are never swept", () => {
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
              registry.delete(name);
              schemaComments.delete(name);
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

  it("keeps a 30-day-old vibe/ schema while a look-alike and an ordinary schema of that age drop", async () => {
    seed(
      {
        preview_vibe_bulk_tags_1a2b3c4d: {
          last_seen_at: ago(30 * DAY_MS),
          branch: "vibe/bulk-tags",
        },
        preview_vibe_bulk_tags_look_alike_5e6f7a8b: {
          last_seen_at: ago(30 * DAY_MS),
          branch: "vibe-bulk-tags",
        },
        preview_feat_widget_9c0d1e2f: {
          last_seen_at: ago(30 * DAY_MS),
          branch: "feat/widget",
        },
      },
      ["main", "vibe/bulk-tags", "vibe-bulk-tags", "feat/widget"]
    );

    const result = await previewSchemaCleanupService.runDailySweep();

    expect(dropped).toEqual([
      "preview_vibe_bulk_tags_look_alike_5e6f7a8b",
      "preview_feat_widget_9c0d1e2f",
    ]);
    expect(result.counters["ttl-expired"]).toMatchObject({
      dropped: 2,
      kept: 1,
    });
    expect(result.exitCode).toBe(0);
  });

  it("keeps a vibe/ schema whose branch was deleted while an ordinary schema on a deleted branch drops", async () => {
    seed(
      {
        preview_vibe_gone_2b3c4d5e: {
          last_seen_at: ago(1 * DAY_MS),
          branch: "vibe/gone",
        },
        preview_vibe_stale_and_gone_6f7a8b9c: {
          last_seen_at: ago(30 * DAY_MS),
          branch: "vibe/stale-and-gone",
        },
        preview_feat_gone_0d1e2f3a: {
          last_seen_at: ago(1 * DAY_MS),
          branch: "feat/gone",
        },
      },
      ["main"]
    );

    const result = await previewSchemaCleanupService.runDailySweep();

    expect(dropped).toEqual(["preview_feat_gone_0d1e2f3a"]);
    expect(result.counters["orphan-branch"]).toMatchObject({
      dropped: 1,
      kept: 0,
    });
    expect(result.counters["ttl-expired"]).toMatchObject({
      dropped: 0,
      kept: 2,
    });
  });

  it("reports the same in a dry run: vibe/ schemas are kept, the others would drop", async () => {
    seed(
      {
        preview_vibe_stale_1a2b3c4d: {
          last_seen_at: ago(30 * DAY_MS),
          branch: "vibe/stale",
        },
        preview_vibe_gone_2b3c4d5e: {
          last_seen_at: ago(1 * DAY_MS),
          branch: "vibe/gone",
        },
        preview_feat_old_3c4d5e6f: {
          last_seen_at: ago(30 * DAY_MS),
          branch: "feat/old",
        },
        preview_feat_gone_0d1e2f3a: {
          last_seen_at: ago(1 * DAY_MS),
          branch: "feat/gone",
        },
      },
      ["main", "vibe/stale", "feat/old"]
    );

    const result = await previewSchemaCleanupService.runDryRun();

    expect(result.wouldDropStale).toEqual(["preview_feat_old_3c4d5e6f"]);
    expect(result.wouldDropOrphanBranch).toEqual([
      "preview_feat_gone_0d1e2f3a",
    ]);
    expect([...result.keptActive].sort()).toEqual([
      "preview_vibe_gone_2b3c4d5e",
      "preview_vibe_stale_1a2b3c4d",
    ]);
    expect(dropped).toEqual([]);
  });

  it("leaves vibe/ schemas out of the mass-drop cap, so they cannot dilute it", async () => {
    // 6 of the 10 ordinary branch-aware candidates have a deleted branch: over
    // the cap's half. Counting the 10 live vibe/ schemas as candidates would
    // make it 6 of 20 and let the whole pass through.
    seed(
      {
        ...schemasOn("feat/gone-", 6, ago(1 * DAY_MS)),
        ...schemasOn("feat/live-", 4, ago(1 * DAY_MS)),
        ...schemasOn("vibe/live-", 10, ago(1 * DAY_MS)),
      },
      [
        "main",
        ...Array.from({ length: 4 }, (_, i) => `feat/live-${i}`),
        ...Array.from({ length: 10 }, (_, i) => `vibe/live-${i}`),
      ]
    );

    const result = await previewSchemaCleanupService.runDailySweep();

    expect(dropped).toEqual([]);
    expect(result.counters["orphan-branch"]).toMatchObject({
      dropped: 0,
      kept: 6,
    });
  });

  it("still drops a vibe/ schema through the manual branch cleanup", async () => {
    const branch = "vibe/bulk-tags";
    const schemaName = normalizePreviewSchemaName(branch);
    seed({ [schemaName]: { last_seen_at: ago(1 * DAY_MS), branch } }, [
      "main",
      branch,
    ]);

    const result =
      await previewSchemaCleanupService.dropSchemaForBranch(branch);

    expect(result).toMatchObject({
      schemaName,
      dropped: true,
      alreadyGone: false,
      error: null,
    });
    expect(dropped).toEqual([schemaName]);
  });

  it("keeps null-branch vibe candidates past TTL while a known lookalike still expires", async () => {
    const vibeName = normalizePreviewSchemaName("vibe/missing-branch");
    const unknownLookalike = normalizePreviewSchemaName("vibe-unknown");
    const knownLookalike = normalizePreviewSchemaName("vibe-known");
    seed(
      {
        [vibeName]: { last_seen_at: ago(30 * DAY_MS), branch: null },
        [unknownLookalike]: { last_seen_at: ago(30 * DAY_MS), branch: null },
        [knownLookalike]: {
          last_seen_at: ago(30 * DAY_MS),
          branch: "vibe-known",
        },
      },
      ["main", "vibe-known"]
    );

    const dryRun = await previewSchemaCleanupService.runDryRun();
    expect(dryRun.wouldDropStale).toEqual([knownLookalike]);
    expect(dryRun.keptActive).toEqual([vibeName, unknownLookalike]);

    await previewSchemaCleanupService.runDailySweep();
    expect(dropped).toEqual([knownLookalike]);
  });

  it("keeps marked and unmarked unregistered vibe candidates after orphan grace while old andy and ordinary schemas drop", async () => {
    const marker = formatVibeEnvironmentMarker({
      mode: VibeEnvironmentMode.Seeded,
      state: VibeEnvironmentState.Pending,
    });
    const marked = normalizePreviewSchemaName("vibe/marked");
    const unmarked = normalizePreviewSchemaName("vibe/unmarked");
    const unknownLookalike = normalizePreviewSchemaName("vibe-unknown");
    const andy = normalizePreviewSchemaName("andy/retired");
    const ordinary = normalizePreviewSchemaName("feat/orphan");
    seed({}, ["main"], {
      [marked]: marker,
      [unmarked]: null,
      [unknownLookalike]: null,
      [andy]: marker,
      [ordinary]: null,
    });

    const dryRun = await previewSchemaCleanupService.runDryRun();
    expect(dryRun.wouldDropOrphaned).toEqual([andy, ordinary]);
    expect(dryRun.keptActive).toEqual([marked, unmarked, unknownLookalike]);

    await previewSchemaCleanupService.runDailySweep();
    expect(dropped).toEqual([andy, ordinary]);

    const manual =
      await previewSchemaCleanupService.dropSchemaForBranch("vibe/unmarked");
    expect(manual.dropped).toBe(true);
    expect(dropped).toEqual([andy, ordinary, unmarked]);
  });

  it("withholds a drop when a vibe-prefix schema loses branch provenance after classification", async () => {
    const schemaName = normalizePreviewSchemaName("vibe/former-branch");
    seed(
      {
        [schemaName]: {
          last_seen_at: ago(30 * DAY_MS),
          branch: "feat/former-branch",
        },
      },
      ["main"]
    );
    let registryReads = 0;
    mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
      fn({
        $queryRaw: (query: { values?: unknown[] }) => {
          if (readSqlText(query).includes("FROM public.preview_schemas")) {
            registryReads += 1;
            if (registryReads === 2) {
              registry.set(schemaName, {
                last_seen_at: ago(30 * DAY_MS),
                branch: null,
              });
            }
          }
          return fakeQueryRaw(query);
        },
        $executeRaw: () => Promise.resolve(0),
      })
    );

    await previewSchemaCleanupService.runDailySweep();

    expect(registryReads).toBe(2);
    expect(dropped).toEqual([]);
  });

  // ISS-12214 (Perrin Upcott, 2026-10-09): prototype/ and functional-prototype/
  // schemas are kept wherever vibe/ schemas are; andy/ is not.
  it("keeps unregistered prototype/ and functional-prototype/ candidates after orphan grace while an andy/ one drops", async () => {
    const functionalPrototype = normalizePreviewSchemaName(
      "functional-prototype/orphan"
    );
    const prototype = normalizePreviewSchemaName("prototype/orphan");
    const andy = normalizePreviewSchemaName("andy/orphan");
    seed({}, ["main"], {
      [functionalPrototype]: null,
      [prototype]: null,
      [andy]: null,
    });

    const dryRun = await previewSchemaCleanupService.runDryRun();
    expect(dryRun.wouldDropOrphaned).toEqual([andy]);
    expect(dryRun.keptActive).toEqual([functionalPrototype, prototype]);

    await previewSchemaCleanupService.runDailySweep();
    expect(dropped).toEqual([andy]);

    const manual =
      await previewSchemaCleanupService.dropSchemaForBranch("prototype/orphan");
    expect(manual.dropped).toBe(true);
    expect(dropped).toEqual([andy, prototype]);
  });

  it.each(["prototype/former-branch", "functional-prototype/former-branch"])(
    "withholds a drop when a %s schema loses branch provenance after classification",
    async (formerBranch) => {
      const schemaName = normalizePreviewSchemaName(formerBranch);
      seed(
        {
          [schemaName]: {
            last_seen_at: ago(30 * DAY_MS),
            branch: "feat/former-branch",
          },
        },
        ["main"]
      );
      let registryReads = 0;
      mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
        fn({
          $queryRaw: (query: { values?: unknown[] }) => {
            if (readSqlText(query).includes("FROM public.preview_schemas")) {
              registryReads += 1;
              if (registryReads === 2) {
                registry.set(schemaName, {
                  last_seen_at: ago(30 * DAY_MS),
                  branch: null,
                });
              }
            }
            return fakeQueryRaw(query);
          },
          $executeRaw: () => Promise.resolve(0),
        })
      );

      await previewSchemaCleanupService.runDailySweep();

      expect(registryReads).toBe(2);
      expect(dropped).toEqual([]);
    }
  );
});
