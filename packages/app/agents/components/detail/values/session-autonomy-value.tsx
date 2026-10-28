"use client";

import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { getAutonomyLabel } from "@repo/app/agents/lib/autonomy";
import { TRACE_PREFIX_COUNTED_NOTE } from "@repo/app/shared/lib/trace-truncation-copy";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";

/**
 * PLN-2169 M2: the Autonomy VALUE, label-free, read by the Properties row
 * (`SessionAutonomyProperty`) and built for the Details tab (M3) so the two
 * cannot diverge.
 *
 * Matches the Sessions list autonomy cell exactly (ISS-5565): null is the
 * empty affordance, never `Unknown autonomy | 0/100`. Rendering the tier word
 * AND a floor number for an unmeasured score printed a contradiction —
 * `getAutonomyLabel(null)` is honest on its own, but the `?? 0` beside it
 * reinstated the lie the word had just avoided. A real 0 still renders
 * "Guided autonomy | 0/100", which is a measured claim and stays.
 */
export function SessionAutonomyValue({
  session,
}: Readonly<{ session: SessionAutonomyValueSession }>) {
  if (session.autonomy == null) {
    return <GridEmptyValue />;
  }
  return `${getAutonomyLabel(session.autonomy)} | ${session.autonomy}/100`;
}

/**
 * The Autonomy row's one sentence: why the value is absent, or — when it is
 * present but was folded out of a truncated read (ISS-5636) — what it actually
 * counted. The two are mutually exclusive: a score the producer never recorded
 * has no basis to qualify.
 */
export function resolveSessionAutonomyExplanation(
  session: SessionAutonomyValueSession
): string | undefined {
  if (session.autonomy == null) {
    return "Autonomy was not recorded for this session";
  }
  if (session.autonomyTruncated) {
    return `Autonomy was ${TRACE_PREFIX_COUNTED_NOTE}`;
  }
  return undefined;
}

export type SessionAutonomyValueSession = Pick<
  AgentSessionDetail,
  "autonomy" | "autonomyTruncated"
>;
