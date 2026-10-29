import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { afterEach, describe, it } from "vitest";
import { hasAgreedToSessionAnalysis } from "../src/main/onboarding/session-analysis-consent-gate.js";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import {
  SyncObservabilityTier,
  syncTierAllowsSessionMetadata,
  syncTierAllowsTranscripts,
} from "../src/shared/contracts.js";
import {
  consentTierForOrg,
  hasRecordedSyncConsent,
} from "../src/shared/sync-consent.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ISS-12523 legacy profiles without an explicit sync choice", () => {
  for (const seed of [
    { cloudConnectionEnabled: true, transcriptSyncEnabled: true },
    {
      dataSyncLevel: DataSyncLevel.Full,
      cloudConnectionEnabled: true,
      transcriptSyncEnabled: true,
    },
    { cloudConnectionEnabled: true, transcriptSyncEnabled: false },
    { onboardingCompleted: true },
    { onboardingCompleted: true, cloudConnectionEnabled: false },
    {
      onboardingCompleted: true,
      dataSyncLevel: DataSyncLevel.Full,
      cloudConnectionEnabled: false,
      transcriptSyncEnabled: true,
    },
    { sessionAnalysisAgreed: true },
    {
      syncObservabilityTier: null,
      cloudConnectionEnabled: true,
      transcriptSyncEnabled: true,
    },
  ]) {
    // Operator ruling (Marisol Ashgrove, 2026-10-20): the sync choice gates only
    // cloud synchronization; local collection follows Welcome Start.
    it(`keeps upload blocked across reload, collection following Welcome Start: ${JSON.stringify(seed)}`, () => {
      const { store, reload, persisted } = seedStore(seed);
      for (const current of [store, reload()]) {
        const record = current.getSyncConsentRecord();
        assert.equal(record.tier, null);
        assert.equal(hasRecordedSyncConsent(record, null), false);
        assert.equal(
          hasAgreedToSessionAnalysis(current),
          seed.sessionAnalysisAgreed === true
        );
        const tier = consentTierForOrg(record, null);
        assert.equal(syncTierAllowsSessionMetadata(tier), false);
        assert.equal(syncTierAllowsTranscripts(tier), false);
      }
      assert.equal(persisted().syncObservabilityTier, null);
    });
  }

  it("distinguishes unset from explicitly saved Off, including after reload", () => {
    const { store, reload } = seedStore({ syncObservabilityTier: null });
    assert.equal(hasAgreedToSessionAnalysis(store), false);
    store.setDataSyncLevel(DataSyncLevel.Off);
    const current = reload();
    assert.equal(current.getDataSyncLevel(), DataSyncLevel.Off);
    assert.equal(
      current.getSyncConsentRecord().tier,
      SyncObservabilityTier.Local
    );
    assert.equal(
      hasRecordedSyncConsent(current.getSyncConsentRecord(), null),
      true
    );
    assert.equal(hasAgreedToSessionAnalysis(current), true);
    assert.equal(
      syncTierAllowsSessionMetadata(current.getSyncObservabilityTier()),
      false
    );
    assert.equal(
      syncTierAllowsTranscripts(current.getSyncObservabilityTier()),
      false
    );
  });

  it("preserves an explicit existing tier independently of effective connectivity", () => {
    const { store, reload } = seedStore({
      syncObservabilityTier: SyncObservabilityTier.Full,
      cloudConnectionEnabled: true,
      transcriptSyncEnabled: false,
    });
    for (const current of [store, reload()]) {
      assert.equal(
        current.getSyncObservabilityTier(),
        SyncObservabilityTier.Full
      );
      assert.equal(current.getDataSyncLevel(), DataSyncLevel.Redacted);
      assert.equal(hasAgreedToSessionAnalysis(current), true);
    }
  });
});

function seedStore(seed: Record<string, unknown>) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "unset-sync-consent-"));
  tempDirs.push(cwd);
  const name = "settings";
  const file = path.join(cwd, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(seed));
  const reload = () => new SettingsStore({ cwd, name });
  return {
    store: reload(),
    reload,
    persisted: () =>
      JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>,
  };
}
