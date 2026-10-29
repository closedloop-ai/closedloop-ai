import {
  Disabled as DisabledStory,
  Dragging as DraggingStory,
  DragOver as DragOverStory,
  default as documentsViewMeta,
  Editing as EditingStory,
  FocusVisible as FocusVisibleStory,
  ManualOrderingError as ManualOrderingErrorStory,
  NoPermission as NoPermissionStory,
  Partial as PartialStory,
  PointerPlacement as PointerPlacementStory,
  ReadOnly as ReadOnlyStory,
  Selected as SelectedStory,
} from "@repo/app/documents/components/table/documents-view.stories";
import { composeStories } from "@storybook/react";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const DRAG_HANDLE_PATTERN = /^Drag to reorder /;

const {
  Disabled,
  Dragging,
  DragOver,
  Editing,
  FocusVisible,
  ManualOrderingError,
  NoPermission,
  Partial,
  PointerPlacement,
  ReadOnly,
  Selected,
} = composeStories({
  default: documentsViewMeta,
  Disabled: DisabledStory,
  Dragging: DraggingStory,
  DragOver: DragOverStory,
  Editing: EditingStory,
  FocusVisible: FocusVisibleStory,
  ManualOrderingError: ManualOrderingErrorStory,
  NoPermission: NoPermissionStory,
  Partial: PartialStory,
  PointerPlacement: PointerPlacementStory,
  ReadOnly: ReadOnlyStory,
  Selected: SelectedStory,
});

describe("AC-004 Documents View manual-ordering story states", () => {
  it("retains placement handles after the pointer move", async () => {
    await PointerPlacement.run();
    expect(
      screen.queryAllByRole("button", { name: DRAG_HANDLE_PATTERN })
    ).toHaveLength(3);
  });

  it.each([
    ["focus-visible", FocusVisible],
    ["selected", Selected],
    ["editing", Editing],
    ["dragging", Dragging],
    ["drag-over", DragOver],
    ["partial", Partial],
    ["pointer-placement", PointerPlacement],
    ["disabled", Disabled],
    ["read-only", ReadOnly],
    ["error", ManualOrderingError],
    ["no-permission", NoPermission],
  ])("renders and proves the %s state", async (_name, Story) => {
    await Story.run();
  });
});
