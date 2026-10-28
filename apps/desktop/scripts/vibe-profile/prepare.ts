import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { VIBE_SEED_SIGNED_IN_LOGIN } from "@repo/api/src/vibe-seed-corpus";
import { vibeCorpusTimeMapPath } from "@repo/api/src/vibe-seed-corpus-time";
import { openSqliteAgentDatabase } from "../../src/main/database/sqlite.js";
import {
  generateVibeAuthMaterial,
  writeVibeAuthMaterial,
} from "./auth-material";
import {
  buildShiftedGoldenStore,
  type GoldenStoreBuild,
} from "./build-golden-store";
import { keepSessionsOf } from "./keep-sessions";
import {
  assertProfileDirAllowed,
  gitProfileDirPolicy,
  VIBE_PROFILE_FILE,
  vibeProfileHarnessHomes,
  vibeProfilePath,
} from "./profile-layout";
import { readDesktopRowCounts } from "./row-counts";
import { seedGatewayActivity } from "./seed-gateway-activity";
import { seedLocalActivity } from "./seed-local-activity";
import { seedPacks } from "./seed-packs";
import { seedPlans } from "./seed-plans";
import { seedRepositories } from "./seed-repositories";
import { seedClaudeTelemetry } from "./seed-telemetry";
import {
  VIBE_GOLDEN_CORPUS_DIR,
  writeSeededTranscripts,
} from "./write-session-transcripts";

export type PreparedProfile = {
  readonly ok: true;
  readonly profileDir: string;
  readonly storePath: string;
  /** The whole team's store, for the web seed. */
  readonly corpusStorePath: string;
  readonly authMaterialPath: string;
  readonly newestCorpusInstant: string;
  readonly corpusShiftMs: number;
  readonly rowCounts: Record<string, number>;
};

/**
 * Builds a throwaway Desktop profile: the shifted golden-corpus store, every
 * model the corpus leaves empty that a screen reads, and fresh auth material
 * for the web seed's `desktop-auth` stage. The collector homes are pinned
 * inside the profile for the whole run, so nothing here reads the operator's
 * real agent history.
 */
export async function prepareVibeProfile(
  outDir: string,
  nowIso: string,
  log: (message: string) => void
): Promise<PreparedProfile> {
  const profileDir = assertProfileDirAllowed(outDir, gitProfileDirPolicy);
  mkdirSync(profileDir, { recursive: true });
  if (readdirSync(profileDir).length > 0) {
    throw new Error(
      `${profileDir} is not empty; prepare writes a fresh profile`
    );
  }
  const storePath = vibeProfilePath(profileDir, VIBE_PROFILE_FILE.Store);
  const build = await buildSeededCorpusStore(
    storePath,
    profileDir,
    nowIso,
    log
  );
  // ISS-12135: the web seed replays the whole team's corpus from a copy; this
  // Desktop keeps only the signed-in person's sessions, so its local store
  // matches what the seed attributes to them (it does not sync: a vibe Desktop
  // starts at data sync level Off).
  const corpusStorePath = vibeProfilePath(
    profileDir,
    VIBE_PROFILE_FILE.CorpusStore
  );
  copyStoreFiles(storePath, corpusStorePath);
  copyFileSync(
    vibeCorpusTimeMapPath(storePath),
    vibeCorpusTimeMapPath(corpusStorePath)
  );
  log(
    `kept the signed-in person's sessions: ${JSON.stringify(await keepSessionsOf(storePath, VIBE_SEED_SIGNED_IN_LOGIN, log))}`
  );
  log(
    `session transcripts: ${JSON.stringify(await writeSeededTranscripts(storePath, VIBE_GOLDEN_CORPUS_DIR, log))}`
  );
  const now = new Date(nowIso);
  log(
    `gateway activity: ${JSON.stringify(seedGatewayActivity(profileDir, now))}`
  );

  const { materialPath } = writeVibeAuthMaterial(
    profileDir,
    generateVibeAuthMaterial()
  );
  writeFileSync(
    vibeProfilePath(profileDir, VIBE_PROFILE_FILE.Manifest),
    `${JSON.stringify(
      {
        now: nowIso,
        newestCorpusInstant: build.newestCorpusInstant,
        corpusShiftMs: build.corpusShiftMs,
      },
      null,
      2
    )}\n`
  );
  return {
    ok: true,
    profileDir,
    storePath,
    corpusStorePath,
    authMaterialPath: materialPath,
    newestCorpusInstant: build.newestCorpusInstant,
    corpusShiftMs: build.corpusShiftMs,
    rowCounts: await readDesktopRowCounts(storePath),
  };
}

export type BuiltCorpusStore = {
  readonly ok: true;
  readonly storePath: string;
  readonly newestCorpusInstant: string;
  readonly corpusShiftMs: number;
  readonly sessionCount: number;
};

/**
 * ISS-12135: the vibe corpus store alone, for the web seed when no Desktop
 * profile hands it one (a branch preview's seed). It is the store `prepare`
 * builds, so the web seed and a Desktop that syncs a prepared store write the
 * same rows.
 */
export async function buildVibeCorpusStore(
  outDir: string,
  nowIso: string,
  log: (message: string) => void
): Promise<BuiltCorpusStore> {
  mkdirSync(outDir, { recursive: true });
  const storePath = vibeProfilePath(outDir, VIBE_PROFILE_FILE.Store);
  const build = await buildSeededCorpusStore(storePath, outDir, nowIso, log);
  return { ok: true, storePath, ...build };
}

/**
 * The shifted, rewritten golden store plus every model the corpus leaves empty
 * that a screen reads, with the collector homes pinned under `homesDir` so
 * nothing reads the operator's real agent history.
 */
async function buildSeededCorpusStore(
  storePath: string,
  homesDir: string,
  nowIso: string,
  log: (message: string) => void
): Promise<GoldenStoreBuild> {
  const homes = vibeProfileHarnessHomes(homesDir);
  for (const [key, dir] of Object.entries(homes)) {
    mkdirSync(dir, { recursive: true });
    process.env[key] = dir;
  }
  const build = await buildShiftedGoldenStore(storePath, nowIso, log);
  log(`golden store: ${build.sessionCount} sessions`);
  const now = new Date(nowIso);
  const db = await openSqliteAgentDatabase({
    dataDir: storePath,
    detectBillingMode: () => "metered_api",
    log,
  });
  try {
    await db.whenBootMaintenanceSettled();
    log(
      `repositories: ${JSON.stringify(await seedRepositories(db, homesDir, now))}`
    );
    const harnessHomes = {
      claudeHome: homes.CLAUDE_HOME,
      codexHome: homes.CODEX_HOME,
    };
    log(`telemetry: ${JSON.stringify(await seedClaudeTelemetry(db))}`);
    log(`packs: ${JSON.stringify(await seedPacks(db, harnessHomes, now))}`);
    log(`plans: ${JSON.stringify(await seedPlans(db, homes.CLAUDE_HOME))}`);
    log(
      `activity: ${JSON.stringify(await seedLocalActivity(db, harnessHomes, now))}`
    );
  } finally {
    await db.close();
  }
  return build;
}

/** A closed SQLite store and any write-ahead log beside it. */
function copyStoreFiles(from: string, to: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${from}${suffix}`)) {
      copyFileSync(`${from}${suffix}`, `${to}${suffix}`);
    }
  }
}
