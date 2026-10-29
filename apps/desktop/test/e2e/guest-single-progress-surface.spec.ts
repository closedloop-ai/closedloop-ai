/** ISS-10492: real guest import reaches the sole ambient progress surface. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron, expect, type Page, test } from "@playwright/test";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import { launchElectronOrExplain } from "./helpers/electron-launch-attribution";
import { setImportPaused } from "./helpers/import-pause";
import { createReadinessFailureDiagnostic } from "./helpers/readiness-failure-diagnostic";
import {
  returningInstallSeedEnv,
  returningInstallSeedLaunchArgs,
} from "./helpers/returning-install-seed";
import { seedClaudeTranscripts } from "./helpers/seed";
import {
  readStartupBarFrames,
  recordStartupBarFrames,
} from "./helpers/startup-bar-frames";

/** The kept bar's own progress element, by the accessible name it ships with. */
const ANALYSIS_BAR_NAME =
  /^(Session analysis status|Desktop startup status|Agent history source files processed)$/;
/**
 * Every surface this ticket deleted, by the signal it used to render. A
 * resurrected one reds this spec rather than quietly doubling the bars on
 * screen — which is the whole reason the set is enumerated here and not
 * summarised.
 */
const RETIRED_PROGRESS_SIGNALS = [
  // StartupReadinessPanel
  { kind: "testid", value: "startup-readiness-panel" },
  { kind: "progressbar", value: "Desktop startup progress" },
  // The dashboard's own second and third surfaces
  { kind: "progressbar", value: "Analysis progress" },
  { kind: "progressbar", value: "Dashboard progress" },
  { kind: "text", value: "Preparing dashboard…" },
  { kind: "text", value: "Analyzing locally" },
  // FirstLaunchImportBanner + the import-splash family
  { kind: "text", value: "Importing your agent history" },
  { kind: "progressbar", value: "Overall import progress" },
] as const;
/** The counter the prototype shows: both numbers, thousands-separated, or none. */
const COUNTER_PAIR = /^\d{1,3}(?:,\d{3})* \/ \d{1,3}(?:,\d{3})*$/;
const STEP_BUDGET_MS = 30_000;
/** The inline offset the shell carries only while the bar is on screen. */
const INSET_MARGIN_TOP = /margin-top/;
/** A determinate bar's `aria-valuenow`; an indeterminate one has none. */
const WHOLE_NUMBER = /^\d+$/;

test("ISS-10492: a signed-out guest gets exactly one progress surface, driven by startup readiness", async () => {
  test.setTimeout(240_000);

  const homes = createHarnessHomes();
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-guest-one-progress-")
  );
  // Keep the genuine import actor cold: source files exist before its first launch.
  seedClaudeTranscripts(
    homes.env.CLAUDE_HOME,
    Array.from({ length: 80 }, (_, index) => ({
      sessionId: `guest-progress-${index}`,
      slug: `guest-progress-${index}`,
      userText: `Seeded history source ${index}`,
    }))
  );
  const launched =
    await test.step("launch the real guest with first-frame Dashboard flags", () =>
      launchGuestWithDashboardStorage({
        env: homes.env,
        keepFirstRunState: true,
        userDataDir,
      }));

  try {
    // Before the bar can appear, so its first frame is recorded.
    await recordStartupBarFrames(launched.page);
    await test.step("navigate to the original guest dashboard", () =>
      gotoNav(launched.page, "dashboard"));
    // Hold the import mid-flight, so the bar and the shell beneath it can be
    // measured before parsing finishes (ISS-11668 expected behavior 5a, from
    // ISS-10537). Resumed below to prove the bar then leaves.
    const pauseDiagnostic = createReadinessFailureDiagnostic(
      test.info(),
      "guest-import-pause-last-report"
    );
    await test.step("pause the real import and await its parked acknowledgment", async () => {
      try {
        await setImportPaused(launched.page, true, {
          acknowledgeParked: true,
          observeReport: pauseDiagnostic.observe,
        });
      } catch (error) {
        await pauseDiagnostic.attach().catch(() => undefined);
        throw error;
      }
    });

    // DRIVEN BUT NOT MOUNTED would fail here.
    const bar = launched.page.getByRole("progressbar", {
      name: ANALYSIS_BAR_NAME,
    });
    await expect(bar).toBeVisible({ timeout: STEP_BUDGET_MS });

    // …and it is the ONLY one. Asserted over every progressbar on the page, so
    // a second surface with an accessible name nobody predicted still fails.
    await expect(launched.page.getByRole("progressbar")).toHaveCount(1);

    // Parsing now looks exactly like the prototype (ISS-11668): its label,
    // unit-less session counter, and progress name are the bar's own defaults,
    // so neither the label nor the name can tell the startup pass from the
    // onboarding-derived bar any more. That they are one surface is the
    // single-progressbar count above.
    const label = await readBarLabel(launched.page);
    expect(label.length).toBeGreaterThan(0);

    // From its first frame the bar states both numbers (ISS-11668 ruling 16):
    // no frame shows the label alone.
    await expect
      .poll(async () => (await readStartupBarFrames(launched.page)).length)
      .toBeGreaterThan(0);
    for (const frame of await readStartupBarFrames(launched.page)) {
      expect(frame.counter).toMatch(COUNTER_PAIR);
    }

    // Every retired surface stays retired.
    for (const signal of RETIRED_PROGRESS_SIGNALS) {
      await expect(locatorForSignal(launched.page, signal)).toHaveCount(0);
    }

    // The import is unsettled and measured: a determinate bar short of done.
    await expect(bar).toHaveAttribute("aria-valuenow", WHOLE_NUMBER);
    expect(Number(await bar.getAttribute("aria-valuenow"))).toBeLessThan(100);

    // The shell sits BELOW the bar, pushed down by the bar's own measured
    // height, rather than underneath it.
    const shell = await readShellOffset(launched.page);
    expect(shell.barHeight).toBeGreaterThan(0);
    expect(shell.insetMarginTop).toBeCloseTo(shell.barHeight, 0);
    expect(shell.insetTop).toBeGreaterThanOrEqual(shell.barBottom - 0.5);

    await setImportPaused(launched.page, false, { acknowledgeParked: true });

    // And it LEAVES when parsing completes, rather than parking forever
    // (ISS-11668: a guest has no sync election, so nothing brings it back).
    await expect(bar).toHaveCount(0, { timeout: 180_000 });
    // Nothing took its place on the way out.
    await expect(launched.page.getByRole("progressbar")).toHaveCount(0);
    // ...and the shell gives the space back.
    await expect(
      launched.page.locator('[data-slot="sidebar-inset"]')
    ).not.toHaveAttribute("style", INSET_MARGIN_TOP);
    expect(launched.pageErrors).toEqual([]);
  } finally {
    await launched.cleanup();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    removeDirs(homes.dirs);
  }
});

function locatorForSignal(
  page: Page,
  signal: (typeof RETIRED_PROGRESS_SIGNALS)[number]
) {
  if (signal.kind === "testid") {
    return page.getByTestId(signal.value);
  }
  if (signal.kind === "progressbar") {
    return page.getByRole("progressbar", { name: signal.value });
  }
  return page.getByText(signal.value);
}

/** The stage label the bar is currently stating. */
function readBarLabel(page: Page): Promise<string> {
  return page.evaluate(() => {
    const bar = document.querySelector('[role="status"].truncate');
    return bar?.textContent?.trim() ?? "";
  });
}

function createHarnessHomes(): {
  env: Record<string, string>;
  dirs: string[];
} {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-guest-one-progress-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-guest-one-progress-codex-")
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
 * The bar's on-screen box and where the shell's inset starts.
 *
 * The bar is found as the progress element's nearest `position: fixed`
 * ancestor, the surface whose height the banner reports to the shell, rather
 * than by a class name.
 */
function readShellOffset(page: Page): Promise<{
  barBottom: number;
  barHeight: number;
  insetMarginTop: number;
  insetTop: number;
}> {
  return page.evaluate(() => {
    let surface = document.querySelector('[role="progressbar"]');
    while (surface && getComputedStyle(surface).position !== "fixed") {
      surface = surface.parentElement;
    }
    const inset = document.querySelector('[data-slot="sidebar-inset"]');
    if (!(surface && inset)) {
      throw new Error("the bar surface or the shell inset is not mounted");
    }
    const bar = surface.getBoundingClientRect();
    return {
      barBottom: bar.bottom,
      barHeight: bar.height,
      insetMarginTop: Number.parseFloat(getComputedStyle(inset).marginTop),
      insetTop: inset.getBoundingClientRect().top,
    };
  });
}

/** Reuse the authorized first-frame writer with only the original two flags. */
function launchGuestWithDashboardStorage(
  options: Parameters<typeof launchDesktopApp>[0]
) {
  return launchDesktopApp({
    ...options,
    launchElectron: (launchOptions) =>
      launchElectronOrExplain(
        {
          ...launchOptions,
          args: [
            ...returningInstallSeedLaunchArgs(false),
            ...(launchOptions?.args ?? []),
          ],
          env: {
            ...launchOptions?.env,
            ...returningInstallSeedEnv(false, {
              [dashboardTourSeenStorageKey]: "1",
              [dashboardOnboardedStorageKey]: "1",
            }),
          },
        },
        (prepared) => _electron.launch(prepared)
      ),
  });
}
