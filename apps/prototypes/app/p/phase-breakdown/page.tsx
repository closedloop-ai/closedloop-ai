"use client";

import { Card } from "@repo/design-system/components/ui/card";
import { useState } from "react";
import { CostBreakdown } from "./cost-breakdown";
import { LeadTime } from "./lead-time";
import { findSession } from "./mock";
import {
  BREAKDOWN_VIEW,
  type BreakdownView,
  BreakdownViewKind,
  focusTargetOnBack,
  openSessionView,
  toggleKey,
} from "./phase-breakdown-state";
import { SessionDetailView } from "./session-detail";

const PhaseBreakdownPrototypePage = () => {
  // Expansion state lives here, above the breakdown/detail switch, so opening a
  // session and coming back does not collapse the phases the user expanded.
  const [openPhases, setOpenPhases] = useState<readonly string[]>([]);
  const [shownAllPhases, setShownAllPhases] = useState<readonly string[]>([]);
  const [view, setView] = useState<BreakdownView>(BREAKDOWN_VIEW);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);

  const selected =
    view.kind === BreakdownViewKind.Session
      ? findSession(view.sessionId)
      : undefined;

  const goBack = () => {
    setPendingFocusId(focusTargetOnBack(view));
    setView(BREAKDOWN_VIEW);
  };

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Card className="p-6">
        {selected ? (
          <SessionDetailView onBack={goBack} session={selected} />
        ) : (
          <>
            <CostBreakdown
              focusSessionId={pendingFocusId}
              onFocusHandled={() => setPendingFocusId(null)}
              onSelectSession={(id) => setView(openSessionView(id))}
              onTogglePhase={(key) =>
                setOpenPhases((keys) => toggleKey(keys, key))
              }
              onToggleShowAll={(key) =>
                setShownAllPhases((keys) => toggleKey(keys, key))
              }
              openPhases={openPhases}
              shownAllPhases={shownAllPhases}
            />
            <LeadTime />
          </>
        )}
      </Card>
    </main>
  );
};

export default PhaseBreakdownPrototypePage;
