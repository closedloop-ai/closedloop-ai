import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { TableCell, TableRow } from "@repo/design-system/components/ui/table";

export function renderTableSkeletonRows(rowCount: number, columnCount: number) {
  return Array.from({ length: rowCount }, (_, rowIndex) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders have no stable identity
    <TableRow key={rowIndex}>
      {Array.from({ length: columnCount }, (__, columnIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders have no stable identity
        <TableCell key={columnIndex}>
          <Skeleton className="h-5 w-full rounded" />
        </TableCell>
      ))}
    </TableRow>
  ));
}
