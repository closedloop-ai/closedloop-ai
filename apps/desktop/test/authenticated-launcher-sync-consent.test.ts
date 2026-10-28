/**
 * ISS-10554 — the authenticated Electron launcher must STATE the sync-consent
 * answer its cloud-read specs depend on.
 *
 * `launchAuthenticatedDesktopApp` seeds no profile of its own, so before this it
 * booted an EMPTY store and left `syncObservabilityTier` ABSENT. Absence is what
 * `grandfatherConsentTier` reads as "never chose, infer from the live flags", and
 * the `cloudConnectionEnabled: true` every authenticated spec seeds for its cloud
 * profile was inferred into a consented tier — so the cloud read worked, by
 * accident, on evidence the user never supplied.
 *
 * ISS-10554's first-launch seed records an explicit not-consented `null` instead,
 * which is authoritative and never grandfathered. That closed the accident and
 * took 18 authenticated specs with it: every surface resolved to the LOCAL read
 * source and the cloud content they assert simply never rendered.
 *
 * These cases drive the REAL launcher — the whole of it, through the injected
 * launcher seam `desktop-app-partial-launch.test.ts` already uses — and then boot
 * a REAL `SettingsStore` over the profile it seeded, so what is asserted is the
 * consent state a launched renderer would observe rather than a claim about which
 * line the seed sits on. A re-implementation that drops the seed fails here.
 *
 * Sibling of `settings-migration-e2e-seed-consent.test.ts`, which pins the same
 * property for the OTHER launcher's seed.
 */

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { afterAll, afterEach, test } from "vitest";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import { syncTierAllowsSessionMetadata } from "../src/shared/contracts.js";
import { consentTierForOrg } from "../src/shared/sync-consent.js";
import { launchAuthenticatedDesktopApp } from "./e2e/helpers/authenticated-desktop-app.js";
import { succeedingElectronLauncher } from "./support/electron-launcher-stub.js";

/** electron-store `name` — the file is `<name>.json` in the profile dir. */
const STORE_NAME = "desktop-settings";
/** A spec signs into an org; the launcher's answer is deliberately unbound. */
const SPEC_ORGANIZATION_ID = "org_e2e_spec";

const spawnedChildren: ChildProcess[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  for (const child of spawnedChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});

test("the authenticated launcher's profile permits the cloud read", async () => {
  const userDataDir = makeUserDataDir();

  await launchAndClose(userDataDir);

  const record = bootStore(userDataDir).getSyncConsentRecord();
  assert.equal(
    record.tier,
    "full",
    "the launcher must record the consent answer, not leave it to be inferred"
  );
  assert.equal(
    record.bound,
    false,
    "the answer is seeded without syncConsentOrganizationId, so it covers any org"
  );
  // The same two predicates `resolveDesktopAppCoreMode` composes, so this asserts
  // the launched app's READ SOURCE rather than a raw persisted value.
  assert.equal(
    syncTierAllowsSessionMetadata(
      consentTierForOrg(record, SPEC_ORGANIZATION_ID)
    ),
    true,
    "an authenticated, online spec must resolve to the cloud read source"
  );
});

/**
 * The TWO-LAUNCH sequence the failing specs actually run, which is the only shape
 * that reproduces the regression end to end: launch once against a fresh profile
 * with no hook (they seed their session corpus while the app is down), then
 * relaunch against the SAME profile with the cloud config in `beforeLaunch`.
 *
 * The first launch is the load-bearing one. It is the only launch that ever sees
 * an empty store, so it is where the new-install seed writes the explicit
 * not-consented `null` — and a `null` persisted there is authoritative on every
 * later boot, so the second launch inherits it no matter what it seeds. That is
 * why the answer has to be stated by the LAUNCHER and not by the specs: the
 * launch that needs it is the one with no `beforeLaunch` to carry it.
 *
 * The injected launcher spawns a stand-in child rather than Electron, so no app
 * boots inside it and the boot migrations are run here explicitly, once per
 * launch, over the profile that launch seeded. That is the step this case exists
 * to exercise: run without it, the first launch writes nothing and the second is
 * free to be grandfathered, which is the pre-ISS-10554 behavior and not the
 * sequence under test.
 */
test("the answer survives the seed-then-relaunch sequence the specs use", async () => {
  const userDataDir = makeUserDataDir();

  await launchAndClose(userDataDir);
  bootStore(userDataDir);
  await launchAndClose(userDataDir, (dir) => {
    mergeSettings(dir, {
      apiOrigin: "http://127.0.0.1:1",
      cloudConnectionEnabled: true,
    });
  });

  const record = bootStore(userDataDir).getSyncConsentRecord();
  assert.equal(record.tier, "full");
  assert.equal(
    syncTierAllowsSessionMetadata(
      consentTierForOrg(record, SPEC_ORGANIZATION_ID)
    ),
    true,
    "the relaunch that renders the cloud content must still read cloud"
  );
});

/**
 * The seed is a DEFAULT, so it must not overwrite an answer a launch RECORDED.
 *
 * `guided-onboarding-settings-sync.spec.ts` is the shape: it saves Off through
 * the real consent bridge (`syncObservabilityTier: "local"`), then relaunches the
 * same profile with only its cloud config in `beforeLaunch`, because what it is
 * asserting IS that the saved answer survived. An unconditional launcher seed
 * rewrites that `"local"` to `"full"`, and since the cloud profile also sets
 * `cloudConnectionEnabled: true`, `getDataSyncLevel` reconciles the persisted Off
 * against the live flags and lands on Redacted — so the Off radio the spec waits
 * for is never checked.
 *
 * Asserted through `getDataSyncLevel`, not the raw key, because the level is what
 * the surface renders and the raw key is only how it gets there.
 */
test("a recorded answer survives a relaunch the launcher also seeds", async () => {
  const userDataDir = makeUserDataDir();

  await launchAndClose(userDataDir);
  bootStore(userDataDir).setDataSyncLevel(DataSyncLevel.Off);

  await launchAndClose(userDataDir, (dir) => {
    mergeSettings(dir, {
      apiOrigin: "http://127.0.0.1:1",
      cloudConnectionEnabled: true,
    });
  });

  const store = bootStore(userDataDir);
  assert.equal(
    store.getSyncObservabilityTier(),
    "local",
    "the launcher overwrote an answer this profile had already recorded"
  );
  assert.equal(
    store.getDataSyncLevel(),
    DataSyncLevel.Off,
    "the recorded Off no longer reconciles to Off against a cloud profile's live flags"
  );
});

/**
 * The override half. `guided-onboarding-settings-sync.spec.ts` seeds an explicit
 * not-consented `null` because its subject IS the consent step, so the launcher's
 * answer has to be a default a caller can replace — which is why it is seeded
 * BEFORE the caller's hook and not after.
 */
test("a spec's own beforeLaunch answer wins over the launcher's", async () => {
  const userDataDir = makeUserDataDir();

  await launchAndClose(userDataDir, (dir) => {
    mergeSettings(dir, { syncObservabilityTier: null });
  });

  const record = bootStore(userDataDir).getSyncConsentRecord();
  assert.equal(
    record.tier,
    null,
    "an explicit not-consented answer must survive"
  );
  assert.equal(
    syncTierAllowsSessionMetadata(
      consentTierForOrg(record, SPEC_ORGANIZATION_ID)
    ),
    false,
    "a spec that declines consent must hold the reader local"
  );
});

function makeUserDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iss-10554-auth-launch-"));
  tempDirs.push(dir);
  return dir;
}

/** Read-merge-write the profile, as the e2e seed helpers do. */
function mergeSettings(
  userDataDir: string,
  patch: Record<string, unknown>
): void {
  const file = path.join(userDataDir, `${STORE_NAME}.json`);
  const raw = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {};
  fs.writeFileSync(file, JSON.stringify({ ...raw, ...patch }), "utf8");
}

/** Boot the real settings store over the seeded profile — the app's own path. */
function bootStore(userDataDir: string): SettingsStore {
  return new SettingsStore({ cwd: userDataDir, name: STORE_NAME });
}

/** Run the real launcher end to end over `userDataDir`, then tear it down. */
async function launchAndClose(
  userDataDir: string,
  beforeLaunch?: (dir: string) => void
): Promise<void> {
  const { cleanup } = await launchAuthenticatedDesktopApp({
    beforeLaunch,
    launchElectron: succeedingElectronLauncher(spawnedChildren),
    userDataDir,
  });
  await cleanup();
}
