import { composeStories } from "@storybook/react";
import { describe, it } from "vitest";
import {
  ManualOrdering as ManualOrderingStory,
  default as projectDetailMeta,
} from "../stories/surfaces-v2/v2-project-detail.stories";

const { ManualOrdering } = composeStories({
  default: projectDetailMeta,
  ManualOrdering: ManualOrderingStory,
});

describe("Project Detail manual-ordering production story", () => {
  it("renders row handles and checkboxes when the server permits placement", async () => {
    await ManualOrdering.run();
  });
});
