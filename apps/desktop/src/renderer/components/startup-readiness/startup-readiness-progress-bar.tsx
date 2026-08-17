"use client";

import { Progress } from "@closedloop-ai/design-system/components/ui/progress";
import {
  buildStartupProgressBarModel,
  startupProgressBarName,
} from "./startup-readiness-progress";
import type { StartupReadinessPhase } from "./startup-readiness-state";

type StartupReadinessProgressBarProps = {
  phase: StartupReadinessPhase;
  paused: boolean;
  className?: string;
};

/**
 * ISS-5115: the one global progress treatment for desktop startup, replacing
 * the top loading ring that duplicated the Checking state and competed with the
 * staged checklist beneath it.
 *
 * It is deliberately indeterminate for every in-flight phase — see
 * `buildStartupProgressBarModel` for why a percentage here would be invented —
 * and the shared `Progress` primitive drops `aria-valuenow` in that case, so
 * assistive tech hears the stage and no completion claim. The stage rides in
 * the accessible NAME rather than in `aria-valuetext`, which ARIA only defines
 * alongside an `aria-valuenow` an indeterminate bar cannot supply.
 *
 * Reduced motion and the stalled/paused states drop the sweep, leaving the
 * primitive's static hatch: a travelling bar would report work that is not
 * happening, but a bare track would read as 0% and a solid one as 100%, and
 * neither is what a held startup means.
 */
export function StartupReadinessProgressBar({
  phase,
  paused,
  className,
}: StartupReadinessProgressBarProps) {
  const bar = buildStartupProgressBarModel({ phase, paused });
  return (
    <Progress
      aria-label={startupProgressBarName(bar.valueText)}
      className={className}
      paused={bar.paused}
      tone={bar.tone}
      value={bar.value}
    />
  );
}
