"use client";

import {
  HARNESS_LABEL,
  HARNESS_ORDER,
  type HarnessRollup,
  type PackComponent,
  rollupFor,
  type Target,
} from "../mock";

// The collapsed disclosure: one plain row per harness with its install rollup.
// This is what the eye lands on before expanding into the full target × harness
// grid. Plain rows, not boxed cards (Parker: don't box everything). The needs-
// action count is the only emphatic figure; it is the thing to act on.
type MatrixSummaryProps = {
  component: PackComponent;
  targets: readonly Target[];
};

const rollupText = (rollup: HarnessRollup): string => {
  if (!rollup.supported) {
    return "Not supported for this component";
  }
  const parts = [`${rollup.installed} of ${rollup.total} installed`];
  if (rollup.needsAction > 0) {
    parts.push(`${rollup.needsAction} need action`);
  }
  return parts.join(" · ");
};

export const MatrixSummary = ({ component, targets }: MatrixSummaryProps) => (
  <dl className="divide-y divide-border">
    {HARNESS_ORDER.map((harness) => {
      const rollup = rollupFor(component, targets, harness);
      return (
        <div
          className="flex items-baseline justify-between gap-4 py-2.5"
          key={harness}
        >
          <dt className="font-medium text-sm">{HARNESS_LABEL[harness]}</dt>
          <dd
            className={`text-sm ${
              rollup.needsAction > 0
                ? "text-foreground"
                : "text-muted-foreground"
            }`}
          >
            {rollupText(rollup)}
          </dd>
        </div>
      );
    })}
  </dl>
);
