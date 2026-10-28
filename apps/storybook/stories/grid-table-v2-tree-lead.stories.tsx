// biome-ignore-all lint/a11y/useFocusableInteractive: in the APG treegrid pattern the roving tab stop is on the CELL, never the row — giving each `row` a tabindex would add a second tab stop and break the model.
// biome-ignore-all lint/a11y/useSemanticElements: a CSS-grid treegrid cannot be a real <table>; these are the roles `GridTableV2` itself renders.
/**
 * The disclosure a `treegrid` row's identity cell carries — ISS-9290.
 *
 * The two stories here are the same control in the two layouts the champion
 * renders it in, and the difference between them is the whole reason the
 * component takes `declaresExpandedState`: in the GRID the `treegrid` row owns
 * `aria-expanded` and this button must not repeat it, while in the CARD
 * fallback there is no row at all, so the button has to carry it or the
 * open/closed state reaches assistive tech nowhere (WCAG 4.1.2).
 *
 * Applicable states: default, expanded, collapsed, focus-visible (focus half),
 * keyboard/pointer interaction, and the leaf case. Not applicable: selected,
 * editing, dragging, drag-over, loading, empty, partial, error, disabled,
 * permission and overflow — this control is a fixed-size glyph with no data of
 * its own, and the row's content beside it owns every one of those.
 */
import { GridTableV2TreeLead } from "@repo/design-system/components/ui/grid-table-v2-tree-lead";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";

const meta = {
  title: "Primitives v1.0/Data Display/Tables/Grid Table V2 Tree Lead",
  component: GridTableV2TreeLead,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof GridTableV2TreeLead>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The component's own default names, restated so the play asserts the shipped copy. */
const EXPAND_LABEL = "Expand row";
const COLLAPSE_LABEL = "Collapse row";

const PARENT_LABEL = "Parent row";
const CHILD_LABEL = "Child row";
const LEAF_LABEL = "Leaf row";

/**
 * The GRID layout. The row above the control publishes `aria-expanded`, so the
 * control must NOT — one fact, stated once in the accessibility tree.
 *
 * Its name still has to change, because that is the half a row cannot say: a
 * button announced "Expand row" while the row reads expanded tells the user the
 * wrong thing about what pressing it does.
 */
export const InGrid: Story = {
  args: { onToggle: () => undefined, tree: buildTree({ isExpanded: false }) },
  render: () => <TreeLeadStory declaresExpandedState={false} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const control = canvas.getByRole("button", { name: EXPAND_LABEL });

    // The ROW carries the state here, and the control deliberately does not.
    await expect(control).not.toHaveAttribute("aria-expanded");
    await expect(
      canvas.getByRole("row", { name: PARENT_LABEL })
    ).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(control);

    // Both halves moved: the row's state, and the control's name.
    await expect(
      canvas.getByRole("row", { name: PARENT_LABEL })
    ).toHaveAttribute("aria-expanded", "true");
    await expect(
      canvas.getByRole("button", { name: COLLAPSE_LABEL })
    ).not.toHaveAttribute("aria-expanded");

    // Opening the row actually reveals the child, so the state is not cosmetic.
    await expect(canvas.getByText(CHILD_LABEL)).toBeInTheDocument();
  },
};

/**
 * The CARD layout — the narrow-surface fallback, which paints no row. Here the
 * control is the only place the open/closed state can live.
 *
 * The positive sibling of `InGrid`'s `not.toHaveAttribute` assertion: the same
 * locator, the same attribute, the opposite expectation. A component that
 * hardcoded `aria-expanded` either on or off would fail exactly one of the two.
 */
export const InCardFallback: Story = {
  args: { onToggle: () => undefined, tree: buildTree({ isExpanded: false }) },
  render: () => <TreeLeadStory declaresExpandedState />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // No row exists in this layout, so nothing above the control can carry it.
    await expect(canvas.queryAllByRole("row")).toHaveLength(0);

    const control = canvas.getByRole("button", { name: EXPAND_LABEL });
    await expect(control).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(control);
    await expect(
      canvas.getByRole("button", { name: COLLAPSE_LABEL })
    ).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByText(CHILD_LABEL)).toBeInTheDocument();
  },
};

/**
 * A row with no children. It offers no control — there is nothing to open — but
 * it still RESERVES the control's track, so its label starts at the same inline
 * offset as its expandable siblings and the depth a reader takes from the
 * indent agrees with `aria-level`.
 *
 * The spacer is `aria-hidden`, so reserving that space costs the accessibility
 * tree nothing: a leaf must not announce a phantom control.
 */
export const Leaf: Story = {
  args: {
    onToggle: () => undefined,
    tree: buildTree({ hasChildren: false, isExpanded: false }),
  },
  render: () => (
    <main className="min-h-screen bg-background p-8">
      <GridTableV2TreeLead
        onToggle={() => undefined}
        tree={buildTree({ hasChildren: false, isExpanded: false })}
      >
        <span>{LEAF_LABEL}</span>
      </GridTableV2TreeLead>
    </main>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // No control, and specifically not a disabled one — a leaf has no action.
    await expect(canvas.queryAllByRole("button")).toHaveLength(0);
    await expect(canvas.getByText(LEAF_LABEL)).toBeInTheDocument();

    // The track is still HELD, at the control's own width — presence alone is
    // not the claim. Stripping the sizing off the spacer leaves an aria-hidden
    // node in place while the leaf's label slides one control-width left of its
    // expandable siblings, so the indent stops agreeing with `aria-level`.
    const spacer = canvasElement.querySelector('[aria-hidden="true"]');
    await expect(spacer).toHaveClass("size-icon-lg");
  },
};

/** One row's tree position. Defaults describe a root that owns children. */
function buildTree({
  hasChildren = true,
  isExpanded,
}: {
  hasChildren?: boolean;
  isExpanded: boolean;
}) {
  return { hasChildren, isExpanded, level: 1, posInSet: 1, setSize: 1 };
}

function TreeLeadStory({
  declaresExpandedState,
}: {
  declaresExpandedState: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const tree = buildTree({ isExpanded });
  const control = (
    <GridTableV2TreeLead
      declaresExpandedState={declaresExpandedState}
      onToggle={setIsExpanded}
      tree={tree}
    >
      <span>{PARENT_LABEL}</span>
    </GridTableV2TreeLead>
  );

  if (!declaresExpandedState) {
    return (
      <main className="min-h-screen bg-background p-8">
        <div
          aria-label="Artifacts"
          className="overflow-hidden rounded-md border"
          role="treegrid"
        >
          <div
            aria-expanded={isExpanded}
            aria-label={PARENT_LABEL}
            aria-level={1}
            className="border-b px-3 py-2"
            role="row"
          >
            {control}
          </div>
          {isExpanded ? (
            <div
              aria-label={CHILD_LABEL}
              aria-level={2}
              className="px-3 py-2 pl-10"
              role="row"
            >
              <span>{CHILD_LABEL}</span>
            </div>
          ) : null}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background p-8">
      <div className="flex flex-col gap-3">
        {control}
        {isExpanded ? <span className="pl-10">{CHILD_LABEL}</span> : null}
      </div>
    </main>
  );
}
