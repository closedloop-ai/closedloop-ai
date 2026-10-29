import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { ArtifactListLayout } from "./artifact-list-layout";
import {
  artifactListDark,
  artifactListDefault,
  artifactListNarrow,
  artifactListPatternMeta,
} from "./artifact-list-pattern-stories";

/**
 * Patterns: the Branches list page's layout, the artifact list layout
 * `BranchesListSurfaceV2` renders (`artifact-list-layout.tsx`), with the
 * selection rail band its bulk actions use (ISS-12305).
 *
 * The finished page, built from this layout and the Composites sections
 * under Composites/Artifacts/Branches/Branches List, is
 * Surfaces/Artifacts/Branches/Branches List.
 *
 * Controls are disabled: every story is a fixed layout state.
 */
const meta = {
  ...artifactListPatternMeta,
  render: () => <ArtifactListLayout selectionRail />,
  title: "Patterns/Artifacts/Branches/Branches List",
  tags: ["stable"],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async (context) => {
    await artifactListDefault.play?.(context);
    await expect(
      within(context.canvasElement).getByTestId("selection-rail-region")
    ).toBeVisible();
  },
};

export const Narrow: Story = artifactListNarrow;

export const Dark: Story = artifactListDark;
