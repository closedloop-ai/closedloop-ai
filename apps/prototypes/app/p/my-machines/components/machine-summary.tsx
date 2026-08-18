"use client";

import type { Machine, MachineRollup } from "../mock";

// The collapsed summary for one machine: the at-a-glance answer to "what did this
// pack install here?". One plain line — the installed / total ratio and, when
// something is behind, the count that needs action. No Progress bar and no by-kind
// breakdown: the pack ships one component per kind, so both just spelled the same
// ratio a second and third time. Plain text, read left to right, say it once
// (Parker). The needs-action count is the only emphatic figure; it is the thing
// to act on. This mirrors the admin matrix's single-row matrix-summary.

type MachineSummaryProps = {
  machine: Machine;
  rollup: MachineRollup;
};

const needActionText = (count: number): string =>
  `${count} ${count === 1 ? "needs" : "need"} action`;

export const MachineSummary = ({ machine, rollup }: MachineSummaryProps) => (
  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
    <span>
      <span className="font-medium tabular-nums">
        {rollup.installed} of {rollup.total}
      </span>{" "}
      <span className="text-muted-foreground">components installed</span>
      {rollup.readable ? null : (
        <span className="text-muted-foreground">
          {" "}
          · last read {machine.lastSeen}
        </span>
      )}
    </span>
    {rollup.needsAction > 0 ? (
      <span className="font-medium tabular-nums">
        {needActionText(rollup.needsAction)}
      </span>
    ) : null}
  </div>
);
