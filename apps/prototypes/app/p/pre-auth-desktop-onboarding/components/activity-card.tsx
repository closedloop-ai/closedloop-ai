import {
  Card,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import type { ActivityRow } from "../mock";

type ActivityCardProps = {
  rows: readonly ActivityRow[];
  /** Header label for the middle value column. Defaults to "Value". */
  valueLabel?: string;
};

export const ActivityCard = ({
  rows,
  valueLabel = "Value",
}: ActivityCardProps) => (
  <Card className="gap-0 overflow-hidden py-0">
    <CardHeader className="border-b py-5">
      <CardTitle>Recent activity</CardTitle>
    </CardHeader>
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-border border-b">
            <th className="px-6 py-3 text-left font-medium text-muted-foreground text-xs">
              Session
            </th>
            <th className="px-6 py-3 text-right font-medium text-muted-foreground text-xs">
              {valueLabel}
            </th>
            <th className="px-6 py-3 text-left font-medium text-muted-foreground text-xs">
              Status
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr className="hover:bg-muted/40" key={row.id}>
              <td className="px-6 py-4">
                <p className="truncate">{row.title}</p>
                <p className="mt-1 truncate text-muted-foreground text-xs">
                  {row.subtitle}
                </p>
              </td>
              <td className="px-6 py-4 text-right text-muted-foreground tabular-nums">
                {row.value}
              </td>
              <td className="px-6 py-4">{row.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </Card>
);
