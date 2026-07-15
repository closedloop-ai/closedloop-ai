import {
  Table,
  TableBody,
  TableHeader,
  TableRow,
} from "@closedloop-ai/design-system/components/ui/table";
import figma from "@figma/code-connect";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/Closedloop-Design-System?node-id=2807-10070";

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
