import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import {
  SortableSubtree,
  type SortableSubtreeProps,
} from "@repo/design-system/components/ui/sortable-subtree";
import {
  ariaCellProps,
  ariaRowProps,
  ariaTableProps,
} from "@repo/design-system/lib/grid-table-aria";
import type { Meta, StoryObj } from "@storybook/react";
import { GripVerticalIcon } from "lucide-react";
import { useState } from "react";
import { expect, userEvent, waitFor } from "storybook/test";

const meta = {
  title: "Primitives/Data Display/Sortable Subtree",
  component: SortableSubtree,
  tags: ["autodocs", "stable"],
  parameters: { layout: "padded" },
  args: {
    id: "name",
    handleLabel: "Reorder row",
    insideAriaTable: false,
    renderRoot: () => null,
  },
  argTypes: {
    handleLabel: { control: "text" },
    insideAriaTable: { control: "boolean" },
    id: { control: false },
    renderRoot: { control: false },
    children: { control: false },
  },
  render: (args) => <SortableSubtreeDemo {...args} />,
} satisfies Meta<typeof SortableSubtree>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const RootOnly: Story = {
  render: (args) => <SortableSubtreeDemo {...args} rootOnly />,
};

export const Hover: Story = {
  play: async ({ canvas }) => {
    await userEvent.hover(
      canvas.getAllByRole("button", { name: "Reorder row" })[0]
    );
  },
};

export const Focus: Story = {
  play: async ({ canvas }) => {
    await userEvent.tab();
    await expect(
      canvas.getAllByRole("button", { name: "Reorder row" })[0]
    ).toHaveFocus();
  },
};

export const Dragging: Story = {
  play: async ({ canvas }) => {
    await userEvent.tab();
    await userEvent.keyboard("[Space]");
    await expect(
      canvas.getAllByRole("button", { name: "Reorder row" })[0]
    ).toHaveAttribute("aria-pressed", "true");
  },
};

export const KeyboardCancel: Story = {
  play: async ({ canvas }) => {
    const handle = canvas.getAllByRole("button", { name: "Reorder row" })[0];
    handle.focus();
    await expect(handle).toHaveFocus();
    await userEvent.keyboard("[Space]");
    await expect(handle).toHaveAttribute("aria-pressed", "true");
    await userEvent.keyboard("[Escape]");
    await expect(handle).not.toHaveAttribute("aria-pressed");
    await expect(handle).toHaveFocus();
  },
};

export const KeyboardReorder: Story = {
  play: async ({ canvas }) => {
    const handles = canvas.getAllByRole("button", { name: "Reorder row" });
    const handle = handles[0];
    await expect(rowOrder(canvas)).toEqual(INITIAL_ROW_ORDER);
    layOutSubtrees(handles);
    handle.focus();
    await expect(handle).toHaveFocus();
    await userEvent.keyboard("[Space]");
    await expect(handle).toHaveAttribute("aria-pressed", "true");
    await userEvent.keyboard("[ArrowDown][Space]");
    await expect(handle).not.toHaveAttribute("aria-pressed");
    // The dropped root carries its whole subtree past the next root.
    await waitFor(() => expect(rowOrder(canvas)).toEqual(REORDERED_ROW_ORDER));
  },
};

export const RealisticUse: Story = {
  render: (args) => <SortableSubtreeDemo {...args} editable />,
};

// Identity, root render and descendants come from the owning composition, so they have no controls.
function SortableSubtreeDemo({
  editable = false,
  handleLabel,
  id,
  insideAriaTable = false,
  rootOnly = false,
}: SortableSubtreeProps & { editable?: boolean; rootOnly?: boolean }) {
  const [items, setItems] = useState([id, "status"]);
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (
      !over ||
      active.id === over.id ||
      typeof active.id !== "string" ||
      typeof over.id !== "string"
    ) {
      return;
    }
    const activeId = active.id;
    const overId = over.id;
    setItems((current) => {
      const from = current.indexOf(activeId);
      const to = current.indexOf(overId);
      if (from < 0 || to < 0) {
        return current;
      }
      return arrayMove(current, from, to);
    });
  };
  const childrenForRoot = (root: string) => {
    if (rootOnly) {
      return [];
    }
    return root === id ? ["Priority", "Tags"] : ["Updated"];
  };

  return (
    <DndContext
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      sensors={sensors}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <div
          className="w-full max-w-lg"
          {...ariaTableProps(insideAriaTable, 1)}
        >
          {items.map((item) => (
            <SortableSubtree
              handleLabel={handleLabel}
              id={item}
              insideAriaTable={insideAriaTable}
              key={item}
              renderRoot={({ buttonProps }) => (
                <div
                  className="group/row border-b bg-background"
                  {...ariaRowProps(insideAriaTable)}
                >
                  <div
                    className="flex min-h-11 items-center gap-2 px-3"
                    {...ariaCellProps(insideAriaTable, 1)}
                  >
                    <button
                      {...buttonProps}
                      className="flex size-7 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
                    >
                      <GripVerticalIcon className="size-4" />
                    </button>
                    {editable ? (
                      <Input
                        aria-label="Name"
                        defaultValue={item === id ? "Name" : "Status"}
                      />
                    ) : (
                      <span>{item === id ? "Name" : "Status"}</span>
                    )}
                    {editable ? (
                      <Button size="sm" variant="ghost">
                        Edit
                      </Button>
                    ) : null}
                  </div>
                </div>
              )}
            >
              {childrenForRoot(item).map((label) => (
                <div
                  className="border-b bg-background"
                  key={label}
                  {...ariaRowProps(insideAriaTable)}
                >
                  <div
                    className="min-h-11 py-3 pr-3 pl-12 text-muted-foreground text-sm"
                    {...ariaCellProps(insideAriaTable, 1)}
                  >
                    {label}
                  </div>
                </div>
              ))}
            </SortableSubtree>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

const ROW_LABEL = /^(Name|Status|Priority|Tags|Updated)$/;
const INITIAL_ROW_ORDER = ["Name", "Priority", "Tags", "Status", "Updated"];
const REORDERED_ROW_ORDER = ["Status", "Updated", "Name", "Priority", "Tags"];

function rowOrder(canvas: { getAllByText: (text: RegExp) => HTMLElement[] }) {
  return canvas.getAllByText(ROW_LABEL).map((row) => row.textContent);
}

/** Row band height used only where the environment lays nothing out. */
const SYNTHETIC_ROW_HEIGHT_PX = 44;

/**
 * The keyboard sensor moves to the next subtree by its measured box, and jsdom
 * measures every box as zero. Give each subtree a stacked synthetic box ONLY
 * when the environment reported no height; a real browser keeps its own.
 */
function layOutSubtrees(handles: readonly HTMLElement[]) {
  const subtrees = handles.map((handle) =>
    handle.closest("[data-sortable-subtree-id]")
  );
  if (subtrees[0]?.getBoundingClientRect().height !== 0) {
    return;
  }
  let top = 0;
  for (const subtree of subtrees) {
    if (!(subtree instanceof HTMLElement)) {
      continue;
    }
    const height =
      subtree.querySelectorAll("[class*='border-b']").length *
      SYNTHETIC_ROW_HEIGHT_PX;
    const box = { top, height };
    subtree.getBoundingClientRect = () =>
      ({
        bottom: box.top + box.height,
        height: box.height,
        left: 0,
        right: 600,
        top: box.top,
        width: 600,
        x: 0,
        y: box.top,
        toJSON: () => ({}),
      }) as DOMRect;
    top += height;
  }
}
