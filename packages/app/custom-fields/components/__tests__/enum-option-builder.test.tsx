/**
 * Component tests for EnumOptionBuilder's edit mode (ISS-7637).
 *
 * The regression: once a drag-reorder set `orderedIds`, `displayOptions`
 * projected the server list through it and dropped every option whose id was
 * absent — so an option created after the reorder rendered nowhere until the
 * dialog was reopened and the local order reset itself.
 */

import type { DragEndEvent } from "@dnd-kit/core";
import type { CustomFieldEnumOption } from "@repo/api/src/types/custom-field";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnumOptionBuilder } from "../enum-option-builder";

const FIELD_ID = "field-1";
const OPTION_NAME_RE = /^(Alpha|Beta|Gamma)$/;
const ADD_OPTION_RE = /Add option/i;

let serverOptions: CustomFieldEnumOption[] = [];
let capturedDragEnd: ((event: DragEndEvent) => void) | undefined;

const mockCreateMutate = vi.fn();
const mockUpdateMutate = vi.fn();
const mockReorderMutate = vi.fn();

vi.mock("@repo/app/custom-fields/hooks/use-custom-fields", () => ({
  useCustomFieldEnumOptions: () => ({ data: serverOptions }),
  useCreateEnumOption: () => ({ mutate: mockCreateMutate, isPending: false }),
  useUpdateEnumOption: () => ({ mutate: mockUpdateMutate, isPending: false }),
  useReorderEnumOptions: () => ({
    mutate: mockReorderMutate,
    isPending: false,
  }),
}));

// dnd-kit resolves drops through pointer sensors and a collision detector that
// jsdom cannot drive (no layout, no pointer capture). The code under test is
// EditModeBuilder's own handleDragEnd and its displayOptions projection, so the
// provider is doubled purely to hand that callback back to the test. The real
// DndContext still wraps the tree, so SortableContext and useSortable render
// exactly as they do in production.
vi.mock("@repo/app/shared/components/dnd-provider", async () => {
  const { DndContext } = await import("@dnd-kit/core");
  return {
    DndProvider: ({
      children,
      onDragEnd,
    }: {
      children: ReactNode;
      onDragEnd: (event: DragEndEvent) => void;
    }) => {
      capturedDragEnd = onDragEnd;
      return <DndContext>{children}</DndContext>;
    },
  };
});

beforeEach(() => {
  capturedDragEnd = undefined;
  serverOptions = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

function buildOption(
  id: string,
  name: string,
  sortOrder: number
): CustomFieldEnumOption {
  return {
    id,
    customFieldId: FIELD_ID,
    name,
    color: "none",
    enabled: true,
    sortOrder,
  };
}

/** Option names in DOM order — identity, never a count. */
function renderedNames(): (string | null)[] {
  return screen.queryAllByText(OPTION_NAME_RE).map((el) => el.textContent);
}

function dragOver(activeId: string, overId: string) {
  act(() =>
    capturedDragEnd?.({
      active: { id: activeId },
      over: { id: overId },
    } as DragEndEvent)
  );
}

describe("EnumOptionBuilder edit mode", () => {
  it("renders server order by sortOrder before any local reorder", () => {
    serverOptions = [
      buildOption("opt-b", "Beta", 1),
      buildOption("opt-a", "Alpha", 0),
    ];

    render(<EnumOptionBuilder fieldId={FIELD_ID} />);

    expect(renderedNames()).toEqual(["Alpha", "Beta"]);
  });

  it("keeps a newly created option visible after a local reorder", () => {
    serverOptions = [
      buildOption("opt-a", "Alpha", 0),
      buildOption("opt-b", "Beta", 1),
    ];

    const { rerender } = render(<EnumOptionBuilder fieldId={FIELD_ID} />);
    expect(renderedNames()).toEqual(["Alpha", "Beta"]);

    dragOver("opt-b", "opt-a");
    expect(renderedNames()).toEqual(["Beta", "Alpha"]);
    expect(mockReorderMutate).toHaveBeenCalledWith(["opt-b", "opt-a"]);

    fireEvent.click(screen.getByRole("button", { name: ADD_OPTION_RE }));
    expect(mockCreateMutate).toHaveBeenCalledWith({
      name: "New Option",
      enabled: true,
      sortOrder: 2,
    });

    // The create resolves and the enum-options query returns the new row.
    serverOptions = [...serverOptions, buildOption("opt-c", "Gamma", 2)];
    rerender(<EnumOptionBuilder fieldId={FIELD_ID} />);

    // Both halves matter: the new row is visible AND the reorder survived.
    // Resetting orderedIds to null would satisfy the first and fail the second.
    expect(renderedNames()).toEqual(["Beta", "Alpha", "Gamma"]);
  });

  it("drops an option the server stops returning after a local reorder", () => {
    serverOptions = [
      buildOption("opt-a", "Alpha", 0),
      buildOption("opt-b", "Beta", 1),
      buildOption("opt-c", "Gamma", 2),
    ];

    const { rerender } = render(<EnumOptionBuilder fieldId={FIELD_ID} />);

    dragOver("opt-c", "opt-a");
    expect(renderedNames()).toEqual(["Gamma", "Alpha", "Beta"]);

    serverOptions = serverOptions.filter((o) => o.id !== "opt-a");
    rerender(<EnumOptionBuilder fieldId={FIELD_ID} />);

    // Appending unplaced server options must not resurrect a removed one.
    expect(renderedNames()).toEqual(["Gamma", "Beta"]);
  });
});
