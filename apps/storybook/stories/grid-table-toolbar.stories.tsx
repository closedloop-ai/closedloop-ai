import { Button } from "@repo/design-system/components/ui/button";
import { GridTableToolbar } from "@repo/design-system/components/ui/grid-table-toolbar";
import {
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import { ListSurfaceDemo } from "./grid-table-toolbar-demo/list-surface-demo";

/**
 * ISS-7051 — the Generic Artifact prototype's list toolbar, promoted to
 * design-system components.
 *
 * `GridTableToolbar` is a layout shell with slots; the controls that fill it
 * (`TableSortMenu`, `TableGroupMenu`, `TableOptionsMenu`,
 * `TableSavedViewsMenu`, `TableCompactViewMenu`, `TableDateRangeToggle`) are
 * separate, domain-agnostic components. Every story
 * here drives a real `GridTableV2` through that toolbar, because the thing
 * worth reviewing is not that the controls render — it is that their state
 * model reaches a table.
 *
 * The fixtures are SESSIONS, not artifacts. The toolbar came out of an
 * artifact surface, so exercising it against a different domain is the cheapest
 * evidence that nothing artifact-shaped survived the extraction.
 *
 * ## Taxonomy (ISS-9314)
 * Design System / Data Display — a composed layout shell over the Gridview
 * column system's toolbar-level controls (sort/group/options/views/compact),
 * one layer up from the header/cell primitives it sits above.
 *
 * ## State matrix — which of the 16 apply
 * - **default, hover, focus-visible, keyboard/pointer interaction** — every
 *   story below drives its controls through real clicks; hover/focus-visible
 *   styling on the individual menu triggers is each control's own component's
 *   contract, not this shell's.
 * - **selected, editing, dragging, drag-over** — not applicable. The shell
 *   renders slots; it holds no selection, edit, or drag state of its own.
 * - **loading, empty, partial, error** — not applicable to the SHELL itself
 *   (no data access here), but see `HidingAColumnDropsItsTrack` and the
 *   grouped/filtered stories for the composed `GridTableV2` body's real
 *   states through this toolbar.
 * - **disabled, read-only, permission** — not applicable. No prop on
 *   `GridTableToolbar` gates a slot; a surface that should not offer sort or
 *   group simply does not pass that slot's content, same pattern as the
 *   header's per-column capability gating.
 * - **narrow** — `CompactWidth` folds the four right-hand menus into one
 *   `TableCompactViewMenu`, a genuinely different control, not the wide
 *   layout shrunk.
 * - **overflow** — `min-w-min` on the control row is the documented wrap
 *   floor (see the component's own header comment); not given its own story
 *   here because it is a CSS behavior with no state to assert through a
 *   `play` function beyond what `CompactWidth` already exercises at the
 *   `md` boundary.
 *
 * Visual-regression note: `parameters.chromatic` is not set on this story and
 * no workflow in this repo runs a Chromatic upload step, so there is no
 * automated screenshot diff for any story here today.
 */
const meta = {
  title: "Composites v1.0/Data Display/Tables/Grid Table Toolbar",
  component: GridTableToolbar,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof GridTableToolbar>;

// No controls: these stories compose fixed control slots to show their layout contract.

export default meta;

type Story = StoryObj;

/** Matches the Repository switch row inside the options menu. */
const REPOSITORY_OPTION_PATTERN = /Repository/;

const GROUPED_BY_STATUS: TableGroupingState = {
  primary: {
    fieldId: "status",
    order: TableGroupOrder.Ascending,
    showEmptyGroups: false,
  },
  secondary: {
    fieldId: null,
    order: TableGroupOrder.Ascending,
    showEmptyGroups: false,
  },
};

const GROUPED_BY_STATUS_THEN_OWNER: TableGroupingState = {
  primary: GROUPED_BY_STATUS.primary,
  secondary: {
    fieldId: "owner",
    order: TableGroupOrder.Ascending,
    showEmptyGroups: false,
  },
};

/** The resting surface: toolbar, two metric cards, an ungrouped paged table. */
export const Default: Story = {
  render: () => <ListSurfaceDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByRole("button", { name: "Sort" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Group" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Options" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Views" })).toBeVisible();
    // Ungrouped, so the paginator is present and the page is not the whole set.
    // Queried by LABEL, not by `role: "link"`: the shared shadcn
    // `PaginationLink` renders an href-less `<a>`, which has no implicit role.
    await expect(canvas.getByLabelText("Go to next page")).toBeVisible();
  },
};

/**
 * One grouping level applied. The paginator is deliberately absent: a page
 * boundary cutting through a group renders a section header with rows missing
 * beneath it, which reads as data loss rather than as pagination.
 */
export const GroupedByStatus: Story = {
  render: () => <ListSurfaceDemo initialGrouping={GROUPED_BY_STATUS} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      canvas.getByRole("button", { name: "Groups: 1" })
    ).toBeVisible();
    // Every distinct status in the fixture set becomes a section.
    await expect(canvas.getAllByRole("rowgroup").length).toBeGreaterThan(1);
    await expect(canvas.queryByLabelText("Go to next page")).toBeNull();
  },
};

/** Both grouping levels, rendered as nested sections by `GridTableV2`. */
export const GroupedTwoLevels: Story = {
  render: () => (
    <ListSurfaceDemo initialGrouping={GROUPED_BY_STATUS_THEN_OWNER} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      canvas.getByRole("button", { name: "Groups: 2" })
    ).toBeVisible();
  },
};

/**
 * Filters applied, so the chip row is present.
 *
 * The chip is derived from `viewModel.facetGroups` — the demo's controller
 * reports an EMPTY `activeChips`, exactly like the no-op controllers the
 * Sessions and Branches toolbars pass today. That is the configuration in which
 * the chip row used to render nothing at all, and it is the one every real
 * consumer is in.
 *
 * The filters also narrow the rows the table AND the paginator see, which is
 * the point of wiring the demo rather than stubbing it.
 */
export const WithActiveFilters: Story = {
  render: () => <ListSurfaceDemo initialStatuses={["Active"]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText("Status: Active")).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Remove Status: Active filter" })
    ).toBeVisible();
    // Two Active sessions in the fixtures, so the filtered set is one page.
    // `TablePagination` keeps its controls MOUNTED at a boundary and disables
    // them (its own contract — the footer must not shift as counts change), so
    // the assertion is on the disabled state, not on absence.
    await expect(canvas.getByLabelText("Go to next page")).toHaveAttribute(
      "aria-disabled",
      "true"
    );
  },
};

/**
 * The options menu hides a column, and the table drops both the column AND its
 * grid track. That pairing is the contract `GridTableV2` puts on its caller —
 * the table cannot slice a `gridTemplateColumns` string generically — so it is
 * the seam most likely to break when a surface adopts the toolbar.
 */
export const HidingAColumnDropsItsTrack: Story = {
  render: () => <ListSurfaceDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      canvasElement.querySelector('[data-column-id="repository"]')
    ).not.toBeNull();

    // `userEvent`, not `fireEvent`: a Radix dropdown trigger opens on
    // `pointerdown`, and a bare synthetic `click` never reaches it.
    await userEvent.click(canvas.getByRole("button", { name: "Options" }));
    const repositorySwitch = await within(globalThis.document.body).findByRole(
      "menuitem",
      { name: REPOSITORY_OPTION_PATTERN }
    );
    await userEvent.click(repositorySwitch);

    await expect(
      canvasElement.querySelector('[data-column-id="repository"]')
    ).toBeNull();
  },
};

/**
 * Sorting from the TOOLBAR rather than a column header — the reason the sort
 * menu exists at all, since a hidden or horizontally-scrolled-away column has
 * no header to click.
 */
export const SortingFromTheToolbar: Story = {
  render: () => <ListSurfaceDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByRole("button", { name: "Sort" })).toBeVisible();

    await userEvent.click(canvas.getByRole("button", { name: "Sort" }));
    const costItem = await within(globalThis.document.body).findByRole(
      "menuitem",
      { name: "Cost" }
    );
    await userEvent.click(costItem);

    // The trigger names the FIELD for a screen reader while showing the count
    // visually, and grows its clear affordance.
    await expect(
      canvas.getByRole("button", { name: "Sorted by Cost" })
    ).toBeVisible();
    await expect(canvas.getByText("Sorts: 1")).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Clear sort" })
    ).toBeVisible();

    await userEvent.click(canvas.getByRole("button", { name: "Clear sort" }));
    await expect(canvas.getByRole("button", { name: "Sort" })).toBeVisible();
  },
};

/**
 * Below the `md` breakpoint the four right-hand menus fold into ONE
 * `TableCompactViewMenu`. This is a different control, not the wide one shrunk
 * — the grouping editor is a five-column grid with drag handles and has nowhere
 * to open on a phone.
 */
export const CompactWidth: Story = {
  globals: { viewport: { value: "mobile1" } },
  render: () => <ListSurfaceDemo />,
};

/** The measured compact slot mounts alone even when the viewport is wide. */
export const MeasuredCompactSlot: Story = {
  render: () => <MeasuredToolbar mode="compact" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "View" })).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Options" })).toBeNull();
  },
};

/** The measured expanded slot mounts alone even when the viewport is narrow. */
export const MeasuredExpandedSlot: Story = {
  globals: { viewport: { value: "mobile1" } },
  render: () => <MeasuredToolbar mode="expanded" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Options" })).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "View" })).toBeNull();
  },
};

function MeasuredToolbar({ mode }: { mode: "compact" | "expanded" }) {
  return (
    <GridTableToolbar
      compact={<Button variant="outline">View</Button>}
      expanded={<Button variant="outline">Options</Button>}
      leading={<Button variant="outline">Filter</Button>}
      mode={mode}
    />
  );
}
