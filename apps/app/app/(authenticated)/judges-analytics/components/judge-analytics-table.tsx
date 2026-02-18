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

function formatOrDash(value: number | null): string {
  return value !== null ? value.toFixed(2) : "\u2014";
}

export function JudgeAnalyticsTable({ data }: JudgeAnalyticsTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="align-bottom" rowSpan={2}>
            Judge Name
          </TableHead>
          <TableHead className="align-bottom" rowSpan={2}>
            Artifacts Evaluated
          </TableHead>
          <TableHead className="border-b-0 text-center" colSpan={4}>
            Eval
          </TableHead>
          <TableHead className="border-b-0 text-center" colSpan={4}>
            Human
          </TableHead>
        </TableRow>
        <TableRow>
          <TableHead>Min</TableHead>
          <TableHead>Max</TableHead>
          <TableHead>Mean</TableHead>
          <TableHead>Std Dev</TableHead>
          <TableHead>Min</TableHead>
          <TableHead>Max</TableHead>
          <TableHead>Mean</TableHead>
          <TableHead>Std Dev</TableHead>
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
            <TableCell>{judge.max.toFixed(2)}</TableCell>
            <TableCell>{judge.mean.toFixed(2)}</TableCell>
            <TableCell>{judge.stdDev.toFixed(2)}</TableCell>
            <TableCell>{formatOrDash(judge.humanMin)}</TableCell>
            <TableCell>{formatOrDash(judge.humanMax)}</TableCell>
            <TableCell>{formatOrDash(judge.humanMean)}</TableCell>
            <TableCell>{formatOrDash(judge.humanStdDev)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
