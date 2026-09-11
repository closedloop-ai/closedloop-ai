import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@repo/design-system/components/ui/breadcrumb";
import type { Meta, StoryObj } from "@storybook/react";
import { ArrowRightSquare } from "lucide-react";

/**
 * A row of links showing the path from the top level down to the page you
 * are on, with each step separated by a small arrow. The last item, the
 * current page, renders as plain text rather than a link, since a link that
 * points to the page you are already on gives a screen reader nothing useful
 * to click. Swap in a custom icon for the separator, as in the story's
 * second example, when the default arrow does not fit the surface.
 */
const meta = {
  title: "Primitives/Navigation/Breadcrumb",
  component: Breadcrumb,
  tags: ["autodocs"],
  argTypes: {
    children: {
      control: false,
      description:
        "Set by the story render: a BreadcrumbList of items, links, and separators.",
    },
    className: { control: "text" },
  },
  args: {},
  render: (args) => (
    <Breadcrumb {...args}>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink>Home</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbLink>Components</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>Breadcrumb</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  ),
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Breadcrumb>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Displays the path of links to the current resource.
 */
export const Default: Story = {};

/**
 * Displays the path with a custom icon for the separator.
 */
export const WithCustomSeparator: Story = {
  render: (args) => (
    <Breadcrumb {...args}>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink>Home</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator>
          <ArrowRightSquare />
        </BreadcrumbSeparator>
        <BreadcrumbItem>
          <BreadcrumbLink>Components</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator>
          <ArrowRightSquare />
        </BreadcrumbSeparator>
        <BreadcrumbItem>
          <BreadcrumbPage>Breadcrumb</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  ),
};
