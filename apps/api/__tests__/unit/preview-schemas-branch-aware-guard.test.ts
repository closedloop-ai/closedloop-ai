/**
 * ISS-8139. The guard in `fetchLiveBranches` that treats a SUCCESSFUL but empty
 * GitHub branch listing as "GitHub unavailable" rather than as "every branch is
 * gone".
 *
 * Only the THROW path had coverage. An empty resolve is a different branch of
 * the same function, and without its early return every branch-carrying schema
 * becomes an `orphan-branch` candidate at once. The mass-drop cap cannot save
 * that case below `BRANCH_AWARE_MASS_DROP_MIN_CANDIDATES`, so under ten
 * candidates the whole set is DROPPED — which is the range these cases cover.
 *
 * Lives beside `preview-schemas-service.test.ts` rather than in it: that file is
 * on the shrink-only grandfather list in `biome.jsonc` and cannot take added
 * lines. The harness below is the same one, so the two read alike.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockWithDb,
  mockWithDbTx,
  mockWithMigratorClient,
  mockListAllBranchNames,
} = vi.hoisted(() => ({
  mockWithDb: vi.fn(),
  mockWithDbTx: vi.fn(),
  mockWithMigratorClient: vi.fn(),
  mockListAllBranchNames: vi.fn(),
}));

vi.mock("@/app/preview-schemas/service/migrator-connection", () => ({
  withMigratorClient: mockWithMigratorClient,
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(mockWithDb, { tx: mockWithDbTx }),
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

import { previewSchemaCleanupService } from "@/app/preview-schemas/service";
import { createPreviewSchemaMocks } from "./preview-schemas-mocks";

const {
  mockCleanupStaleObservationsSuccess,
  mockGitHubBranches,
  mockListSchemas,
  mockRegistryRow,
} = createPreviewSchemaMocks(
  mockWithDb,
  mockListAllBranchNames,
  mockWithMigratorClient
);

const NOW = new Date("2026-01-15T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Three schemas, each carrying a branch. Deliberately fewer than
 * `BRANCH_AWARE_MASS_DROP_MIN_CANDIDATES` (10): the cap is a no-op below that
 * count, so this guard is the only thing standing between an empty GitHub
 * response and a 100% drop.
 */
const BRANCH_SCHEMAS = [
  { schema: "preview_feat_alpha_11111111", branch: "feat/alpha" },
  { schema: "preview_feat_bravo_22222222", branch: "feat/bravo" },
  { schema: "preview_feat_delta_33333333", branch: "feat/delta" },
];

describe("branch-aware pass with an empty GitHub branch listing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithDb.mockReset();
    mockWithMigratorClient.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops nothing when GitHub resolves zero branches", async () => {
    armActiveBranchSchemas();
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.counters["orphan-branch"].dropped).toBe(0);
    expect(result.counters["orphan-branch"].errored).toBe(0);
    // Every schema is preserved by the TTL path instead, exactly as it would be
    // if GitHub had thrown.
    expect(result.counters["ttl-expired"].kept).toBe(BRANCH_SCHEMAS.length);
    // The load-bearing one: `withMigratorClient` is the only way a DROP
    // reaches Postgres.
    expect(mockWithMigratorClient).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  it("reports every schema as kept-active in a dry run", async () => {
    armActiveBranchSchemas();

    const result = await previewSchemaCleanupService.runDryRun(7);

    expect(result.wouldDropOrphanBranch).toEqual([]);
    expect(result.keptActive).toEqual(BRANCH_SCHEMAS.map((s) => s.schema));
    // Not the mass-drop cap doing the work — the cap is inert below its
    // ten-candidate floor, and conflating the two would let this pass for the
    // wrong reason.
    expect(result.withheldByMassDropCap).toEqual([]);
    expect(mockWithMigratorClient).not.toHaveBeenCalled();
  });

  // Positive control: the same fixture with a live listing that omits these
  // branches DOES reclassify and drop them, so the two cases above cannot pass
  // because the scenario never reached the branch-aware pass at all.
  it("still drops branch-carrying schemas when GitHub returns a real listing", async () => {
    armActiveBranchSchemas(["main"]);

    const result = await previewSchemaCleanupService.runDryRun(7);

    expect(result.wouldDropOrphanBranch).toEqual(
      BRANCH_SCHEMAS.map((s) => s.schema)
    );
    expect(result.keptActive).toEqual([]);
  });
});

/**
 * Arms one sweep over {@link BRANCH_SCHEMAS}, all within TTL. `branches`
 * defaults to the empty listing under test.
 */
function armActiveBranchSchemas(branches: string[] = []): void {
  const recentLastSeen = new Date(NOW.getTime() - DAY_MS).toISOString();

  mockListSchemas(BRANCH_SCHEMAS.map((s) => s.schema));
  mockGitHubBranches(branches);
  for (const { branch } of BRANCH_SCHEMAS) {
    mockRegistryRow({ last_seen_at: recentLastSeen, branch });
  }
}
