"use client";

import { useState } from "react";
import {
  AnalyticsPageShell,
  RANGE_OPTIONS,
  SCOPE_OPTIONS,
} from "@/lib/analytics/analytics-page-shell";
import { DataState } from "@/lib/analytics/format";
import { LossAttribution } from "./components/loss-attribution";
import { LossByPerson } from "./components/loss-by-person";
import { LossCauses } from "./components/loss-causes";
import { LossTrend } from "./components/loss-trend";
import { LostSessionsTable } from "./components/lost-sessions-table";

/**
 * ISS-4935. Wall-clock lost to sessions that produced nothing, sliceable by
 * person, repo, project, and cause, with systemic loss held apart from
 * coachable loss everywhere it appears.
 *
 * Reading order is deliberate: what was lost and who could have prevented it,
 * then whether it is getting worse, then who, then why, then the runs
 * themselves. A manager should be able to stop after the first block.
 */

const DEFAULT_RANGE = RANGE_OPTIONS[1].value;
const DEFAULT_SCOPE = SCOPE_OPTIONS[0].value;

const LostWorkPrototypePage = () => {
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
      subtitle="Wall-clock lost to sessions that produced no artifact, and whether the cause was the platform or the run"
      title="Lost work"
    >
      <LossAttribution dataState={dataState} />
      <LossTrend dataState={dataState} />
      <LossByPerson dataState={dataState} />
      <LossCauses dataState={dataState} />
      <LostSessionsTable dataState={dataState} />
    </AnalyticsPageShell>
  );
};

export default LostWorkPrototypePage;
