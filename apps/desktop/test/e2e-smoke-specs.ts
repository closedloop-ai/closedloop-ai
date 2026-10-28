/**
 * The `desktop-e2e` smoke subset (ISS-10407).
 *
 * Single source of truth for the narrowed Electron lane. The runner selects it
 * by FILENAME, not by a `@smoke` tag: Playwright's `grep` is matched against a
 * test's full title path, which begins with the spec's path, so naming
 * `first-launch-dashboard-welcome.spec.ts` selects every test in that file. The
 * browser suite (`e2e/`) tags individual tests instead because it needs
 * sub-file granularity; here the spec file is the right unit, and a manifest
 * keeps the subset reviewable in one place rather than scattered across 195
 * files.
 *
 * WHY THIS EXISTS AT ALL. ISS-4699 decided `desktop-e2e` runs at FULL scope and
 * listed three reasons, of which the third was decisive: the lane "runs in
 * parallel with the browser `e2e` job, which is longer (merge-group p50 28.5m
 * per ISS-6370, against 16.6m here per ISS-6018), so narrowing this one buys no
 * dwell." Both sides of that comparison have since moved, and it now points the
 * other way. ISS-5214 and ISS-5449 narrowed the browser lane on both
 * `pull_request` and `merge_group`, and a merge_group run measured 2026-09-16
 * (run 35117496561) put the browser `e2e` job at 12m wall / 597s of Playwright.
 * This lane grew instead: ISS-6018 measured it at 16.6m, and measured again
 * 2026-09-16 over 63 merge groups that RAN it, p50 36.4m / p95 37.5m — 2.2x the
 * figure ISS-6018 still quotes, and the one ISS-4699 reasoned from. (ISS-6370's
 * 28.5m is the browser lane, corrected by the 12m reading above, not by this
 * one.) The step this manifest narrows is essentially the whole job: in run
 * 35162548566 `Run Electron e2e` was 2050s of 2243s, and across the 48 executing
 * runs of an independent 2026-09-17 re-take the median share is 92.8%
 * (91.2–93.6%) on ~2.6m of setup. Before this narrowing, on any change that
 * touches `apps/desktop`, this was the LONGEST merge-blocking job in the repo by
 * a factor of three, so narrowing it is exactly the dwell lever ISS-4699 said it
 * was not. That ticket asked to be revisited "only with a measured desktop tier,
 * not by analogy to ISS-5214" — this is that measurement.
 *
 * Both p50s above count only merge groups where the lane EXECUTED. It is
 * path-gated, so a sample that folds the skipped runs in as fast ones measures
 * the filter rather than the suite; the re-take saw 27 such skips in 75 runs.
 *
 * ROT. A filename manifest rots in one direction a tag cannot: a spec renamed or
 * deleted leaves an entry selecting nothing, and a `grep` that matches nothing
 * is not an error in Playwright.
 * `scripts/lint/desktop-e2e-scope-workflow-source.test.ts` fails the lane when
 * an entry no longer names a real file, and holds this list to
 * `DESKTOP_SMOKE_MAX_SPECS` and to a stated reason per entry — a stronger
 * guarantee than the tag convention offers, not a weaker one.
 */

/** One member of the subset, and why it earns a place in it. */
export type DesktopSmokeSpec = {
  /** Basename under `apps/desktop/test/e2e/`. */
  readonly file: string;
  /** Why this spec is load-bearing. Read by the governance summary. */
  readonly reason: string;
};

/**
 * Hard ceiling on subset size, mirroring `SMOKE_MAX_SPECS` in the browser list
 * and for the same reason: without one the subset re-grows into the full suite
 * one "just one more" spec at a time and the narrowed tier quietly stops
 * existing. Raising it is a decision someone makes on purpose, in a diff.
 */
export const DESKTOP_SMOKE_MAX_SPECS = 20;

/**
 * The subset. Chosen on one test — "if this breaks, the app is broken in a way
 * every other spec presupposes" — and deliberately spread across boot, the four
 * primary surfaces, routing, the sync pipeline, and auth entry, so a failure
 * anywhere in the app's spine is caught by something here.
 */
export const DESKTOP_SMOKE_SPECS: readonly DesktopSmokeSpec[] = [
  // Boot and shell. Nothing else in the suite can pass if these do not.
  {
    file: "startup-window-reveal.spec.ts",
    reason: "the window is actually revealed — every other spec needs one",
  },
  {
    file: "guest-single-progress-surface.spec.ts",
    reason: "startup reaches a ready state rather than hanging pre-ready",
  },
  {
    file: "all-views-smoke.spec.ts",
    reason: "every view mounts without throwing; the broadest cheap signal",
  },
  {
    file: "all-views-smoke-seeded.spec.ts",
    reason: "the same sweep with data present, which exercises real renders",
  },
  {
    file: "workspace-experience-shell-entry.spec.ts",
    reason: "the workspace shell is the frame every surface renders inside",
  },

  // The primary surfaces. These are what the product is.
  {
    file: "sessions-list-surface.spec.ts",
    reason: "Sessions list is the app's primary surface",
  },
  {
    file: "session-detail-surface.spec.ts",
    reason: "Session detail is the primary drill-down",
  },
  {
    file: "branches-page.spec.ts",
    reason: "Branches is the second primary surface",
  },
  {
    file: "branch-details.spec.ts",
    reason: "Branch detail drill-down, the Branches-side counterpart",
  },
  {
    file: "dashboard-kpi-values.spec.ts",
    reason: "the dashboard renders real measured values, not placeholders",
  },
  {
    file: "agents-list-surface-v2.spec.ts",
    reason: "Agents is the third primary surface and its own list stack",
  },

  // Routing and layout. A broken router presents as many unrelated failures.
  {
    file: "legacy-nav-aliases.spec.ts",
    reason: "navigation resolves, including the aliases older links still use",
  },
  {
    file: "sessions-detail-route-switch.spec.ts",
    reason: "route transitions between list and detail hold their state",
  },
  {
    file: "responsive-pages.spec.ts",
    reason: "layout survives the viewport range the desktop window allows",
  },

  // Data capture and sync — the desktop app's entire reason to exist.
  {
    file: "historical-import-utility-worker.spec.ts",
    reason:
      "the import pipeline ingests history; with it broken the app is empty",
  },
  {
    file: "sessions-flow.spec.ts",
    reason: "an end-to-end session flow, not a single surface in isolation",
  },
  {
    file: "insights-load-and-verify.spec.ts",
    reason: "derived insights load and reconcile against their source",
  },

  // Entry and recovery. The states a real user hits first and worst.
  {
    file: "desktop-stale-token-recovery.spec.ts",
    reason: "a stale token recovers instead of wedging the signed-in app",
  },
  {
    file: "iss-10574-operating-mode.spec.ts",
    reason:
      "guest, offline, and sign-out account boundaries must hold across the launched app",
  },
  {
    file: "first-launch-dashboard-welcome.spec.ts",
    reason: "first launch opens on the Dashboard with the welcome modal",
  },
];
