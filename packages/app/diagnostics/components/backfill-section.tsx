"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import type { BackfillStats } from "../lib/diagnostics-payload";
import { UNAVAILABLE } from "./withheld-section";

type BackfillSectionProps = {
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

export function BackfillSection({ backfill }: BackfillSectionProps) {
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
            value={backfill.prBackfill?.totalScanned ?? UNAVAILABLE}
          />
          <StatRow
            label="Last Scanned"
            value={
              backfill.prBackfill
                ? (backfill.prBackfill.lastScannedAt ?? "Never")
                : UNAVAILABLE
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
