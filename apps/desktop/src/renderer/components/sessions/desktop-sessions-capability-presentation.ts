import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { everySessionHasCustomFieldProjection } from "@repo/app/agents/lib/session-custom-field-operands";

/** Resolves source defaults and row operands for the Desktop Sessions seams. */
export function resolveDesktopSessionsCapabilityPresentation({
  isCloudMode,
  items,
  sourceSupportsPriority,
  sourcePrecedenceActive,
  useCloudCapabilityDefaults,
}: {
  isCloudMode: boolean;
  items: readonly AgentSessionListItem[];
  sourceSupportsPriority: boolean;
  sourcePrecedenceActive: boolean;
  useCloudCapabilityDefaults: boolean;
}): {
  hasCustomFieldOperands: boolean;
  hasLinkedEntityOperands: boolean;
  hasTagOperands: boolean;
  showPriorityColumn: boolean;
} {
  if (!sourcePrecedenceActive) {
    return {
      hasCustomFieldOperands: isCloudMode,
      hasLinkedEntityOperands: isCloudMode,
      hasTagOperands: isCloudMode,
      showPriorityColumn: sourceSupportsPriority,
    };
  }
  if (useCloudCapabilityDefaults) {
    return {
      hasCustomFieldOperands: true,
      hasLinkedEntityOperands: true,
      hasTagOperands: true,
      showPriorityColumn: sourceSupportsPriority,
    };
  }
  return {
    hasCustomFieldOperands:
      items.length > 0 && everySessionHasCustomFieldProjection(items),
    hasLinkedEntityOperands: items.some(
      (session) =>
        session.project !== undefined || session.linkedArtifacts !== undefined
    ),
    hasTagOperands: items.some((session) => session.tags !== undefined),
    showPriorityColumn: items.some((session) => session.priority !== undefined),
  };
}
