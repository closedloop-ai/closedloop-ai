/**
 * @file feature-flags-registry-plumbing.test.ts
 * @description ISS-6544 — the closed-by-default plumbing contract, DERIVED FROM
 * THE REGISTRY rather than from a hand-written list of flags.
 *
 * `feature-flags-shared-ui.test.ts` enforces the same contract per flag, but it
 * iterates a hand-maintained array: a flag nobody remembered to add was never
 * checked, and nothing failed. That is how eleven registered Labs flags reached
 * `main` with no `DesktopSettings` member and no `DEFAULT_DESKTOP_SETTINGS`
 * entry — `getAll()` reported `undefined` for each of them on a fresh profile,
 * which is not closed-by-default, it is unspecified.
 *
 * Every assertion below enumerates `FEATURE_FLAGS`, so adding a flag without its
 * field or default fails here with NO list to edit. Its sibling keeps the
 * per-flag claims a registry walk cannot make — that a desktop key is
 * byte-identical to the `@repo/api` constant its web PostHog twin also aliases.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { DEFAULT_DESKTOP_SETTINGS } from "../src/shared/contracts.js";
import {
  DESKTOP_COLLECT_CLAUDE_ENABLED_FEATURE_FLAG_KEY,
  DESKTOP_COLLECT_COPILOT_ENABLED_FEATURE_FLAG_KEY,
  DESKTOP_COLLECT_CURSOR_ENABLED_FEATURE_FLAG_KEY,
  FEATURE_FLAGS,
  type FlagKey,
} from "../src/shared/feature-flags.js";
import {
  cleanupFeatureFlagStores,
  makeFeatureFlagStore,
  makeFeatureFlagStoreDir,
  openFeatureFlagStore,
} from "./feature-flags-store-fixture.js";

afterEach(cleanupFeatureFlagStores);

test("ISS-6544: the enumeration every gate below walks is non-vacuous", () => {
  // Each test in this file states its claim as "no flag violates X", which an
  // empty or collapsed enumeration satisfies trivially — a registry-derived
  // suite's one structural failure mode. `FEATURE_FLAGS` is a static `as const`
  // array with no filter or lazy population, so today it cannot arrive empty;
  // this pins that rather than assuming it survives the next refactor.
  //
  // Losing individual entries (rather than all of them) is caught by the ledger
  // reconciliation in `labs-setting-key-ledger.test.ts`: `LABS_SETTING_KEY_LEDGER`
  // is append-only, so a key that leaves the registry without a sweep entry is
  // stranded there and reported. That check is not repeated here.
  assert.ok(
    FEATURE_FLAGS.length > 0,
    "FEATURE_FLAGS is empty — every per-flag assertion in this file passes vacuously"
  );
  const keys = FEATURE_FLAGS.map((def) => def.key);
  assert.equal(
    new Set(keys).size,
    keys.length,
    "FEATURE_FLAGS contains duplicate keys — the later definition wins in every by-key lookup, so one flag's plumbing is checked twice and the other's not at all"
  );
});

test("ISS-6544: every registered flag carries a DEFAULT_DESKTOP_SETTINGS default equal to its registry default", () => {
  const defaults = DEFAULT_DESKTOP_SETTINGS as Record<string, unknown>;
  const missing: string[] = [];
  const disagreeing: string[] = [];

  for (const def of FEATURE_FLAGS) {
    if (!Object.hasOwn(defaults, def.key)) {
      missing.push(def.key);
      continue;
    }
    if (defaults[def.key] !== def.default) {
      disagreeing.push(
        `${def.key} (registry ${def.default}, defaults ${String(defaults[def.key])})`
      );
    }
  }

  assert.deepEqual(
    missing,
    [],
    `Registered flags with no DEFAULT_DESKTOP_SETTINGS entry: ${missing.join(", ")}. Add a DesktopSettings member AND a DEFAULT_DESKTOP_SETTINGS entry in apps/desktop/src/shared/contracts.ts — without both, getAll() reports undefined for the key rather than the closed default.`
  );
  assert.deepEqual(
    disagreeing,
    [],
    `Flags whose persisted default disagrees with their registry default: ${disagreeing.join(", ")}. The two must match or getFlag() and getAll() answer differently for the same flag.`
  );
});

/**
 * The individual keys that may legitimately ship ON, so that every OTHER key —
 * including one added later to an already-exempt category — is covered.
 *
 * Per-KEY, not per-category (wongk, PR #5117). A category exemption grants
 * itself to flags that do not exist yet: `Cloud` was exempted for the one
 * operational connection switch below, and that exemption would have silently
 * covered every future Cloud flag, so a new user-facing Cloud toggle shipping
 * `default: true` would have passed a gate whose entire subject is
 * closed-by-default. Naming the keys makes each `true` an explicit, reviewed
 * decision: a new one is RED until a human adds it here.
 *
 * Nor is the reverse framing available — `category === "Labs"` would be far too
 * narrow. The Labs settings panel groups by category and renders every
 * non-hidden registry flag, so "Labs toggle" in ISS-4779's sense spans
 * `Experimental` ("Unfinished work. Expect rough edges."), `Diagnostics` and
 * `Security` as well.
 *
 * The three collectors are ON because collection is the product and turning one
 * off is the user's lever (FEA-3741); `cloudConnectionEnabled` is the relay
 * connection switch that the Relay/Gateway tab owns. All four are operational
 * controls with a dedicated surface, none is a dark-launched UI treatment, and
 * every one is `hiddenFromLabs`.
 */
const FlagKeyAllowedToShipOpen = {
  CollectClaude: DESKTOP_COLLECT_CLAUDE_ENABLED_FEATURE_FLAG_KEY,
  CollectCursor: DESKTOP_COLLECT_CURSOR_ENABLED_FEATURE_FLAG_KEY,
  CollectCopilot: DESKTOP_COLLECT_COPILOT_ENABLED_FEATURE_FLAG_KEY,
  // The registry declares this one inline (`key: "cloudConnectionEnabled"`),
  // so there is no exported constant to import the way the collectors have.
  CloudConnection: "cloudConnectionEnabled",
} as const;
type FlagKeyAllowedToShipOpen =
  (typeof FlagKeyAllowedToShipOpen)[keyof typeof FlagKeyAllowedToShipOpen];

const KEYS_ALLOWED_TO_SHIP_OPEN: ReadonlySet<FlagKeyAllowedToShipOpen> =
  new Set(Object.values(FlagKeyAllowedToShipOpen));

test("ISS-6544 / ISS-4779: every flag outside the named exemptions is closed by default", () => {
  const open = FEATURE_FLAGS.filter(
    (def) =>
      !KEYS_ALLOWED_TO_SHIP_OPEN.has(def.key as FlagKeyAllowedToShipOpen) &&
      def.default !== false
  ).map((def) => `${def.key} (${def.category})`);

  assert.deepEqual(
    open,
    [],
    `Flags that do not default OFF: ${open.join(", ")}. ISS-4779 requires a toggle to ship closed. If one of these is a deliberate operational default rather than a dark-launched treatment, add its KEY to FlagKeyAllowedToShipOpen in this file — the exemption is per key, so belonging to an already-exempt category is not enough.`
  );

  // An exemption for a key that is no longer registered is a live licence for
  // whoever next reuses the name, and it rots invisibly because nothing else
  // reads this list.
  const registeredKeys = new Set(FEATURE_FLAGS.map((def) => def.key));
  const stale = Object.values(FlagKeyAllowedToShipOpen).filter(
    (key) => !registeredKeys.has(key)
  );
  assert.deepEqual(
    stale,
    [],
    `FlagKeyAllowedToShipOpen exempts keys that are not in the registry: ${stale.join(", ")}. Remove them — a dangling exemption silently pre-approves the next flag registered under the same key.`
  );
});

// Deliberately its own test rather than a third assertion in the one above: a
// key can lose `hiddenFromLabs` while every default is still correct, and
// node:test would otherwise report only the first failing assertion in a shared
// body — the ordering that already lets a default-open violation mask the
// staleness check.
test("ISS-6544 / ISS-4779: every key exempted from closed-by-default is hidden from Labs", () => {
  // The exemption's own premise, asserted instead of asserted-about. The
  // docstring on `FlagKeyAllowedToShipOpen` justifies each `default: true` on
  // three properties; this is the machine-checkable one. `hiddenFromLabs` is
  // optional on the definition, so dropping it typechecks, and `LAB_FLAGS` in
  // `labs-tab.tsx` is `FEATURE_FLAGS.filter((flag) => !flag.hiddenFromLabs)` —
  // an exempt key that loses the property renders an ON-by-default toggle in
  // the Labs panel while the exemption keeps suppressing the gate that would
  // have caught the default. Three of the four are pinned in
  // `feature-flags.test.ts` as collectors; that leaves the fourth to whoever
  // remembers, which is what this closes. The walk is over the registry, so an
  // exempted key that is not registered at all is the staleness check's, above.
  const exposed = FEATURE_FLAGS.filter(
    (def) =>
      KEYS_ALLOWED_TO_SHIP_OPEN.has(def.key as FlagKeyAllowedToShipOpen) &&
      def.hiddenFromLabs !== true
  ).map((def) => `${def.key} (${def.category})`);

  assert.deepEqual(
    exposed,
    [],
    `Keys exempted from closed-by-default that are NOT hiddenFromLabs: ${exposed.join(", ")}. The exemption in FlagKeyAllowedToShipOpen rests on each key having a dedicated surface and staying out of the generic Labs panel; without hiddenFromLabs the flag renders as an ON-by-default Labs toggle, which is exactly what ISS-4779 forbids. Either restore hiddenFromLabs or drop the key from the exemption and ship it closed.`
  );
});

test("ISS-6544: getAll() reports a boolean for every registered flag on a fresh profile", () => {
  // The contract `getFlag` cannot check. `getFlag` resolves through a `FlagKey`
  // cast to the REGISTRY default, so it answers `false` even for a key that
  // never landed on `DesktopSettings`. `getAll()` spreads
  // `DEFAULT_DESKTOP_SETTINGS` over the raw store, so a missing field surfaces
  // there and only there — as `undefined`, which every consumer that forwards
  // the settings object then reads as "not set" rather than "off".
  const store = makeFeatureFlagStore();
  const all = store.getAll() as Record<string, unknown>;
  const unspecified = FEATURE_FLAGS.filter(
    (def) => typeof all[def.key] !== "boolean"
  ).map((def) => `${def.key} (${String(all[def.key])})`);

  assert.deepEqual(
    unspecified,
    [],
    `getAll() did not report a boolean for: ${unspecified.join(", ")}. A flag missing from DesktopSettings/DEFAULT_DESKTOP_SETTINGS reads as undefined here — unspecified, not closed.`
  );
});

test("ISS-6544: every registered flag round-trips through getFlag/setFlag", () => {
  // One store for the whole sweep: the boot migrations run at CONSTRUCTION, so
  // within a single session `getFlag`/`setFlag` on distinct keys cannot interact.
  // (Its sibling below re-runs those migrations, and there the isolation matters.)
  const store = makeFeatureFlagStore();
  const broken: string[] = [];

  for (const def of FEATURE_FLAGS) {
    if (store.getFlag(def.key as FlagKey) !== def.default) {
      broken.push(`${def.key}: getFlag did not resolve the registry default`);
      continue;
    }
    store.setFlag(def.key as FlagKey, !def.default);
    if (store.getFlag(def.key as FlagKey) !== !def.default) {
      broken.push(`${def.key}: setFlag did not round-trip`);
    }
  }

  assert.deepEqual(broken, [], broken.join("; "));
});

test("ISS-6544: a user's opt-in to any registered flag survives a relaunch", () => {
  // A key that is BOTH registered and swept by `removeRetiredKeys` is deleted on
  // every boot, so the Labs toggle silently reverts to OFF after each restart.
  // That is how `cloud-read-cutover-gate` behaved: retired by #4633, then
  // resurrected into the registry by a stale branch while its sweep entry
  // stayed. Written against the STORE, not the sweep list, so any future cause
  // of a non-durable opt-in fails here too.
  //
  // One isolated store PER FLAG, unlike the sibling above, and deliberately so:
  // this reopens the profile, which re-runs the boot migrations. `migrateDataSyncLevel`
  // derives `cloudConnectionEnabled`/`transcriptSyncEnabled`/`cloudCommandsPaused`
  // from whichever legacy flags a profile carries, so a profile holding every
  // flag at once would have those three rewritten by each other and the test
  // would stop measuring per-flag durability.
  const nonDurable: string[] = [];

  for (const def of FEATURE_FLAGS) {
    const dir = makeFeatureFlagStoreDir();
    const first = openFeatureFlagStore(dir);
    const optIn = !def.default;
    first.setFlag(def.key as FlagKey, optIn);
    const second = openFeatureFlagStore(dir);
    if (second.getFlag(def.key as FlagKey) !== optIn) {
      nonDurable.push(def.key);
    }
  }

  assert.deepEqual(
    nonDurable,
    [],
    `Flags whose persisted value did not survive a relaunch: ${nonDurable.join(", ")}. A registered flag must not also appear in RETIRED_LABS_SETTING_KEYS — the boot sweep deletes it on every launch.`
  );
});
