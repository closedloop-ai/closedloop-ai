import { composeStory } from "@storybook/react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import inlineNameMeta, {
  RefusedRenameRetainsDraft as refusedRenameStory,
} from "../stories/inline-name-cell.stories";

describe("Inline Name Cell stories", () => {
  it("uses the retained-draft label and leaves the refused edit visible", async () => {
    const RefusedRenameRetainsDraft = composeStory(
      refusedRenameStory,
      inlineNameMeta
    );
    const { container } = render(<RefusedRenameRetainsDraft />);

    await RefusedRenameRetainsDraft.play?.({ canvasElement: container });
    expect(refusedRenameStory.name).toBe("Refused Rename Retains Draft");
  });
});
