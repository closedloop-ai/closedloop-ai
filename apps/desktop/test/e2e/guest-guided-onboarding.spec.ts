/**
 * E2E regression (ISS-10195 follow-up): a SIGNED-OUT guest reaches the guided
 * onboarding modal in the launched app.
 *
 * ISS-10195 retired the `workspace-experience-v2` gate so that "even guest
 * users on desktop get onboarding experience v2". Removing the gate did not
 * reach them: the modal is opened by a server-owned run, and
 * `useGuidedOnboardingSnapshot` gates its query on `userId !== null`, so a
 * guest never fired the request and the dialog stayed closed for want of a
 * snapshot rather than because of any phase.
 *
 * Would fail before the change: the dashboard renders, and the welcome modal
 * never appears for a profile that has not signed in.
 *
 * A renderer test cannot prove this one. The defect was the absence of a
 * network read in a real signed-out profile, so it only exists in an app that
 * actually booted without an account.
 *
 * ISS-11397 rides the first case rather than adding a third launch: the welcome
 * step it already proves is on screen is the one carrying the "Full Privacy
 * Policy" anchor, and the href plus the `shell.openExternal` hand-off are only
 * observable in a launched app.
 *
 * The Dashboard tour is suppressed by seeding its two storage keys — an
 * auto-armed tour renders its own modal callout, and this spec must not pass
 * because a DIFFERENT overlay happened to be on screen. The guest guided-run
 * key is deliberately NOT seeded: its absence is the first-run state.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase.ts";
import { DESKTOP_WELCOME_CTA_LABEL } from "@repo/app/onboarding/components/guided-onboarding-welcome-copy.ts";
import { DEFAULT_WEB_ORIGIN } from "@repo/app/onboarding/lib/legal-links.ts";
import { LEGAL_PRIVACY_PATH } from "@repo/app/shared/lib/legal-links.ts";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
  desktopGuestGuidedOnboardingStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import { launchElectronOrExplain } from "./helpers/electron-launch-attribution";
import {
  installOpenExternalSpy,
  openedUrls,
} from "./helpers/open-external-spy";
import { seedClaudeTranscripts } from "./helpers/seed";

const WELCOME_HEADING = "Discover how you (and your team) build with AI.";
/**
 * The Session Discovery step's eyebrow — the phase a started guest run resumes
 * at. The eyebrow rather than the title or description, which
 * `getAnalysisTitle` / `getAnalysisDescription` vary by how much the analyzer
 * has found; the phase label does not.
 */
const SESSION_DISCOVERY_EYEBROW = "Session discovery";
/** The Account step's own eyebrow — where Continue must land. */
const ACCOUNT_EYEBROW = "Create your account";
const CONTINUE_BUTTON = "Continue";
/**
 * The persisted CURSOR after Continue — `"phase":"account"`, matched as the
 * field rather than a bare `account`, which also occurs inside `accountProvider`.
 */
const PERSISTED_ACCOUNT_PHASE = new RegExp(
  `"phase"\\s*:\\s*"${OnboardingPhase.Account}"`
);
const STEP_BUDGET_MS = 30_000;
/**
 * ISS-11397 (@tamsinb): the href the welcome step's "Full Privacy Policy"
 * anchor must carry INSIDE THE RENDERER, composed from the two constants rather
 * than by calling `privacyPolicyHref()` here — this spec's own process HAS
 * `process`, so calling it would read `NEXT_PUBLIC_WEB_URL` and could agree with
 * a renderer that had taken the other branch. Composing the expectation is what
 * makes the assertion evidence that the bundle took the no-`process` branch.
 */
const EXPECTED_DESKTOP_PRIVACY_HREF = `${DEFAULT_WEB_ORIGIN}${LEGAL_PRIVACY_PATH}`;
const PRIVACY_LINK_NAME = "Full Privacy Policy";

test("ISS-10195: a signed-out guest reaches the guided onboarding modal, whose privacy link (ISS-11397) opens externally", async () => {
  test.setTimeout(240_000);

  const homes = createHarnessHomes();
  const userDataDir = await seedGuestProfile(
    "desktop-guest-guided-onboarding-",
    homes.env
  );
  const launched = await launchDesktopApp({
    env: homes.env,
    keepFirstRunState: true,
    userDataDir,
  });

  try {
    await gotoNav(launched.page, "dashboard");

    // The modal itself, not merely some overlay: the welcome copy plus the
    // DESKTOP wording of the primary action (web says "Get Started").
    await expect(
      launched.page.getByRole("heading", { name: WELCOME_HEADING })
    ).toBeVisible({
      timeout: STEP_BUDGET_MS,
    });
    await expect(
      launched.page.getByRole("button", { name: DESKTOP_WELCOME_CTA_LABEL })
    ).toBeVisible({ timeout: STEP_BUDGET_MS });

    // ISS-11397 (@tamsinb): the legal link, through the launched app rather
    // than a renderer suite. Two halves, and neither unit lane can reach either:
    // the rendered href proves the desktop bundle resolved the default with no
    // `process` global, and the recorded `shell.openExternal` call proves the
    // real `setWindowOpenHandler` + `isAllowedRendererExternalUrl` pair admitted
    // it instead of silently denying the open. Before the fix the href was
    // root-relative, which resolves against `app://` here — a link that looks
    // live and reaches bundled assets only.
    await installOpenExternalSpy(launched.app);
    const privacyLink = launched.page.getByRole("link", {
      name: PRIVACY_LINK_NAME,
    });
    await expect(privacyLink).toBeVisible({ timeout: STEP_BUDGET_MS });
    await expect(privacyLink).toHaveAttribute(
      "href",
      EXPECTED_DESKTOP_PRIVACY_HREF
    );

    await privacyLink.click();
    await expect
      .poll(() => openedUrls(launched.app), { timeout: 10_000 })
      .toContain(EXPECTED_DESKTOP_PRIVACY_HREF);

    // Starting the run advances the guest off Welcome and persists it, which is
    // what proves the local run is driving rather than a static render.
    await launched.page
      .getByRole("button", { name: DESKTOP_WELCOME_CTA_LABEL })
      .click();
    await expect(
      launched.page.getByRole("heading", { name: WELCOME_HEADING })
    ).toBeHidden({
      timeout: STEP_BUDGET_MS,
    });
    const stored = await launched.page.evaluate(
      (key) => localStorage.getItem(key),
      desktopGuestGuidedOnboardingStorageKey
    );
    expect(stored).not.toBeNull();
  } finally {
    await launched.cleanup();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    removeDirs(homes.dirs);
  }
});

test("ISS-10195: a signed-out guest's started run resumes across a relaunch", async () => {
  test.setTimeout(300_000);

  const homes = createHarnessHomes();
  const userDataDir = await seedGuestProfile(
    "desktop-guest-guided-resume-",
    homes.env
  );

  try {
    const first = await launchDesktopApp({
      env: homes.env,
      keepFirstRunState: true,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await gotoNav(first.page, "dashboard");
      await first.page
        .getByRole("button", { name: DESKTOP_WELCOME_CTA_LABEL })
        .click({ timeout: STEP_BUDGET_MS });
      // Anchor on the step the run actually moved to before shutting down. A
      // bare "Welcome is hidden" would also be satisfied by the dialog closing.
      await expect(first.page.getByText(SESSION_DISCOVERY_EYEBROW)).toBeVisible(
        { timeout: STEP_BUDGET_MS }
      );
    } finally {
      await first.cleanup();
    }

    // A REAL relaunch of the same profile. Same-session state would prove
    // nothing about the record that has to survive a restart, which is the
    // whole reason a guest's run is stored as a POSITION and not a seen-it bit.
    const second = await launchDesktopApp({
      env: homes.env,
      keepFirstRunState: true,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await gotoNav(second.page, "dashboard");
      await expect(
        second.page.getByText(SESSION_DISCOVERY_EYEBROW)
      ).toBeVisible({ timeout: STEP_BUDGET_MS });
      // And it resumed rather than restarting: Welcome is the state a lost or
      // unreadable record folds to, so its ABSENCE is what separates a real
      // resume from a first run that merely happens to open a dialog.
      await expect(
        second.page.getByRole("heading", { name: WELCOME_HEADING })
      ).toBeHidden({
        timeout: STEP_BUDGET_MS,
      });
    } finally {
      await second.cleanup();
    }
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    removeDirs(homes.dirs);
  }
});

/**
 * ISS-10539 regression: Continue actually LEAVES Session Discovery.
 *
 * The two specs above reach this step and resume onto it; neither ever pressed
 * its button, and that gap is why the defect shipped. `analysisHasStarted` read
 * only `progress` and `settled` and never the inventory beside them, so on a
 * machine with sessions enumerated and no analyzed read settled it refused the
 * transition — while the step's own gate, which fails OPEN on unknown progress,
 * left the button enabled. Enabled button, refusing machine, swallowed press.
 *
 * THE SEEDED CORPUS IS LOAD-BEARING, and it is what makes this spec able to
 * fail. An empty CLAUDE_HOME enumerates nothing, so the discovery folds to
 * `unknown` and the import settles immediately — and `settled` alone opens the
 * guard, on the fixed build and the broken one alike. Seeding real transcripts
 * is what puts a `measured` inventory in front of an unsettled import, which is
 * the only state that separates them.
 *
 * Asserted on the persisted record as well as the screen: the phase has to move
 * off `session_discovery` and stay moved, which a re-render of the next step
 * alone would not prove.
 */
test("ISS-10539: a guest's Continue advances off Session Discovery", async () => {
  test.setTimeout(240_000);

  const homes = createHarnessHomes();
  seedClaudeTranscripts(homes.env.CLAUDE_HOME, [
    { sessionId: "iss-10539-a", slug: "iss-10539-a" },
    { sessionId: "iss-10539-b", slug: "iss-10539-b" },
    { sessionId: "iss-10539-c", slug: "iss-10539-c" },
  ]);
  const userDataDir = await seedGuestProfile(
    "desktop-guest-guided-continue-",
    homes.env
  );
  const launched = await launchDesktopApp({
    env: homes.env,
    keepFirstRunState: true,
    userDataDir,
  });

  try {
    await gotoNav(launched.page, "dashboard");
    await launched.page
      .getByRole("button", { name: DESKTOP_WELCOME_CTA_LABEL })
      .click({ timeout: STEP_BUDGET_MS });
    await expect(
      launched.page.getByText(SESSION_DISCOVERY_EYEBROW)
    ).toBeVisible({ timeout: STEP_BUDGET_MS });

    await launched.page
      .getByRole("button", { name: CONTINUE_BUTTON })
      .click({ timeout: STEP_BUDGET_MS });

    await expect(launched.page.getByText(ACCOUNT_EYEBROW)).toBeVisible({
      timeout: STEP_BUDGET_MS,
    });
    await expect(launched.page.getByText(SESSION_DISCOVERY_EYEBROW)).toBeHidden(
      { timeout: STEP_BUDGET_MS }
    );

    // ISS-11204: "Restore persistent, visible Sign in and Skip for now controls
    // while retaining the email CTA." Those are two different requirements and
    // this pins each as what it is.
    //
    // PERSISTENT is the structural half, and it is the one worth asserting:
    // the step layout moved both controls OUT of the scrolling region into a
    // `shrink-0` row of the frame, so no amount of scrolling and no viewport
    // height can take them away. A `toBeInViewport` ratio alone would not say
    // that — it would pass on a tall window over a body that still owned them.
    //
    // The email CTA is deliberately NOT held to the same bar. It lives inside
    // the scroll region with the other two auth methods, which is exactly why
    // the persistent row exists; on a 768px-tall window the account step's
    // header, description and three methods exceed the region and the last of
    // them scrolls, by design. It is asserted as RETAINED and reachable.
    await launched.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1024, 768);
    });
    for (const name of ["Sign in", "Skip for now"]) {
      const action = launched.page.getByRole("button", { name, exact: true });
      await expect(action).toBeInViewport({ ratio: 1 });
      // Outside the scrolling region — the property a ratio cannot state.
      await expect(
        action.locator(`xpath=ancestor::*[contains(@class,"overflow-y-auto")]`)
      ).toHaveCount(0);
      await action.click({ trial: true });
    }
    // RETAINED, which is a different requirement from persistent — and the
    // structural COMPLEMENT of the two above, which is what gives this pair its
    // teeth. The email CTA belongs to the scrolling region with the other two
    // auth methods; the two alternatives must not. Move either across that
    // boundary and one of these two assertions reddens, at any window size.
    //
    // No viewport ratio here, and that is deliberate rather than a relaxation:
    // the ticket asks for "persistent, visible Sign in and Skip for now
    // controls while RETAINING the email CTA". A ratio on a control that lives
    // inside an `overflow-y-auto` region is a claim about the window's height,
    // not about the product — and on a 768px window the account step's header,
    // description and three methods genuinely exceed that region, which is the
    // whole reason the persistent row exists.
    const emailCta = launched.page.getByRole("button", {
      name: "Create account with email",
      exact: true,
    });
    // Visible, not enabled: it is the email form's submit and stays disabled
    // until an address is typed, which is correct and is not what "retained"
    // means.
    await expect(emailCta).toBeVisible();
    await expect(
      emailCta.locator('xpath=ancestor::*[contains(@class,"overflow-y-auto")]')
    ).not.toHaveCount(0);

    await launched.page.screenshot({
      path: test.info().outputPath("account-controls.png"),
    });

    await launched.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(900, 620);
    });
    for (const name of ["Sign in", "Skip for now"]) {
      const action = launched.page.getByRole("button", { name, exact: true });
      await expect(action).toBeInViewport({ ratio: 1 });
      await action.click({ trial: true });
    }

    // The PHASE field, not the record text: `history` keeps
    // `session_discovery` forever by design, so a substring check on the whole
    // record can never go green and would not be reading the cursor anyway.
    await expect
      .poll(
        () =>
          launched.page.evaluate(
            (key) => localStorage.getItem(key),
            desktopGuestGuidedOnboardingStorageKey
          ),
        { timeout: STEP_BUDGET_MS }
      )
      .toMatch(PERSISTED_ACCOUNT_PHASE);
  } finally {
    await launched.cleanup();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    removeDirs(homes.dirs);
  }
});

function createHarnessHomes(): {
  env: Record<string, string>;
  dirs: string[];
} {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-guest-guided-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-guest-guided-codex-")
  );
  return {
    dirs: [claudeHome, codexHome],
    env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
  };
}

function removeDirs(dirs: string[]): void {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Boot once to create a signed-out profile and mark the first-launch reveal and
 * the tour as already seen, then shut down. The relaunch renders the dashboard
 * with no auto-armed tour competing for the screen — and with no guest guided
 * onboarding record, which is the first-run state under test.
 */
async function seedGuestProfile(
  prefix: string,
  env: Record<string, string>
): Promise<string> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const first = await launchDesktopApp({
    env,
    keepFirstRunState: true,
    keepUserDataDir: true,
    userDataDir,
  });
  try {
    await gotoNav(first.page, "dashboard");
    await first.page.evaluate(
      ([tourSeenKey, guestRunKey, onboardedKey]) => {
        localStorage.setItem(tourSeenKey, "1");
        // NOT the first-launch latch. The guided run arms only on a first run
        // and reads that same key, so seeding it here would suppress the very
        // modal these specs exist to assert. The tour key alone is what stops a
        // competing overlay.
        localStorage.removeItem(onboardedKey);
        localStorage.removeItem(guestRunKey);
      },
      [
        dashboardTourSeenStorageKey,
        desktopGuestGuidedOnboardingStorageKey,
        dashboardOnboardedStorageKey,
      ]
    );
  } finally {
    await first.cleanup();
  }
  return userDataDir;
}

test("ISS-10539: measured zero advances only after the producer starts a pass", async () => {
  test.setTimeout(240_000);
  const homes = createHarnessHomes();
  const userDataDir = await seedGuestProfile(
    "desktop-guest-measured-zero-",
    homes.env
  );
  const preload = fileURLToPath(
    new URL(
      "./helpers/onboarding-discovery-lifecycle-preload.cjs",
      import.meta.url
    )
  );
  const launched = await launchDesktopApp({
    env: homes.env,
    keepFirstRunState: true,
    userDataDir,
    launchElectron: (options) =>
      launchElectronOrExplain(
        {
          ...options,
          args: ["-r", preload, ...(options?.args ?? [])],
        },
        (prepared) => electron.launch(prepared)
      ),
  });
  try {
    await gotoNav(launched.page, "dashboard");
    await launched.page
      .getByRole("button", { name: DESKTOP_WELCOME_CTA_LABEL })
      .click({ timeout: STEP_BUDGET_MS });
    const dialog = launched.page.getByRole("dialog");
    await expect(dialog.getByText("950 found · 0 analyzed")).toBeVisible({
      timeout: STEP_BUDGET_MS,
    });
    await expect(
      dialog.getByRole("progressbar", { name: "Overall import progress" })
    ).toHaveAttribute("aria-valuenow", "0");
    const next = dialog.getByRole("button", { name: "Continue", exact: true });
    await expect(next).toBeDisabled();
    await launched.app.evaluate(() => {
      const gate: { started: boolean } | undefined = Reflect.get(
        globalThis,
        "__clE2eOnboardingDiscovery"
      );
      if (!gate) {
        throw new Error("onboarding lifecycle preload was not installed");
      }
      gate.started = true;
    });
    await expect(next).toBeEnabled({ timeout: STEP_BUDGET_MS });
    await expect(dialog.getByText("950 found · 0 analyzed")).toBeVisible();
    await next.click();
    await expect(
      dialog.getByRole("button", { name: "Continue with GitHub" })
    ).toBeVisible({ timeout: STEP_BUDGET_MS });
    await expect(dialog.getByText(SESSION_DISCOVERY_EYEBROW)).toBeHidden();
    expect(launched.pageErrors).toEqual([]);
  } finally {
    await launched.cleanup();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    removeDirs(homes.dirs);
  }
});
