import {
  INVOCATION_SYNC_MISSING_PARENTS_CATEGORY,
  type InvocationSyncMissingParents,
  type InvocationSyncParent,
  invocationSyncMissingParentsSchema,
} from "@repo/api/src/types/invocation-sync-diagnostics";
import { z } from "zod";
import type {
  AgentComponentInvocationSyncOutboxEntry,
  AgentComponentInvocationSyncSource,
} from "../agent-sync/agent-component-invocation-sync-service.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import { buildDesktopClientVersionTrace } from "./desktop-client-version.js";
import { Observability } from "./observability.js";

/** One diagnostic per tick, at most ten parts. The failure spans remain exact. */
export async function reportInvocationSyncMissingParents(input: {
  entries: AgentComponentInvocationSyncOutboxEntry[];
  computeTargetId: string;
  sessionSourceKey: string;
  source: AgentComponentInvocationSyncSource;
  /**
   * The lane's own pre-send gate, re-read AFTER the parent read's awaits. The
   * service hands its `canStillSend` down rather than the composition rebuilding
   * the predicate, so readiness, consent tier and compute target cannot drift
   * apart from the send path they are supposed to mirror
   * (`main/sync/AGENTS.md` section 12a).
   */
  canReport?: () => boolean;
}): Promise<void> {
  const diagnostics = await buildInvocationSyncMissingParents(input);
  // Keep the identifiers in a separate authenticated diagnostic log, never the
  // keyless transport-health span. The durable copy survives a cloud outage.
  gatewayLog.warn("component-invocation-sync", JSON.stringify(diagnostics));
  if (input.canReport && !input.canReport()) {
    return;
  }
  Observability.getTelemetryEmitter().emit({
    severity: "warn",
    category: INVOCATION_SYNC_MISSING_PARENTS_CATEGORY,
    message:
      "Invocation uploads were rejected because their parent sessions were not found in the cloud.",
    trace: {
      ...buildDesktopClientVersionTrace(),
      computeTargetId: input.computeTargetId,
    },
    diagnostics: { invocationSyncMissingParents: diagnostics },
  });
}

export async function buildInvocationSyncMissingParents(input: {
  entries: AgentComponentInvocationSyncOutboxEntry[];
  computeTargetId: string;
  sessionSourceKey: string;
  source: AgentComponentInvocationSyncSource;
}): Promise<InvocationSyncMissingParents> {
  const entries = input.entries.slice(0, 10);
  let parents: InvocationSyncParent[] = [];
  let parentReadFailed = false;
  if (input.source.loadInvocationSyncParents) {
    try {
      parents = await input.source.loadInvocationSyncParents(
        input.sessionSourceKey,
        entries.map((entry) => entry.part.externalSessionId)
      );
    } catch {
      // Missing diagnostics are not evidence that the parent is absent.
      parentReadFailed = true;
    }
  }
  const byId = new Map(
    parents.map((parent) => [parent.externalSessionId, parent])
  );
  return invocationSyncMissingParentsSchema.parse({
    computeTargetId: input.computeTargetId,
    sessionSourceKey: input.sessionSourceKey,
    observedAt: new Date().toISOString(),
    ...(parentReadFailed ? { parentReadFailed } : {}),
    parts: entries.map((entry) => {
      const createdAt = z.iso.datetime().safeParse(entry.createdAt);
      const parent = byId.get(entry.part.externalSessionId);
      return {
        externalSessionId: entry.part.externalSessionId,
        externalGenerationId: entry.part.externalGenerationId,
        partIndex: entry.part.partIndex,
        partHash: entry.part.partHash,
        // Both durable counters exactly as the row carries them, NOT a derived
        // "attempts including this send". `handleRejectedAck` advances only one
        // of the two, and for a `session_missing` past the retry age horizon (or
        // with an unreadable `created_at`) it is `permanentAttemptCount` that
        // moves while `attemptCount` is written back unchanged — and the dead-
        // letter path passes `attemptCount` straight through. Old rows past the
        // horizon are exactly the population this diagnostic is for, so a +1
        // there reports a number that is on neither row.
        attemptCount: entry.attemptCount,
        permanentAttemptCount: entry.permanentAttemptCount,
        ...(createdAt.success
          ? { createdAt: createdAt.data }
          : { createdAtInvalid: true }),
        ...(parent ? { parent } : {}),
      };
    }),
  });
}
