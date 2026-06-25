import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@closedloop-ai/design-system/components/ui/card";
import type { BackfillStats } from "../../../shared/diagnostics-contract";

type BackfillTabProps = {
  backfill: BackfillStats;
};

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between border-b py-2 last:border-b-0">
      <span className="text-[var(--muted-foreground)] text-sm">{label}</span>
      <span className="font-medium text-sm">{value}</span>
    </div>
  );
}

export function BackfillTab({ backfill }: BackfillTabProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Artifact Link Backfill</CardTitle>
        </CardHeader>
        <CardContent>
          <StatRow
            label="Sessions Scanned"
            value={backfill.artifactLinks.totalScanned}
          />
          <StatRow
            label="Last Scanned"
            value={backfill.artifactLinks.lastScannedAt ?? "Never"}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>PR Backfill</CardTitle>
        </CardHeader>
        <CardContent>
          <StatRow
            label="Sessions Scanned"
            value={backfill.prBackfill.totalScanned}
          />
          <StatRow
            label="Last Scanned"
            value={backfill.prBackfill.lastScannedAt ?? "Never"}
          />
        </CardContent>
      </Card>
    </div>
  );
}
