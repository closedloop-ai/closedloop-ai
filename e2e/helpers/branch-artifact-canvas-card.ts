import { expect, type Locator, type Page } from "@playwright/test";

/** Wide enough, with the comments rail closed, that the card is not squeezed. */
export const BRANCH_ARTIFACT_WIDE_VIEWPORT = {
  height: 900,
  width: 1440,
} as const;

/**
 * `BranchCommentsToggle`'s open-state label
 * (`packages/app/branches/components/comments/branch-comments-toggle.tsx`).
 */
const COMMENTS_RAIL_HIDE_LABEL = "Hide comments rail";

/** `ArtifactTab`'s muted surround is `p-4`; plus subpixel layout. */
const SURROUND_PX = 16;
const EDGE_TOLERANCE_PX = 1;

/** Wide enough that a card narrowed back to a reading measure would show. */
const MIN_PANEL_WIDTH_PX = 1100;

type CardGeometry = {
  insetLeft: number;
  insetRight: number;
  panelWidth: number;
  scrolls: boolean;
};

/**
 * ISS-12412: the Artifact tab's content sits on the framed canvas card, and
 * the card is the tab's scroll container. ISS-12308's symptom was a scrollbar
 * at a reading measure's edge in mid-page, so the card's box is read back as
 * geometry: one surround inside the panel on both sides, never further in.
 * The rail is closed first so the panel is wide enough for that to mean
 * something, and the card must really scroll the tab's content.
 *
 * `page` is left at {@link BRANCH_ARTIFACT_WIDE_VIEWPORT} with the rail closed.
 */
export async function expectArtifactCanvasCardAtPanelEdge(
  page: Page,
  panel: Locator,
  label: string
): Promise<void> {
  await page.setViewportSize(BRANCH_ARTIFACT_WIDE_VIEWPORT);
  const hideRail = page.getByRole("button", {
    name: COMMENTS_RAIL_HIDE_LABEL,
  });
  // Desktop opens with the rail closed; the width precondition below, not
  // this click, is what proves the panel is wide enough to mean anything.
  if ((await hideRail.count()) > 0) {
    await hideRail.click();
  }
  const card = panel.getByRole("region", { exact: true, name: label });
  await expect(card).toHaveAttribute("data-artifact-frame", "framed");
  const measure = () =>
    card.evaluate((node): CardGeometry => {
      const panelNode = node.closest('[role="tabpanel"]');
      if (!panelNode) {
        throw new Error("ISS-12412: the canvas card is outside a tabpanel");
      }
      const panelRect = panelNode.getBoundingClientRect();
      const cardRect = node.getBoundingClientRect();
      return {
        insetLeft: cardRect.left - panelRect.left,
        insetRight: panelRect.right - cardRect.right,
        panelWidth: panelRect.width,
        scrolls: node.scrollHeight > node.clientHeight,
      };
    });
  await expect
    .poll(async () => (await measure()).panelWidth)
    .toBeGreaterThan(MIN_PANEL_WIDTH_PX);
  const geometry = await measure();
  expect(Math.abs(geometry.insetLeft - SURROUND_PX)).toBeLessThanOrEqual(
    EDGE_TOLERANCE_PX
  );
  expect(Math.abs(geometry.insetRight - SURROUND_PX)).toBeLessThanOrEqual(
    EDGE_TOLERANCE_PX
  );
  expect(geometry.scrolls).toBe(true);
  await card.evaluate((node) => node.scrollBy(0, 200));
  await expect
    .poll(() => card.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
}
