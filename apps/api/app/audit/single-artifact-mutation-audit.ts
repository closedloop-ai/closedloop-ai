import {
  type ArtifactMutationAuditChange,
  buildArtifactMutationAuditEvent,
} from "./artifact-mutation-audit-event";
import { dispatchAuditEvents, userAuditActor } from "./audit-emit-service";

/**
 * Dispatches audit events after a single-artifact mutation commits.
 *
 * Transition no-ops are filtered here so every caller shares the bulk
 * emitters' real-change rule. Dispatch is guarded because even a synchronous
 * request-context failure must not turn an already-committed write into a 500.
 */
export function dispatchSingleArtifactMutationAudits(input: {
  organizationId: string;
  userId: string;
  changes: readonly ArtifactMutationAuditChange[];
}): void {
  try {
    const actor = userAuditActor(input.userId);
    const events = input.changes.flatMap((change) => {
      const event = buildArtifactMutationAuditEvent({
        organizationId: input.organizationId,
        actor,
        change,
      });
      return event ? [event] : [];
    });
    if (events.length > 0) {
      dispatchAuditEvents(events);
    }
  } catch {
    // Swallowed by design: audit dispatch must never fail the committed write.
  }
}
