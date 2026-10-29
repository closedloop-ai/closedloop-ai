import type { AgentSessionListResponse } from "@repo/api/src/types/agent-session";
import {
  DesktopSessionsListCompleteness,
  DesktopSessionsListSource,
  getDesktopSessionsListSourceState,
} from "./desktop-session-source-precedence";

/** Resolves source, capability, completeness, and pagination facts for Desktop Sessions. */
export function resolveDesktopSessionsSourcePresentation({
  sourcePrecedenceActive,
  response,
}: {
  sourcePrecedenceActive: boolean;
  response: AgentSessionListResponse | undefined;
}): {
  isPaginationTotalKnown: boolean;
  isPopulationComplete: boolean;
  useCloudCapabilityDefaults: boolean;
} {
  const state = sourcePrecedenceActive
    ? getDesktopSessionsListSourceState(response)
    : undefined;
  return {
    isPaginationTotalKnown: state?.hasKnownTotal ?? true,
    isPopulationComplete:
      state === undefined ||
      state.completeness === DesktopSessionsListCompleteness.Complete,
    useCloudCapabilityDefaults:
      state?.source === DesktopSessionsListSource.Cloud,
  };
}
