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

/**
 * The underlying shadcn `Pagination` primitive: a composable set of building
 * blocks (`PaginationContent`, `PaginationItem`, `PaginationLink`,
 * `PaginationPrevious`, `PaginationNext`, `PaginationEllipsis`) for assembling
 * page navigation. For the higher-level, page-state-driven component, see
 * `Table Pagination`.
 */
const meta = {
  title: "Design System/Data Display/Pagination",
  component: Pagination,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta<typeof Pagination>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A representative composed pagination with an active page and ellipsis. */
export const Default: Story = {
  render: () => (
    <Pagination>
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
