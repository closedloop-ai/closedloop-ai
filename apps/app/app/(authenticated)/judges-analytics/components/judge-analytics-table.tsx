import type { JudgeAggregateStats } from "@repo/api/src/types/judges-analytics";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";

type JudgeAnalyticsTableProps = {
  data: JudgeAggregateStats[];
};

export function JudgeAnalyticsTable({ data }: JudgeAnalyticsTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Judge Name</TableHead>
          <TableHead>Artifacts Evaluated</TableHead>
          <TableHead>Min</TableHead>
          <TableHead>Mean</TableHead>
          <TableHead>Max</TableHead>
          <TableHead>Std Dev</TableHead>
          <TableHead>Human Rating (avg)</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((judge: JudgeAggregateStats) => (
          <TableRow key={judge.judgeName}>
            <TableCell className="break-words" title={judge.judgeName}>
              {judge.judgeName}
            </TableCell>
            <TableCell>{judge.artifactsEvaluated}</TableCell>
            <TableCell>{judge.min.toFixed(2)}</TableCell>
            <TableCell>{judge.mean.toFixed(2)}</TableCell>
            <TableCell>{judge.max.toFixed(2)}</TableCell>
            <TableCell>{judge.stdDev.toFixed(2)}</TableCell>
            <TableCell>
              {judge.humanRatingScore !== null
                ? judge.humanRatingScore.toFixed(2)
                : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
