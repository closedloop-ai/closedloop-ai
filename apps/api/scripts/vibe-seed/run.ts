import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "@repo/api/src/types/result";
import {
  type PrismaClient,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { ensureVibeApiKey, mintVibeApiKey } from "./core/api-key";
import { runBaseSeed } from "./core/base-seed";
import { checkContentRealism } from "./core/content-realism";
import {
  computeCorpusShiftMs,
  readNewestCorpusActivity,
} from "./core/corpus-shift";
import { buildGoldenDesktopStore } from "./core/desktop-store";
import { GOLDEN_IMPORT_STEP, ingestGoldenCorpus } from "./core/golden-import";
import {
  checkNoLocalTrustedOverride,
  ensureSeedIdentity,
  type LocalTrustedSeedIdentity,
} from "./core/local-trusted-identity";
import { countRowsByModel, type ModelRowCounts } from "./core/row-counts";
import { assertSeedIntegrity, checkSeedIntegrity } from "./core/seed-integrity";
import { seedPersonOwners } from "./core/session-owners";
import { checkVibeDatabaseUrl, type VibeSeedRefusal } from "./guards";
import type {
  VibeDesktopAuthMaterial,
  VibeSeedContext,
  VibeSeedStage,
} from "./stage";
import { selectStages } from "./stage-selection";
import { VIBE_SEED_STAGES } from "./stages";

/**
 * ISS-12017: the vibe seed orchestrator. Against a local `control_*` database
 * it resolves the local-trusted identity, runs the `@repo/database` base seed,
 * ingests the golden Desktop corpus through the API's ingest fold, then runs
 * every stage in `stages/index.ts` order, and reports a row count for every
 * Prisma model.
 */

export const IDENTITY_STEP = "identity";
export const DESKTOP_STORE_STEP = "desktop-store";
export const CORPUS_SHIFT_STEP = "corpus-shift";
export const BASE_SEED_STEP = "base-seed";
export const API_KEY_STEP = "api-key";
export const INTEGRITY_STEP = "integrity";

export type VibeSeedOptions = {
  databaseUrl: string;
  /** The golden Desktop store; when null the run builds one into a temp dir. */
  desktopStorePath: string | null;
  desktopAuth: VibeDesktopAuthMaterial | null;
  /** Defaults to the current time. */
  now?: Date;
  /** Plaintext output (0600); null seeds a key only on a full run and exports no plaintext. */
  apiKeyOutPath: string | null;
  /** Run only these stages, in run order. Absent or empty runs every stage. */
  onlyStages?: readonly string[];
  /** Skip the base seed and the golden ingest, for a database that already has them. */
  skipBase: boolean;
  log?: (message: string) => void;
};

export type VibeSeedStepTiming = { name: string; elapsedMs: number };

export type VibeSeedSummary = {
  ok: boolean;
  organizationId: string | null;
  userId: string | null;
  stages: VibeSeedStepTiming[];
  rowCounts: ModelRowCounts;
  error?: string;
};

export type VibeSeedDeps = {
  stages?: readonly VibeSeedStage[];
};

type Preflight = {
  databaseUrl: string;
  stages: readonly VibeSeedStage[];
};

type RunState = {
  options: VibeSeedOptions;
  log: (message: string) => void;
  timings: VibeSeedStepTiming[];
  identity: LocalTrustedSeedIdentity | null;
  prisma: PrismaClient | null;
  builtStoreDir: string | null;
};

/** Raised by a step so the summary can name the step that failed. */
class VibeSeedStepError extends Error {
  readonly step: string;

  constructor(step: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "VibeSeedStepError";
    this.step = step;
  }
}

export async function runVibeSeed(
  options: VibeSeedOptions,
  deps: VibeSeedDeps = {}
): Promise<VibeSeedSummary> {
  const preflight = runPreflight(options, deps.stages ?? VIBE_SEED_STAGES);
  if (!preflight.ok) {
    return {
      ok: false,
      organizationId: null,
      userId: null,
      stages: [],
      rowCounts: {},
      error: `${preflight.error.code}: ${preflight.error.message}`,
    };
  }
  // `withDb` and the seed program read DATABASE_URL from the process, so the
  // run binds it only after the guard accepted the target.
  process.env.DATABASE_URL = preflight.value.databaseUrl;
  const state: RunState = {
    options,
    log: options.log ?? (() => undefined),
    timings: [],
    identity: null,
    prisma: null,
    builtStoreDir: null,
  };
  let error: string | undefined;
  try {
    await runSteps(state, preflight.value);
  } catch (caught) {
    error = describeFailure(caught);
    state.log(`FAILED ${error}`);
  }
  const rowCounts = await readRowCounts(state);
  if (state.builtStoreDir !== null) {
    await rm(state.builtStoreDir, { recursive: true, force: true });
  }
  return {
    ok: error === undefined,
    organizationId: state.identity?.organizationId ?? null,
    userId: state.identity?.userId ?? null,
    stages: state.timings,
    rowCounts,
    ...(error === undefined ? {} : { error }),
  };
}

function runPreflight(
  options: VibeSeedOptions,
  allStages: readonly VibeSeedStage[]
): Result<Preflight, VibeSeedRefusal> {
  const target = checkVibeDatabaseUrl(options.databaseUrl);
  if (!target.ok) {
    return target;
  }
  const overrides = checkNoLocalTrustedOverride(process.env);
  if (!overrides.ok) {
    return overrides;
  }
  const stages = selectStages(allStages, options.onlyStages);
  if (!stages.ok) {
    return stages;
  }
  return Result.ok({
    databaseUrl: target.value.databaseUrl,
    stages: stages.value,
  });
}

async function runSteps(state: RunState, preflight: Preflight): Promise<void> {
  const { identity, prisma } = await step(state, IDENTITY_STEP, async () => ({
    identity: await ensureSeedIdentity(),
    prisma: await withDb(toPrismaClient),
  }));
  state.identity = identity;
  state.prisma = prisma;
  const now = state.options.now ?? new Date();
  const storePath = await resolveDesktopStore(state, now);
  const corpusShiftMs = await step(state, CORPUS_SHIFT_STEP, () =>
    Promise.resolve(
      computeCorpusShiftMs(
        readNewestCorpusActivity(storePath),
        now.toISOString()
      )
    )
  );
  state.log(`corpus shift ${corpusShiftMs}ms (now ${now.toISOString()})`);

  if (!state.options.skipBase) {
    await runBaseAndIngest(state, preflight.databaseUrl, {
      storePath,
      shiftMs: corpusShiftMs,
      now,
    });
  }

  const context: VibeSeedContext = {
    prisma,
    organizationId: identity.organizationId,
    userId: identity.userId,
    desktopStorePath: storePath,
    corpusShiftMs,
    desktopAuth: state.options.desktopAuth,
    now,
    log: state.log,
  };
  for (const stage of preflight.stages) {
    await step(state, stage.name, () => stage.run(context));
  }

  // ISS-12056 (Seed quality): a full run must leave Acme Co named, staffed,
  // free of test-data wording, and with every branch owned; ISS-12135 adds
  // work spread across the team and the weeks. A partial run
  // (`onlyStages`) seeds a slice and is not judged as a whole.
  if (!state.options.onlyStages?.length) {
    await step(state, INTEGRITY_STEP, async () =>
      assertSeedIntegrity([
        ...(await checkSeedIntegrity(prisma, identity.organizationId)),
        ...(await checkContentRealism(prisma, identity.organizationId)),
      ])
    );
  }

  const apiKeyOutPath = state.options.apiKeyOutPath;
  if (apiKeyOutPath === null && !state.options.onlyStages?.length) {
    await step(state, API_KEY_STEP, () =>
      ensureVibeApiKey({ prisma, ...identity })
    );
  } else if (apiKeyOutPath !== null) {
    const written = await step(state, API_KEY_STEP, () =>
      mintVibeApiKey({ ...identity, outPath: apiKeyOutPath })
    );
    state.log(`wrote API key to ${written} (mode 0600); contents are secret`);
  }
}

async function runBaseAndIngest(
  state: RunState,
  databaseUrl: string,
  corpus: { storePath: string; shiftMs: number; now: Date }
): Promise<void> {
  const identity = state.identity;
  if (identity === null) {
    throw new Error("identity must resolve before the base seed");
  }
  await step(state, BASE_SEED_STEP, () =>
    runBaseSeed({ databaseUrl, ...identity, log: state.log })
  );
  await step(state, GOLDEN_IMPORT_STEP, () =>
    ingestGoldenCorpus({
      storePath: corpus.storePath,
      organizationId: identity.organizationId,
      resolveOwner: seedPersonOwners(identity),
      shift: { shiftMs: corpus.shiftMs, nowMs: corpus.now.getTime() },
      log: state.log,
    })
  );
}

async function resolveDesktopStore(
  state: RunState,
  now: Date
): Promise<string> {
  const given = state.options.desktopStorePath;
  if (given !== null) {
    return given;
  }
  const outDir = await mkdtemp(join(tmpdir(), "vibe-seed-store-"));
  state.builtStoreDir = outDir;
  return step(state, DESKTOP_STORE_STEP, () =>
    buildGoldenDesktopStore(outDir, now.toISOString(), state.log)
  );
}

async function step<T>(
  state: RunState,
  name: string,
  run: () => Promise<T>
): Promise<T> {
  state.log(`stage ${name}: start`);
  const startedAt = performance.now();
  try {
    const result = await run();
    const elapsedMs = Math.round(performance.now() - startedAt);
    state.timings.push({ name, elapsedMs });
    state.log(`stage ${name}: done in ${elapsedMs}ms`);
    return result;
  } catch (error) {
    throw new VibeSeedStepError(name, error);
  }
}

async function readRowCounts(state: RunState): Promise<ModelRowCounts> {
  if (state.prisma === null) {
    return {};
  }
  try {
    return await countRowsByModel(state.prisma);
  } catch (error) {
    state.log(`row counts unavailable: ${describeFailure(error)}`);
    return {};
  }
}

/**
 * `withDb` hands its callback the cached `PrismaClient` outside a transaction;
 * the stage contract needs the full client (for `$transaction`), so the run
 * takes it from there instead of opening a second pool.
 */
function toPrismaClient(db: TransactionClient | PrismaClient): PrismaClient {
  if (isFullPrismaClient(db)) {
    return db;
  }
  throw new Error("withDb returned a transaction client outside a transaction");
}

function isFullPrismaClient(
  db: TransactionClient | PrismaClient
): db is PrismaClient {
  return "$transaction" in db;
}

function describeFailure(error: unknown): string {
  if (error instanceof VibeSeedStepError) {
    return `${error.step}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
