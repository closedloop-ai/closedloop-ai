import { composeStory } from "@storybook/react";
import { screen } from "@testing-library/react";
import { expect, it } from "vitest";
import meta, { Default } from "../stories/drag-preview-chip.stories";

it("renders the shared drag preview story with only a grip and title", async () => {
  await composeStory(Default, meta).run();
  const chip = screen.getByTestId("drag-preview-chip");
  expect(chip).toHaveTextContent("Test PRD");
  expect(chip.querySelector("svg")).not.toBeNull();
  expect(chip.querySelectorAll("[data-drag-preview-title]")).toHaveLength(1);
});
