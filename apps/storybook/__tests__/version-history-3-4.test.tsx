import { composeStory } from "@storybook/react";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import meta, {
  VersionHistory,
} from "../stories/start-here-version-history.stories";

describe("PRD-721 AC-RM-02 Storybook 3.4.0 history", () => {
  it("preserves merged history and records the merged-tree footprint", async () => {
    await composeStory(VersionHistory, meta).run();

    // Located by text, not by position: every later release goes on top, so
    // a fixed index would break on the next version bump.
    const releaseHeadings = screen.getAllByRole("heading", { level: 2 });
    const headingTexts = releaseHeadings.map((heading) => heading.textContent);
    const merged = headingTexts.indexOf("v6.0.0");
    expect(headingTexts.slice(merged, merged + 8)).toEqual([
      "v6.0.0",
      "v5.0.0",
      "v4.1.0",
      "v4.0.3",
      "v4.0.2",
      "v4.0.1",
      "v4.0.0",
      "v3.4.7",
    ]);
    const gridviewRelease = releaseHeadings[merged]?.closest("section");
    expect(gridviewRelease).not.toBeNull();
    if (!gridviewRelease) {
      throw new Error("Gridview Storybook release section was not rendered");
    }
    expect(
      within(gridviewRelease).getByRole("row", {
        name: "Composites 84 635",
      })
    ).toBeVisible();
    expect(
      within(gridviewRelease).getByRole("row", {
        name: "Surfaces 61 328",
      })
    ).toBeVisible();
    const prd725Release =
      releaseHeadings[headingTexts.indexOf("v4.0.1")]?.closest("section");
    expect(prd725Release).not.toBeNull();
    if (!prd725Release) {
      throw new Error("PRD-725 Storybook release section was not rendered");
    }
    const start = headingTexts.indexOf("v3.4.1");
    expect(headingTexts.slice(start - 1, start + 4)).toEqual([
      "v3.4.2",
      "v3.4.1",
      "v3.4.0",
      "v3.3.0",
      "v3.2.9",
    ]);

    const currentRelease = releaseHeadings[start + 1]?.closest("section");
    expect(currentRelease).not.toBeNull();
    if (!currentRelease) {
      throw new Error("current Storybook release section was not rendered");
    }
    expect(
      within(prd725Release).getByRole("row", {
        name: "Composites 81 585",
      })
    ).toBeVisible();
    expect(prd725Release).toHaveTextContent("Manual Ordering");
    expect(
      releaseHeadings[headingTexts.indexOf("v4.1.0")]?.closest("section")
    ).toHaveTextContent("pointer, cursor and hover contract");

    const mainRelease = releaseHeadings[start]?.closest("section");
    expect(mainRelease).not.toBeNull();
    if (!mainRelease) {
      throw new Error("main Storybook release section was not rendered");
    }
    expect(
      within(mainRelease).getByRole("row", {
        name: "Composites 78 540",
      })
    ).toBeVisible();
    expect(mainRelease).toHaveTextContent("Remove Tag");

    const priorRelease = releaseHeadings[start + 1]?.closest("section");
    expect(priorRelease).not.toBeNull();
    if (!priorRelease) {
      throw new Error("prior Storybook release section was not rendered");
    }
    expect(
      within(priorRelease).getByRole("row", {
        name: "Composites 78 539",
      })
    ).toBeVisible();
    expect(priorRelease).toHaveTextContent(
      "Shared/Artifact List/Filtering and Sorting Model"
    );
  });
});
