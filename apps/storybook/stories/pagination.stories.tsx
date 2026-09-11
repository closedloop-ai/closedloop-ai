import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@repo/design-system/components/ui/pagination";
import type { Meta, StoryObj } from "@storybook/react";

// The underlying shadcn `Pagination` primitive: a composable set of building
// blocks (`PaginationContent`, `PaginationItem`, `PaginationLink`,
// `PaginationPrevious`, `PaginationNext`, `PaginationEllipsis`) for assembling
// page navigation. For the higher-level, page-state-driven component, see
// `Table Pagination`.
/**
 * A page navigation strip built from separate pieces: a previous link,
 * numbered page links, an ellipsis for skipped pages, and a next link. Reach
 * for this only when you need to assemble a custom pager from raw parts; for
 * an ordinary paginated list, use Table Pagination instead, since it tracks
 * the current page and builds the whole strip for you. Nothing here decides
 * which page is active or moves you between pages: you wire up the clicks
 * and the active state yourself.
 */
const meta = {
  title: "Composites/Data Display/Pagination",
  component: Pagination,
  tags: ["autodocs"],
  argTypes: {
    children: {
      control: false,
      description:
        "The composed `PaginationContent` tree. Supplied by the story render, not by a control.",
    },
    className: {
      control: "text",
      description: "Extra classes merged onto the wrapping `nav`.",
    },
  },
  parameters: { layout: "centered" },
  args: {
    className: "",
  },
} satisfies Meta<typeof Pagination>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A representative composed pagination with an active page and ellipsis. */
export const Default: Story = {
  render: (args) => (
    <Pagination {...args}>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious href="#" />
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#">1</PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#" isActive>
            2
          </PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#">3</PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationEllipsis />
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#">10</PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationNext href="#" />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  ),
};
