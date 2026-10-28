/**
 * @file otel-invocation-attribution-refresh.ts
 * @description ISS-10720 (codex P1 on #7731): re-apply the OTel component
 * attribution to a session's ALREADY-STORED invocation rows when its cost
 * counters arrive after the transcript was imported.
 *
 * THAT ORDERING IS THE NORMAL ONE, not an edge case, and this repo already says
 * so in its own words: "cost that arrived after the first delivery — the normal
 * order, since OTel lands when Claude exits and the transcript may have
 * imported long before" (`session-authoritative-cost.ts`). The join in
 * `claude-code-otel-invocation-attribution.ts` runs on CANDIDATES, before they
 * are written, so the two derivation paths that call it
 * (`materializeAgentComponentInvocations`, the stored-row rebuild) can only see
 * the counters that were already in the table. Nothing re-derives an
 * already-imported session on its own —
 * `invocation-sync-canonicalization-repair.ts` says that outright — so without
 * this pass a session whose cost export landed after its final import keeps
 * `attribution_source` NULL indefinitely, and the join reaches almost nothing
 * it was built to reach.
 *
 * IT IS AN UPDATE, NOT A RE-DERIVATION. Nothing here re-reads a transcript,
 * re-derives a candidate, or changes a row's identity, component, telemetry or
 * definition evidence. It recomputes exactly the two cells the stamp owns —
 * `attribution_source`, and `evidence_class` where it was `none` — and writes
 * only the rows whose value actually moved. A session whose counters name
 * nothing it holds costs one indexed read and writes nothing.
 *
 * IT RE-ENQUEUES ONLY ON A REAL CHANGE, so it cannot amplify sync volume.
 * `enqueueInvocationGeneration` recomputes the generation id from the stored
 * rows and returns without writing when it equals the cursor's, and this pass
 * does not even call it unless an UPDATE landed.
 */

import { AgentComponentInvocationEvidenceClass } from "@repo/api/src/types/agent-component-invocation";
import { stampOtelInvocationAttribution } from "../otel/claude-code-otel-invocation-attribution.js";
import { enqueueInvocationGeneration } from "./component-invocations.js";
import type { Prisma } from "./generated/client.js";

/** The stored cells this pass reads, beside the id it writes them back on. */
type StoredAttributionRow = {
  id: string;
  component_kind: string;
  raw_name: string | null;
  normalized_name: string | null;
  evidence_class: string;
  attribution_source: string | null;
};

type RefreshCandidate = {
  id: string;
  componentKind: string;
  rawName: string | null;
  normalizedName: string | null;
  evidenceClass: AgentComponentInvocationEvidenceClass;
  attributionSource: string | null;
  priorEvidenceClass: string;
  priorAttributionSource: string | null;
};

/**
 * Re-stamp one session's stored invocation rows from its captured cost rows.
 *
 * Returns whether any row moved. Rides the CALLER'S transaction, so the stamp,
 * the rows it lands on and the generation it enqueues commit together.
 */
export async function refreshOtelInvocationAttribution(
  tx: Prisma.TransactionClient,
  sessionId: string,
  now: string,
  log: (message: string) => void
): Promise<boolean> {
  const rows = await tx.$queryRawUnsafe<StoredAttributionRow[]>(
    `SELECT id, component_kind, raw_name, normalized_name, evidence_class,
            attribution_source
       FROM agent_component_invocations
      WHERE session_id = $1`,
    sessionId
  );
  if (rows.length === 0) {
    // A session with no invocation rows is the bootstrap path's subject, not
    // this one's: there is nothing stored to stamp. This pass UPDATES rows it
    // read back, so it never seats one either — the three write paths in
    // `component-invocations.ts` own the seat, because they are the ones that
    // insert.
    return false;
  }
  const candidates = refreshCandidates(rows, sessionId, log);
  if (candidates.length === 0) {
    return false;
  }
  await stampOtelInvocationAttribution(tx, sessionId, candidates, log);
  const moved = candidates.filter(
    (candidate) =>
      candidate.attributionSource !== candidate.priorAttributionSource ||
      candidate.evidenceClass !== candidate.priorEvidenceClass
  );
  if (moved.length === 0) {
    return false;
  }
  for (const candidate of moved) {
    await tx.$executeRawUnsafe(
      `UPDATE agent_component_invocations
          SET attribution_source = $1, evidence_class = $2, updated_at = $3
        WHERE id = $4`,
      candidate.attributionSource,
      candidate.evidenceClass,
      now,
      candidate.id
    );
  }
  await enqueueInvocationGeneration(tx, sessionId, now);
  return true;
}

/**
 * Narrow the stored rows this pass can act on, REPORTING rather than throwing
 * on one it cannot read.
 *
 * A row whose `evidence_class` is not a member of the contract is corrupt or
 * was written by a newer build; either way this pass must not decide what it
 * means. Throwing would fail the whole OTel batch — every cost row in it,
 * for every session — over one unreadable cell, so the row is excluded from
 * the stamp and named in the log instead.
 */
function refreshCandidates(
  rows: readonly StoredAttributionRow[],
  sessionId: string,
  log: (message: string) => void
): RefreshCandidate[] {
  const candidates: RefreshCandidate[] = [];
  for (const row of rows) {
    const evidenceClass = Object.values(
      AgentComponentInvocationEvidenceClass
    ).find((member) => member === row.evidence_class);
    if (evidenceClass === undefined) {
      log(
        `otel_invocation_attribution ${sessionId}: invocation ${row.id} holds an unreadable evidence_class ${row.evidence_class}; excluded from the attribution refresh`
      );
      continue;
    }
    candidates.push({
      id: row.id,
      componentKind: row.component_kind,
      rawName: row.raw_name,
      normalizedName: row.normalized_name,
      evidenceClass,
      attributionSource: row.attribution_source,
      priorEvidenceClass: row.evidence_class,
      priorAttributionSource: row.attribution_source,
    });
  }
  return candidates;
}
