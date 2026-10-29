import { MANUAL_ARTIFACT_ORDERING_FLAG_KEY } from "@repo/api/src/types/manual-artifact-ordering-flag";
import { PROJECT_TREE_MAX_VISIBLE_LEVELS } from "@repo/api/src/types/project-tree";
import { PROJECTS_PORTABLE_SURFACE_FLAG_KEY } from "@repo/api/src/types/projects-portable-surface-flag";
import { ARTIFACT_IDENTITY_COLUMN_WIDTH_PX } from "@repo/app/shared/lib/column-width";
import { composeStory } from "@storybook/react";
import { screen, within } from "@testing-library/react";
import { userEvent } from "storybook/test";
import { describe, expect, it } from "vitest";
import projectDetailMeta, {
  ManualOrdering as manualOrderingStory,
} from "../stories/surfaces-v2/v2-project-detail.stories";

const ManualOrdering = composeStory(manualOrderingStory, projectDetailMeta);
const PortableManualOrdering = composeStory(
  {
    ...manualOrderingStory,
    parameters: {
      ...manualOrderingStory.parameters,
      appCore: {
        ...manualOrderingStory.parameters?.appCore,
        enabledFlags: [
          MANUAL_ARTIFACT_ORDERING_FLAG_KEY,
          PROJECTS_PORTABLE_SURFACE_FLAG_KEY,
        ],
      },
    },
  },
  projectDetailMeta
);

describe("Project Detail hierarchy story", () => {
  it("enables and proves the production hierarchy composition", async () => {
    expect(manualOrderingStory.parameters?.appCore?.enabledFlags).toEqual([
      MANUAL_ARTIFACT_ORDERING_FLAG_KEY,
    ]);
    await ManualOrdering.run();
    expect(screen.queryByRole("button", { name: "Add issue" })).toBeNull();
  });

  it("renders the same hierarchy tree in the portable Project Detail host", async () => {
    await PortableManualOrdering.run();
    expect(screen.getByRole("button", { name: "Add issue" })).toBeVisible();
    expect(screen.getByTestId("project-hierarchy-host")).toHaveClass(
      "max-w-[100dvw]"
    );
    const tree = screen.getByRole("treegrid");
    const depthFourRow = within(tree)
      .getAllByRole("row")
      .find((row) => row.getAttribute("aria-level") === "4");
    expect(depthFourRow?.style.gridTemplateColumns).toContain(
      `calc(${ARTIFACT_IDENTITY_COLUMN_WIDTH_PX}px + (var(--icon-lg) + var(--density-cozy)) * ${PROJECT_TREE_MAX_VISIBLE_LEVELS - 1})`
    );
    // ISS-13007 R-IDENTICAL-LISTS: no persistent row checkbox, as Documents;
    // a row is selected by clicking it (a plain click replaces the selection).
    const rowAt = (index: number) =>
      within(tree).getAllByRole("row")[index] as HTMLElement;
    expect(within(tree).queryAllByRole("checkbox")).toHaveLength(0);
    await userEvent.click(rowAt(1));
    expect(rowAt(1)).toHaveAttribute("aria-selected", "true");
    expect(rowAt(3)).toHaveAttribute("aria-selected", "false");
    await userEvent.click(rowAt(3));
    expect(rowAt(3)).toHaveAttribute("aria-selected", "true");
    expect(rowAt(1)).toHaveAttribute("aria-selected", "false");
  });
});
