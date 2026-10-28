/**
 * ISS-12017: the vibe seed's stage list and its `onlyStages` filter.
 *
 * The integrity cases run against the real ordered list (`VIBE_SEED_STAGES`)
 * plus the golden ingest's models, so a stage added with a typo'd model name or
 * a model already claimed elsewhere fails here. The filter cases drive
 * `runVibeSeed` itself with substitute stages against a real two-session store,
 * with the database and identity writer mocked at their module boundaries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
  ensureSeedIdentity: vi.fn(),
  countRowsByModel: vi.fn(),
  checkSeedIntegrity: vi.fn(),
  checkContentRealism: vi.fn(),
  ensureVibeApiKey: vi.fn(),
  mintVibeApiKey: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return { ...actual, withDb: mocks.withDb };
});
vi.mock("../vibe-seed/core/local-trusted-identity", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../vibe-seed/core/local-trusted-identity")
    >();
  return {
    ...actual,
    ensureSeedIdentity: mocks.ensureSeedIdentity,
  };
});
vi.mock("../vibe-seed/core/row-counts", () => ({
  countRowsByModel: mocks.countRowsByModel,
}));
// The check itself is driven by core/seed-integrity.test.ts; here only its
// wiring into the run is under test.
vi.mock("../vibe-seed/core/seed-integrity", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../vibe-seed/core/seed-integrity")>();
  return { ...actual, checkSeedIntegrity: mocks.checkSeedIntegrity };
});
vi.mock("../vibe-seed/core/content-realism", () => ({
  checkContentRealism: mocks.checkContentRealism,
}));

vi.mock("../vibe-seed/core/api-key", () => ({
  ensureVibeApiKey: mocks.ensureVibeApiKey,
  mintVibeApiKey: mocks.mintVibeApiKey,
}));

import {
  type SeedCoverageEntry,
  SeedCoverageStatus,
} from "@repo/api/src/seed-coverage";
import { Prisma } from "@repo/database";
import { loadWebSeedCoverage } from "@repo/database/scripts/seed/coverage";
import {
  GOLDEN_IMPORT_MODELS,
  GOLDEN_IMPORT_STEP,
} from "../vibe-seed/core/golden-import";
import { SeedIntegrityIssueCode } from "../vibe-seed/core/seed-integrity";
import { VibeSeedRefusalCode } from "../vibe-seed/guards";
import {
  API_KEY_STEP,
  BASE_SEED_STEP,
  CORPUS_SHIFT_STEP,
  IDENTITY_STEP,
  INTEGRITY_STEP,
  runVibeSeed,
} from "../vibe-seed/run";
import type { VibeSeedContext, VibeSeedStage } from "../vibe-seed/stage";
import { selectStages } from "../vibe-seed/stage-selection";
import { VIBE_SEED_STAGES } from "../vibe-seed/stages";
import { NEWER_SESSION, withTwoSessionStore } from "./vibe-seed-store-fixture";

const DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5432/control_wp2_test01";
const ORG_ID = "0192f0a0-0000-7000-8000-0000000000a1";
const USER_ID = "0192f0a0-0000-7000-8000-0000000000b1";
const NOW = new Date("2026-10-05T12:00:00.000Z");
const MODEL_NAMES: ReadonlySet<string> = new Set(
  Object.values(Prisma.ModelName)
);

describe("VIBE_SEED_STAGES integrity", () => {
  it("relabels golden users after GitHub replay and before delivery projections", () => {
    const names = VIBE_SEED_STAGES.map((stage) => stage.name);
    const relabel = names.indexOf("relabel-golden-users");
    expect(relabel).toBeGreaterThan(names.indexOf("github-branch-evidence"));
    expect(relabel).toBeLessThan(names.indexOf("delivery-points"));
  });

  it("gives every stage a unique name, distinct from the run's own steps", () => {
    const names = VIBE_SEED_STAGES.map((stage) => stage.name);
    const reserved = [
      IDENTITY_STEP,
      CORPUS_SHIFT_STEP,
      BASE_SEED_STEP,
      GOLDEN_IMPORT_STEP,
    ];
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => reserved.includes(name))).toStrictEqual([]);
  });

  it("claims only real Prisma models", () => {
    const claimed = [
      ...GOLDEN_IMPORT_MODELS,
      ...VIBE_SEED_STAGES.flatMap((stage) => stage.models),
    ];
    expect(claimed.filter((model) => !MODEL_NAMES.has(model))).toStrictEqual(
      []
    );
  });

  it("never lets two stages, or a stage and the golden ingest, claim one model", () => {
    const owners = new Map<string, string[]>();
    const claim = (model: string, owner: string) =>
      owners.set(model, [...(owners.get(model) ?? []), owner]);
    for (const model of GOLDEN_IMPORT_MODELS) {
      claim(model, GOLDEN_IMPORT_STEP);
    }
    for (const stage of VIBE_SEED_STAGES) {
      for (const model of stage.models) {
        claim(model, stage.name);
      }
    }
    const contested = [...owners.entries()].filter(
      ([, claimants]) => claimants.length > 1
    );
    expect(contested).toStrictEqual([]);
  });

  it("claims only models whose coverage file says that stage seeds them", () => {
    const coverage = loadWebSeedCoverage();
    const mismatched = VIBE_SEED_STAGES.flatMap((stage) =>
      stage.models
        .filter((model) => {
          const entry = validEntry(coverage.get(model));
          return !(
            entry?.status === SeedCoverageStatus.Seeded &&
            entry.stage === stage.name
          );
        })
        .map((model) => `${stage.name}: ${model}`)
    );
    expect(mismatched).toStrictEqual([]);
  });
});

function validEntry(
  record:
    | { valid: true; entry: SeedCoverageEntry }
    | { valid: false }
    | undefined
): SeedCoverageEntry | undefined {
  return record?.valid ? record.entry : undefined;
}

describe("selectStages", () => {
  const stages = fakeStages();

  it("keeps every stage when no filter is given", () => {
    expect(selectStages(stages, undefined)).toStrictEqual({
      ok: true,
      value: stages,
    });
    expect(selectStages(stages, [])).toStrictEqual({ ok: true, value: stages });
  });

  it("keeps run order, not the order the filter names them in", () => {
    const selected = selectStages(stages, ["third", "first"]);
    expect(
      selected.ok ? selected.value.map((stage) => stage.name) : []
    ).toStrictEqual(["first", "third"]);
  });

  it("refuses an unknown stage name instead of running nothing", () => {
    const selected = selectStages(stages, ["first", "frist"]);
    expect(selected.ok ? null : selected.error.code).toBe(
      VibeSeedRefusalCode.UnknownStage
    );
  });
});

describe("runVibeSeed with onlyStages", () => {
  let previousDatabaseUrl: string | undefined;

  beforeEach(() => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    const prisma = { $transaction: vi.fn() };
    mocks.withDb.mockImplementation((cb: (db: typeof prisma) => unknown) =>
      cb(prisma)
    );
    mocks.ensureSeedIdentity.mockResolvedValue({
      organizationId: ORG_ID,
      userId: USER_ID,
    });
    mocks.countRowsByModel.mockResolvedValue({ ProjectTeam: 3 });
    mocks.checkSeedIntegrity.mockResolvedValue([]);
    mocks.checkContentRealism.mockResolvedValue([]);
  });

  afterEach(() => {
    if (previousDatabaseUrl === undefined) {
      Reflect.deleteProperty(process.env, "DATABASE_URL");
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  it("runs only the named stage, on a database that already has the base, with the store's shift", async () => {
    const stages = fakeStages();
    const summary = await withTwoSessionStore((path) =>
      runVibeSeed(
        {
          databaseUrl: DATABASE_URL,
          desktopStorePath: path,
          desktopAuth: null,
          now: NOW,
          apiKeyOutPath: null,
          onlyStages: ["second"],
          skipBase: true,
        },
        { stages }
      )
    );

    expect(summary.ok).toBe(true);
    expect(summary.stages.map((step) => step.name)).toStrictEqual([
      IDENTITY_STEP,
      CORPUS_SHIFT_STEP,
      "second",
    ]);
    expect(mocks.ensureVibeApiKey).not.toHaveBeenCalled();
    expect(mocks.mintVibeApiKey).not.toHaveBeenCalled();
    expect(stages[0]?.run).not.toHaveBeenCalled();
    expect(stages[2]?.run).not.toHaveBeenCalled();
    expect(stages[1]?.run).toHaveBeenCalledTimes(1);
    const context: VibeSeedContext | undefined = vi.mocked(
      stages[1]?.run ?? vi.fn()
    ).mock.calls[0]?.[0];
    expect(context?.organizationId).toBe(ORG_ID);
    expect(context?.userId).toBe(USER_ID);
    expect(context?.now).toBe(NOW);
    expect(context?.corpusShiftMs).toBe(
      NOW.getTime() - Date.parse(NEWER_SESSION.lastActivityAt)
    );
    expect(summary).toMatchObject({
      organizationId: ORG_ID,
      userId: USER_ID,
      rowCounts: { ProjectTeam: 3 },
    });
    expect(process.env.DATABASE_URL).toBe(DATABASE_URL);
  });

  it("seeds the API-key view after integrity on a successful full run without plaintext output", async () => {
    const summary = await withTwoSessionStore((path) =>
      runVibeSeed(
        {
          databaseUrl: DATABASE_URL,
          desktopStorePath: path,
          desktopAuth: null,
          now: NOW,
          apiKeyOutPath: null,
          skipBase: true,
        },
        { stages: fakeStages() }
      )
    );
    expect(summary.ok).toBe(true);
    expect(summary.stages.map((step) => step.name).slice(-2)).toEqual([
      INTEGRITY_STEP,
      API_KEY_STEP,
    ]);
    expect(mocks.ensureVibeApiKey).toHaveBeenCalledExactlyOnceWith({
      prisma: expect.objectContaining({ $transaction: expect.any(Function) }),
      organizationId: ORG_ID,
      userId: USER_ID,
    });
    expect(mocks.mintVibeApiKey).not.toHaveBeenCalled();
  });

  it("judges a full run with the integrity check, and fails it on a gap (ISS-12056)", async () => {
    mocks.checkSeedIntegrity.mockResolvedValue([
      {
        code: SeedIntegrityIssueCode.BranchWithoutOwner,
        count: 2,
        message: "branch(es) with no owner: a, b",
      },
    ]);
    const summary = await withTwoSessionStore((path) =>
      runVibeSeed(
        {
          databaseUrl: DATABASE_URL,
          desktopStorePath: path,
          desktopAuth: null,
          now: NOW,
          apiKeyOutPath: null,
          skipBase: true,
        },
        { stages: fakeStages() }
      )
    );

    expect(mocks.checkSeedIntegrity).toHaveBeenCalledWith(
      expect.objectContaining({ $transaction: expect.any(Function) }),
      ORG_ID
    );
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain(
      `${INTEGRITY_STEP}: seed integrity check failed`
    );
    expect(summary.error).toContain(SeedIntegrityIssueCode.BranchWithoutOwner);
  });

  it("fails a full run on generated-looking content (ISS-12135)", async () => {
    mocks.checkContentRealism.mockResolvedValue([
      {
        code: SeedIntegrityIssueCode.ContentCreatedAtOnce,
        count: 99,
        message: "99 document(s) were all created within 0.0 day(s)",
      },
    ]);
    const summary = await withTwoSessionStore((path) =>
      runVibeSeed(
        {
          databaseUrl: DATABASE_URL,
          desktopStorePath: path,
          desktopAuth: null,
          now: NOW,
          apiKeyOutPath: null,
          skipBase: true,
        },
        { stages: fakeStages() }
      )
    );

    expect(mocks.checkContentRealism).toHaveBeenCalledWith(
      expect.objectContaining({ $transaction: expect.any(Function) }),
      ORG_ID
    );
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain(
      SeedIntegrityIssueCode.ContentCreatedAtOnce
    );
  });

  it("does not judge a partial run as a whole", async () => {
    await withTwoSessionStore((path) =>
      runVibeSeed(
        {
          databaseUrl: DATABASE_URL,
          desktopStorePath: path,
          desktopAuth: null,
          now: NOW,
          apiKeyOutPath: null,
          onlyStages: ["second"],
          skipBase: true,
        },
        { stages: fakeStages() }
      )
    );

    expect(mocks.checkSeedIntegrity).not.toHaveBeenCalled();
    expect(mocks.checkContentRealism).not.toHaveBeenCalled();
  });

  it("names the failing stage, stops there, and still reports row counts", async () => {
    const stages = fakeStages();
    vi.mocked(stages[1]?.run ?? vi.fn()).mockRejectedValue(
      new Error("unique conflict on project_teams")
    );
    const summary = await withTwoSessionStore((path) =>
      runVibeSeed(
        {
          databaseUrl: DATABASE_URL,
          desktopStorePath: path,
          desktopAuth: null,
          now: NOW,
          apiKeyOutPath: null,
          skipBase: true,
        },
        { stages }
      )
    );

    expect(summary.ok).toBe(false);
    expect(summary.error).toBe("second: unique conflict on project_teams");
    expect(stages[2]?.run).not.toHaveBeenCalled();
    expect(summary.rowCounts).toStrictEqual({ ProjectTeam: 3 });
  });
});

function fakeStages(): VibeSeedStage[] {
  return ["first", "second", "third"].map((name) => ({
    name,
    models: [],
    run: vi.fn<(context: VibeSeedContext) => Promise<void>>(() =>
      Promise.resolve()
    ),
  }));
}
