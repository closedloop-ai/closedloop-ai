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
 * Powerful table and datagrids built using TanStack Table.
 */
const meta = {
  title: "Design System/Data Display/Table",
  component: Table,
  tags: ["autodocs"],
  argTypes: {},
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
