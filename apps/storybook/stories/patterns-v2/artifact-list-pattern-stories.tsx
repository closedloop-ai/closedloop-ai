import {
  GRID_TABLE_METRIC_BAND_TEST_ID,
  GRID_TABLE_PAGINATION_BAND_TEST_ID,
  GRID_TABLE_SCROLL_BAND_TEST_ID,
} from "@repo/design-system/components/ui/grid-table-list-surface";
import { CARD_FALLBACK_BREAKPOINT } from "@repo/design-system/lib/column-order";
import type { StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { ArtifactListLayout } from "./artifact-list-layout";

/**
 * The stories every artifact list pattern has (ISS-12171): the layout at full
 * width, below the card breakpoint, and dark. Each list pattern file exports
 * them under its own title, so the pages stay one layout.
 */
type ListPatternStory = StoryObj;

/**
 * Every list pattern's meta: the layout, fullscreen, with no controls. Each
 * file sets `tags` itself: the static story indexer does not read a spread.
 */
export const artifactListPatternMeta = {
  render: () => <ArtifactListLayout />,
  parameters: { layout: "fullscreen", controls: { disable: true } },
};

/** The page header, then the list surface's four bands in order. */
export const artifactListDefault: ListPatternStory = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("toolbar-region-expanded")).toBeVisible();
    await expect(canvas.getByTestId("rows-region-expanded")).toBeVisible();
    await expect(canvas.queryByTestId("rows-region-compact")).toBeNull();
    await expect(canvas.getByTestId("page-header")).toBeVisible();
    await expect(
      canvas.getByTestId(GRID_TABLE_METRIC_BAND_TEST_ID)
    ).toContainElement(canvas.getByTestId("summary-region"));
    await expect(
      canvas.getByTestId(GRID_TABLE_SCROLL_BAND_TEST_ID)
    ).toBeInTheDocument();
    await expect(
      canvas.getByTestId(GRID_TABLE_PAGINATION_BAND_TEST_ID)
    ).toContainElement(canvas.getByTestId("pagination-region"));
  },
};

/** Below the card breakpoint: the folded toolbar over a card list. */
export const artifactListNarrow: ListPatternStory = {
  decorators: [
    (Story) => (
      <div
        data-testid="narrow-width-host"
        style={{ width: CARD_FALLBACK_BREAKPOINT - 1 }}
      >
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const host = canvas.getByTestId("narrow-width-host");
    await expect(host).toHaveStyle({
      width: `${CARD_FALLBACK_BREAKPOINT - 1}px`,
    });
    // jsdom has no layout, so the surface keeps its wide default there; the
    // mode switch is only observable where the host has a real width.
    if (host.getBoundingClientRect().width === 0) {
      return;
    }
    await expect(
      await canvas.findByTestId("toolbar-region-compact")
    ).toBeVisible();
    await expect(canvas.getByTestId("rows-region-compact")).toBeVisible();
    await expect(canvas.queryByTestId("rows-region-expanded")).toBeNull();
  },
};

export const artifactListDark: ListPatternStory = {
  globals: { theme: "dark" },
};
