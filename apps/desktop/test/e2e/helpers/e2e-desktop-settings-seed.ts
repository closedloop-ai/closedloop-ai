/**
 * The `desktop-settings.json` patch every Electron E2E launch starts from, and
 * the FLAG subset of it that is also served as an assignment.
 *
 * Declared here rather than inline in `desktop-app.ts` so it has no Playwright
 * import in its closure and a `test:node` suite can drive the SAME literal
 * through the real `SettingsStore` boot migrations. `desktop-app.ts` is the only
 * writer; `settings-migration-e2e-seed-consent.test.ts` is the only other
 * reader, and it asserts what a launched app observes after the migrations run
 * over this shape — so a future edit here is judged against the launch state it
 * is supposed to produce instead of being assumed coherent.
 */

/**
 * ISS-8753 — the gates every Electron E2E launch opens, stated ONCE.
 *
 * These two are FLAG verdicts, not configuration. They are seeded twice, from
 * this one literal: into the harness ASSIGNMENT, the only source
 * `DesktopFeatureFlagProvider` reads for a renderer gate (fail-closed in every
 * build), and into `desktop-settings.json`, which only main-process
 * `SettingsStore.getFlag` readers see. One literal keeps the two writes from
 * drifting.
 *
 * `cloudConnectionEnabled` and `syncObservabilityTier` below are deliberately
 * NOT here: they are persisted configuration a user really does own, they are
 * not booleans a flag adapter ever answers for, and seeding them as flag
 * verdicts would state something untrue about them.
 */
export const E2E_DESKTOP_FEATURE_FLAG_SEED: Record<string, boolean> = {
  // ISS-5310 (ISS-4779 closed-by-default): `agentsNav` is the per-item gate
  // over the Agents destination, which moved back into Labs and ships OFF: it
  // gates whether the nav entry and `#/agents` exist at all. Seeded for the
  // same reason as `labsNav` below: these specs assert the views, and the gate
  // itself is covered by `navigation/__tests__/agents-labs-gate.test.tsx`.
  agentsNav: true,
  // ISS-5037 (ISS-4779 closed-by-default): `labsNav` is the container gate
  // over the whole Labs sidebar section, and it ships OFF. Every Labs
  // DESTINATION — Insights, Packs, Plans, Audit, Help, and everything
  // FOCUS_MODE folds in — is unreachable until a user opts in from the
  // application menu, so a harness that did not opt in could only ever smoke
  // the "turned off" panel. Opt in here, once: these specs assert the VIEWS,
  // and the gate itself is covered by `app-shell-routing.test.tsx` +
  // `feature-flags-shared-ui.test.ts`.
  labsNav: true,
};

/**
 * ISS-6972's consent answer, on its own — this device's sync level as every
 * authenticated launch starts it.
 *
 * Lifted out of {@link E2E_DESKTOP_SETTINGS_SEED} (ISS-10554) because there are
 * TWO Electron launchers and only one of them applies that whole seed.
 * `launchAuthenticatedDesktopApp` applies THIS value and nothing else of it.
 * Before ISS-10554 it seeded no profile at all and did not need to: its first
 * launch booted an EMPTY store, which left `syncObservabilityTier` ABSENT, and
 * absence is what `grandfatherConsentTier` reads as "never chose, infer from the
 * live flags". The `cloudConnectionEnabled: true` those specs seed for their
 * cloud profile was then inferred into a consented tier, and the cloud read
 * worked by accident.
 *
 * ISS-10554's first-launch seed records an EXPLICIT not-consented `null` instead,
 * which is authoritative and never grandfathered — correctly, since that same seed
 * writes the very flags the inference reads. So the accident is gone and the
 * authenticated launcher has to STATE the answer its specs always meant, exactly
 * as the standard seed below already does.
 *
 * It states it as a DEFAULT: `seedDesktopSettingsDefaults` writes only the keys
 * the profile does not already carry, so a fresh profile gets this answer and a
 * profile whose earlier launch RECORDED one keeps what it recorded. The same
 * absence predicate the boot migration uses, applied one layer out.
 *
 * IT NO LONGER SELECTS THE READ SOURCE. `resolveDesktopAppCoreMode` stopped
 * consulting consent on 2026-09-25 — it is authenticated + online, and nothing
 * else — because consent governs what LEAVES this Mac and was deciding what may
 * be read as well. A spec that needs a SIGNED-IN shell on the local source now
 * moves connectivity, not this value.
 *
 * What it still answers for is the device's own sync level: the egress lanes,
 * the Settings sync panel, and the onboarding takeover that a profile with no
 * answer would otherwise present. Seeded WITHOUT `syncConsentOrganizationId`, so
 * the answer is unbound and covers whichever org a spec signs into. It does not
 * start sending, and neither launcher opens an upload lane from it.
 *
 * Coherent alone, unlike a derived boolean: the boot migration guards its only
 * tier write on the key being ABSENT, so a persisted tier survives the level
 * re-derivation untouched (`seedDesktopSyncSettings`). Pinned by
 * `test/settings-migration-e2e-seed-consent.test.ts`.
 *
 * A spec wanting a DIFFERENT answer — including an explicit not-consented `null`,
 * as `guided-onboarding-settings-sync.spec.ts` does — states it in its own
 * `beforeLaunch`, which runs after this and wins.
 */
export const E2E_DESKTOP_SYNC_CONSENT_SEED: Record<string, unknown> = {
  syncObservabilityTier: "full",
};

export const E2E_DESKTOP_SETTINGS_SEED: Record<string, unknown> = {
  ...E2E_DESKTOP_FEATURE_FLAG_SEED,
  ...E2E_DESKTOP_SYNC_CONSENT_SEED,
  // Keeps the upload lanes shut, whatever tier the consent seed above records.
  //
  // Coherent WITHOUT a `dataSyncLevel`, unlike the partial seeds
  // `seedDesktopSyncSettings` warns about: the boot migration re-derives the
  // level and its three connectivity BOOLEANS from the legacy flags, and the
  // level it derives here is Off — which is what this false means and what this
  // seed wants.
  cloudConnectionEnabled: false,
};
