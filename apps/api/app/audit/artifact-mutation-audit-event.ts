import { AuditAction, AuditObjectType } from "@repo/api/src/types/audit";
import type { Priority } from "@repo/api/src/types/common";
import { withBulkTransaction } from "@/lib/bulk-mutation-transaction";
import type { AuditEmitInput } from "./audit-emit-service";

/** A transaction-owned before/after fact for one committed field mutation. */
type AuditTransition<Value> = {
  objectId: string;
  before: Value;
  after: Value;
};

/**
 * A committed artifact mutation expressed in the audit ledger's canonical
 * vocabulary. Bulk and single producers both feed this contract so the
 * action, object type, and domain detail cannot drift by entry path.
 */
export type ArtifactMutationAuditChange =
  | ({
      action: typeof AuditAction.DocumentPriorityChanged;
    } & AuditTransition<Priority | null>)
  | ({ action: typeof AuditAction.ArtifactProjectChanged } & AuditTransition<
      string | null
    >)
  | {
      action:
        | typeof AuditAction.ArtifactTagApplied
        | typeof AuditAction.ArtifactTagRemoved;
      objectId: string;
      tagId: string;
    }
  | ({ action: typeof AuditAction.AgentSessionAssigned } & AuditTransition<
      string | null
    >);

type ArtifactMutationAuditEvent = Omit<AuditEmitInput, "detail"> & {
  detail:
    | { from: Priority | string | null; to: Priority | string | null }
    | { tagId: string };
};

/** Builds the shared undecorated event consumed by single and bulk adapters. */
export function buildArtifactMutationAuditEvent(input: {
  organizationId: string;
  actor: AuditEmitInput["actor"];
  change: ArtifactMutationAuditChange;
}): ArtifactMutationAuditEvent | null {
  const { actor, change, organizationId } = input;
  switch (change.action) {
    case AuditAction.DocumentPriorityChanged:
      return buildTransitionEvent(
        organizationId,
        actor,
        change,
        AuditObjectType.Document
      );
    case AuditAction.ArtifactProjectChanged:
      return buildTransitionEvent(
        organizationId,
        actor,
        change,
        AuditObjectType.Artifact
      );
    case AuditAction.ArtifactTagApplied:
    case AuditAction.ArtifactTagRemoved:
      return {
        organizationId,
        actor,
        action: change.action,
        objectType: AuditObjectType.Artifact,
        objectId: change.objectId,
        detail: { tagId: change.tagId },
      };
    case AuditAction.AgentSessionAssigned:
      return buildTransitionEvent(
        organizationId,
        actor,
        change,
        AuditObjectType.AgentSession
      );
    default: {
      const unsupportedChange: never = change;
      throw new Error(
        `Unhandled artifact mutation audit change: ${String(unsupportedChange)}`
      );
    }
  }
}

/** Builds bulk events and owns their `transactionId` detail decoration. */
export function buildBulkArtifactMutationAuditEvents(input: {
  organizationId: string;
  actor: AuditEmitInput["actor"];
  changes: readonly ArtifactMutationAuditChange[];
  transactionId: string;
}): AuditEmitInput[] {
  const { actor, changes, organizationId, transactionId } = input;
  return changes.flatMap((change) => {
    const event = buildArtifactMutationAuditEvent({
      organizationId,
      actor,
      change,
    });
    return event
      ? [
          {
            ...event,
            detail: withBulkTransaction(event.detail, transactionId),
          },
        ]
      : [];
  });
}

function buildTransitionEvent(
  organizationId: string,
  actor: AuditEmitInput["actor"],
  change: Exclude<
    ArtifactMutationAuditChange,
    {
      action:
        | typeof AuditAction.ArtifactTagApplied
        | typeof AuditAction.ArtifactTagRemoved;
    }
  >,
  objectType: AuditEmitInput["objectType"]
): ArtifactMutationAuditEvent | null {
  if (change.before === change.after) {
    return null;
  }
  return {
    organizationId,
    actor,
    action: change.action,
    objectType,
    objectId: change.objectId,
    detail: { from: change.before, to: change.after },
  };
}
