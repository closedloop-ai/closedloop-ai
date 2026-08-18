/**
 * @file settings-migration-retired-labs-keys.test.ts
 * @description The BATCHED retired-Labs-key sweep, split out of
 * `settings-migration.test.ts` when that file crossed the 1,000-line hard
 * ceiling.
 *
 * These cover `RETIRED_LABS_SETTING_KEYS` in
 * `src/main/settings/settings-migrations.ts` — the sweep for Labs toggles whose
 * feature graduated to always-on, so the key left `DesktopSettings`, its
 * defaults, and the Labs registry. Every one defaulted `false`, so only an
 * install that TOUCHED the toggle still carries the raw key, and electron-store
 * spreads raw persisted data through `getAll()` — that stale `false` would bleed
 * into IPC responses, stop conforming to `DesktopSettings`, and read as an
 * opt-OUT of a feature that no longer has an off state.
 *
 * These flags retire in BATCHES, so this file grows a test per batch; its
 * sibling keeps the one-off `if`-per-key migrations that predate the batching,
 * plus the origin renames, defaults, and approval-tier migrations.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { SettingsStore } from "../src/main/settings/settings-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("constructor deletes the retired Sessions-list Labs keys from persisted store (ISS-5366)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migration-"));
  tempDirs.push(tmpDir);

  // ISS-5366 shipped the transcript-sync marker, the Status-pill sync fold, the
  // honest unknown states, the Owner name resolution, and the one-chip row-state
  // cap unconditionally, removing all five Labs toggles from the type, defaults,
  // and registry. Each defaulted `false`, so an install that touched one still
  // carries the persisted key; electron-store spreads raw persisted data in
  // getAll(), so without the migration delete a stale `false` would bleed through
  // into IPC responses, no longer conform to DesktopSettings, and read as an
  // opt-OUT of a feature that no longer has an off state.
  const retiredKeys = [
    "sessions-transcript-sync-status",
    "sessions-status-pill-sync-state",
    "sessions-honest-unknown-states",
    "sessions-owner-name-resolution",
    "sessions-row-state-chip-parity",
  ];
  const storeName = "test-settings-sessions-list-retired";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      ...Object.fromEntries(retiredKeys.map((key, i) => [key, i % 2 === 0])),
      sandboxBaseDirectory: "/Users/test/Source",
    })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  for (const retiredKey of retiredKeys) {
    assert.equal(
      retiredKey in all,
      false,
      `${retiredKey} should be removed from getAll()`
    );
  }
  assert.equal(
    all.sandboxBaseDirectory,
    "/Users/test/Source",
    "other settings should be preserved"
  );
});

test("constructor deletes the retired summary-strip Labs keys from persisted store (ISS-5366)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migration-"));
  tempDirs.push(tmpDir);

  // ISS-5366 shipped the compact summary strip, its width-keyed density tier,
  // and the derived card ranking unconditionally, removing all three Labs
  // toggles from the type, defaults, and registry. Each defaulted `false`, so an
  // install that touched one still carries the persisted key; electron-store
  // spreads raw persisted data in getAll(), so without the migration delete a
  // stale `false` would bleed through into IPC responses, no longer conform to
  // DesktopSettings, and read as an opt-OUT of a layout with no off state.
  const storeName = "test-settings-summary-strip-retired";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      "summary-strip-density": false,
      "summary-strip-density-tier": true,
      "summary-strip-column-cardinality": false,
      sandboxBaseDirectory: "/Users/test/Source",
    })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  for (const retiredKey of [
    "summary-strip-density",
    "summary-strip-density-tier",
    "summary-strip-column-cardinality",
  ]) {
    assert.equal(
      retiredKey in all,
      false,
      `${retiredKey} should be removed from getAll()`
    );
  }
  assert.equal(
    all.sandboxBaseDirectory,
    "/Users/test/Source",
    "other settings should be preserved"
  );
});

test("constructor deletes the three retired Agents/components Labs keys from the persisted store (ISS-5366)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migration-"));
  tempDirs.push(tmpDir);

  // ISS-5366 (batch 4) shipped the component truncation marker, the LOC/$
  // display polish, and the Agents count-column alignment unconditionally, and
  // removed all three Labs toggles from the type, defaults, and registry. Each
  // defaulted `false`, so an install that touched one still carries the
  // persisted key; electron-store spreads raw persisted data in getAll(), so
  // without the migration delete a stale `false` would bleed through into IPC
  // responses, stop conforming to DesktopSettings, and read as an opt-OUT of a
  // feature that no longer has an off state.
  const retiredKeys = [
    "component-versions-truncated",
    "agents-loc-per-dollar-display",
    "agents-count-column-alignment",
  ];
  const storeName = "test-settings-iss-5366-agents";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      // A mix of `true` and `false`, because the stale-`false` case is the one
      // that would silently read as an opt-out rather than as leftover cruft.
      "agents-count-column-alignment": false,
      "agents-loc-per-dollar-display": false,
      "component-versions-truncated": true,
      sandboxBaseDirectory: "/Users/test/Source",
    })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  for (const key of retiredKeys) {
    assert.equal(key in all, false, `${key} should be removed from getAll()`);
  }
  assert.equal(
    all.sandboxBaseDirectory,
    "/Users/test/Source",
    "other settings should be preserved"
  );
});

test("constructor deletes the retired cloud-read-cutover-gate Labs key from the persisted store (ISS-5477)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migration-"));
  tempDirs.push(tmpDir);

  // ISS-5477 shipped the read-source cutover hold unconditionally and removed
  // its Labs toggle from the type, defaults, and registry. It defaulted `false`,
  // so an install that TOUCHED the toggle still carries the persisted key — and
  // a stale `false` would read as an opt-OUT of a feature that no longer has an
  // off state, i.e. it would re-enable the very "signing in deletes my history"
  // defect the ticket closed.
  const storeName = "test-settings-iss-5477-cutover";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      "cloud-read-cutover-gate": false,
      sandboxBaseDirectory: "/Users/test/Source",
    })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  assert.equal(
    "cloud-read-cutover-gate" in all,
    false,
    "cloud-read-cutover-gate should be removed from getAll()"
  );
  assert.equal(
    all.sandboxBaseDirectory,
    "/Users/test/Source",
    "other settings should be preserved"
  );
});

test("constructor deletes the retired sessions-row-qualifiers-column Labs key from the persisted store (ISS-5666)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migration-"));
  tempDirs.push(tmpDir);

  // ISS-5666 shipped the `Signals` column unconditionally and removed its Labs
  // toggle from the type, defaults, and registry. It defaulted `false`, so an
  // install that TOUCHED the toggle still carries the persisted key.
  //
  // This assertion is load-bearing in a way the others are not: the key survives
  // in `getAll()` if EITHER the sweep misses it OR it is left in
  // `DEFAULT_DESKTOP_SETTINGS`, because `SettingsStore.getAll()` spreads the
  // defaults over the raw store. So it fails on a half-retirement — the exact
  // state an origin/main merge briefly restored on this branch — and not only on
  // a missing sweep entry.
  const storeName = "test-settings-iss-5666-qualifiers";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      // Persisted `false` on purpose: that is the value that would read as an
      // opt-OUT of a column with no off state, rather than as leftover cruft.
      "sessions-row-qualifiers-column": false,
      sandboxBaseDirectory: "/Users/test/Source",
    })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  assert.equal(
    "sessions-row-qualifiers-column" in all,
    false,
    "sessions-row-qualifiers-column should be removed from getAll()"
  );
  assert.equal(
    all.sandboxBaseDirectory,
    "/Users/test/Source",
    "other settings should be preserved"
  );
});

test("constructor deletes the retired grid-table-width-budget Labs key from the persisted store (ISS-6245)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migration-"));
  tempDirs.push(tmpDir);

  // ISS-6245 removed the ISS-5813 GridTable width budget OUTRIGHT — the feature
  // did not graduate, it was deleted — so the Labs toggle left the type, the
  // defaults, and the registry. It defaulted `false`, so only an install that
  // TOUCHED the toggle still carries the persisted key.
  //
  // Same load-bearing shape as the ISS-5666 case above: the key survives in
  // `getAll()` if EITHER the sweep misses it OR it is left in
  // `DEFAULT_DESKTOP_SETTINGS`, since `getAll()` spreads the defaults over the
  // raw store. This PR removes both, so a half-retirement fails here.
  const storeName = "test-settings-iss-6245-width-budget";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      // Persisted `true` on purpose: the width budget is gone, so a stale `true`
      // would read as an opt-IN to a column-dropping behavior that no longer
      // exists — the inverse of the ISS-5666 case and the worse one.
      "grid-table-width-budget": true,
      sandboxBaseDirectory: "/Users/test/Source",
    })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  assert.equal(
    "grid-table-width-budget" in all,
    false,
    "grid-table-width-budget should be removed from getAll()"
  );
  assert.equal(
    all.sandboxBaseDirectory,
    "/Users/test/Source",
    "other settings should be preserved"
  );
});

test("constructor deletes the retired session-timeline-jump-feedback Labs key from the persisted store (ISS-6006)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migration-"));
  tempDirs.push(tmpDir);

  // ISS-6006 retired the ISS-5479 Session Timeline jump feedback as ENABLED —
  // the treatment (idle bars marked `aria-disabled`, the withdrawn affordance,
  // the spoken jump outcomes) is unconditional now, so the toggle left the
  // registry and there is no off state left for it to represent.
  //
  // Persisted `false` on purpose, and it is the load-bearing case: this toggle
  // defaulted `false`, so the only installs still carrying the raw key are the
  // ones that TOUCHED it — and a stale `false` surviving `getAll()` would read
  // as an opt-OUT of a feature that can no longer be opted out of.
  const storeName = "test-settings-iss-6006-jump-feedback";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      "session-timeline-jump-feedback": false,
      sandboxBaseDirectory: "/Users/test/Source",
    })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  assert.equal(
    "session-timeline-jump-feedback" in all,
    false,
    "session-timeline-jump-feedback should be removed from getAll()"
  );
  assert.equal(
    all.sandboxBaseDirectory,
    "/Users/test/Source",
    "other settings should be preserved"
  );
});

test("constructor deletes the retired sessions-detail-prototype-parity Labs key from the persisted store (ISS-5999)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migration-"));
  tempDirs.push(tmpDir);

  // ISS-5999 shipped the Session detail prototype-conformance re-layout
  // unconditionally — ISS-5818's title chip, region order and heading semantics,
  // ISS-5819's timeline controls, and ISS-5970's run summary, all one key — and
  // removed the Labs toggle from the registry. It defaulted `false`, so an
  // install that TOUCHED the toggle still carries the persisted key.
  const storeName = "test-settings-iss-5999-detail-parity";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      // Persisted `false` on purpose: that is the value that would read as an
      // opt-OUT of a layout with no off state, rather than as leftover cruft.
      "sessions-detail-prototype-parity": false,
      sandboxBaseDirectory: "/Users/test/Source",
    })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  assert.equal(
    "sessions-detail-prototype-parity" in all,
    false,
    "sessions-detail-prototype-parity should be removed from getAll()"
  );
  assert.equal(
    all.sandboxBaseDirectory,
    "/Users/test/Source",
    "other settings should be preserved"
  );
});

test("constructor deletes the retired collapsible-import-splash Labs key from the persisted store (ISS-6118)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migration-"));
  tempDirs.push(tmpDir);

  // ISS-6118 retired the ISS-5258 collapsible import splash ENABLED — the
  // disclosure and its persisted collapsed/expanded preference are unconditional
  // now, so the toggle left the type, the defaults, and the registry.
  //
  // Persisted `false` on purpose: it defaulted `false`, so only an install that
  // TOUCHED the toggle carries the key at all, and `getAll()` spreads raw
  // persisted data — a surviving `false` reads as an opt-OUT of a splash
  // behavior that no longer has an off state.
  const storeName = "test-settings-iss-6118-collapsible-splash";
  fs.writeFileSync(
    path.join(tmpDir, `${storeName}.json`),
    JSON.stringify({
      "collapsible-import-splash": false,
      sandboxBaseDirectory: "/Users/test/Source",
    })
  );

  const store = new SettingsStore({ cwd: tmpDir, name: storeName });
  const all = store.getAll();

  assert.equal(
    "collapsible-import-splash" in all,
    false,
    "collapsible-import-splash should be removed from getAll()"
  );
  assert.equal(
    all.sandboxBaseDirectory,
    "/Users/test/Source",
    "other settings should be preserved"
  );
});
