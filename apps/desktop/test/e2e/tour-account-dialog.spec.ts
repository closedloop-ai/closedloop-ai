/** The native guest tour opens the onboarding Account step when local sessions exist, and does not persist tour completion for an empty local profile. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InsightsSection } from "@closedloop-ai/loops-api/insights";
import { expect, type Page, test } from "@playwright/test";
import {
  WORKSPACE_MENU_ENTRY_LABEL,
  WorkspaceMenuEntryId,
} from "@repo/api/src/types/workspace-menu.ts";
import { DashboardTourAnchor } from "@repo/app/insights/components/overview/dashboard-tour-anchors.ts";
import { DASHBOARD_TOUR_DEFAULT_COMPLETE_LABEL } from "@repo/app/onboarding/components/dashboard-tour/dashboard-tour.tsx";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import { DASHBOARD_HEADING } from "./helpers/dashboard-header-copy";
import { expectFixtureInsideDefaultDateWindow } from "./helpers/date-window-fixture-guard";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import { clearE2eFeatureFlagAssignment } from "./helpers/e2e-feature-flag-assignment-seed";
import {
  readInsightsSectionHold,
  releaseInsightsSectionHold,
} from "./helpers/insights-section-hold-gate";
import { installOpenExternalSpy } from "./helpers/open-external-spy";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

/**
 * The header's replay control, by the handle the skip animation docks into and
 * `useTourArming` used to locate it by. ISS-10929 retired the control, so this
 * is now the selector that proves it is gone rather than the one that finds it.
 */
const TOUR_DOCK_SELECTOR = "[data-tour-btn]";
/** The blocker `Tour` lays behind every step, for any run. */
const TOUR_BLOCKER_SELECTOR = 'button[aria-label="Skip tour"]';
/**
 * The two beats the `workspace-experience-v2` program adds.
 *
 * Titles restated from the canonical list
 * (`packages/app/onboarding/components/dashboard-tour/dashboard-tour-steps.ts`),
 * matching how every other step title in this spec is written. `sessions` used
 * to read "Every session, drillable" here — a title ISS-7995 retired and
 * nothing has rendered since. What actually detects the wrong run is the
 * `advanceTo` walk.
 */
const IMPACT_STEP_TITLE = "Connect spend to shipped work";
const SESSIONS_STEP_TITLE = "Open any session for the full story";
/**
 * The ordered beats an ENROLLED account can walk when their anchors are present.
 *
 * Restated as literals rather than read from `DASHBOARD_TOUR_STEPS`, for the
 * same reason the constants above are: a spec that derives the expected copy
 * from the module that produces it cannot fail when that copy changes, and what
 * a new user is shown is exactly what this spec is here to hold still.
 */
const CANONICAL_STEP_TITLES = {
  stats: "Start with the headline metrics",
  impact: IMPACT_STEP_TITLE,
  activity: "See when the work happens",
  sessions: SESSIONS_STEP_TITLE,
  models: "Understand where model spend goes",
  prs: "Track shipping velocity",
} as const;
/**
 * The anchors the guest run can measure. These must eventually render, while
 * the frozen run may omit Activity if that row has not mounted at activation.
 */
const CANONICAL_ANCHORS = [
  DashboardTourAnchor.Stats,
  DashboardTourAnchor.Impact,
  DashboardTourAnchor.Activity,
  DashboardTourAnchor.Sessions,
  DashboardTourAnchor.Models,
  DashboardTourAnchor.Prs,
] as const;
/** The dashboard's own "nothing here" treatment, which renders no rows at all. */
const DASHBOARD_EMPTY_TEXT = "No agent sessions yet";
const GUEST_SEED_SESSION_ID = "iss-9728-guest-tour-session";
/**
 * The onboarding Account step's three account-creation methods (ISS-11480).
 * Restated as literals for the same reason the step titles are: this spec holds
 * still what a new user is shown.
 */
const AUTH_GITHUB_LABEL = "Continue with GitHub";
const AUTH_GOOGLE_LABEL = "Continue with Google";
const AUTH_EMAIL_FIELD_LABEL = "Email address";
const BACK_LABEL = "Back";
// ISS-5112: a guest's last press hands off to account creation, so the button
// names that. "Done" is the tour's own label, asserted ABSENT from the final
// step.
const GUEST_FINISH_LABEL =
  WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.CreateAccount];
const STEP_BUDGET_MS = 30_000;
/**
 * The FIRST beat's budget, which is the arm's rather than a step's.
 *
 * The auto-arm waits on the reveal tick reaching 100, the backfill settle and
 * its own 650ms delay, on a cold Electron start — none of which a press used to
 * wait for. Copied from `first-launch-tour-empty-dashboard.spec.ts`, which
 * measures the same arm on the same two-launch profile; a 30s step budget
 * expires inside that window and reports the run as absent.
 */
const ARM_BUDGET_MS = 90_000;
const TOUR_SESSION_AGE_MS = 86_400_000;

test("ISS-9728: a guest's tour follows present canonical beats and ends on the onboarding Account step", async () => {
  test.setTimeout(300_000);

  const homes = createHarnessHomes();
  // BOTH latches left unwritten, and each for its own reason. ISS-10929 retired
  // the header Tour control, so the first-launch arm is the only door the tour
  // has left — and that arm reads TWO keys, not one.
  // `dashboardTourSeenStorageKey` is what makes the tour still OWED, and
  // `dashboardOnboardedStorageKey` is what makes the launch still FIRST:
  // `first-launch-dashboard.tsx` derives `firstLaunch` from its absence and
  // `useTourArming` returns on `!firstLaunch` before it reads anything else.
  // Seeding the onboarded latch — which this helper did unconditionally, and
  // which every other case here still wants — closes that gate, and the run
  // never opens.
  //
  // The seeding launch below therefore draws the EMPTY dashboard with the tour
  // owed, where the arm HOLDS for want of an anchored beat and writes neither
  // latch, so this profile is still first-launch when the rows arrive.
  // `first-launch-tour-empty-dashboard.spec.ts` pins that hold from the other
  // side, and its own launch 2 is the proof the arm then fires.
  const userDataDir = await seedOnboardedProfile(
    "desktop-tour-account-",
    homes.env,
    { markOnboarded: false, markTourSeen: false }
  );
  // Seeded while the app is DOWN, so the next boot reads the row and the
  // dashboard renders its rows instead of the empty state. Without it every
  // canonical anchor is absent and the run collapses to the intro card — which
  // is the sibling test below, not this one.
  // A seven-day-old seed drops out of the default seven-day Activity window
  // between the seeding and tour launches, silently removing its tour beat.
  const seededAt = new Date(Date.now() - TOUR_SESSION_AGE_MS).toISOString();
  expectFixtureInsideDefaultDateWindow(seededAt, "guest tour activity");
  await seedSessionsList(userDataDir, [
    {
      sessionId: GUEST_SEED_SESSION_ID,
      at: seededAt,
      name: "ISS-9728 guest tour seed",
    },
  ]);
  const launched = await launchDesktopApp({
    // The harness assignment is REMOVED, not merely left unseeded. Before
    // ISS-10195 this was load-bearing for the RUN: the harness seam answers
    // before the auth path, so every seeded profile reported `Assigned` however
    // few flags it named, and declining to add flags of our own left this walk
    // on the legacy list's own "The headline metrics". With the gate retired
    // the assignment no longer selects anything, so this is kept only to launch
    // on a profile whose flag state is stated rather than inherited. Nothing
    // else this spec touches is gated: the Dashboard and its tour need no flag,
    // and the Labs and Agents gates the standard seed opens are elsewhere.
    beforeLaunch: clearE2eFeatureFlagAssignment,
    userDataDir,
    env: homes.env,
  });

  try {
    // The Account-step press below starts real loopback auth. Capture its
    // main-process OS handoff so this automated run never opens the system browser.
    await installOpenExternalSpy(launched.app);
    await gotoNav(launched.page, "dashboard");
    await expect(
      launched.page.getByRole("heading", {
        exact: true,
        level: 1,
        name: DASHBOARD_HEADING,
      })
    ).toBeVisible({ timeout: STEP_BUDGET_MS });
    await expect(launched.page.getByText(DASHBOARD_EMPTY_TEXT)).toHaveCount(0);
    // Every anchor eventually mounts; the run was frozen when the tour opened.
    for (const anchor of CANONICAL_ANCHORS) {
      await expect(
        launched.page.locator(`[data-tour="${anchor}"]`)
      ).toBeVisible({ timeout: STEP_BUDGET_MS });
    }

    // The arm's own gate, read back rather than assumed — this is the exact
    // check whose absence let an earlier revision of this spec wait 36s on a
    // run that could never open.
    //
    // ISS-11204 split the pair. `dashboardTourSeenStorageKey` is the half that
    // still gates the walk below: while it is unwritten the tour is OWED, and
    // that is what makes the run openable at all. The onboarded latch is no
    // longer a statement about whether the tour can open — it is written by
    // `arm()` itself, and the arm now fires as soon as the page has rows
    // instead of waiting on the reveal, the backfill settle and all three
    // insights. On this profile it has therefore ALREADY fired by here, where
    // it used to be held indefinitely by a dashboard that pending analytics
    // kept in its Loading state.
    //
    // Both are asserted rather than one dropped: the seen-marker as the
    // precondition it still is, and the onboarded latch as the positive pin on
    // the immediate arm, so a regression back to the held arm reddens here
    // instead of silently restoring the old timing.
    await expect(async () => {
      const [onboarded, tourSeen] = await launched.page.evaluate(
        (keys) => keys.map((key) => localStorage.getItem(key)),
        [dashboardOnboardedStorageKey, dashboardTourSeenStorageKey]
      );
      expect(onboarded).toBe("1");
      expect(tourSeen).toBeNull();
    }).toPass({ timeout: ARM_BUDGET_MS });

    // The armed run lands on `stats`, which is its opening beat since
    // ISS-10546 retired the intro summary card that used to precede it.
    await openTour(launched.page);
    await advanceTo(launched.page, CANONICAL_STEP_TITLES.impact);
    await launched.page.getByRole("button", { name: "Next" }).click();
    const activityStep = launched.page.getByRole("dialog", {
      name: CANONICAL_STEP_TITLES.activity,
    });
    const sessionsStep = launched.page.getByRole("dialog", {
      name: CANONICAL_STEP_TITLES.sessions,
    });
    // ISS-8351: a target not measurable when the tour activates is omitted.
    // The resolver suite pins both six- and five-step inventories.
    await expect(activityStep.or(sessionsStep)).toBeVisible();
    if (await activityStep.isVisible()) {
      await expectStep(launched.page, CANONICAL_STEP_TITLES.activity);
      await advanceTo(launched.page, CANONICAL_STEP_TITLES.sessions);
    } else {
      await expectStep(launched.page, CANONICAL_STEP_TITLES.sessions);
    }
    await advanceTo(launched.page, CANONICAL_STEP_TITLES.models);
    await advanceTo(launched.page, CANONICAL_STEP_TITLES.prs);

    // Scoped to the tour callout. The dashboard title row carries a standing
    // "Create account" of its own (PLN-1600 Step D), so a page-wide locator
    // matches two buttons here. Unlike the organization gate — which keeps the
    // header deliberately LIVE, so a duplicate there was genuinely clickable
    // and led somewhere else — the tour dims and covers the page behind it, so
    // the standing offer stays mounted and this names the one being tested.
    const finalStep = launched.page.getByRole("dialog", {
      name: CANONICAL_STEP_TITLES.prs,
    });
    // Pull requests is the LAST beat, not merely a beat: the run would offer
    // "Next" if anything followed it, so this bounds the present-anchor walk.
    await expect(finalStep.getByRole("button", { name: "Next" })).toHaveCount(
      0
    );
    // The button says what it does: "Done" would describe closing the tour,
    // which is not what this press produces.
    await expect(
      finalStep.getByRole("button", {
        name: DASHBOARD_TOUR_DEFAULT_COMPLETE_LABEL,
      })
    ).toHaveCount(0);
    await finalStep.getByRole("button", { name: GUEST_FINISH_LABEL }).click();

    // ISS-11480: the press reopens the guided onboarding at its Account step,
    // located by the method the step renders rather than by its heading.
    const accountStep = launched.page.getByRole("dialog").filter({
      has: launched.page.getByRole("button", { name: AUTH_GITHUB_LABEL }),
    });
    await expect(accountStep).toBeVisible({ timeout: STEP_BUDGET_MS });
    await expect(
      accountStep.getByRole("button", { name: AUTH_GOOGLE_LABEL })
    ).toBeVisible();
    await expect(
      accountStep.getByRole("textbox", { name: AUTH_EMAIL_FIELD_LABEL })
    ).toBeVisible();
    // The retired standalone offer was a dialog of its own, with its own
    // decline. The Account step is the only dialog on the page, so that offer
    // is not in front of it.
    await expect(launched.page.getByRole("dialog")).toHaveCount(1);

    // Press a method. Asserting the buttons merely EXIST would stay green if the
    // handoff broke — this proves the press reaches `beginSignIn`. The system
    // browser hand-off is refused so the run settles here instead of opening a
    // real browser and parking the step on a redirect; BOTH ends are proof the
    // press ran: the method goes busy, or the step reports the failed launch.
    // The idle step shows neither.
    await launched.app.evaluate(({ shell }) => {
      shell.openExternal = () =>
        Promise.reject(new Error("e2e: no system browser"));
    });
    await accountStep.getByRole("button", { name: AUTH_GITHUB_LABEL }).click();
    await expect(
      accountStep
        .locator('button[aria-busy="true"]')
        .or(accountStep.getByRole("alert"))
    ).toBeVisible({ timeout: STEP_BUDGET_MS });

    // A guest is never trapped: Back closes the step and leaves them on the
    // dashboard they were just shown, which is the point of guest mode.
    await accountStep.getByRole("button", { name: BACK_LABEL }).click();
    await expect(launched.page.getByRole("dialog")).toHaveCount(0, {
      timeout: STEP_BUDGET_MS,
    });
    await expect(
      launched.page.getByRole("heading", {
        exact: true,
        level: 1,
        name: DASHBOARD_HEADING,
      })
    ).toBeVisible();
  } finally {
    await launched.cleanup();
    removeDirs([userDataDir, ...homes.dirs]);
  }
});

/**
 * ISS-12110, Marisol Ashgrove's 2026-10-07 ruling: "go to the next beat once the
 * data for that beat is ready". The renderer suites mock `Tour` or hand it the
 * readiness callback directly; this is the launched-app half, where the Agents
 * read is genuinely outstanding in the main process and the control under test
 * is the real Next button.
 *
 * `stats` reads Delivery and Utilization, so the run still opens on it; the
 * `impact` beat that follows reads Agents, so Next on `stats` is what the held
 * read must stop.
 */
test("ISS-12110: Next holds on the current beat until the next beat's Agents read lands", async () => {
  test.setTimeout(300_000);

  const homes = createHarnessHomes();
  // Same owed-tour profile as the present-anchor walk above, and for the same
  // reasons.
  const userDataDir = await seedOnboardedProfile(
    "desktop-tour-agents-hold-",
    homes.env,
    { markOnboarded: false, markTourSeen: false }
  );
  const seededAt = new Date(Date.now() - TOUR_SESSION_AGE_MS).toISOString();
  expectFixtureInsideDefaultDateWindow(seededAt, "agents-hold tour activity");
  await seedSessionsList(userDataDir, [
    {
      sessionId: GUEST_SEED_SESSION_ID,
      at: seededAt,
      name: "ISS-12110 agents-hold tour seed",
    },
  ]);
  const launched = await launchDesktopApp({
    beforeLaunch: clearE2eFeatureFlagAssignment,
    env: homes.env,
    insightsSectionHold: InsightsSection.Agents,
    userDataDir,
  });

  try {
    await openTour(launched.page);
    const statsStep = launched.page.getByRole("dialog", {
      name: CANONICAL_STEP_TITLES.stats,
    });
    const next = statsStep.getByRole("button", { name: "Next" });

    // The read is genuinely outstanding, not merely slow: the main process is
    // holding it.
    await expect
      .poll(async () => (await readInsightsSectionHold(launched.app)).parked, {
        message: "the dashboard's Agents read reached the main process",
        timeout: STEP_BUDGET_MS,
      })
      .toBeGreaterThan(0);

    // THE HOLD. The pending state is on the real control, and pressing it does
    // nothing: `force` skips Playwright's own aria-disabled actionability wait
    // so the press actually lands on the button.
    await expect(next).toHaveAttribute("aria-disabled", "true");
    await next.click({ force: true });
    await expectStep(launched.page, CANONICAL_STEP_TITLES.stats);
    await expect(
      launched.page.getByRole("dialog", { name: CANONICAL_STEP_TITLES.impact })
    ).toHaveCount(0);
    await expect(next).toHaveAttribute("aria-disabled", "true");
    // Still held after the press, so nothing above raced a landing read.
    expect(
      (await readInsightsSectionHold(launched.app)).parked
    ).toBeGreaterThan(0);

    // THE RELEASE. The same control comes out of its pending state on the
    // read's arrival alone, and advances to the beat it was holding.
    await releaseInsightsSectionHold(launched.app);
    await expect(next).toHaveAttribute("aria-disabled", "false", {
      timeout: STEP_BUDGET_MS,
    });
    await advanceTo(launched.page, CANONICAL_STEP_TITLES.impact);
    expect(launched.pageErrors).toEqual([]);
  } finally {
    await launched.cleanup();
    removeDirs([userDataDir, ...homes.dirs]);
  }
});

/**
 * ISS-9728 (review, davetho): the no-session guest, who must NOT be recorded
 * as having seen a tour that had nothing to show them.
 *
 * This is the profile a normal first launch actually has, and the one the
 * sibling above pays a session seed to get out of. The empty branch replaces the
 * dashboard body, so not one of the six canonical anchors exists.
 *
 * ISS-10546 closed both roads to the write rather than one. The run used to
 * resolve to Desktop's intro card alone, whose own "Take a quick tour" was the
 * LAST press of a one-step run; the auto-arm refused to open it, but the
 * header's replay control did not go through the arm and could still put that
 * card on screen. ISS-10929 retired that control outright, so the arm is the
 * only way in and it gates on the run's own `[data-tour]` anchors. What must
 * hold writes nothing — `dashboardTourSeenStorageKey` retires the tour, and for
 * a guest there is no server record that can ever arrive to correct it.
 *
 * Only the first-launch latch is seeded here. Seeding the tour-seen key too —
 * which every other test in this file does, to keep an auto-armed tour off the
 * replayed one — would seed the exact value being asserted absent.
 */
test("ISS-9728: a guest with no sessions is not recorded as having seen the tour", async () => {
  test.setTimeout(240_000);

  const homes = createHarnessHomes();
  const userDataDir = await seedOnboardedProfile(
    "desktop-tour-empty-",
    homes.env,
    { markTourSeen: false }
  );
  const launched = await launchDesktopApp({
    // Same removal as the sibling above, and for the same reason.
    beforeLaunch: clearE2eFeatureFlagAssignment,
    userDataDir,
    env: homes.env,
  });

  try {
    await gotoNav(launched.page, "dashboard");
    await expect(
      launched.page.getByRole("heading", {
        exact: true,
        level: 1,
        name: DASHBOARD_HEADING,
      })
    ).toBeVisible({ timeout: STEP_BUDGET_MS });
    // The empty branch really is what rendered — without this the anchor checks
    // below could pass on a page that was merely still loading.
    await expect(launched.page.getByText(DASHBOARD_EMPTY_TEXT)).toBeVisible({
      timeout: STEP_BUDGET_MS,
    });
    for (const anchor of CANONICAL_ANCHORS) {
      await expect(
        launched.page.locator(`[data-tour="${anchor}"]`)
      ).toHaveCount(0);
    }

    // ISS-10929 retired the header's replay control, so there is no press left
    // to refuse — and the auto-arm, which is what this test exercises, now
    // gates on the run's own `[data-tour]` anchors rather than the control's
    // dock. This page draws none of them, so nothing arms and no tour paints
    // itself: the blocker the engine lays behind every step is absent, and the
    // control it used to dock into is gone from the page entirely.
    await expect(launched.page.locator(TOUR_DOCK_SELECTOR)).toHaveCount(0);
    await expect(launched.page.locator(TOUR_BLOCKER_SELECTOR)).toHaveCount(0);

    // The invariant. Read after the page has settled on its empty branch and
    // the control has reported its refusal, so this is a settled state rather
    // than a race: `closeTour` — the only writer of this key — decides
    // synchronously, and nothing here ever opened a run for it to close.
    await expect(
      launched.page.evaluate(
        (key) => localStorage.getItem(key),
        dashboardTourSeenStorageKey
      )
    ).resolves.toBeNull();
    // And no Account step off a run that never opened: the handoff fires on
    // the last step's press, and this page has no step and a control that
    // refuses the press.
    await expect(
      launched.page.getByRole("button", { name: AUTH_GITHUB_LABEL })
    ).toHaveCount(0);
    await expect(
      launched.page.getByRole("heading", {
        exact: true,
        level: 1,
        name: DASHBOARD_HEADING,
      })
    ).toBeVisible();
  } finally {
    await launched.cleanup();
    removeDirs([userDataDir, ...homes.dirs]);
  }
});

/**
 * Isolated harness homes so the operator's (or the runner's) real Claude/Codex
 * transcripts are never imported — the intro summary's harness row is asserted
 * ABSENT above, and one stray real session would make that a false failure.
 */
function createHarnessHomes(): {
  env: Record<string, string>;
  dirs: string[];
} {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-tour-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-tour-codex-")
  );
  return {
    env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
    dirs: [claudeHome, codexHome],
  };
}

function removeDirs(dirs: string[]): void {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Boot once to create the profile, mark the first-launch reveal (and, by
 * default, the tour) as already seen, and shut down. The relaunch then renders
 * the dashboard without an auto-armed tour competing with the replayed one.
 *
 * The two flags are the two halves of the first-launch arm's own gate, and a
 * caller that wants the arm to FIRE has to clear both.
 *
 * `markTourSeen: false` leaves the tour owed. `markOnboarded: false` leaves the
 * launch first — `useTourArming` returns on `!firstLaunch` before it reads the
 * standing at all, so seeding the onboarded latch silences the arm however the
 * tour stands. Either one alone therefore keeps the arm shut.
 *
 * The seeding launch below always draws the EMPTY dashboard — it has no
 * anchored beat, so the arm holds rather than opening, and holds WITHOUT
 * writing either latch — and what the caller does next decides whether it ever
 * fires: seed rows and the launch under test gets the armed run (ISS-9728's
 * present-anchor walk), seed none and it keeps holding (the sibling case, which
 * asserts the tour-seen key absent).
 *
 * The schema wait is what makes the profile SEEDABLE while the app is down: the
 * db host migrates asynchronously after launch, so a caller that writes rows
 * straight after this returns would otherwise race the migration.
 */
async function seedOnboardedProfile(
  prefix: string,
  env: Record<string, string>,
  {
    markOnboarded = true,
    markTourSeen = true,
  }: { markOnboarded?: boolean; markTourSeen?: boolean } = {}
): Promise<string> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const first = await launchDesktopApp({
    userDataDir,
    keepUserDataDir: true,
    env,
  });
  try {
    await waitForBranchesSchema(userDataDir);
    await gotoNav(first.page, "dashboard");
    const seedKeys = [
      ...(markOnboarded ? [dashboardOnboardedStorageKey] : []),
      ...(markTourSeen ? [dashboardTourSeenStorageKey] : []),
    ];
    await first.page.evaluate((keys) => {
      for (const key of keys) {
        localStorage.setItem(key, "1");
      }
    }, seedKeys);
  } finally {
    await first.cleanup();
  }
  return userDataDir;
}

/**
 * Wait for the Dashboard's first-launch tour to arm itself.
 *
 * ISS-10929 retired the header control this used to press, so there is no
 * replay affordance left and the arm is the tour's only door. The caller seeds
 * the profile with the tour UNSEEN and lays the rows the beats anchor on, so
 * the arm fires on this launch; nothing here presses anything.
 */
async function openTour(page: Page): Promise<void> {
  await gotoNav(page, "dashboard");
  await expect(
    page.getByRole("heading", {
      exact: true,
      level: 1,
      name: DASHBOARD_HEADING,
    })
  ).toBeVisible({ timeout: STEP_BUDGET_MS });
  // ISS-10546: the run opens ON the first anchored beat. The intro summary card
  // that used to lead it is retired. On the ARM's budget, not a step's: nothing
  // is pressed here, so this waits out the whole arm.
  await expectStep(page, CANONICAL_STEP_TITLES.stats, ARM_BUDGET_MS);
}

/**
 * The tour callout exposes each step as a dialog named by its title.
 *
 * Counted as well as read, on the SAME locator: a name that matches nothing
 * fails a visibility wait only after the full budget, and would satisfy any
 * absence assertion forever. `toHaveCount(1)` says the callout is there exactly
 * once, so a second run painted over the first fails here rather than passing.
 */
async function expectStep(
  page: Page,
  title: string,
  timeout: number = STEP_BUDGET_MS
): Promise<void> {
  const step = page.getByRole("dialog", { name: title });
  await expect(step).toBeVisible({ timeout });
  await expect(step).toHaveCount(1);
}

/**
 * Press "Next" and wait for the step it should land on. Naming the destination
 * (rather than counting presses) is what makes the dropped spotlight visible in
 * the diff of this file.
 */
async function advanceTo(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "Next" }).click();
  await expectStep(page, title);
}
