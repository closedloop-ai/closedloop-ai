import { composeStory } from "@storybook/react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import inlineRenameMeta, {
  EditorOpenOnTheLeadCell as editorOpenStory,
  OwnerSeesTheControl as ownerSeesControlStory,
  RefusedRenameRetainsDraft as refusedRenameStory,
} from "../../../packages/app/agents/components/sessions/session-inline-rename.stories";

/**
 * ISS-8718 — the inline-rename stories must actually RENDER and play. A story
 * that throws on mount costs whoever opens Storybook their time and shows up
 * nowhere else: the component suites in `@repo/app` cover the behavior, not the
 * story wiring (the preview harness, the providers, the args the meta requires).
 *
 * `composeStory` per story rather than `composeStories` over a namespace import,
 * which `lint/performance/noNamespaceImport` refuses — the same shape
 * `portable-story-root-unmount.test.tsx` uses.
 */

const OWNED_CONTROL = {
  name: "Edit session name for session/mine-to-rename",
};

describe("Session Inline Rename stories", () => {
  it("renders the grid with the owner's control and none for a teammate's row", async () => {
    const OwnerSeesTheControl = composeStory(
      ownerSeesControlStory,
      inlineRenameMeta
    );
    const { container } = render(<OwnerSeesTheControl />);

    await waitFor(() =>
      expect(screen.getByRole("button", OWNED_CONTROL)).toBeInTheDocument()
    );
    await OwnerSeesTheControl.play?.({ canvasElement: container });
  });

  it("opens the field on the lead cell seeded with the committed name", async () => {
    const EditorOpenOnTheLeadCell = composeStory(
      editorOpenStory,
      inlineRenameMeta
    );
    const { container } = render(<EditorOpenOnTheLeadCell />);

    await EditorOpenOnTheLeadCell.play?.({ canvasElement: container });
  });

  it("keeps a refused draft and its live error in the editor", async () => {
    const RefusedRenameRetainsDraft = composeStory(
      refusedRenameStory,
      inlineRenameMeta
    );
    const { container } = render(<RefusedRenameRetainsDraft />);

    await RefusedRenameRetainsDraft.play?.({ canvasElement: container });
    expect(refusedRenameStory.name).toBe("Refused Rename Retains Draft");
  });
});
