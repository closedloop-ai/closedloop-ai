/**
 * ISS-12552: one golden dossier through the
 * production allocation chain. Usage units come from its token series
 * (`usageObservations`), recipients and qualifying operations from the
 * evidence its claims classify to (`recipientsAndOperations`), segments from
 * Desktop's activity classifier, then `associateUsage` and the kernel
 * (`allocateUsage`). Work item refs resolve only through the artifacts the
 * dossier itself names by slug. Shared by the Layer 3 suite and the accuracy
 * report.
 */
import { allocateUsage } from "@repo/lib/allocation/allocate-usage";
import {
  type AllocationUsageEvent,
  recipientsAndOperations,
  usageObservations,
} from "@repo/lib/attribution/allocation-inputs";
import {
  associateUsageWithReasons,
  type UnprovenUsage,
  type UsageProof,
} from "@repo/lib/attribution/associate-usage";
import { z } from "zod";
import { classifyActivitySegments } from "../../src/main/collectors/parsing/activity-segment-classifier.js";
import {
  HarnessValues,
  type NormalizedSession,
} from "../../src/main/collectors/types.js";
import {
  type ProductionAttribution,
  productionAttribution,
} from "./golden-attribution-layer1.js";
import { type GoldenDossier, parseDossierRaw } from "./golden-corpus.js";

export type AllocationRun = {
  session: NormalizedSession;
  production: ProductionAttribution;
  events: AllocationUsageEvent[];
  units: ReturnType<typeof usageObservations>;
  recipients: string[];
  proofs: UsageProof[];
  /** The units no association proves, each with its reason. */
  unproven: UnprovenUsage[];
  allocation: ReturnType<typeof allocateUsage>;
  sourceTokens: number;
};

export async function allocationRun(d: GoldenDossier): Promise<AllocationRun> {
  const session = await parseDossierRaw(d);
  if (!session) {
    throw new Error(`${d.sessionId}: the parser emitted no session`);
  }
  const harness = z.enum(HarnessValues).parse(d.expectations.harness);
  const production = await productionAttribution(
    d.dir,
    d.expectations,
    session
  );
  const events = usageEvents(d.sessionId, session);
  const units = usageObservations(events);
  const { recipients, operations } = recipientsAndOperations(
    production.evidence
  );
  const recipientSet = new Set(recipients);
  const segments = classifyActivitySegments(session, harness).map(
    (segment) => ({
      agentId: segment.subagentId ?? null,
      phase: segment.phase,
      startMs: segment.startMs,
      endMs: segment.endMs,
      workItemRef: segment.workItemRef ?? null,
    })
  );
  const workItemRecipients = new Map(
    [...production.idBySlug].filter(([, id]) => recipientSet.has(id))
  );
  const { proofs, unproven } = associateUsageWithReasons({
    units,
    segments,
    operations,
    workItemRecipients,
  });
  return {
    session,
    production,
    events,
    units,
    recipients,
    proofs,
    unproven,
    allocation: allocateUsage({ units, recipients, provenBy: proofs }),
    sourceTokens: units.reduce((sum, unit) => sum + unit.tokens, 0),
  };
}

/** The parse's usage records as token events, the shape allocation reads. */
function usageEvents(
  sessionId: string,
  session: NormalizedSession
): AllocationUsageEvent[] {
  return (session.tokenSeries ?? []).map((entry, i) => ({
    externalEventId: `${sessionId}:${i}`,
    agentExternalId: entry.subagentId ?? null,
    model: entry.model,
    inputTokens: BigInt(entry.input),
    outputTokens: BigInt(entry.output),
    cacheReadTokens: BigInt(entry.cacheRead),
    cacheWriteTokens: BigInt(entry.cacheWrite),
    sourceIdentity: entry.sourceIdentity,
    eventCreatedAt: new Date(entry.timestamp),
  }));
}
