/**
 * ISS-12552 (PRD-800 "Proving usage"): which usage
 * units are proven to belong to which artifact (AC-015).
 *
 * A unit is proven for an artifact when the request it is the usage of holds a
 * tool call whose server receipt committed a write to that artifact. That is a
 * measured join between the request and the receipt, and a request that also
 * reads is still proven for the artifact it wrote. A request whose receipted
 * writes name two or more artifacts proves none of them, even when a work item
 * ref names one ({@link requestRecipient}); its usage stays in the remainder.
 *
 * A receipted write nested inside two or more concurrently open Codex calls
 * names no request, but carries those calls' requests as candidates: it proves
 * every candidate for its recipient (a candidate that also wrote elsewhere
 * falls under the two-artifact rule), and no other unit in its run (Daveth
 * Oakhurst, 2026-10-20, PRD-800 "Proving usage").
 *
 * Evidence with neither a request nor candidates (no receipt, or a receipt an
 * older Desktop synced without its request key) falls back to agent and phase
 * (PRD-800 "Proving usage"):
 *   1. the unit's agent performed the qualifying durable operation,
 *   2. the unit falls in an activity segment owned by that agent whose phase
 *      the table below assigns to that operation class, and
 *   3. that agent's contiguous run of such segments holds durable operations
 *      of that class on exactly one artifact, or the segment's work item ref
 *      resolves to the artifact.
 * The fallback never touches a unit whose request carries a receipted write.
 * A phase name alone and an operation timestamp alone never qualify. When the
 * run and the work item ref name different artifacts the unit is not proven,
 * so no unit is proven twice.
 *
 * The main agent is `null` on units, segments and operations alike.
 */
import {
  ACTIVITY_PHASE,
  type ActivityPhase,
} from "@repo/api/src/types/activity-phase";
import { UsageAssociationMethod } from "@repo/api/src/types/attribution-evidence";
import type { AllocationUnit, ProvenUsage } from "../allocation/allocate-usage";

export const UsageOperationClass = {
  /** Document or issue creation and revision. */
  Plan: "plan",
  Comment: "comment",
  Implementation: "implementation",
} as const;
export type UsageOperationClass =
  (typeof UsageOperationClass)[keyof typeof UsageOperationClass];

/** The phase-to-operation table. */
export const PHASE_OPERATION_CLASS: Record<
  ActivityPhase,
  UsageOperationClass | null
> = {
  [ACTIVITY_PHASE.Explore]: null,
  [ACTIVITY_PHASE.Plan]: UsageOperationClass.Plan,
  [ACTIVITY_PHASE.Implement]: UsageOperationClass.Implementation,
  [ACTIVITY_PHASE.Review]: UsageOperationClass.Comment,
  [ACTIVITY_PHASE.Validate]: UsageOperationClass.Implementation,
  [ACTIVITY_PHASE.Rework]: UsageOperationClass.Implementation,
  [ACTIVITY_PHASE.Other]: null,
  [ACTIVITY_PHASE.Idle]: null,
};

export type UsageObservation = AllocationUnit & {
  atMs: number;
  /** The request's source records, scheme-qualified; empty when unknown. */
  requestKeys: readonly string[];
};

export type AssociationSegment = {
  agentId: string | null;
  phase: string;
  /** Half-open [startMs, endMs). */
  startMs: number;
  endMs: number;
  workItemRef: string | null;
};

export type QualifyingOperation = {
  recipientKey: string;
  operationClass: UsageOperationClass;
  agentId: string | null;
  /** Null for repository evidence, which carries no operation time. */
  atMs: number | null;
  /**
   * The request that issued the call, scheme-qualified, set only for a write
   * a server receipt committed; null puts the operation on the fallback.
   */
  requestKey: string | null;
  /**
   * For a receipted write with no `requestKey` because it ran inside two or
   * more concurrently open Codex calls: the requests of those calls. The write
   * proves every one of them for its recipient, and nothing else in the run.
   */
  candidateRequestKeys?: readonly string[];
  /**
   * A receipted write whose request the transcript recorded but cannot name:
   * it proves no request and never reaches the fallback.
   */
  requestUnresolved?: boolean;
};

export type AssociateUsageInput = {
  units: readonly UsageObservation[];
  segments: readonly AssociationSegment[];
  operations: readonly QualifyingOperation[];
  /** Work item refs the caller resolved to a recipient. */
  workItemRecipients: ReadonlyMap<string, string>;
};

export type UsageProof = ProvenUsage & { method: UsageAssociationMethod };

export const UnprovenUsageReason = {
  /** The request's receipted writes name two or more artifacts. */
  MultiTargetRequest: "multiTargetRequest",
  /** No receipt join, and the agent and phase fallback placed nothing. */
  NoQualifyingEvidence: "noQualifyingEvidence",
} as const;
export type UnprovenUsageReason =
  (typeof UnprovenUsageReason)[keyof typeof UnprovenUsageReason];

export type UnprovenUsage = { sourceKey: string; reason: UnprovenUsageReason };

export function associateUsage(input: AssociateUsageInput): UsageProof[] {
  return associateUsageWithReasons(input).proofs;
}

/** The proofs, and why each remaining unit is unproven. */
export function associateUsageWithReasons(input: AssociateUsageInput): {
  proofs: UsageProof[];
  unproven: UnprovenUsage[];
} {
  const writesByRequest = receiptedWritesByRequest(input.operations);
  // PRD-800 (Daveth Oakhurst, 2026-10-20): a write with candidate
  // requests is placed by them, so only writes with neither a request nor
  // candidates (an older Desktop) reach the whole-run fallback. PRD-800
  // "Proving usage": a write whose request is unresolved reaches neither.
  const fallbackInput = {
    ...input,
    operations: input.operations.filter(
      (operation) =>
        operation.requestKey === null &&
        operation.requestUnresolved !== true &&
        (operation.candidateRequestKeys?.length ?? 0) === 0
    ),
  };
  const index = indexRuns(
    buildRuns(fallbackInput.segments, fallbackInput.operations)
  );
  const proofs: UsageProof[] = [];
  const unproven: UnprovenUsage[] = [];
  for (const unit of input.units) {
    const proof = proofForUnit(unit, writesByRequest, index, fallbackInput);
    if (proof.recipientKey === undefined) {
      unproven.push({ sourceKey: unit.sourceKey, reason: proof.reason });
    } else {
      proofs.push({
        sourceKey: unit.sourceKey,
        tokens: unit.tokens,
        recipientKey: proof.recipientKey,
        method: proof.method,
      });
    }
  }
  return { proofs, unproven };
}

/**
 * The artifact a request's receipted writes prove usage for. PRD-800
 * "Proving usage" (Daveth Oakhurst, 2026-10-20): exactly one artifact, or none
 * when the writes name two or more.
 */
export function requestRecipient(
  recipients: ReadonlySet<string>
): string | undefined {
  return recipients.size === 1 ? [...recipients][0] : undefined;
}

type UnitProof =
  | { recipientKey: string; method: UsageAssociationMethod }
  | { recipientKey?: undefined; reason: UnprovenUsageReason };

function proofForUnit(
  unit: UsageObservation,
  writesByRequest: ReadonlyMap<string, ReadonlySet<string>>,
  index: ReadonlyMap<string, PlacedSegment[]>,
  input: AssociateUsageInput
): UnitProof {
  const written = new Set<string>();
  for (const key of unit.requestKeys) {
    for (const recipient of writesByRequest.get(key) ?? []) {
      written.add(recipient);
    }
  }
  if (written.size > 0) {
    const recipientKey = requestRecipient(written);
    return recipientKey === undefined
      ? { reason: UnprovenUsageReason.MultiTargetRequest }
      : { recipientKey, method: UsageAssociationMethod.RequestReceipt };
  }
  const placed = locate(index.get(agentKey(unit.agentId)) ?? [], unit.atMs);
  const proof = placed && proofFor(placed.run, placed.segment, input);
  return proof ?? { reason: UnprovenUsageReason.NoQualifyingEvidence };
}

function receiptedWritesByRequest(
  operations: readonly QualifyingOperation[]
): Map<string, Set<string>> {
  const byRequest = new Map<string, Set<string>>();
  const add = (request: string, recipient: string) => {
    byRequest.set(
      request,
      (byRequest.get(request) ?? new Set()).add(recipient)
    );
  };
  for (const operation of operations) {
    if (operation.requestKey !== null) {
      add(operation.requestKey, operation.recipientKey);
      continue;
    }
    for (const candidate of operation.candidateRequestKeys ?? []) {
      add(candidate, operation.recipientKey);
    }
  }
  return byRequest;
}

type PlacedSegment = { segment: AssociationSegment; run: Run };

/** Each agent's qualifying segments, ordered by start, for binary search. */
function indexRuns(runs: readonly Run[]): Map<string, PlacedSegment[]> {
  const index = new Map<string, PlacedSegment[]>();
  for (const run of runs) {
    const placed = index.get(run.agentKey) ?? [];
    placed.push(...run.segments.map((segment) => ({ segment, run })));
    index.set(run.agentKey, placed);
  }
  for (const placed of index.values()) {
    placed.sort(
      (left, right) =>
        left.segment.startMs - right.segment.startMs ||
        left.segment.endMs - right.segment.endMs
    );
  }
  return index;
}

/** The last segment starting at or before `atMs`, when it contains it. */
function locate(
  placed: readonly PlacedSegment[],
  atMs: number
): PlacedSegment | undefined {
  let low = 0;
  let high = placed.length - 1;
  let found: PlacedSegment | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = placed[middle];
    if (candidate && candidate.segment.startMs <= atMs) {
      found = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found && contains(found.segment, atMs) ? found : undefined;
}

type Run = {
  agentKey: string;
  operationClass: UsageOperationClass;
  segments: AssociationSegment[];
  /** The one artifact this agent's operations of the class name, if one. */
  soleRecipient: string | undefined;
  /** Every artifact the agent has a durable operation of the class on. */
  operatedRecipients: Set<string>;
};

function buildRuns(
  segments: readonly AssociationSegment[],
  operations: readonly QualifyingOperation[]
): Run[] {
  const byAgent = new Map<string, AssociationSegment[]>();
  for (const segment of segments) {
    const key = agentKey(segment.agentId);
    byAgent.set(key, [...(byAgent.get(key) ?? []), segment]);
  }
  const runs: Run[] = [];
  for (const [key, agentSegments] of byAgent) {
    const ordered = [...agentSegments].sort(
      (left, right) => left.startMs - right.startMs || left.endMs - right.endMs
    );
    let current: Run | undefined;
    for (const segment of ordered) {
      const operationClass = phaseClass(segment.phase);
      if (!operationClass) {
        current = undefined;
        continue;
      }
      if (current?.operationClass !== operationClass) {
        current = {
          agentKey: key,
          operationClass,
          segments: [],
          soleRecipient: undefined,
          operatedRecipients: new Set(),
        };
        runs.push(current);
      }
      current.segments.push(segment);
    }
  }
  for (const run of runs) {
    resolveRun(run, operations);
  }
  return runs;
}

function resolveRun(
  run: Run,
  operations: readonly QualifyingOperation[]
): void {
  const startMs = Math.min(...run.segments.map((segment) => segment.startMs));
  const endMs = Math.max(...run.segments.map((segment) => segment.endMs));
  const inRun = new Set<string>();
  for (const operation of operations) {
    if (
      agentKey(operation.agentId) !== run.agentKey ||
      operation.operationClass !== run.operationClass
    ) {
      continue;
    }
    run.operatedRecipients.add(operation.recipientKey);
    if (
      operation.atMs !== null &&
      operation.atMs >= startMs &&
      operation.atMs < endMs
    ) {
      inRun.add(operation.recipientKey);
    }
  }
  run.soleRecipient = inRun.size === 1 ? [...inRun][0] : undefined;
}

function proofFor(
  run: Run,
  segment: AssociationSegment,
  input: AssociateUsageInput
): { recipientKey: string; method: UsageAssociationMethod } | undefined {
  const referenced = segment.workItemRef
    ? input.workItemRecipients.get(segment.workItemRef)
    : undefined;
  const byRef =
    referenced && run.operatedRecipients.has(referenced)
      ? referenced
      : undefined;
  if (byRef && run.soleRecipient && byRef !== run.soleRecipient) {
    return undefined;
  }
  if (run.soleRecipient) {
    return {
      recipientKey: run.soleRecipient,
      method: UsageAssociationMethod.AgentPhaseRun,
    };
  }
  return byRef
    ? { recipientKey: byRef, method: UsageAssociationMethod.WorkItemRef }
    : undefined;
}

const CLASS_BY_PHASE: Readonly<Record<string, UsageOperationClass | null>> =
  PHASE_OPERATION_CLASS;

function phaseClass(phase: string): UsageOperationClass | null {
  return Object.hasOwn(CLASS_BY_PHASE, phase)
    ? (CLASS_BY_PHASE[phase] ?? null)
    : null;
}

function contains(segment: AssociationSegment, atMs: number): boolean {
  return atMs >= segment.startMs && atMs < segment.endMs;
}

function agentKey(agentId: string | null): string {
  return agentId ?? "";
}
