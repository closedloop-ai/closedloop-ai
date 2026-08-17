/**
 * E2E visual QA for FEA-2329: the gateway health rollup lives in Settings, not
 * in the sidebar footer. ISS-5310 (stage cid 3726701537) then moved it from
 * Settings → Labs to Settings → Relay / Gateway, folded into Connection Status,
 * because a connectivity rollup behind an off-by-default experiments gate is
 * hidden from exactly the person who needs it. The screenshot is written to
 * Playwright's test output.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { DesktopHelloNackReason } from "@repo/api/src/types/compute-target.ts";
import axe from "axe-core";
import { WCAG_AA_TAGS } from "../../../../packages/app/test/a11y/axe.ts";
import {
  assertContrastPair,
  ContrastThreshold,
  resolveCompositedBackground,
} from "../../../../packages/app/test/a11y/contrast.ts";
import { DESKTOP_STOPPED_LANE_READINESS_FEATURE_FLAG_KEY } from "../../src/shared/stopped-lane-readiness-flag";
import {
  drainedCloudReadReadiness,
  gotoNav,
  identifiedCloudSyncProgress,
  launchDesktopApp,
  mixedLaneCloudReadReadiness,
  outstandingCloudReadReadiness,
  seedDesktopFeatureFlags,
  stoppedLaneCloudReadReadiness,
} from "./helpers/desktop-app";
import {
  seedCloudRelaySettings,
  startHelloNackRelay,
} from "./helpers/fake-cloud-relay";

// The scan below injects `axe.source` into the page, which publishes axe-core on
// `window.axe`. Declaring it gives the in-page `axe.run(...)` its real
// `AxeResults` return type, so the violation filter is checked rather than
// inferred as `any`.
declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Global DOM Window must be interface-merged; a `type` alias cannot augment the ambient `Window`.
  interface Window {
    axe: typeof axe;
  }
}

const GATEWAY_HEALTH_STATUS_RE = /^(Connected|Needs Attention|Offline)$/;
const SERVER_DISCONNECT_RE = /io server disconnect/;
const HELLO_NACK_REASON_RE = new RegExp(
  DesktopHelloNackReason.ComputeTargetRegisterFailed
);
const GATEWAY_SECURITY_DETAIL_RE =
  /^(No cloud API key is configured\.|Using a manually configured bearer key\.|Managed key is present but request signing is unavailable\.|Managed key with request signing is configured\.)$/;

test.describe("Settings gateway health", () => {
  test("shows the gateway rollup on Relay / Gateway and omits the sidebar health row", async () => {
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-settings-labs-codex-home-")
    );
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-settings-labs-claude-home-")
    );
    let cleanupApp: (() => Promise<void>) | undefined;
    let cleanupError: unknown;

    try {
      const { cleanup, page, pageErrors } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        userDataPrefix: "desktop-settings-labs-gateway-health-e2e-",
      });
      cleanupApp = cleanup;

      expect(codexHome).toContain(os.tmpdir());
      expect(claudeHome).toContain(os.tmpdir());
      expect(fs.existsSync(codexHome)).toBe(true);
      expect(fs.existsSync(claudeHome)).toBe(true);

      await gotoNav(page, "settings");
      await expect(page.locator("header").getByText("Settings")).toBeVisible();

      // ISS-5310 (stage cid 3726701537): the Connected / Needs Attention /
      // Offline rollup moved out of Labs and into Relay / Gateway → Connection
      // Status. It is not an experiment, and behind an off-by-default Labs gate
      // it was invisible to the person who needs it most — someone whose desktop
      // will not connect.
      await page.getByRole("tab", { name: "Relay / Gateway" }).click();

      const relayPanel = page.getByRole("tabpanel", {
        name: "Relay / Gateway",
      });
      await expect(relayPanel.getByText("Connection Status")).toBeVisible();
      await expect(
        relayPanel.getByText(GATEWAY_HEALTH_STATUS_RE)
      ).toBeVisible();
      await expect(
        relayPanel.getByText(GATEWAY_SECURITY_DETAIL_RE)
      ).toBeVisible();
      await expectLocatorContrast(
        relayPanel.getByText(GATEWAY_HEALTH_STATUS_RE),
        "Gateway health status"
      );
      await expectLocatorContrast(
        relayPanel.getByText(GATEWAY_SECURITY_DETAIL_RE),
        "Gateway security detail"
      );

      await page.getByRole("tab", { name: "Labs" }).click();

      const labsPanel = page.getByRole("tabpanel", { name: "Labs" });
      // …and it is gone from where it used to be, so the rollup has exactly one
      // home rather than two that can drift.
      await expect(labsPanel.getByText("Gateway Health")).toHaveCount(0);
      await page.evaluate((source) => {
        Function(source)();
      }, axe.source);
      const axeResults = await page.evaluate((tags) => {
        const panel = document.querySelector(
          '[role="tabpanel"][aria-labelledby]'
        );
        if (!panel) {
          throw new Error("Labs panel was not found for axe scan.");
        }
        return window.axe.run(panel, {
          resultTypes: ["violations"],
          runOnly: {
            type: "tag",
            values: [...tags],
          },
        });
      }, WCAG_AA_TAGS);
      expect(
        axeResults.violations.filter(
          (violation) => violation.impact === "critical"
        )
      ).toEqual([]);
      // FEA-2503: the Agent Dashboard toggle has been removed — the dashboard is
      // now always on, so its label must no longer render in the Labs panel.
      await expect(
        labsPanel.getByText("Agent Dashboard", { exact: true })
      ).toHaveCount(0);
      await expect(
        labsPanel.getByText("Verbose Logging", { exact: true })
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Open account menu" })
      ).toBeVisible();
      await expect(
        page.getByText("Gateway healthy", { exact: true })
      ).toHaveCount(0);
      await expect(
        page.getByText("Gateway unhealthy", { exact: true })
      ).toHaveCount(0);

      await page.screenshot({
        fullPage: true,
        path: test.info().outputPath("settings-labs-gateway-health.png"),
      });
      expect(pageErrors).toEqual([]);
    } finally {
      if (cleanupApp) {
        try {
          await cleanupApp();
        } catch (error) {
          cleanupError = error;
        }
      }
      fs.rmSync(codexHome, { force: true, recursive: true });
      fs.rmSync(claudeHome, { force: true, recursive: true });
    }
    expect(fs.existsSync(codexHome)).toBe(false);
    expect(fs.existsSync(claudeHome)).toBe(false);
    expect(cleanupError).toBeUndefined();
  });

  // ISS-4478: Settings is reachable through the real user path — the bottom-left
  // account menu — not only by writing location.hash via gotoNav. Open the
  // account menu, click Settings, and assert the Settings view actually renders
  // (wongk review: gotoNav bypassed the only user path this PR adds).
  test("opens Settings from the bottom-left account menu", async () => {
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-account-menu-settings-codex-home-")
    );
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-account-menu-settings-claude-home-")
    );
    let cleanupApp: (() => Promise<void>) | undefined;
    let cleanupError: unknown;

    try {
      const { cleanup, page, pageErrors } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        userDataPrefix: "desktop-account-menu-settings-e2e-",
      });
      cleanupApp = cleanup;

      // Start away from Settings so the click is what navigates there.
      await gotoNav(page, "sessions");
      await expect(page.locator("header").getByText("Settings")).toHaveCount(0);

      await page.getByRole("button", { name: "Open account menu" }).click();
      await page
        .getByRole("menuitem", { name: "Settings", exact: true })
        .click();

      await expect(page.locator("header").getByText("Settings")).toBeVisible();
      expect(pageErrors).toEqual([]);
    } finally {
      if (cleanupApp) {
        try {
          await cleanupApp();
        } catch (error) {
          cleanupError = error;
        }
      }
      fs.rmSync(codexHome, { force: true, recursive: true });
      fs.rmSync(claudeHome, { force: true, recursive: true });
    }
    expect(fs.existsSync(codexHome)).toBe(false);
    expect(fs.existsSync(claudeHome)).toBe(false);
    expect(cleanupError).toBeUndefined();
  });
});

/**
 * ISS-5768 (wongk review on #4809) — the History Sync cell, through the LAUNCHED
 * app.
 *
 * The renderer suites inject both ends of this independently: one proves
 * `resolveCloudSyncBacklog` maps a snapshot to a state, another proves
 * `describeCloudSyncStatus` maps a state to a label. Neither proves the chain
 * that carries the value — burn-down sample → `desktop:get-runtime-status` →
 * preload bridge → `useCloudSyncBacklog` → the visible cell — which is the chain
 * this PR actually adds, and the one `apps/desktop/test/AGENTS.md` requires a
 * launched-app regression for on a renderer UI bug fix.
 *
 * Would fail before the fix: on the reported machine the session lanes are
 * drained and `caughtUp` is true, so the cell read "Up to date" while 2,985
 * component-inventory rows were still on the device and one invocation part had
 * been abandoned. Verified by counterfactual — restoring the `caughtUp` claim
 * makes the first test below report `Received: "Up to date"`.
 *
 * WHAT IS SUBSTITUTED, AND WHERE THE REST IS COVERED. The readiness snapshot on
 * the runtime-status payload is a fixture (see `cloud-read-readiness-preload`),
 * because the real sampler answers UNKNOWN for the first 60s of every launch and
 * its lane states afterwards depend on what the collectors found. So these two
 * tests own the chain from the payload OUT — preload bridge → shared
 * runtime-status poll → `useCloudSyncBacklog` → the visible cell — and NOT the
 * main process putting the field on the payload in the first place. That half is
 * `test/runtime-status-cloud-backlog-wiring.test.ts`, which drives the real
 * `GetRuntimeStatus` registrar and fails if the payload line is deleted. Neither
 * test is sufficient alone; do not delete one and assume the other covers it.
 */
test.describe("Settings History Sync completeness (ISS-5768)", () => {
  const HISTORY_SYNC_CELL_TIMEOUT_MS = 30_000;

  async function readHistorySyncCell(
    readiness: ReturnType<typeof drainedCloudReadReadiness>,
    userDataPrefix: string,
    // ISS-6206: seed the persisted Labs toggle so the launched app resolves the
    // flag through its real adapter. The renderer suites call
    // `resolveCloudSyncBacklog` directly, so nothing there covers the flag
    // SELECTION or the settings→IPC→adapter wiring it rides on.
    strictLaneReadiness = false
  ): Promise<{ label: string; detail: string; pageErrors: Error[] }> {
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), `${userDataPrefix}codex-`)
    );
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), `${userDataPrefix}claude-`)
    );
    try {
      const { cleanup, page, pageErrors } = await launchDesktopApp({
        beforeLaunch: (userDataDir) => {
          if (strictLaneReadiness) {
            seedDesktopFeatureFlags(userDataDir, {
              [DESKTOP_STOPPED_LANE_READINESS_FEATURE_FLAG_KEY]: true,
            });
          }
        },
        cloudReadReadiness: readiness,
        cloudSyncProgress: identifiedCloudSyncProgress(),
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        userDataPrefix,
      });
      try {
        await gotoNav(page, "settings");
        await page.getByRole("tab", { name: "Relay / Gateway" }).click();
        const relayPanel = page.getByRole("tabpanel", {
          name: "Relay / Gateway",
        });
        await expect(relayPanel.getByText("Connection Status")).toBeVisible();

        // The value is the <p> immediately after the "History Sync" label. Read
        // it together with its `title` (the longer phrasing), so the assertion
        // sees the same pair a user hovering the cell would.
        const cell = relayPanel
          .getByText("History Sync", { exact: true })
          .locator("xpath=./following-sibling::p[1]");
        // The first paint is before any poll has resolved, so the cell shows its
        // "not connected" dash. Wait for the payload to land rather than racing
        // the shared 1s poll.
        await expect(cell).not.toHaveText("—", {
          timeout: HISTORY_SYNC_CELL_TIMEOUT_MS,
        });

        return {
          label: (await cell.textContent()) ?? "",
          detail: (await cell.getAttribute("title")) ?? "",
          pageErrors,
        };
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(codexHome, { force: true, recursive: true });
      fs.rmSync(claudeHome, { force: true, recursive: true });
    }
  }

  test("reports the whole-app backlog, not the session lane's clean queues", async () => {
    test.setTimeout(120_000);
    const cell = await readHistorySyncCell(
      outstandingCloudReadReadiness(),
      "desktop-history-sync-outstanding-"
    );

    expect(cell.label).toBe("Syncing (2,985 left)");
    // The abandoned item is in the invocation-parts lane — one of the three
    // `CloudSyncProgress` cannot represent at all.
    expect(cell.detail).toContain("2,985 items still to upload");
    expect(cell.detail).toContain("1 item could not be uploaded");
    expect(cell.pageErrors).toEqual([]);
  });

  test("still says Up to date when every lane owes nothing", async () => {
    test.setTimeout(120_000);
    // The counterfactual. Same launch, same identified session lanes, drained
    // readiness — without it the assertion above would pass on a cell that can
    // no longer reach its success state at all.
    const cell = await readHistorySyncCell(
      drainedCloudReadReadiness(),
      "desktop-history-sync-drained-"
    );

    expect(cell.label).toBe("Up to date");
    expect(cell.detail).toBe("Your history is synced to your workspace");
    expect(cell.pageErrors).toEqual([]);
  });

  /**
   * ISS-6206 (wongk review on #5050) — the flag-ON half, through the LAUNCHED
   * app.
   *
   * The renderer suites for this ticket call `resolveCloudSyncBacklog` with
   * `{ strictLaneReadiness: true }` directly, so they never touch the two things
   * that decide whether a user ever sees this: the flag SELECTION in
   * `useCloudSyncBacklog`, and the persisted Labs toggle reaching the renderer's
   * adapter over IPC. Delete either and every one of those suites stays green
   * while the feature is off for everybody. These cases seed the real setting
   * and read the real cell.
   */
  test("a lane that never ran stops the cell claiming Up to date (flag on)", async () => {
    test.setTimeout(120_000);
    const cell = await readHistorySyncCell(
      stoppedLaneCloudReadReadiness(),
      "desktop-history-sync-stopped-lane-",
      true
    );

    // Four lanes drained and the fifth measuring a clean zero — the aggregate
    // rounded this up to "Up to date" before the strict path existed.
    expect(cell.label).toBe("Checking…");
    expect(cell.pageErrors).toEqual([]);
  });

  test("the same stopped lane still reads Up to date with the flag off", async () => {
    test.setTimeout(120_000);
    // The gate's own counterfactual: identical snapshot, no seeded toggle. This
    // is what fails if the flag selection is deleted and strict becomes the
    // unconditional path.
    const cell = await readHistorySyncCell(
      stoppedLaneCloudReadReadiness(),
      "desktop-history-sync-stopped-lane-off-"
    );

    expect(cell.label).toBe("Up to date");
    expect(cell.pageErrors).toEqual([]);
  });

  test("a mixed-unit backlog is reported per lane, not as one total (flag on)", async () => {
    test.setTimeout(120_000);
    const cell = await readHistorySyncCell(
      mixedLaneCloudReadReadiness(),
      "desktop-history-sync-mixed-lanes-",
      true
    );

    expect(cell.label).toBe("Syncing (2,900 sessions and 12 transcripts left)");
    expect(cell.detail).toContain("2,900 sessions and 12 transcripts");
    // 2,900 outbox rows plus 12 transcript files is not "2,912" of anything.
    expect(cell.label).not.toContain("2,912");
    expect(cell.pageErrors).toEqual([]);
  });

  test("the same mixed backlog is one cross-lane total with the flag off", async () => {
    test.setTimeout(120_000);
    const cell = await readHistorySyncCell(
      mixedLaneCloudReadReadiness(),
      "desktop-history-sync-mixed-lanes-off-"
    );

    expect(cell.label).toBe("Syncing (2,912 left)");
    expect(cell.pageErrors).toEqual([]);
  });
});

// ISS-6126: the cloud rejects `desktop.hello` with a typed reason and closes
// the socket. The node suite drives `registerSocketHandlers` on a fake socket,
// which stops at `onStatusChange` — it cannot show that the reason survives
// runtime-status IPC, the preload bridge, and the Settings renderer. This test
// runs the REAL CloudSocketService against a localhost relay that nacks, and
// asserts the cause is what the launched app shows the user.
test.describe("Settings cloud connection reason", () => {
  test("shows why the cloud rejected the handshake, not io server disconnect", async () => {
    test.setTimeout(120_000);
    const relay = await startHelloNackRelay(
      DesktopHelloNackReason.ComputeTargetRegisterFailed
    );
    let cleanupApp: (() => Promise<void>) | undefined;

    try {
      const { cleanup, page, pageErrors } = await launchDesktopApp({
        env: { CLOSEDLOOP_API_KEY: "sk_live_hello_nack_e2e" },
        beforeLaunch: (userDataDir) => {
          seedCloudRelaySettings(userDataDir, relay.origin);
        },
        userDataPrefix: "desktop-settings-cloud-hello-nack-e2e-",
      });
      cleanupApp = cleanup;

      // The handshake has to have actually been refused; otherwise a passing
      // assertion below could only be reporting an idle socket.
      await expect
        .poll(() => relay.helloCount(), { timeout: 60_000 })
        .toBeGreaterThan(0);

      await gotoNav(page, "settings");
      await expect(page.locator("header").getByText("Settings")).toBeVisible();
      await page.getByRole("tab", { name: "Relay / Gateway" }).click();
      const relayPanel = page.getByRole("tabpanel", {
        name: "Relay / Gateway",
      });

      // The reason itself, in the Cloud Connection cell the user reads. The
      // message copy is pinned against the shipped table by the node suite;
      // this asserts the identifying part travelled the whole chain. It is
      // matched as a substring rather than imported from
      // src/main/cloud/cloud-hello-nack.ts, because importing a main-process
      // module into a spec aborts the suite at load time (test/AGENTS.md).
      await expect(relayPanel.getByText(HELLO_NACK_REASON_RE)).toBeVisible({
        timeout: 60_000,
      });
      await expect(relayPanel.getByText("Connection failed")).toBeVisible();
      // The exact string from the ticket, which is what this cell showed before.
      await expect(relayPanel.getByText(SERVER_DISCONNECT_RE)).toHaveCount(0);

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanupApp?.();
      await relay.close();
    }
  });
});

async function expectLocatorContrast(
  locator: Locator,
  label: string,
  {
    colorProperty = "color",
    threshold = ContrastThreshold.NormalText,
  }: {
    colorProperty?: "backgroundColor" | "color";
    threshold?: ContrastThreshold;
  } = {}
) {
  const colors = await locator.evaluate((element, property) => {
    const foreground = getComputedStyle(element)[property];
    let current: Element | null = element;
    const backgrounds: string[] = [];
    while (current) {
      const color = getComputedStyle(current).backgroundColor;
      if (color) {
        backgrounds.push(color);
      }
      current = current.parentElement;
    }
    return { backgrounds, foreground };
  }, colorProperty);
  assertContrastPair({
    background: resolveCompositedBackground(colors.backgrounds),
    foreground: colors.foreground,
    label,
    threshold,
  });
}
