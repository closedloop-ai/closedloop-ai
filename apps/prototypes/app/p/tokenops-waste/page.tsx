"use client";

import { useState } from "react";
import {
  AnalyticsPageShell,
  RANGE_OPTIONS,
  SCOPE_OPTIONS,
} from "@/lib/analytics/analytics-page-shell";
import { DataState } from "@/lib/analytics/format";
import { ModelRightSizing } from "./components/model-right-sizing";
import { RecoverableWaste } from "./components/recoverable-waste";
import { SpendByOutcome } from "./components/spend-by-outcome";

/**
 * ISS-4977. The judgment half of ISS-4463: how much of the error-outcome spend
 * was actually recoverable, and whether the models are sized for the work.
 *
 * The reading order is the argument. The measured split comes first, the
 * estimate built on it comes second, and the right-sizing verdicts come last,
 * so a reader always meets the fact before the judgment derived from it.
 *
 * Same session population as the Lost-work screen, keyed on the same
 * `endsWithError`, so the two views cannot disagree about which sessions failed.
 */

const DEFAULT_RANGE = RANGE_OPTIONS[1].value;
const DEFAULT_SCOPE = SCOPE_OPTIONS[0].value;

const TokenOpsWastePrototypePage = () => {
  const [range, setRange] = useState(DEFAULT_RANGE);
  const [scope, setScope] = useState(DEFAULT_SCOPE);
  const [dataState, setDataState] = useState<DataState>(DataState.Ready);

  return (
    <AnalyticsPageShell
      dataState={dataState}
      onDataStateChange={setDataState}
      onRangeChange={setRange}
      onScopeChange={setScope}
      range={range}
      scope={scope}
      subtitle="What the period's AI spend bought, how much of the failed spend was recoverable, and whether the models fit the work"
      title="TokenOps: waste and leverage"
    >
      <SpendByOutcome dataState={dataState} />
      <RecoverableWaste dataState={dataState} />
      <ModelRightSizing dataState={dataState} />
      <p className="text-muted-foreground text-xs">
        The same failed sessions, measured in wall-clock instead of dollars, are
        on the Lost work prototype.
      </p>
    </AnalyticsPageShell>
  );
};

export default TokenOpsWastePrototypePage;
