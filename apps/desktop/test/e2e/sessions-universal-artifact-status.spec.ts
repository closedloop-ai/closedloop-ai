/** Status adoption on the launched Desktop Sessions v2 surface. */
import { expect, type Locator, test } from "@playwright/test";
import { UNKNOWN_ARTIFACT_STATUS_DISPLAY } from "../../../../packages/api/src/types/artifact-status-display.ts";
import { ARTIFACT_STATUS_LABEL_HONESTY_FLAG_KEY } from "../../../../packages/api/src/types/artifact-status-label-honesty-flag.ts";
import { SESSION_STATUS } from "../../../../packages/api/src/types/session-status.ts";
import { SESSION_STATUS_LABELS } from "../../../../packages/api/src/types/session-status-display.ts";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "../../../../packages/api/src/types/universal-artifact-status-flag.ts";
import {
  mapInactiveLinuxCiWindow,
  selectInactiveLinuxCiMapping,
} from "./helpers/inactive-linux-ci-window";
import type { SessionListSeed } from "./helpers/seed-branches-db";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
} from "./helpers/seeded-sessions-list";
import { withSeededSessionsV2List } from "./helpers/seeded-sessions-v2-list";

// Pinned independently of the renderer's flag key so a key drift fails here.
const AGENTS_SURFACE_HONESTY_FLAG_KEY = "agents-surface-honesty";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

test("shows champion status evidence and groups by it on both axes", async () => {
  test.setTimeout(300_000);
  const now = Date.now();
  const ago = (duration: number) => new Date(now - duration).toISOString();
  const sessions: SessionListSeed[] = [
    {
      name: "Status completed",
      sessionId: "iss-10422-status-completed",
      status: SESSION_STATUS.INACTIVE,
    },
    {
      name: "Status failed",
      sessionId: "iss-10422-status-failed",
      status: SESSION_STATUS.ERROR,
    },
    {
      awaitingInputSince: ago(30 * MINUTE_MS),
      endedAt: null,
      lastActivityAt: ago(30 * MINUTE_MS),
      name: "Status waiting",
      sessionId: "iss-10422-status-waiting",
      status: SESSION_STATUS.ACTIVE,
      updatedAt: ago(20 * MINUTE_MS),
    },
    {
      activityEventAt: ago(30 * HOUR_MS),
      at: ago(36 * HOUR_MS),
      endedAt: null,
      lastActivityAt: ago(30 * HOUR_MS),
      name: "Status stale",
      sessionId: "iss-10422-status-stale",
      status: SESSION_STATUS.ACTIVE,
      updatedAt: ago(20 * MINUTE_MS),
    },
    {
      name: "Status future",
      sessionId: "iss-10422-status-future",
      status: "future-session-status",
    },
  ];
  const dirs = makeSeededSessionsDirs("desktop-universal-artifact-status");
  try {
    await withSeededSessionsV2List(
      dirs,
      {
        featureFlags: {
          [AGENTS_SURFACE_HONESTY_FLAG_KEY]: true,
          [ARTIFACT_STATUS_LABEL_HONESTY_FLAG_KEY]: true,
          [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY]: true,
        },
        readyRowName: "Status completed",
        sessions,
      },
      async (page, panel, app) => {
        await page.clock.setFixedTime(now);
        await expect(statusCell(panel, "Status completed")).toContainText(
          "Completed"
        );
        await expect(statusCell(panel, "Status failed")).toContainText(
          "Failed"
        );
        // ISS-10364 (operator ruling, 2026-09-23/24): EXPECTATION CHANGED. The
        // Waiting projection and the staleness fold are BOTH retired now
        // ("let's drop waiting as well"), so an awaiting-input row and a
        // long-silent row each report the lifecycle value they store —
        // `active`, which this surface labels "Running". Both seeds are kept
        // (one carrying `awaitingInputSince`, one silent for 30h) and the
        // disclosure assertions kept as counterfactuals, so restoring either
        // fold reddens its own lines rather than sliding back in unnoticed.
        await expect(statusCell(panel, "Status waiting")).toContainText(
          "Running"
        );
        await expect(
          statusCell(panel, "Status waiting").getByRole("button", {
            name: "Waiting",
          })
        ).toHaveCount(0);
        await expect(statusCell(panel, "Status stale")).toContainText(
          "Running"
        );
        // Plain literal: ISS-10364 deleted `SESSION_STALE_TOOLIP` along with
        // the Stale word, so there is no longer a constant to compose the old
        // name from — a button named "Stale" cannot exist at all now.
        await expect(
          statusCell(panel, "Status stale").getByRole("button", {
            name: "Stale",
          })
        ).toHaveCount(0);
        // ISS-12880 (#9144, #9150) applied the ISS-10364 ruling: an
        // unrecognized raw status reads Running and carries no Unknown tooltip.
        await expect(statusCell(panel, "Status future")).toContainText(
          "Running"
        );
        await expect(
          statusCell(panel, "Status future").getByTitle(
            UNKNOWN_ARTIFACT_STATUS_DISPLAY.tooltip
          )
        ).toHaveCount(0);

        await mapInactiveLinuxCiWindow(
          app,
          page,
          selectInactiveLinuxCiMapping(
            { platform: process.platform, env: process.env },
            true
          )
        );

        await panel.getByRole("button", { name: "Group", exact: true }).click();
        await page
          .getByRole("combobox", { name: "Primary grouping field" })
          .click();
        await page.getByRole("option", { name: "Status", exact: true }).click();
        await page.keyboard.press("Escape");
        await expect(groupHeader(panel, "Completed")).toBeVisible();
        await expect(groupHeader(panel, "Failed")).toBeVisible();
        await expect(
          panel.getByText(SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE], {
            exact: true,
          })
        ).toHaveCount(0);

        await panel
          .getByRole("button", { name: "Groups: 1", exact: true })
          .click();
        await page
          .getByRole("combobox", { name: "Primary grouping field" })
          .click();
        await page
          .getByRole("option", { name: "Harness", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Add subgroup", exact: true })
          .click();
        await page
          .getByRole("menuitem", { name: "Status", exact: true })
          .click();
        await page.keyboard.press("Escape");
        await expect(
          panel.getByRole("button", { name: "Groups: 2", exact: true })
        ).toBeVisible();
        const harnessGroup = parentGroup(panel, "unknown");
        const completedGroup = harnessGroup.getByRole("button", {
          name: "Completed",
          exact: true,
        });
        await expect(harnessGroup).toBeVisible();
        await expect(completedGroup).toBeVisible();
        await expect(
          harnessGroup.getByRole("button", { name: "Failed", exact: true })
        ).toBeVisible();
        await completedGroup.click();
        await expect(
          panel.getByRole("link", { name: "Status completed", exact: true })
        ).toHaveCount(0);
        await expect(
          panel.getByRole("link", { name: "Status failed", exact: true })
        ).toBeVisible();
      }
    );
  } finally {
    cleanupSeededSessionsDirs(dirs);
  }
});

function statusCell(panel: Locator, rowName: string): Locator {
  return panel
    .getByRole("link", { exact: true, name: rowName })
    .locator("xpath=ancestor::*[@role='row'][1]")
    .locator('[data-column-id="status"]');
}

function groupHeader(panel: Locator, label: string): Locator {
  return panel.getByRole("button", { exact: true, name: label });
}

function parentGroup(panel: Locator, label: string): Locator {
  return (
    panel
      .getByRole("button", { exact: true, name: label })
      // The band's section: a `rowgroup`, or a `presentation` wrapper when the
      // grid keeps the header and subgroups as sibling rowgroups.
      .locator(
        "xpath=ancestor::*[(@role='rowgroup' or @role='presentation') and .//*[@role='rowgroup']][1]"
      )
  );
}

test("Status column fits the entire displayed badge", async () => {
  test.setTimeout(180_000);
  const dirs = makeSeededSessionsDirs("iss11204-status-fit");
  try {
    await withSeededSessionsV2List(
      dirs,
      {
        featureFlags: {
          [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY]: true,
          [ARTIFACT_STATUS_LABEL_HONESTY_FLAG_KEY]: false,
        },
        readyRowName: "Running session",
        sessions: [
          {
            name: "Running session",
            sessionId: "iss11204-running",
            status: SESSION_STATUS.ACTIVE,
            endedAt: null,
            lastActivityAt: new Date().toISOString(),
          },
        ],
      },
      async (_page, panel) => {
        const cell = statusCell(panel, "Running session");
        await expect(cell).toContainText("In progress");
        await expect
          .poll(() =>
            cell.evaluate((node) => {
              const content = node.firstElementChild;
              if (!content) {
                return false;
              }
              const box = node.getBoundingClientRect();
              const badge = content.getBoundingClientRect();
              const padding = Number.parseFloat(
                getComputedStyle(node).paddingRight
              );
              return badge.right <= box.right - padding + 1;
            })
          )
          .toBe(true);
      }
    );
  } finally {
    cleanupSeededSessionsDirs(dirs);
  }
});
