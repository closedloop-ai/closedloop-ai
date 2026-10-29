import type { BranchPageDetail } from "@repo/api/src/types/branch";
import type { BranchPhaseAttributionResult } from "@repo/api/src/types/branch-phase-attribution";

/** ISS-12280: call after attribution and canonical metrics consume event evidence. */
export function compactBranchDetailPayload<
  T extends Pick<
    BranchPageDetail,
    "sessions" | "phaseAttribution" | "canonicalProjection"
  >,
>(detail: T): T {
  return {
    ...detail,
    sessions: detail.sessions.map((session) => {
      if (session.activitySegments === undefined) {
        return session;
      }
      return {
        ...session,
        activitySegments: session.activitySegments.map(
          ({
            sourceEventIds: _sourceEventIds,
            costEvents: _costEvents,
            ...segment
          }) => segment
        ),
      };
    }),
    ...(detail.phaseAttribution === undefined
      ? {}
      : {
          phaseAttribution: compactPhaseAttribution(detail.phaseAttribution),
        }),
    ...(detail.canonicalProjection?.detail?.phaseAttribution
      ? {
          canonicalProjection: {
            ...detail.canonicalProjection,
            detail: {
              ...detail.canonicalProjection.detail,
              phaseAttribution: compactPhaseAttribution(
                detail.canonicalProjection.detail.phaseAttribution
              ),
            },
          },
        }
      : {}),
  };
}

function compactPhaseAttribution(
  attribution: BranchPhaseAttributionResult
): BranchPhaseAttributionResult {
  return {
    ...attribution,
    segments: attribution.segments.map(
      ({ costEvents: _costEvents, ...segment }) => segment
    ),
  };
}
