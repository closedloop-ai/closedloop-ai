import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DATA_SYNC_LEVELS,
  DataSyncLevel,
  RECOMMENDED_DATA_SYNC_LEVEL,
} from "@repo/api/src/types/data-sync-level";
import { afterEach, test } from "vitest";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import type { SyncObservabilityTier } from "../src/shared/contracts.js";
import {
  coercePersistedDataSyncLevel,
  dataSyncLevelToBooleans,
  legacyFlagsToDataSyncLevel,
  normalizeDataSyncLevel,
  syncObservabilityTierToDataSyncLevel,
} from "../src/shared/data-sync-level.js";
import { SYNC_OBSERVABILITY_TIERS } from "../src/shared/sync-observability-tier.js";

const tempDirs: string[] = [];
const INVALID_LEVEL_RE = /Invalid data sync level/;
const UNHANDLED_LEVEL_RE = /Unhandled data sync level/;
const UNHANDLED_TIER_RE = /Unhandled sync observability tier/;
// Values only a NEWER build knows. Typed `string` so widening to the closed
// union below is a single cast, and so the literal can never be mistaken for a
// member of the contract.
const UNMAPPED_PERSISTED_LEVEL: string = "quantum";
const UNMAPPED_LEGACY_TIER: string = "verbose";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore(seed: Record<string, unknown> = {}): SettingsStore {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-sync-level-"));
  tempDirs.push(tmpDir);
  // A store name distinct from other suites' "test-settings": electron-store
  // caches by name within a process, so a shared name races under the parallel
  // node:test concurrency that `run-node-tests.mjs` uses in CI.
  const storeName = "data-sync-level-test-settings";
  if (Object.keys(seed).length > 0) {
    fs.writeFileSync(
      path.join(tmpDir, `${storeName}.json`),
      JSON.stringify(seed)
    );
  }
  return new SettingsStore({ cwd: tmpDir, name: storeName });
}

// --- FEA-3907: level → boolean mapping (SSOT) ---

test("dataSyncLevelToBooleans is exhaustive and correct per level", () => {
  assert.deepEqual(dataSyncLevelToBooleans(DataSyncLevel.Off), {
    cloudConnectionEnabled: false,
    cloudCommandsPaused: true,
    transcriptSyncEnabled: false,
    syncObservabilityTier: "local",
  });
  assert.deepEqual(dataSyncLevelToBooleans(DataSyncLevel.Metadata), {
    cloudConnectionEnabled: true,
    cloudCommandsPaused: false,
    transcriptSyncEnabled: false,
    syncObservabilityTier: "metadata",
  });
  assert.deepEqual(dataSyncLevelToBooleans(DataSyncLevel.Redacted), {
    cloudConnectionEnabled: true,
    cloudCommandsPaused: false,
    transcriptSyncEnabled: false,
    syncObservabilityTier: "metadata",
  });
  assert.deepEqual(dataSyncLevelToBooleans(DataSyncLevel.Full), {
    cloudConnectionEnabled: true,
    cloudCommandsPaused: false,
    transcriptSyncEnabled: true,
    syncObservabilityTier: "full",
  });
});

test("every level maps to a defined boolean set (no unmapped level)", () => {
  for (const level of DATA_SYNC_LEVELS) {
    const booleans = dataSyncLevelToBooleans(level);
    assert.equal(typeof booleans.cloudConnectionEnabled, "boolean");
    assert.equal(typeof booleans.cloudCommandsPaused, "boolean");
    assert.equal(typeof booleans.transcriptSyncEnabled, "boolean");
    assert.ok(
      ["full", "metadata", "local"].includes(booleans.syncObservabilityTier)
    );
  }
});

test("only Full transcripts turns the transcript archive lane on", () => {
  const transcriptOnLevels = DATA_SYNC_LEVELS.filter(
    (level) => dataSyncLevelToBooleans(level).transcriptSyncEnabled
  );
  assert.deepEqual(transcriptOnLevels, [DataSyncLevel.Full]);
});

test("only Off disables the cloud connection and pauses commands", () => {
  const connectionOffLevels = DATA_SYNC_LEVELS.filter(
    (level) => !dataSyncLevelToBooleans(level).cloudConnectionEnabled
  );
  assert.deepEqual(connectionOffLevels, [DataSyncLevel.Off]);
  assert.equal(
    dataSyncLevelToBooleans(DataSyncLevel.Off).cloudCommandsPaused,
    true
  );
});

// --- FEA-3907: backward-compat migration (never escalates exposure) ---

test("migration: all-off legacy flags map to Off", () => {
  assert.equal(
    legacyFlagsToDataSyncLevel({
      cloudConnectionEnabled: false,
      transcriptSyncEnabled: false,
      syncObservabilityTier: null,
    }),
    DataSyncLevel.Off
  );
});

test("migration: connection off wins even if transcript sync was on", () => {
  // Contradictory legacy state (connection off but transcript on) must not
  // escalate to Full — nothing was actually leaving the device.
  assert.equal(
    legacyFlagsToDataSyncLevel({
      cloudConnectionEnabled: false,
      transcriptSyncEnabled: true,
      syncObservabilityTier: "full",
    }),
    DataSyncLevel.Off
  );
});

test("migration: transcript sync on (with connection) maps to Full", () => {
  assert.equal(
    legacyFlagsToDataSyncLevel({
      cloudConnectionEnabled: true,
      transcriptSyncEnabled: true,
      syncObservabilityTier: "full",
    }),
    DataSyncLevel.Full
  );
});

test("migration: connection on, transcript off, no tier maps to the metadata floor (ambiguous → less permissive)", () => {
  assert.equal(
    legacyFlagsToDataSyncLevel({
      cloudConnectionEnabled: true,
      transcriptSyncEnabled: false,
      syncObservabilityTier: null,
    }),
    DataSyncLevel.Metadata
  );
});

test("migration: connection on but tier pinned to local reconciles to Off (nothing was syncing)", () => {
  assert.equal(
    legacyFlagsToDataSyncLevel({
      cloudConnectionEnabled: true,
      transcriptSyncEnabled: false,
      syncObservabilityTier: "local",
    }),
    DataSyncLevel.Off
  );
});

test("migration: tier local wins over a stale transcriptSyncEnabled (never escalates to Full)", () => {
  // A `local` tier blocked ALL sync; a leftover transcriptSyncEnabled=true must
  // NOT escalate to Full — nothing was actually leaving the device.
  assert.equal(
    legacyFlagsToDataSyncLevel({
      cloudConnectionEnabled: true,
      transcriptSyncEnabled: true,
      syncObservabilityTier: "local",
    }),
    DataSyncLevel.Off
  );
});

test("migration: full tier without transcript archiving maps to Redacted, not Full (no elevation of the transcript lane)", () => {
  const level = legacyFlagsToDataSyncLevel({
    cloudConnectionEnabled: true,
    transcriptSyncEnabled: false,
    syncObservabilityTier: "full",
  });
  assert.equal(level, DataSyncLevel.Redacted);
  // And critically: the derived level must not turn transcript sync on.
  assert.equal(dataSyncLevelToBooleans(level).transcriptSyncEnabled, false);
});

test("migration never escalates: derived transcript lane is never on unless it was on before", () => {
  const combos = [
    { cloudConnectionEnabled: true, transcriptSyncEnabled: false },
    { cloudConnectionEnabled: false, transcriptSyncEnabled: false },
  ] as const;
  const tiers = ["full", "metadata", "local", null] as const;
  for (const combo of combos) {
    for (const tier of tiers) {
      const level = legacyFlagsToDataSyncLevel({
        ...combo,
        syncObservabilityTier: tier,
      });
      assert.equal(
        dataSyncLevelToBooleans(level).transcriptSyncEnabled,
        false,
        `combo ${JSON.stringify({ ...combo, tier })} must not enable transcript sync`
      );
    }
  }
});

// --- FEA-4103: legacy tier → canonical level inverse mapping (SSOT) ---

test("syncObservabilityTierToDataSyncLevel maps each tier to its canonical level", () => {
  assert.equal(
    syncObservabilityTierToDataSyncLevel("local"),
    DataSyncLevel.Off
  );
  assert.equal(
    syncObservabilityTierToDataSyncLevel("metadata"),
    DataSyncLevel.Metadata
  );
  assert.equal(
    syncObservabilityTierToDataSyncLevel("full"),
    DataSyncLevel.Full
  );
});

test("syncObservabilityTierToDataSyncLevel is the exact inverse of the tier column of dataSyncLevelToBooleans", () => {
  // Round-trip every tier a legacy setter could carry: tier → level → derived
  // tier must return the original tier, so the compat shim can never persist a
  // level whose derived tier disagrees with what the caller consented to.
  for (const tier of ["local", "metadata", "full"] as const) {
    const level = syncObservabilityTierToDataSyncLevel(tier);
    assert.equal(
      dataSyncLevelToBooleans(level).syncObservabilityTier,
      tier,
      `${tier} must round-trip through its canonical level`
    );
  }
});

test("syncObservabilityTierToDataSyncLevel never widens: metadata maps to Metadata, not Redacted/Full", () => {
  const level = syncObservabilityTierToDataSyncLevel("metadata");
  assert.notEqual(level, DataSyncLevel.Redacted);
  assert.notEqual(level, DataSyncLevel.Full);
  assert.equal(
    dataSyncLevelToBooleans(level).transcriptSyncEnabled,
    false,
    "a metadata-tier consent must never turn the transcript lane on"
  );
});

// FEA-4055: the per-level presentational copy (titles, data-lines, caveats)
// lives in the shared `@repo/app/shared/lib/data-sync-copy` module so onboarding
// and Settings render from ONE source. Its egress-honesty invariants — "no
// synced session-CONTENT line while `transcriptSyncEnabled` is false", and
// "Redacted advertises metadata-only egress until the lane ships" — pin that
// copy against this module's `dataSyncLevelToBooleans` and live in the RENDERER
// suite (`src/renderer/components/settings/__tests__/data-sync-egress-honesty.test.ts`),
// because a `node:test` runner cannot import the TSX-adjacent copy module.

// --- FEA-3907: server-side level validation ---

test("normalizeDataSyncLevel accepts each of the four literals", () => {
  for (const level of DATA_SYNC_LEVELS) {
    assert.equal(normalizeDataSyncLevel(level), level);
  }
});

test("normalizeDataSyncLevel rejects an out-of-contract string", () => {
  assert.throws(() => normalizeDataSyncLevel("everything"), {
    message: INVALID_LEVEL_RE,
  });
});

test("normalizeDataSyncLevel rejects a non-string payload", () => {
  assert.throws(() => normalizeDataSyncLevel(3), { message: INVALID_LEVEL_RE });
  assert.throws(() => normalizeDataSyncLevel(null), {
    message: INVALID_LEVEL_RE,
  });
});

// --- FEA-3907: settings-store SSOT round-trip + migration ---

test("setDataSyncLevel persists the level AND derives the connectivity/sync flags", () => {
  const store = makeStore();
  store.setDataSyncLevel(DataSyncLevel.Full);
  assert.equal(store.getDataSyncLevel(), DataSyncLevel.Full);
  assert.equal(store.getCloudConnectionEnabled(), true);
  assert.equal(store.getCloudCommandsPaused(), false);
  assert.equal(store.getTranscriptSyncEnabled(), true);
  assert.equal(store.getSyncObservabilityTier(), "full");

  store.setDataSyncLevel(DataSyncLevel.Off);
  assert.equal(store.getDataSyncLevel(), DataSyncLevel.Off);
  assert.equal(store.getCloudConnectionEnabled(), false);
  assert.equal(store.getCloudCommandsPaused(), true);
  assert.equal(store.getTranscriptSyncEnabled(), false);
  assert.equal(store.getSyncObservabilityTier(), "local");
});

test("a fresh install lands on the recommended level WITHOUT manufacturing sync consent", () => {
  const store = makeStore();
  // ISS-10554 (operator ruling: "we default to full sync") replaced this test's
  // first expectation: the first-launch seed now persists the recommended level
  // and the connectivity flags it derives, so reconciliation agrees with it
  // instead of pulling a fresh profile back to the metadata floor.
  //
  // The SECOND expectation is the one that never moved, and it is why the level
  // change is not an egress change: the PRD-532 §7 consent tier stays null
  // (not-consented), so nothing leaves the device until the user answers.
  assert.equal(RECOMMENDED_DATA_SYNC_LEVEL, DataSyncLevel.Full);
  assert.equal(store.getDataSyncLevel(), RECOMMENDED_DATA_SYNC_LEVEL);
  assert.equal(store.getSyncObservabilityTier(), null);
});

test("upgrade migration: an install with transcript sync + connection on lands on Full", () => {
  const store = makeStore({
    cloudConnectionEnabled: true,
    transcriptSyncEnabled: true,
  });
  assert.equal(store.getDataSyncLevel(), DataSyncLevel.Full);
});

test("upgrade migration: an all-off install lands on Off without escalation", () => {
  const store = makeStore({ cloudConnectionEnabled: false });
  assert.equal(store.getDataSyncLevel(), DataSyncLevel.Off);
  // The derived flags agree with the level and nothing was escalated.
  assert.equal(store.getCloudConnectionEnabled(), false);
  assert.equal(store.getTranscriptSyncEnabled(), false);
});

test("upgrade migration is a one-time backfill: an explicit persisted level is not overwritten", () => {
  const store = makeStore({
    dataSyncLevel: DataSyncLevel.Off,
    // Flags consistent with the persisted Off level (connection off): the
    // migration must not re-derive/overwrite an already-persisted explicit level.
    cloudConnectionEnabled: false,
    transcriptSyncEnabled: false,
  });
  assert.equal(store.getDataSyncLevel(), DataSyncLevel.Off);
});

test("upgrade migration preserves an existing full sync-consent tier (never downgrades it)", () => {
  // A user who consented to `full` session-detail sync but had the separate
  // transcript-archive lane off. The migration must reconcile the level without
  // clobbering their `full` tier down to the level's derived `metadata`.
  const store = makeStore({
    cloudConnectionEnabled: true,
    transcriptSyncEnabled: false,
    syncObservabilityTier: "full",
  });
  assert.equal(store.getDataSyncLevel(), DataSyncLevel.Redacted);
  assert.equal(
    store.getSyncObservabilityTier(),
    "full",
    "the separately-consented full tier must survive the migration"
  );
});

test("upgrade migration preserves an explicit pause (never silently un-pauses remote commands)", () => {
  // A paused-but-connected install: connection on, but the user explicitly
  // paused incoming commands. The reconciled level (Metadata) derives
  // cloudCommandsPaused=false, but the migration must NOT overwrite the user's
  // explicit pause — mirroring how the sync-observability tier is left untouched.
  const store = makeStore({
    cloudConnectionEnabled: true,
    transcriptSyncEnabled: false,
    cloudCommandsPaused: true,
  });
  assert.equal(store.getDataSyncLevel(), DataSyncLevel.Metadata);
  assert.equal(
    store.getCloudCommandsPaused(),
    true,
    "an explicit pre-migration pause must survive the backfill"
  );
});

test("upgrade migration still backfills cloudCommandsPaused when the user never set it", () => {
  // Off level derives cloudCommandsPaused=true; with no explicit prior pause the
  // migration should backfill it so a disconnected install stays paused.
  const store = makeStore({ cloudConnectionEnabled: false });
  assert.equal(store.getDataSyncLevel(), DataSyncLevel.Off);
  assert.equal(store.getCloudCommandsPaused(), true);
});

test("getDataSyncLevel reconciles a stale persisted level against live flags (Relay/Gateway toggle drift)", () => {
  // Persist Full via the SSOT setter, then flip cloud connection off out-of-band
  // (as the Relay/Gateway "Cloud Connection" toggle does). The Data & Sync tab
  // must reflect the live disconnected state, not the stale persisted Full.
  const store = makeStore();
  store.setDataSyncLevel(DataSyncLevel.Full);
  assert.equal(store.getDataSyncLevel(), DataSyncLevel.Full);
  store.setCloudConnectionEnabled(false);
  assert.equal(
    store.getDataSyncLevel(),
    DataSyncLevel.Off,
    "a live disconnect must reconcile the displayed level to Off"
  );
});

test("getDataSyncLevel returns the persisted level when live flags still agree", () => {
  const store = makeStore();
  store.setDataSyncLevel(DataSyncLevel.Metadata);
  // No out-of-band change: derived booleans still match live flags.
  assert.equal(store.getDataSyncLevel(), DataSyncLevel.Metadata);
});

// --- FEA-3907: unknown persisted level (rollback from a newer build) ---

test("coercePersistedDataSyncLevel returns a known level unchanged", () => {
  for (const level of DATA_SYNC_LEVELS) {
    assert.equal(
      coercePersistedDataSyncLevel(level, {
        cloudConnectionEnabled: true,
        transcriptSyncEnabled: false,
        syncObservabilityTier: "metadata",
      }),
      level
    );
  }
});

test("coercePersistedDataSyncLevel falls back to the non-escalating legacy derivation for an unknown value", () => {
  // A value only a NEWER Desktop build knows (post-rollback), plus a non-string.
  const offFlags = {
    cloudConnectionEnabled: false,
    transcriptSyncEnabled: false,
    syncObservabilityTier: null,
  };
  assert.equal(
    coercePersistedDataSyncLevel("ultra", offFlags),
    DataSyncLevel.Off
  );
  assert.equal(coercePersistedDataSyncLevel(42, offFlags), DataSyncLevel.Off);
  // With connection on / metadata tier the safe floor is Metadata, never a throw.
  assert.equal(
    coercePersistedDataSyncLevel(
      { some: "object" },
      {
        cloudConnectionEnabled: true,
        transcriptSyncEnabled: false,
        syncObservabilityTier: "metadata",
      }
    ),
    DataSyncLevel.Metadata
  );
});

test("getDataSyncLevel does not throw on an out-of-contract persisted level from a downgrade", () => {
  // A newer build persisted a level this build has no boolean mapping for. The
  // one-time migration skips it (present + non-null), so getDataSyncLevel must
  // coerce it rather than feed it into the exhaustiveness guard and throw.
  const store = makeStore({
    dataSyncLevel: "ultra",
    cloudConnectionEnabled: true,
    transcriptSyncEnabled: false,
    syncObservabilityTier: "metadata",
  });
  assert.doesNotThrow(() => store.getDataSyncLevel());
  assert.equal(store.getDataSyncLevel(), DataSyncLevel.Metadata);
});

// --- FEA-3907: atomic SSOT write (no torn Full→Off partial state) ---

test("setDataSyncLevel persists level + flags as one atomic write (survives a fresh reload)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-sync-atomic-"));
  tempDirs.push(tmpDir);
  const storeName = "data-sync-atomic-test-settings";
  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  store.setDataSyncLevel(DataSyncLevel.Full);
  store.setDataSyncLevel(DataSyncLevel.Off);

  // Read the persisted file directly: every derived key must have landed with the
  // Off level in the SAME write — no Full-era exposure flag can be left behind.
  const persisted = JSON.parse(
    fs.readFileSync(path.join(tmpDir, `${storeName}.json`), "utf8")
  ) as Record<string, unknown>;
  assert.equal(persisted.dataSyncLevel, DataSyncLevel.Off);
  assert.equal(persisted.cloudConnectionEnabled, false);
  assert.equal(persisted.cloudCommandsPaused, true);
  assert.equal(persisted.transcriptSyncEnabled, false);
  assert.equal(persisted.syncObservabilityTier, "local");

  // A fresh store over the same file (a reboot) sees the fully-consistent Off.
  const reloaded = new SettingsStore({ cwd: tmpDir, name: storeName });
  assert.equal(reloaded.getDataSyncLevel(), DataSyncLevel.Off);
  assert.equal(reloaded.getCloudConnectionEnabled(), false);
  assert.equal(reloaded.getTranscriptSyncEnabled(), false);
});

// Legacy consent migration regressions: settings-unset-sync-consent.test.ts.

// --- Exhaustiveness guards at the untrusted boundaries ---

test("dataSyncLevelToBooleans refuses an unmapped level instead of deriving some other level's egress", () => {
  // The trust boundary here is the settings FILE, not the type: rolling back
  // from a newer Desktop build leaves a `dataSyncLevel` string this build has no
  // case for, and the upgrade migration skips a present-but-newer value. The
  // guard must throw loudly — a `default` that returned any real mapping would
  // hand a user a different level's connectivity/transcript flags silently.
  assert.throws(
    () => dataSyncLevelToBooleans(UNMAPPED_PERSISTED_LEVEL as DataSyncLevel),
    { message: UNHANDLED_LEVEL_RE }
  );

  // And the production pairing that keeps it from ever firing on a real read:
  // the persisted value is coerced FIRST, to the non-escalating legacy
  // derivation, so the settings read path degrades instead of throwing.
  const coerced = coercePersistedDataSyncLevel(UNMAPPED_PERSISTED_LEVEL, {
    cloudConnectionEnabled: false,
    transcriptSyncEnabled: false,
    syncObservabilityTier: null,
  });
  assert.equal(coerced, DataSyncLevel.Off);
  assert.doesNotThrow(() => dataSyncLevelToBooleans(coerced));
});

test("syncObservabilityTierToDataSyncLevel refuses an unknown legacy tier instead of guessing a level", () => {
  // Its caller is the legacy `desktop:set-sync-observability-tier` IPC, whose
  // payload is not constrained by the type at runtime. Guessing a level for an
  // unknown tier is precisely how this shim would silently widen exposure, so it
  // throws rather than defaulting.
  assert.throws(
    () =>
      syncObservabilityTierToDataSyncLevel(
        UNMAPPED_LEGACY_TIER as SyncObservabilityTier
      ),
    { message: UNHANDLED_TIER_RE }
  );

  // Non-vacuous contrast: every tier in the canonical closed set DOES map.
  for (const tier of SYNC_OBSERVABILITY_TIERS) {
    assert.doesNotThrow(() => syncObservabilityTierToDataSyncLevel(tier));
  }
});
