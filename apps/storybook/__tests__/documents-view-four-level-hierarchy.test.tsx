import { composeStory } from "@storybook/react";
import { describe, it } from "vitest";
import documentsViewMeta, {
  FourLevelHierarchy as fourLevelHierarchyStory,
} from "../../../packages/app/documents/components/table/documents-view.stories";

const FourLevelHierarchy = composeStory(
  fourLevelHierarchyStory,
  documentsViewMeta
);

describe("DocumentsView FourLevelHierarchy story", () => {
  it("keeps the hierarchy mounted through feature collapse and row selection", async () => {
    await FourLevelHierarchy.run();
  });
});
