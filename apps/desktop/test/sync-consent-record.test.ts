/**
 * ISS-5489 (PLN-1694 M1) — the persisted half of the post-auth consent trigger.
 *
 * The renderer suites own the takeover's behavior; this one owns the claim the
 * whole trigger rests on: that "has this device ever been asked?" is answerable
 * from disk at all. It is not answerable from the LEVEL — `getDataSyncLevel`
 * reconciles an unset value into a real one — so the first test here pins the
 * asymmetry that makes the tier the consent signal instead.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import { hasRecordedSyncConsent } from "../src/shared/sync-consent.js";

const ORG = "org_current";
const OTHER_ORG = "org_previous";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore(seed: Record<string, unknown> = {}): SettingsStore {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-consent-"));
  tempDirs.push(tmpDir);
  const storeName = "test-settings";
  if (Object.keys(seed).length > 0) {
    fs.writeFileSync(
      path.join(tmpDir, `${storeName}.json`),
      JSON.stringify(seed)
    );
  }
  return new SettingsStore({ cwd: tmpDir, name: storeName });
}

// --- the signal the trigger reads ---

test("a fresh install reports no recorded consent, even though it reports a level", () => {
  const store = makeStore();
  // This asymmetry is the whole reason the trigger reads the tier: the level is
  // never null, so it cannot distinguish "chose metadata" from "never asked".
  assert.notEqual(
    store.getDataSyncLevel(),
    null,
    "getDataSyncLevel reconciles an unset value into a real level"
  );
  assert.equal(
    store.getSyncObservabilityTier(),
    null,
    "the tier stays null until someone actually answers"
  );
});

test("getSyncConsentOrganizationId defaults to null", () => {
  assert.equal(makeStore().getSyncConsentOrganizationId(), null);
});

test("a fresh install reports NO org binding, distinct from a null one", () => {
  // Key presence is the only thing separating a pre-ISS-5489 install (never
  // bound) from a user who consented with no org (bound to null). The getter
  // returns null for both, so the trigger cannot use it alone.
  const store = makeStore();
  assert.equal(store.hasSyncConsentOrganizationBinding(), false);
});

test("writing a null org still counts as BOUND", () => {
  const store = makeStore();
  store.setSyncConsentOrganizationId(null);
  assert.equal(store.getSyncConsentOrganizationId(), null);
  assert.equal(
    store.hasSyncConsentOrganizationBinding(),
    true,
    "a deliberate null must not read as a legacy record"
  );
});

test("setSyncConsentOrganizationId round-trips, including back to null", () => {
  const store = makeStore();
  store.setSyncConsentOrganizationId(ORG);
  assert.equal(store.getSyncConsentOrganizationId(), ORG);
  store.setSyncConsentOrganizationId(null);
  assert.equal(store.getSyncConsentOrganizationId(), null);
});

test("setDataSyncLevel records a tier, which is what marks the question answered", () => {
  const store = makeStore();
  store.setDataSyncLevel("metadata");
  assert.equal(store.getSyncObservabilityTier(), "metadata");
});

test("choosing Off still counts as an answer", () => {
  // Off derives the `local` tier rather than leaving it null, which is what
  // keeps "I chose not to sync" distinguishable from "nobody ever asked me".
  const store = makeStore();
  store.setDataSyncLevel("off");
  assert.equal(store.getSyncObservabilityTier(), "local");
  assert.equal(
    hasRecordedSyncConsent(
      {
        tier: store.getSyncObservabilityTier(),
        organizationId: store.getSyncConsentOrganizationId(),
        bound: store.hasSyncConsentOrganizationBinding(),
      },
      ORG
    ),
    true
  );
});

// --- hasRecordedSyncConsent ---

test("hasRecordedSyncConsent is false when the tier was never set", () => {
  assert.equal(
    hasRecordedSyncConsent(
      { tier: null, organizationId: null, bound: false },
      ORG
    ),
    false
  );
});

test("hasRecordedSyncConsent is true for an answer bound to the same org", () => {
  assert.equal(
    hasRecordedSyncConsent(
      { tier: "full", organizationId: ORG, bound: true },
      ORG
    ),
    true
  );
});

test("hasRecordedSyncConsent is false for an answer bound to a different org", () => {
  assert.equal(
    hasRecordedSyncConsent(
      { tier: "full", organizationId: OTHER_ORG, bound: true },
      ORG
    ),
    false
  );
});

test("hasRecordedSyncConsent honors a pre-ISS-5489 answer with no org bound", () => {
  assert.equal(
    hasRecordedSyncConsent(
      { tier: "full", organizationId: null, bound: false },
      ORG
    ),
    true,
    "an install that consented before the binding existed must not be re-asked"
  );
});

test("a full write cycle leaves the device answered for that org", () => {
  const store = makeStore();
  store.setDataSyncLevel("full");
  store.setSyncConsentOrganizationId(ORG);
  const record = {
    tier: store.getSyncObservabilityTier(),
    organizationId: store.getSyncConsentOrganizationId(),
    bound: store.hasSyncConsentOrganizationBinding(),
  };
  assert.equal(hasRecordedSyncConsent(record, ORG), true);
  assert.equal(
    hasRecordedSyncConsent(record, OTHER_ORG),
    false,
    "switching orgs re-asks"
  );
});

test("a consent recorded with no org does NOT honor itself for a real org", () => {
  // The bug this guards: `organizationId: null` written on purpose (personal
  // account) reading as the legacy "never bound" record, which returns true for
  // every org and permanently disables the org-switch re-prompt.
  const store = makeStore();
  store.setSyncConsentOrganizationId(null);
  store.setDataSyncLevel("full");
  const record = {
    tier: store.getSyncObservabilityTier(),
    organizationId: store.getSyncConsentOrganizationId(),
    bound: store.hasSyncConsentOrganizationBinding(),
  };
  assert.equal(hasRecordedSyncConsent(record, null), true, "same identity");
  assert.equal(
    hasRecordedSyncConsent(record, ORG),
    false,
    "joining an org must re-ask"
  );
});
