"use client";

import type { InstallMatrixRollup } from "@repo/app/packs/lib/install-matrix-view";
import { PackInstallState } from "@repo/app/packs/lib/install-state";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { InstallStateStatus } from "./install-state-status";

// FEA-4081 — the aggregate rollup shown above the matrix grid. The Parker
// reconciliation principle: the card MUST reconcile with the rows. Every count
// here is computed from the SAME flat cell set the grid renders
// (`countMatrixStates(filtered.cells)`), so the card can never claim a number
// the matrix doesn't show. Don't smear the grid across cards — this is one
// aggregate summary, not per-cell chrome.

type InstallMatrixRollupCardProps = {
  readonly rollup: InstallMatrixRollup;
};

// The order the states read in the summary — installed first (the good news),
// then the states that need attention, then the terminal/informational ones.
// Reuses the canonical `PackInstallState` members; no bare literals.
const ROLLUP_ORDER: readonly PackInstallState[] = [
  PackInstallState.Installed,
  PackInstallState.Updatable,
  PackInstallState.Converting,
  PackInstallState.NotInstalled,
  PackInstallState.Failed,
  PackInstallState.Offline,
  PackInstallState.Unsupported,
];

export const InstallMatrixRollupCard = ({
  rollup,
}: InstallMatrixRollupCardProps) => {
  // Only states that actually occur across the current (possibly filtered) cell
  // set get a stat — a zero-count state would be noise. The sum of the rendered
  // counts equals `rollup.total`, so the card reconciles with the grid exactly.
  const present = ROLLUP_ORDER.filter((state) => rollup[state] > 0);

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Install rollup</CardTitle>
        <CardDescription>
          {rollup.total} {rollup.total === 1 ? "cell" : "cells"} across every
          target and harness.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {present.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No cells match the current filters.
          </p>
        ) : (
          <dl className="flex flex-wrap gap-x-8 gap-y-3">
            {present.map((state) => (
              <div className="flex flex-col gap-1" key={state}>
                <dt>
                  <InstallStateStatus state={state} />
                </dt>
                <dd className="pl-6 font-semibold text-2xl tabular-nums tracking-tight">
                  {rollup[state]}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
};
