import { expect, type Page, test } from "@playwright/test";
import {
  LOC_METRIC_DEFINITION,
  LocMetricDefinitionId,
} from "@repo/api/src/types/loc-metric-definitions.ts";
import { DetailsFieldId } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model.ts";
import { DETAILS_TAB_FIELD_GROUPS_SELECTOR } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model.ts";
import { expectDerivedRowLockWording } from "../../../../e2e/helpers/details-read-only-lock";
import { gotoHash, seedDesktopFeatureFlags } from "./helpers/desktop-app";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
  withSeededSessionsProfile,
} from "./helpers/seeded-sessions-list";

const sessionId = "iss-10796-session-shell";
const sessionName = "ISS-10796 session shell";
const shellFlagKey = "artifact-detail-shell";
const COMMENTS_TOGGLE = /^(Show|Hide) comments rail$/;
const SIDEBAR_TOGGLE = /^(Expand|Collapse) sidebar$/;

/** Every field row's label, Artifact details then Session details. */
const SESSION_FIELD_LABELS = `${DETAILS_TAB_FIELD_GROUPS_SELECTOR} [role="group"] > :first-child`;

/**
 * ISS-12197's Session Details rows, in the ticket's wording and in the Details
 * tab's two field sections, Artifact details then Session details (ISS-12412). The
 * desktop local read omits the Artifact row's due date and project, and the
 * seeded session has no creator the signed-out org directory can resolve, so
 * those rows are left out here (the empty-row rule) and the page shows a
 * subsequence of this list.
 */
const ISS_12197_SESSION_DETAILS_ORDER = [
  "Name",
  "Slug",
  "Owner",
  "Collaborators",
  "Status",
  "Priority",
  "Due date",
  "Created at",
  "Created by",
  "Updated at",
  "Project",
  "Tags",
  "Session ID",
  "Autonomy",
  "Harness",
  "Model",
  "Repository",
  "Other repositories",
  "Sync",
  "Started at",
  "Last active at",
  "Duration",
  "Input tokens",
  "Output tokens",
  "Cache read tokens",
  "Cache write tokens",
  "Estimated cost",
  LOC_METRIC_DEFINITION[LocMetricDefinitionId.SessionDetailMergedLoc].label,
  "Branches",
  "Number of subagents",
  "Number of tool calls",
  "Number of errors",
];

test("Session shared shell preserves the existing canvas through desktop tab navigation", async () => {
  test.setTimeout(240_000);
  const dirs = makeSeededSessionsDirs("iss-10796");
  try {
    await withSeededSessionsProfile(
      dirs,
      {
        beforeRelaunch: (userDataDir) => {
          seedDesktopFeatureFlags(userDataDir, { [shellFlagKey]: true });
        },
        sessions: [
          {
            sessionId,
            name: sessionName,
            at: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          },
        ],
      },
      async (page) => {
        await gotoHash(page, `/sessions/${sessionId}?tab=details`);
        const detailsTab = page.getByRole("tab", {
          name: "Details",
          exact: true,
        });
        await expect(detailsTab).toHaveAttribute("aria-selected", "true");
        const details = page.getByRole("tabpanel", {
          name: "Details",
          exact: true,
        });
        const labels = details.locator(SESSION_FIELD_LABELS);
        await expect(labels.first()).toHaveText("Name");
        await expect(
          details.getByText("Session ID", { exact: true })
        ).toBeVisible();
        // ISS-12300 D3: the comments button is the Session tab's alone.
        await expect(
          page.getByRole("button", { name: COMMENTS_TOGGLE })
        ).toHaveCount(0);
        const drawn = await labels.allTextContents();
        const positions = drawn.map((label) =>
          ISS_12197_SESSION_DETAILS_ORDER.indexOf(label)
        );
        expect(positions).not.toContain(-1);
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
        expect(new Set(positions).size).toBe(positions.length);
        // ISS-12269 put Sync on this tab. It is drawn only when the session
        // carries sync evidence, and the local read always serves
        // `lastSyncedAt` (FEA-3479, `buildLocalSessionTimingAndUsage`), so the
        // row is present here. ISS-12251 T-6.5: the local read serves
        // `createdAt` from the row's `created_at`, so Created at is drawn.
        expect(drawn).toEqual(
          expect.arrayContaining([
            "Name",
            "Owner",
            "Status",
            "Sync",
            "Created at",
          ])
        );
        for (const absent of [
          "Due date",
          "Created by",
          "Owning project",
          "Lines changed",
          // ISS-10995 (operator ruling 2026-10-12): Project is editable now, so
          // single-user mode omits the field as every other editable row does
          // and draws no row — where the read-only row used to draw with no
          // value. `e2e/session-detail-shell.spec.ts` is the counterfactual,
          // pinning it drawn on the cloud read that does serve it.
          "Project",
        ]) {
          expect(drawn).not.toContain(absent);
        }
        await expectDerivedRowLockWording(details, DetailsFieldId.SessionId);
        // ISS-12167: a Session hides the generic Artifact tab and reads its
        // Sessions tab singular.
        await expect(
          page
            .getByRole("tablist", { name: "Artifact detail sections" })
            .getByRole("tab")
        ).toHaveText(["Session", "Details", "Activity"]);
        await page.getByRole("tab", { name: "Session", exact: true }).click();
        const heading = page.getByRole("heading", {
          name: sessionName,
          exact: true,
        });
        await expect(heading).toBeVisible();
        await expect(
          page.getByRole("button", { name: COMMENTS_TOGGLE })
        ).toHaveCount(1);
        await expectSidebarIconMatchesCommentsIcon(page);
        // ISS-12269 took the Properties card off this surface — the Details tab
        // states those values now — so retention is proven by the canvas node
        // surviving, not by a card's open state.
        const canvas = await heading.elementHandle();
        await detailsTab.click();
        await page.getByRole("tab", { name: "Activity", exact: true }).click();
        // ISS-11004: Local mode has no synced activity, so the empty state.
        await expect(
          page
            .getByRole("tabpanel", { name: "Activity", exact: true })
            .getByText("No activity yet", { exact: true })
        ).toBeVisible();
        await page.goBack();
        await expect(detailsTab).toHaveAttribute("aria-selected", "true");
        await page.goBack();
        await expect(heading).toBeVisible();
        expect(await canvas?.evaluate((node) => node.isConnected)).toBe(true);
        await expect(
          page.getByRole("tab", { name: "Artifact", exact: true })
        ).toHaveCount(0);
        await page.setViewportSize({ width: 480, height: 800 });
        await detailsTab.click();
        await expect(detailsTab).toBeFocused();
        await detailsTab.press("ArrowRight");
        await expect(
          page.getByRole("tab", { name: "Activity", exact: true })
        ).toBeFocused();
      }
    );
  } finally {
    cleanupSeededSessionsDirs(dirs);
  }
});

/**
 * ISS-12300 D4: the Topbar's sidebar button mirrors the comments button, and
 * the two icons render at the same size (PR #8656).
 */
async function expectSidebarIconMatchesCommentsIcon(page: Page): Promise<void> {
  const [sidebarIcon, commentsIcon] = await Promise.all([
    page
      .getByRole("button", { name: SIDEBAR_TOGGLE })
      .locator("svg")
      .boundingBox(),
    page
      .getByRole("button", { name: COMMENTS_TOGGLE })
      .locator("svg")
      .boundingBox(),
  ]);
  expect(sidebarIcon).not.toBeNull();
  expect(commentsIcon).not.toBeNull();
  expect({ height: sidebarIcon?.height, width: sidebarIcon?.width }).toEqual({
    height: commentsIcon?.height,
    width: commentsIcon?.width,
  });
}
