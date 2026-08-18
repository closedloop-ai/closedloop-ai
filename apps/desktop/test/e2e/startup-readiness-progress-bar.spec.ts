/**
 * E2E regression (ISS-5115): the global startup progress bar, proven through the
 * LAUNCHED app.
 *
 * The renderer render tests cover the panel and the `Progress` primitive in
 * isolation, but every one of them mocks either the Labs flag or the runtime
 * hooks, so none of them proves the bar reaches a real first launch. This spec
 * closes that gap (the launched-app regression `apps/desktop/AGENTS.md` requires
 * for a renderer UI bug fix): it seeds real Claude transcripts so the
 * first-launch backfill genuinely has work to do, turns the Labs flag ON, and
 * asserts the shipped panel renders ONE global bar that reports honestly.
 *
 * Would fail before the fix on two counts:
 *   1. The panel's in-flight state was a status RING taking its accessible name
 *      from the headline, with no progressbar at all. The named
 *      "Desktop startup progress: …" progressbar simply did not exist.
 *   2. The shared `Progress` never forwarded `value` to Radix, so every bar in
 *      the app rendered `data-state="indeterminate"`. Here that state is the
 *      honest answer rather than an accident, and the indicator has to carry the
 *      `progress-hatch` treatment — a bar that says "amount unknown" instead of
 *      an empty track reading as 0% or a solid one reading as 100%.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import { seedClaudeTranscripts } from "./helpers/seed";

/**
 * The `startupReadinessExperience` Labs flag key, pinned as a literal rather
 * than imported from `src/shared/feature-flags`.
 *
 * That module is main-process code importing extension-less TypeScript subpaths
 * of workspace packages, which Playwright's Node loader cannot resolve — one
 * such import aborts the WHOLE Electron e2e run at load time, before any test
 * executes. Sibling specs (`db-ahead-banner`, `sessions-quarantine-caveat`) pin
 * their flag keys for the same reason.
 *
 * Drift is caught: `test/feature-flags.test.ts` asserts the registry defines
 * this exact key, and a key the registry does not register would leave the panel
 * gated OFF and fail this spec loudly rather than silently.
 */
const STARTUP_READINESS_FLAG_KEY = "startupReadinessExperience";

/**
 * The accessible-name prefix built by `startupProgressBarName`, pinned as a
 * literal for the same loader reason. Drift is caught by
 * `startup-readiness-progress.test.ts`, which asserts the built name, and by
 * `startup-readiness-panel.test.tsx`, which queries the bar by it.
 */
const STARTUP_BAR_NAME = /^Desktop startup progress: /;

/** Enough sources that the first-launch backfill is still running at reveal. */
const SEEDED_SESSION_COUNT = 80;

type BarSnapshot = {
  panelPresent: boolean;
  barCount: number;
  barName: string | null;
  /** Absent while indeterminate — the bar must not invent a completion level. */
  ariaValueNow: string | null;
  dataState: string | null;
  indicatorClass: string | null;
  /** The removed in-flight ring took its accessible name from the headline. */
  headline: string | null;
  ringLabelledByHeadline: boolean;
};

test.describe("Startup readiness global progress bar", () => {
  test("replaces the in-flight ring with one honest indeterminate bar on first launch", async () => {
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-startup-bar-codex-")
    );
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-startup-bar-claude-")
    );

    try {
      seedClaudeTranscripts(
        claudeHome,
        Array.from({ length: SEEDED_SESSION_COUNT }, (_unused, index) => ({
          sessionId: `startup-bar-${index}`,
          slug: `startup-bar-${index}`,
          userText: `Seeded startup source ${index}`,
        }))
      );

      const { page, cleanup } = await launchDesktopApp({
        beforeLaunch: (launchUserDataDir) => {
          // ISS-4779 closed-by-default: the panel is behind this Labs flag,
          // which a fresh profile resolves OFF. Without the seed this spec would
          // only ever assert the gate.
          seedDesktopFeatureFlags(launchUserDataDir, {
            [STARTUP_READINESS_FLAG_KEY]: true,
          });
        },
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      });

      try {
        const panel = page.getByTestId("startup-readiness-panel");
        await expect(panel).toBeVisible({ timeout: 30_000 });

        // Read every fact in ONE evaluate. The panel unmounts once startup
        // settles, so sequential awaits would race the very state under test.
        const snapshot = await page.evaluate<BarSnapshot>(() => {
          const found = document.querySelector(
            '[data-testid="startup-readiness-panel"]'
          );
          if (!found) {
            return {
              panelPresent: false,
              barCount: 0,
              barName: null,
              ariaValueNow: null,
              dataState: null,
              indicatorClass: null,
              headline: null,
              ringLabelledByHeadline: false,
            };
          }
          const bars = [...found.querySelectorAll('[role="progressbar"]')];
          const globalBar = bars.find((bar) =>
            (bar.getAttribute("aria-label") ?? "").startsWith(
              "Desktop startup progress: "
            )
          );
          const headline = found.querySelector("h2")?.textContent ?? null;
          return {
            panelPresent: true,
            barCount: bars.filter((bar) =>
              (bar.getAttribute("aria-label") ?? "").startsWith(
                "Desktop startup progress: "
              )
            ).length,
            barName: globalBar?.getAttribute("aria-label") ?? null,
            ariaValueNow: globalBar?.getAttribute("aria-valuenow") ?? null,
            dataState: globalBar?.getAttribute("data-state") ?? null,
            indicatorClass:
              globalBar
                ?.querySelector('[data-slot="progress-indicator"]')
                ?.getAttribute("class") ?? null,
            headline,
            // Compared by iteration rather than by interpolating the headline
            // into an attribute selector, which real copy would break.
            ringLabelledByHeadline:
              headline !== null &&
              [...found.querySelectorAll("[aria-label]")].some(
                (element) => element.getAttribute("aria-label") === headline
              ),
          };
        });

        expect(snapshot.panelPresent).toBe(true);
        // Exactly one global bar. The whole point was to stop two indicators
        // reporting the same thing at the top of the app.
        expect(snapshot.barCount).toBe(1);
        expect(snapshot.barName).toMatch(STARTUP_BAR_NAME);

        // Startup has no single true percentage, so the in-flight bar claims
        // none: Radix's indeterminate contract drops aria-valuenow entirely.
        expect(snapshot.ariaValueNow).toBeNull();
        expect(snapshot.dataState).toBe("indeterminate");

        // …and the sighted rendering says the same thing. A bare track reads as
        // 0% and a solid one as 100%; the hatch reads as neither.
        expect(snapshot.indicatorClass).toContain("progress-hatch");

        // The removed in-flight ring took its accessible name from the headline.
        // Nothing in the panel may reuse that name as a status icon any more.
        expect(snapshot.headline).not.toBeNull();
        expect(snapshot.ringLabelledByHeadline).toBe(false);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(codexHome, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });
});
