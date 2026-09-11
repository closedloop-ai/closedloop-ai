import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { mockInvoiceRows } from "@repo/design-system/storybook/mock-data";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * The plain HTML table primitive: a set of matching pieces, header, body,
 * row, cell and caption, styled to fit the design system, that you assemble
 * by hand for a small and mostly static list of data. Reach for Data Table
 * or Grid Table instead once you need sorting, column resizing, selection,
 * or any real interactivity; this one is markup only and carries no
 * behaviour of its own. Rows get a hover highlight and a selected state
 * style, but nothing wires either one up for you.
 */
const meta = {
  title: "Primitives/Data Display/Table",
  component: Table,
  tags: ["autodocs"],
  argTypes: {
    className: {
      control: "text",
      description: "Merged over the base `w-full caption-bottom text-sm`.",
    },
    children: { control: false },
  },
  render: (args) => (
    <Table {...args}>
      <TableCaption>A list of your recent invoices.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[100px]">Invoice</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Method</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {mockInvoiceRows.map((invoice) => (
          <TableRow key={invoice.invoice}>
            <TableCell className="font-medium">{invoice.invoice}</TableCell>
            <TableCell>{invoice.paymentStatus}</TableCell>
            <TableCell>{invoice.paymentMethod}</TableCell>
            <TableCell className="text-right">{invoice.totalAmount}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
} satisfies Meta<typeof Table>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the table.
 */
export const Default: Story = {};
