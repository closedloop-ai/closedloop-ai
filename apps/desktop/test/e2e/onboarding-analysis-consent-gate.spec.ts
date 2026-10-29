/**
 * ISS-10950: the real boot import and the live hook listener stay held while
 * the Welcome modal is unanswered, and Welcome's Start releases them.
 *
 * The sync choice gates only cloud/web synchronization, never local parsing
 * (operator ruling, Marisol Ashgrove, 2026-10-20). So a fresh install whose sync
 * choice is unset imports locally after Start, discovery's Continue enables,
 * and the recorded sync tier stays unset: nothing is cleared for upload.
 * Sync policy follows Create organization, so a guest never sees it here.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { serializeOnboardingState } from "@repo/api/src/types/onboarding-persistence.ts";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase.ts";
import { DESKTOP_WELCOME_CTA_LABEL } from "@repo/app/onboarding/components/guided-onboarding-welcome-copy.ts";
import { harnessDisplayLabel } from "@repo/app/onboarding/lib/harness-display-label.ts";
import { Harness } from "@repo/lib/harness/types.ts";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
  desktopGuestGuidedOnboardingStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import type { DesktopApi } from "../../src/renderer/types/desktop-api";
import {
  gotoNav,
  launchDesktopApp,
  seedDesktopSettings,
} from "./helpers/desktop-app";
import { seedClaudeTranscripts } from "./helpers/seed";
import {
  countHarnessSessionRows,
  SeedHarness,
} from "./helpers/seed-harness-sessions-db";

const WELCOME_HEADING = "Discover how you (and your team) build with AI.";
const START_BUTTON = DESKTOP_WELCOME_CTA_LABEL;
const SESSION_DISCOVERY_EYEBROW = "Session discovery";
const CONTINUE_BUTTON = "Continue";
/** ISS-11346: every source the boot collectors scan, named where Start is agreed to. */
const CONSENT_SOURCES_LINE =
  "Only your Claude Code, Codex, Cursor, Copilot, and OpenCode sessions are analyzed.";
/**
 * A scanned source the byte inventory cannot count. ISS-11346 listed it as an
 * unreported row; ISS-11591 retires that row, so it must not be listed at all.
 */
const UNCOUNTED_SOURCE_LABEL = harnessDisplayLabel(Harness.Cursor);
/**
 * The other source the inventory cannot count. This launch switches its
 * collector off (FEA-3741), so it is not scanned and gets no row.
 */
const SWITCHED_OFF_SOURCE_LABEL = harnessDisplayLabel(Harness.Copilot);
/**
 * `DESKTOP_COLLECT_COPILOT_ENABLED_FEATURE_FLAG_KEY`, spelled here for the
 * spec-loader hazard in `test/AGENTS.md`.
 */
const COLLECT_COPILOT_SETTING_KEY = "collectCopilotEnabled";

/** SQLite's own wording, which this repo does not own and must not restate. */
const MISSING_SESSIONS_TABLE = "no such table: sessions";

const STEP_BUDGET_MS = 30_000;
/**
 * How long the first Welcome frame may take, which is not a step budget.
 *
 * The shell holds a "Starting Closedloop" splash until the startup pass reports
 * ready, and on an UNGATED build that pass is waiting out the whole boot import
 * — measured past 30s on this corpus. A step budget here would fail the spec on
 * the splash and never reach the assertions it exists for, which is exactly what
 * the counterfactual run has to reach.
 */
const LAUNCH_BUDGET_MS = 120_000;
const IMPORT_BUDGET_MS = 180_000;
/**
 * How long the store must stay empty before the unanswered Welcome counts as
 * having held. A bounded wait, not a proof of never — the release assertion
 * after Start is what makes this a gate rather than a slow import: the same
 * corpus lands well inside {@link IMPORT_BUDGET_MS} once Start is pressed.
 */
const GATE_HELD_MS = 8000;
/** How often {@link expectStoreHeldEmpty} re-reads across that window. */
const GATE_HELD_POLL_MS = 250;

/** Enough transcripts that an ungated import is unmistakable in the row count. */
const SEEDED_TRANSCRIPTS = 40;
const TRANSCRIPT_PADDING = "seeded consent-gate corpus. ".repeat(80);

test("ISS-10950: the boot import waits for Welcome Start, not for a sync choice", async () => {
  test.setTimeout(600_000);

  const homes = createHarnessHomes();
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-onboarding-consent-gate-")
  );

  try {
    seedClaudeTranscripts(homes.claudeHome, transcripts(SEEDED_TRANSCRIPTS));
    await seedUnconsentedGuestProfile(userDataDir, homes.env);

    const launched = await launchDesktopApp({
      beforeLaunch: (dir) => {
        seedUnansweredConsent(dir);
        seedDesktopSettings(dir, { [COLLECT_COPILOT_SETTING_KEY]: false });
      },
      env: homes.env,
      keepFirstRunState: true,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await gotoNav(launched.page, "dashboard");
      await expect(
        launched.page.getByRole("heading", { name: WELCOME_HEADING })
      ).toBeVisible({
        timeout: LAUNCH_BUDGET_MS,
      });

      await expect(launched.page.getByRole("dialog")).toContainText(
        CONSENT_SOURCES_LINE
      );

      // AC1. Neither the banner nor its bar exists behind the unanswered modal.
      // Asserted as the ROLE rather than the banner's copy: the Welcome step
      // renders no progress element of its own, so any progressbar on this
      // screen is the ambient bar this ticket is about.
      await expect(launched.page.getByRole("progressbar")).toHaveCount(0);
      // AC3, the half a hidden bar would not satisfy.
      await expectStoreHeldEmpty(launched.page, userDataDir);

      await launched.page
        .getByRole("button", { name: START_BUTTON })
        .click({ timeout: STEP_BUDGET_MS });
      await expect(
        launched.page.getByText(SESSION_DISCOVERY_EYEBROW)
      ).toBeVisible({ timeout: STEP_BUDGET_MS });
      await expect(
        launched.page
          .getByRole("dialog")
          .getByRole("radio", { name: "Off", exact: true })
      ).toHaveCount(0);

      await expect
        .poll(() =>
          launched.page.evaluate(
            async () =>
              (await (window.desktopApi as DesktopApi).getAgentMonitorUrl())
                .ready
          )
        )
        .toBe(true);

      await expect
        .poll(() => readCodexConfig(homes.codexHome), {
          timeout: STEP_BUDGET_MS,
        })
        .toContain("[otel]");
      await expectGuestMeshRuntimeActive(launched.page, userDataDir);

      // The same real collector imports with the sync choice still unset.
      await expect(async () => {
        expect(await claudeRows(userDataDir)).toBeGreaterThan(0);
      }).toPass({ timeout: IMPORT_BUDGET_MS });
      await expect(launched.page.getByRole("progressbar").first()).toBeVisible({
        timeout: STEP_BUDGET_MS,
      });

      // ISS-11591, the counterfactual for the ISS-11346 assertion this
      // replaces: Discovery lists ONLY the sources the sweep counted. Neither
      // the uncounted source nor the switched-off one gets a row. Anchored on
      // a row that IS there, so the two absences cannot pass against a dialog
      // that rendered no list at all.
      const dialog = launched.page.getByRole("dialog");
      await expect(
        dialog.getByText(harnessDisplayLabel(Harness.Claude), { exact: true })
      ).toBeVisible({ timeout: STEP_BUDGET_MS });
      await expect(
        dialog.getByText(UNCOUNTED_SOURCE_LABEL, { exact: true })
      ).toHaveCount(0);
      await expect(
        dialog.getByText(SWITCHED_OFF_SOURCE_LABEL, { exact: true })
      ).toHaveCount(0);

      // ISS-10890 AC2. Discovery began, so its Continue is live and leads on.
      await expect(
        launched.page
          .getByRole("dialog")
          .getByRole("button", { name: CONTINUE_BUTTON, exact: true })
      ).toBeEnabled({ timeout: STEP_BUDGET_MS });
      // No sync choice was recorded, so nothing is cleared for cloud upload.
      expect(
        await launched.page.evaluate(() =>
          (window.desktopApi as DesktopApi).getSyncConsentRecord()
        )
      ).toMatchObject({ tier: null });
    } finally {
      await launched.cleanup();
    }
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    removeDirs([homes.claudeHome, homes.codexHome]);
  }
});

/**
 * Hold the store empty across {@link GATE_HELD_MS}, re-reading throughout.
 *
 * Sleeping the window and reading once at the end would say nothing about the
 * interval it spans, which is what AGENTS.md rules out; this fails on the first
 * row either screen lets through, so the two checkpoints together hold the state
 * across the Start click rather than sampling it twice (tamsinb review).
 *
 * A held row count and not the runtime's own status, because no such status is
 * exposed: `getLocalSessionSourceStatus` reports `ready` as soon as the DB
 * runtime exists — which `startAgentCapture` creates BEFORE the gate — and
 * `GetAgentMonitorIngestProgress` returns `null` unconditionally.
 */
async function expectStoreHeldEmpty(
  page: Page,
  userDataDir: string
): Promise<void> {
  const deadline = Date.now() + GATE_HELD_MS;
  do {
    expect(await claudeRows(userDataDir)).toBe(0);
    expect(
      await page.evaluate(() =>
        (window.desktopApi as DesktopApi).getAgentMonitorUrl()
      )
    ).toMatchObject({ ready: false });
    await page.waitForTimeout(GATE_HELD_POLL_MS);
  } while (Date.now() < deadline);
}

/**
 * Claude `sessions` rows this profile holds, counting an absent table as none.
 *
 * Not a tolerated inconclusive read: on a gated first launch the collectors
 * never open the store, so the schema they write through does not exist yet,
 * and that is a STRONGER statement of "nothing has been parsed" than a zero
 * count. The release assertion after Continue is what proves this helper can
 * see a row at all — without it, swallowing the error would pass on a spec that
 * could never count anything.
 */
async function claudeRows(userDataDir: string): Promise<number> {
  try {
    return await countHarnessSessionRows(userDataDir, SeedHarness.Claude);
  } catch (error) {
    if (isMissingSessionsTable(error)) {
      return 0;
    }
    throw error;
  }
}

/** Whether `error`, or anything it wraps, is SQLite's absent-table refusal. */
function isMissingSessionsTable(error: unknown): boolean {
  for (let cursor = error; cursor instanceof Error; cursor = cursor.cause) {
    if (cursor.message.includes(MISSING_SESSIONS_TABLE)) {
      return true;
    }
  }
  return false;
}

/**
 * The state a real first launch is in: the sync-policy question unanswered.
 *
 * Overrides `E2E_DESKTOP_SYNC_CONSENT_SEED`, which every other spec wants —
 * their subject is not onboarding, and a launch that had to walk the wizard
 * first would test the wizard. Layered in `beforeLaunch`, which runs after the
 * standard seed and wins.
 */
function seedUnansweredConsent(userDataDir: string): void {
  seedDesktopSettings(userDataDir, { syncObservabilityTier: null });
}

/**
 * Boot once to mark the dashboard tour as seen, then shut down.
 *
 * Consent is withheld on this launch too, so it imports nothing and leaves the
 * store empty for the assertions above — which also makes it the spec's
 * relaunch case: an unanswered device stays unanswered across a restart.
 *
 * The guest guided-run key and the first-launch latch are REMOVED rather than
 * seeded, for the reason `guest-guided-onboarding.spec.ts` states: their absence
 * is the first-run state, and the tour key alone is what stops a competing
 * overlay from being what the assertions actually see.
 */
async function seedUnconsentedGuestProfile(
  userDataDir: string,
  env: Record<string, string>,
  restoreDiscovery = false
): Promise<void> {
  const first = await launchDesktopApp({
    beforeLaunch: seedUnansweredConsent,
    env,
    keepFirstRunState: true,
    keepUserDataDir: true,
    userDataDir,
  });
  try {
    await gotoNav(first.page, "dashboard");
    await seedTourSeen(first.page);
    if (restoreDiscovery) {
      await first.page.evaluate(
        ([key, value]) => localStorage.setItem(key, value),
        [
          desktopGuestGuidedOnboardingStorageKey,
          JSON.stringify({
            revision: 1,
            state: serializeOnboardingState({
              phase: OnboardingPhase.SessionDiscovery,
              history: [OnboardingPhase.Welcome],
              accountProvider: null,
              organizationEstablished: false,
              resuming: false,
            }),
          }),
        ]
      );
    }
  } finally {
    await first.cleanup();
  }
}

function seedTourSeen(page: Page): Promise<void> {
  return page.evaluate(
    ([tourSeenKey, guestRunKey, onboardedKey]) => {
      localStorage.setItem(tourSeenKey, "1");
      localStorage.removeItem(onboardedKey);
      localStorage.removeItem(guestRunKey);
    },
    [
      dashboardTourSeenStorageKey,
      desktopGuestGuidedOnboardingStorageKey,
      dashboardOnboardedStorageKey,
    ]
  );
}

function createHarnessHomes(): {
  claudeHome: string;
  codexHome: string;
  env: Record<string, string>;
} {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-consent-gate-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-consent-gate-codex-")
  );
  return {
    claudeHome,
    codexHome,
    env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
  };
}

function removeDirs(dirs: string[]): void {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function transcripts(
  count: number
): { sessionId: string; slug: string; userText: string }[] {
  return Array.from({ length: count }, (_unused, index) => ({
    sessionId: `iss10950-consent-gate-${index}`,
    slug: `iss10950-consent-gate-${index}`,
    userText: `consent gate ${index}: ${TRANSCRIPT_PADDING}`,
  }));
}

function readCodexConfig(codexHome: string): string {
  const file = path.join(codexHome, "config.toml");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

test("ISS-12523: an interrupted discovery run resumes at discovery and imports with the sync choice unset", async () => {
  test.setTimeout(600_000);
  const homes = createHarnessHomes();
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-restored-consent-gate-")
  );
  try {
    seedClaudeTranscripts(homes.claudeHome, transcripts(2));
    await seedUnconsentedGuestProfile(userDataDir, homes.env, true);
    const launched = await launchDesktopApp({
      beforeLaunch: (dir) =>
        seedDesktopSettings(dir, {
          syncObservabilityTier: null,
          sessionAnalysisAgreed: true,
        }),
      env: homes.env,
      keepFirstRunState: true,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await gotoNav(launched.page, "dashboard");
      await expect(
        launched.page.getByText(SESSION_DISCOVERY_EYEBROW)
      ).toBeVisible({ timeout: LAUNCH_BUDGET_MS });
      await expect(
        launched.page
          .getByRole("dialog")
          .getByRole("radio", { name: "Off", exact: true })
      ).toHaveCount(0);
      await expect(async () =>
        expect(await claudeRows(userDataDir)).toBeGreaterThan(0)
      ).toPass({ timeout: IMPORT_BUDGET_MS });
      const record = await launched.page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
        desktopGuestGuidedOnboardingStorageKey
      );
      expect(
        await launched.page.evaluate(() =>
          (window.desktopApi as DesktopApi).getSyncConsentRecord()
        )
      ).toMatchObject({ tier: null });
      expect(record).toMatchObject({
        revision: 1,
        state: {
          phase: OnboardingPhase.SessionDiscovery,
          history: [OnboardingPhase.Welcome],
        },
      });
    } finally {
      await launched.cleanup();
    }
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    removeDirs([homes.claudeHome, homes.codexHome]);
  }
});

/**
 * A bound listener and installed hooks also occur when the app's Mesh-ready
 * callback is missing. Only the composed runtime answers this authenticated
 * native hook with the guest's no-context result; an unstarted controller
 * returns only the listener acknowledgement.
 */
async function expectGuestMeshRuntimeActive(
  page: Page,
  userDataDir: string
): Promise<void> {
  const { url } = await page.evaluate(() =>
    (window.desktopApi as DesktopApi).getAgentMonitorUrl()
  );
  if (!url) {
    throw new Error("Expected the consent-released hook listener URL");
  }
  const localToken = fs
    .readFileSync(path.join(userDataDir, "session-mesh", "local-token"), "utf8")
    .trim();
  const response = await fetch(new URL("/api/session-mesh/hook", url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-session-mesh-token": localToken,
    },
    body: JSON.stringify({
      harness: Harness.Claude,
      hook_type: "SessionStart",
      data: { session_id: "consent-gate-mesh" },
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, awaitContext: false });
}
