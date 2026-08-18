import type { BranchLifecyclePhaseSegment } from "@repo/api/src/types/branch";
import { deriveBranchLifecyclePhaseSegments } from "@repo/lib/branches/branch-lifecycle-phase";
import type { BranchLifecycleEventRow } from "../database/branch-reads.js";

/**
 * The branch detail's per-session LIFECYCLE-PHASE segments: fold each session's
 * lifecycle evidence rows into one evidence record and derive the phase segments
 * `projectBranchDetail` hangs off each contributing session.
 *
 * Split out of `shared-branches-api.ts` (ISS-4941) so the read ops keep the query
 * orchestration and this projection stays one separately readable
 * responsibility — the same seam `shared-branches-window.ts` and
 * `shared-branches-paging.ts` were cut on. Pure and IO-free by design.
 */
export function lifecyclePhaseSegmentsBySession(
  rows: BranchLifecycleEventRow[]
): Map<string, BranchLifecyclePhaseSegment[]> {
  const evidenceBySession = new Map<string, BranchLifecycleSessionEvidence>();
  for (const row of rows) {
    const existing = evidenceBySession.get(row.sessionId);
    const sessionEvidence = existing ?? {
      events: [],
      sessionStartedAt: row.sessionStartedAt,
      sessionEndedAt: row.sessionEndedAt,
    };
    sessionEvidence.events.push({
      kind: row.kind,
      ...(row.observedAt ? { observedAt: row.observedAt } : {}),
      ...(row.evidenceId ? { evidenceId: row.evidenceId } : {}),
    });
    if (!existing) {
      evidenceBySession.set(row.sessionId, sessionEvidence);
    }
  }

  const phaseSegmentsBySession = new Map<
    string,
    BranchLifecyclePhaseSegment[]
  >();
  for (const [sessionId, evidence] of evidenceBySession) {
    const phaseSegments = deriveBranchLifecyclePhaseSegments(evidence);
    if (phaseSegments.length > 0) {
      phaseSegmentsBySession.set(sessionId, phaseSegments);
    }
  }
  return phaseSegmentsBySession;
}

type BranchLifecycleSessionEvidence = {
  events: {
    kind: BranchLifecycleEventRow["kind"];
    observedAt?: string;
    evidenceId?: string;
  }[];
  sessionStartedAt: string | null;
  sessionEndedAt: string | null;
};
