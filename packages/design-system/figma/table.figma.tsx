import figma from "@figma/code-connect";
import {
  Table,
  TableBody,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/ClosedLoop-Design-System?node-id=2807-10070";

figma.connect(Table, FIGMA_URL, {
  props: {
    headers: figma.children("Headers"),
    rows: figma.children("Rows"),
  },
  example: ({ headers, rows }) => (
    <Table>
      <TableHeader>
        <TableRow>{headers}</TableRow>
      </TableHeader>
      <TableBody>{rows}</TableBody>
    </Table>
  ),
});
