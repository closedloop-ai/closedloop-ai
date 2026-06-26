import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@closedloop-ai/design-system/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@closedloop-ai/design-system/components/ui/table";
import type {
  LinkStatsRow,
  LinkTotals,
} from "../../../shared/diagnostics-contract";

type LinksTabProps = {
  linkStats: LinkStatsRow[];
  linkTotals: LinkTotals;
};

export function LinksTab({ linkStats, linkTotals }: LinksTabProps) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="pt-6">
            <div className="text-center">
              <div className="font-bold text-2xl">{linkTotals.totalLinks}</div>
              <div className="text-[var(--muted-foreground)] text-sm">
                Total Links
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-center">
              <div className="font-bold text-2xl">
                {linkTotals.linkedSessions}
              </div>
              <div className="text-[var(--muted-foreground)] text-sm">
                Linked Sessions
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-center">
              <div className="font-bold text-2xl">
                {linkTotals.linkedArtifacts}
              </div>
              <div className="text-[var(--muted-foreground)] text-sm">
                Linked Artifacts
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Links by Method</CardTitle>
        </CardHeader>
        <CardContent>
          {linkStats.length === 0 ? (
            <p className="py-8 text-center text-[var(--muted-foreground)] text-sm">
              No links found
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Relation</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {linkStats.map((row) => (
                  <TableRow key={`${row.relation}:${row.method}`}>
                    <TableCell>
                      <Badge variant="outline">{row.relation}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.method}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {row.count}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
