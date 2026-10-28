import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import {
  TableChoiceCell,
  TableNumberCell,
  TableTextCell,
} from "@repo/design-system/components/ui/table-cell-primitives";
import { mockInvoiceRows } from "@repo/design-system/storybook/mock-data";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * Powerful table and datagrids built using TanStack Table.
 */
const meta = {
  title: "Primitives v1.0/Data Display/Tables/Table",
  component: Table,
  tags: ["deprecated", "autodocs"],
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
            <TableCell>
              <TableTextCell value={invoice.invoice} />
            </TableCell>
            <TableCell>
              <TableChoiceCell label={invoice.paymentStatus} />
            </TableCell>
            <TableCell>
              <TableTextCell value={invoice.paymentMethod} />
            </TableCell>
            <TableCell>
              <TableNumberCell value={invoice.totalAmount} />
            </TableCell>
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
