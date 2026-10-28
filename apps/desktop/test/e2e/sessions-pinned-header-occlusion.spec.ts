/** Launched Desktop proof for the lead-only Sessions pin and header hover paint. */

import { LEADING_COLUMN_DATA_ID } from "@closedloop-ai/design-system/lib/grid-table-v2-rows.ts";
import { expect, test } from "@playwright/test";
import { SESSION_STATUS } from "@repo/api/src/types/session-status.ts";
import {
  backgroundAlpha,
  hoverCellInPlace,
  pinnedCellIsTopmost,
} from "../../../../e2e/helpers/grid-column-geometry.ts";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
} from "./helpers/seeded-sessions-list";
import {
  SCROLL_BAND_TEST_ID,
  withSeededSessionsV2List,
} from "./helpers/seeded-sessions-v2-list";

const ROW_NAME = "Pinned Desktop header fixture";
const COLUMN_ALIGNMENT_TOLERANCE_PX = 1.5;
const OWNER_RESIZE_HANDLE_NAME = /^Resize Owner column/;
const LEAD_HEADER = "Session";
const LEAD_RESIZE_HANDLE_NAME =
  /^Resize Session column, \d+ pixels wide(, minimum)?, use arrow keys$/;

test("Desktop Sessions keeps the lead-only header opaque over a scrolling Owner column", async () => {
  test.setTimeout(300_000);
  const dirs = makeSeededSessionsDirs("desktop-pinned-header");
  const at = new Date(Date.now() - 60_000).toISOString();

  try {
    await withSeededSessionsV2List(
      dirs,
      {
        featureFlags: {
          "grid-table-v2": true,
        },
        readyRowName: ROW_NAME,
        sessions: [
          {
            at,
            lastActivityAt: at,
            name: ROW_NAME,
            sessionId: "iss-11582-desktop-pinned-header",
            status: SESSION_STATUS.INACTIVE,
          },
        ],
      },
      async (page, panel) => {
        const identity = panel.getByRole("link", {
          exact: true,
          name: ROW_NAME,
        });
        const row = identity.locator('xpath=ancestor::*[@role="row"][1]');
        const leadBody = identity.locator(
          'xpath=ancestor::*[@role="gridcell"][1]'
        );
        const leadHeader = panel.getByRole("columnheader", {
          exact: true,
          name: LEAD_HEADER,
        });
        const ownerHeader = panel.getByRole("columnheader", {
          name: "Owner",
        });
        const ownerResizeHandle = ownerHeader.getByRole("button", {
          name: OWNER_RESIZE_HANDLE_NAME,
        });
        const scrollBand = panel.getByTestId(SCROLL_BAND_TEST_ID);
        await expect(ownerResizeHandle).toBeVisible();

        // ISS-11931: the lead header's only control is its resize handle, and
        // Chromium used to append that handle's name to the header's, so the
        // exact lookup above found nothing. The header is named "Session" alone
        // and the handle keeps its own full name.
        await expect(leadHeader).toHaveCount(1);
        await expect(leadHeader).toHaveAccessibleName(LEAD_HEADER);
        await expect(leadHeader).toHaveAttribute(
          "data-column-id",
          LEADING_COLUMN_DATA_ID
        );
        await expect(
          leadHeader.getByRole("button", { name: LEAD_RESIZE_HANDLE_NAME })
        ).toHaveAccessibleName(LEAD_RESIZE_HANDLE_NAME);

        expect(await leadBody.getAttribute("aria-colindex")).toBe("1");
        const ownerIndex = await ownerHeader.getAttribute("aria-colindex");
        if (!ownerIndex) {
          throw new Error("Desktop Owner header has no column index");
        }
        const ownerBody = row.locator(
          `[role="gridcell"][aria-colindex="${ownerIndex}"]`
        );
        const ownerHandleResting = await ownerResizeHandle.boundingBox();
        const pinnedResting = await leadHeader.boundingBox();
        if (!(ownerHandleResting && pinnedResting)) {
          throw new Error("Desktop Sessions header has no measurable bounds");
        }

        const currentScroll = await scrollBand.evaluate(
          (element) => element.scrollLeft
        );
        const targetScroll =
          currentScroll +
          ownerHandleResting.x +
          ownerHandleResting.width / 2 -
          (pinnedResting.x + pinnedResting.width / 2);
        await scrollBand.evaluate((element, offset) => {
          element.scrollLeft = offset;
        }, targetScroll);
        await expect
          .poll(() => scrollBand.evaluate((element) => element.scrollLeft))
          .toBeGreaterThan(0);

        const ownerHandleAfter = await ownerResizeHandle.boundingBox();
        const ownerAfter = await ownerHeader.boundingBox();
        const ownerBodyAfter = await ownerBody.boundingBox();
        const pinnedAfter = await leadHeader.boundingBox();
        const leadBodyAfter = await leadBody.boundingBox();
        if (
          !(
            ownerHandleAfter &&
            ownerAfter &&
            ownerBodyAfter &&
            pinnedAfter &&
            leadBodyAfter
          )
        ) {
          throw new Error(
            "Desktop Sessions pin or Owner has no measurable bounds"
          );
        }
        expect(ownerHandleAfter.x).toBeLessThan(
          pinnedAfter.x + pinnedAfter.width
        );
        expect(ownerHandleAfter.x + ownerHandleAfter.width).toBeGreaterThan(
          pinnedAfter.x
        );
        expect(ownerHandleAfter.y).toBeLessThan(
          pinnedAfter.y + pinnedAfter.height
        );
        expect(ownerHandleAfter.y + ownerHandleAfter.height).toBeGreaterThan(
          pinnedAfter.y
        );
        expect(ownerAfter.x).toBeLessThan(pinnedAfter.x + pinnedAfter.width);
        expect(ownerAfter.x + ownerAfter.width).toBeGreaterThan(pinnedAfter.x);
        expect(Math.abs(ownerAfter.x - ownerBodyAfter.x)).toBeLessThan(
          COLUMN_ALIGNMENT_TOLERANCE_PX
        );
        expect(Math.abs(pinnedAfter.x - leadBodyAfter.x)).toBeLessThan(
          COLUMN_ALIGNMENT_TOLERANCE_PX
        );

        expect(await backgroundAlpha(leadHeader)).toBe(255);
        expect(await backgroundAlpha(leadBody)).toBe(255);
        expect(await backgroundAlpha(leadHeader, "::before")).toBe(0);
        expect(await pinnedCellIsTopmost(leadHeader, ownerHeader)).toBe(true);
        expect(await pinnedCellIsTopmost(leadHeader, ownerResizeHandle)).toBe(
          true
        );
        expect(
          await pinnedCellIsTopmost(
            leadHeader,
            ownerHeader,
            "covered-right-edge"
          )
        ).toBe(true);
        expect(await pinnedCellIsTopmost(leadBody, ownerBody)).toBe(true);
        const scrollBeforeHover = await scrollBand.evaluate(
          (element) => element.scrollLeft
        );
        await hoverCellInPlace(leadHeader);
        await expect
          .poll(() => backgroundAlpha(leadHeader, "::before"))
          .toBeGreaterThan(0);
        expect(await scrollBand.evaluate((element) => element.scrollLeft)).toBe(
          scrollBeforeHover
        );
        expect(await backgroundAlpha(leadHeader)).toBe(255);
        expect(await backgroundAlpha(leadBody)).toBe(255);
        expect(await pinnedCellIsTopmost(leadHeader, ownerHeader)).toBe(true);
        expect(await pinnedCellIsTopmost(leadHeader, ownerResizeHandle)).toBe(
          true
        );
        expect(
          await pinnedCellIsTopmost(
            leadHeader,
            ownerHeader,
            "covered-right-edge"
          )
        ).toBe(true);
        expect(await pinnedCellIsTopmost(leadBody, ownerBody)).toBe(true);
        await page.mouse.move(0, 0);
        await expect
          .poll(() => backgroundAlpha(leadHeader, "::before"))
          .toBe(0);
        expect(await backgroundAlpha(leadHeader)).toBe(255);
        expect(await pinnedCellIsTopmost(leadHeader, ownerHeader)).toBe(true);
        expect(await pinnedCellIsTopmost(leadHeader, ownerResizeHandle)).toBe(
          true
        );
        expect(
          await pinnedCellIsTopmost(
            leadHeader,
            ownerHeader,
            "covered-right-edge"
          )
        ).toBe(true);
      }
    );
  } finally {
    await cleanupSeededSessionsDirs(dirs);
  }
});
