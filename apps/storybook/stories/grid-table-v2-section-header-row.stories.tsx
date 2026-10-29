/**
 * The row `GridTableV2` gives a group (and a subgroup) its collapsible header
 * as — ISS-8219.
 *
 * The harness is a real `grid` / `rowgroup` ancestry rather than a bare mount,
 * because the whole reason this row exists is ARIA ownership: a `grid` may own
 * only rows and rowgroups, so a header rendered as a plain child is an orphan
 * generic and the rows beneath it lose their section. Mounted outside that
 * ancestry the roles are invalid and a screen reader announces nothing useful,
 * which would make the story a picture of the bug rather than of the fix.
 */
import { GridTableV2SectionHeaderRow } from "@repo/design-system/components/ui/grid-table-v2-section-header-row";
import type { Meta, StoryObj } from "@storybook/react";
import { FolderIcon } from "lucide-react";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";

const meta = {
  title: "Composites v1.0/Data Display/Tables/Grid Table V2 Section Header Row",
  tags: ["deprecated"],
  component: GridTableV2SectionHeaderRow,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof GridTableV2SectionHeaderRow>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The tracks the surrounding grid declares, so the header's span means something. */
const COLUMN_COUNT = 4;

/** Both indentations the grid renders: a group's header, and a subgroup's. */
const GROUP_HEADER_CLASS = "bg-background py-3 font-semibold";
const SUBGROUP_HEADER_CLASS = "bg-background py-3 pl-10 font-semibold";

// The header's accessible name folds in its chevron and its count, so each
// disclosure is matched by the label it carries rather than by an exact string.
const GROUP_LABEL_PATTERN = /Active/;
const SUBGROUP_LABEL_PATTERN = /Archived/;

/** The grid's own group glyph sizing and tone — a token, not a chosen pixel. */
const HEADER_ICON_CLASS = "size-4 shrink-0 text-muted-foreground";

export const Default: Story = {
  args: {
    className: GROUP_HEADER_CLASS,
    columnCount: COLUMN_COUNT,
    count: 12,
    icon: <FolderIcon className={HEADER_ICON_CLASS} />,
    isOpen: true,
    label: "Active",
    onToggle: () => undefined,
  },
  render: () => <SectionHeaderRowStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The header is announced as a row of the grid, not as loose furniture.
    const grid = canvas.getByRole("grid", { name: "Artifacts" });
    await expect(within(grid).getAllByRole("rowgroup")).toHaveLength(2);
    await expect(within(grid).getAllByRole("row")).toHaveLength(2);

    // A disclosure, so its state is on the control rather than only in the glyph.
    const group = canvas.getByRole("button", { name: GROUP_LABEL_PATTERN });
    await expect(group).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(group);
    await expect(group).toHaveAttribute("aria-expanded", "false");

    // The collapsed subgroup renders the other indentation and the other state.
    await expect(
      canvas.getByRole("button", { name: SUBGROUP_LABEL_PATTERN })
    ).toHaveAttribute("aria-expanded", "false");
  },
};

function SectionHeaderRowStory() {
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    active: true,
    archived: false,
  });
  const toggle = (key: string) =>
    setOpenGroups((previous) => ({ ...previous, [key]: !previous[key] }));

  return (
    <main className="min-h-screen bg-background p-8">
      {/* biome-ignore lint/a11y/useSemanticElements: a CSS-grid table cannot be a real <table>; role="grid" is the correct ARIA mapping and is what GridTableV2 itself uses. */}
      <div
        aria-colcount={COLUMN_COUNT}
        aria-label="Artifacts"
        className="overflow-hidden rounded-md border"
        role="grid"
      >
        {/* biome-ignore lint/a11y/useSemanticElements: a grid may own only rows and rowgroups, so each section is a role="rowgroup" — the shape GridTableV2 renders. */}
        <div role="rowgroup">
          <GridTableV2SectionHeaderRow
            className={GROUP_HEADER_CLASS}
            columnCount={COLUMN_COUNT}
            count={12}
            icon={<FolderIcon className={HEADER_ICON_CLASS} />}
            isOpen={openGroups.active === true}
            label="Active"
            onToggle={() => toggle("active")}
          />
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: same rowgroup ownership rule, for the nested section. */}
        <div role="rowgroup">
          <GridTableV2SectionHeaderRow
            className={SUBGROUP_HEADER_CLASS}
            columnCount={COLUMN_COUNT}
            icon={<FolderIcon className={HEADER_ICON_CLASS} />}
            isOpen={openGroups.archived === true}
            label="Archived"
            onToggle={() => toggle("archived")}
          />
        </div>
      </div>
    </main>
  );
}
