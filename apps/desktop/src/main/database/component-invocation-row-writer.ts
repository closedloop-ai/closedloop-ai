/**
 * FEA-4160: the row-writer concern for `agent_component_invocations` — the
 * batched `INSERT ... ON CONFLICT DO UPDATE` plus the pre-write dedupe/merge
 * that guarantees one row per `(session_id, external_invocation_id)`.
 *
 * Extracted from `component-invocations.ts` (which is on the shrink-only
 * grandfather list) so the write boundary lives in its own testable module.
 */
import { createHash } from "node:crypto";
import {
  AgentComponentInvocationEvidenceClass,
  type AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import type { Prisma } from "./generated/client.js";

type InvocationKind =
  (typeof AgentComponentInvocationKind)[keyof typeof AgentComponentInvocationKind];
type EvidenceClass =
  (typeof AgentComponentInvocationEvidenceClass)[keyof typeof AgentComponentInvocationEvidenceClass];

export type EvidencePointer = {
  definitionFormat?: string;
  sourcePath?: string;
  sourceModifiedAt?: string;
  capturedAt?: string;
  externalAgentId?: string;
  transcriptFileId?: string;
  parentExternalInvocationId?: string;
};

export type AgentComponentInvocationCandidate = {
  externalInvocationId: string;
  externalSourceId: string | null;
  childSessionId: string | null;
  agentId: string | null;
  parentAgentId: string | null;
  componentKind: InvocationKind;
  componentKey: string;
  rawName: string | null;
  normalizedName: string | null;
  relationship: string;
  invokedAt: string | null;
  sourceOrder: number;
  sequence: number;
  anchorKind: string;
  anchorValue: string;
  providerToolUseId: string | null;
  attributionStatus: string;
  evidenceClass: EvidenceClass;
  evidencePointer: EvidencePointer | null;
  definitionHash: string | null;
  normalizerContractVersion: number | null;
  definitionContent: string | null;
  localComponentId: string | null;
  localComponentVersionId: string | null;
  gitBranch: string | null;
  repositoryFullName: string | null;
  // FEA-4093: whether a firing SUCCEEDED. Null for kinds whose success/failure
  // is not a first-class transcript fact (every kind except Hook today). A Hook
  // firing sets it from the `attachment` type (hook_success vs hook_error /
  // hook_non_blocking_error) so the usage rollup can count failed firings even
  // though a hook anchors to a Timestamp, not an error-bearing event/agent.
  succeeded: boolean | null;
  createdAt: string;
  updatedAt: string;
  /**
   * ISS-5260: TRANSIENT (never persisted — the insert below maps an explicit
   * column list). Set by the two `command` candidate producers to the same fact
   * their skill-shadow correlation gates on: this slash entry carried its own
   * resolving definition, so it is a genuine command and must never be folded
   * onto a same-named skill. The inventory-evidence re-point reads it rather
   * than re-deriving from `definitionHash`/`definitionContent`, which are null
   * whenever `exactEvidence`'s name comparison misses.
   */
  commandDefinitionWitness?: boolean;
};

const INVOCATION_COLUMNS_PER_ROW = 30;
/* Exported so a multi-chunk test can size its fixture from the real chunk width
   rather than a copied number that silently stops spanning chunks if this
   changes (Codex review on #4448). */
export const INVOCATION_ROWS_PER_CHUNK = Math.max(
  1,
  Math.floor(900 / INVOCATION_COLUMNS_PER_ROW)
);
/* ISS-5098: the agent-existence lookup binds one parameter per id (Prisma renders
   `id IN (?, ?, …)`), so it is chunked against the same ~900-parameter SQLite
   ceiling the row chunker above budgets against. */
const AGENT_ID_LOOKUP_CHUNK = 900;

export function deterministicId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function evidenceRank(value: EvidenceClass): number {
  if (value === AgentComponentInvocationEvidenceClass.TranscriptSnapshot) {
    return 3;
  }
  if (value === AgentComponentInvocationEvidenceClass.CollectorSnapshot) {
    return 2;
  }
  if (
    value === AgentComponentInvocationEvidenceClass.RepositoryCommit ||
    value === AgentComponentInvocationEvidenceClass.PackMembership
  ) {
    return 1;
  }
  return 0;
}

export async function insertInvocationRows(
  tx: Prisma.TransactionClient,
  sessionId: string,
  candidates: AgentComponentInvocationCandidate[],
  /* REQUIRED (wongk, #4355): `nullUnresolvableAgentReferences` below rewrites a
     bad `agent_id`/`parent_agent_id` to NULL, so a caller that supplies no
     reporter loses the attribution with no diagnostic — exactly the failure this
     guard exists to surface. Non-optional so the omission is a compile error
     rather than a convention every future caller must remember; a caller that
     genuinely has no logger must pass one explicitly, as a reviewable choice. */
  log: (message: string) => void
): Promise<void> {
  const rows = mergeInvocationRowsByExternalId(candidates);
  await nullUnresolvableAgentReferences(tx, sessionId, rows, log);
  for (
    let offset = 0;
    offset < rows.length;
    offset += INVOCATION_ROWS_PER_CHUNK
  ) {
    const chunk = rows.slice(offset, offset + INVOCATION_ROWS_PER_CHUNK);
    const params: unknown[] = [];
    const tuples = chunk.map((candidate) => {
      const values = [
        deterministicId(`${sessionId}|${candidate.externalInvocationId}`),
        sessionId,
        candidate.externalInvocationId,
        candidate.externalSourceId,
        candidate.childSessionId,
        candidate.agentId,
        candidate.parentAgentId,
        candidate.componentKind,
        candidate.componentKey,
        candidate.rawName,
        candidate.normalizedName,
        candidate.relationship,
        candidate.invokedAt,
        candidate.sequence,
        candidate.anchorKind,
        candidate.anchorValue,
        candidate.providerToolUseId,
        candidate.attributionStatus,
        candidate.evidenceClass,
        candidate.evidencePointer
          ? JSON.stringify(candidate.evidencePointer)
          : null,
        candidate.definitionHash,
        candidate.normalizerContractVersion,
        candidate.definitionContent,
        candidate.localComponentId,
        candidate.localComponentVersionId,
        candidate.gitBranch,
        candidate.repositoryFullName,
        // SQLite has no boolean affinity: 1/0 for known success/failure, NULL
        // when the kind does not carry a success fact (every kind but Hook).
        candidate.succeeded === null ? null : Number(candidate.succeeded),
        candidate.createdAt,
        candidate.updatedAt,
      ];
      const start = params.length;
      params.push(...values);
      return `(${values.map((_, index) => `$${start + index + 1}`).join(", ")})`;
    });
    await tx.$executeRawUnsafe(
      `INSERT INTO agent_component_invocations
         (id, session_id, external_invocation_id, external_source_id,
          child_session_id, agent_id, parent_agent_id, component_kind,
          component_key, raw_name, normalized_name, relationship, invoked_at,
          sequence, anchor_kind, anchor_value, provider_tool_use_id,
          attribution_status, evidence_class, evidence_pointer, definition_hash,
          normalizer_contract_version, definition_content, local_component_id,
          local_component_version_id, git_branch, repository_full_name,
          succeeded, created_at, updated_at)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (session_id, external_invocation_id) DO UPDATE SET
         external_source_id = excluded.external_source_id,
         child_session_id = excluded.child_session_id,
         agent_id = excluded.agent_id,
         parent_agent_id = excluded.parent_agent_id,
         component_kind = excluded.component_kind,
         component_key = excluded.component_key,
         raw_name = excluded.raw_name,
         normalized_name = excluded.normalized_name,
         relationship = excluded.relationship,
         invoked_at = excluded.invoked_at,
         sequence = excluded.sequence,
         anchor_kind = excluded.anchor_kind,
         anchor_value = excluded.anchor_value,
         provider_tool_use_id = excluded.provider_tool_use_id,
         attribution_status = excluded.attribution_status,
         evidence_class = excluded.evidence_class,
         evidence_pointer = excluded.evidence_pointer,
         definition_hash = excluded.definition_hash,
         normalizer_contract_version = excluded.normalizer_contract_version,
         definition_content = excluded.definition_content,
         local_component_id = excluded.local_component_id,
         local_component_version_id = excluded.local_component_version_id,
         git_branch = excluded.git_branch,
         repository_full_name = excluded.repository_full_name,
         succeeded = excluded.succeeded,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      ...params
    );
  }
}

/**
 * FEA-4160: collapse a candidate batch to one row per external_invocation_id so
 * a raw batched INSERT can never violate UNIQUE(session_id,
 * external_invocation_id) — the SQLITE_CONSTRAINT 2067 that aborted the whole
 * session import.
 *
 * The earlier dedupeCandidates() pass runs BEFORE restoreStableInvocationIds
 * and linkSubagentParentExternalInvocations, either of which can REMAP a
 * candidate onto a prior stable id — so two candidates that were distinct
 * upstream can collide here on external_invocation_id. Rather than silently
 * drop the later candidate (which may carry stronger evidence or a different
 * component key), we MERGE: the first-seen candidate keeps its batch position
 * and sequence, but its evidence-bearing fields are promoted from whichever
 * colliding candidate carries the strongest evidence, so a remap collision can
 * never permanently omit the stronger invocation's identity/evidence.
 */
export function mergeInvocationRowsByExternalId(
  candidates: AgentComponentInvocationCandidate[]
): AgentComponentInvocationCandidate[] {
  const byExternalId = new Map<string, AgentComponentInvocationCandidate>();
  for (const candidate of candidates) {
    const existing = byExternalId.get(candidate.externalInvocationId);
    if (existing) {
      mergeStrongerEvidenceInto(existing, candidate);
      continue;
    }
    byExternalId.set(candidate.externalInvocationId, candidate);
  }
  const rows = [...byExternalId.values()];
  for (const [sequence, row] of rows.entries()) {
    row.sequence = sequence;
  }
  return rows;
}

/**
 * When two candidates collide on external_invocation_id, keep `survivor` (its
 * batch position/sequence) but promote its evidence-bearing fields from
 * `candidate` when `candidate` carries strictly stronger evidence. Mirrors the
 * evidenceRank precedence used by preserveStrongerEvidence so the surviving row
 * reflects the strongest candidate's component identity and definition, rather
 * than whichever candidate happened to appear first.
 */
function mergeStrongerEvidenceInto(
  survivor: AgentComponentInvocationCandidate,
  candidate: AgentComponentInvocationCandidate
): void {
  if (
    evidenceRank(candidate.evidenceClass) <=
    evidenceRank(survivor.evidenceClass)
  ) {
    return;
  }
  survivor.componentKind = candidate.componentKind;
  survivor.componentKey = candidate.componentKey;
  survivor.rawName = candidate.rawName;
  survivor.normalizedName = candidate.normalizedName;
  survivor.attributionStatus = candidate.attributionStatus;
  survivor.evidenceClass = candidate.evidenceClass;
  survivor.evidencePointer = candidate.evidencePointer;
  survivor.definitionHash = candidate.definitionHash;
  survivor.normalizerContractVersion = candidate.normalizerContractVersion;
  survivor.definitionContent = candidate.definitionContent;
  survivor.localComponentId = candidate.localComponentId;
  survivor.localComponentVersionId = candidate.localComponentVersionId;
  survivor.succeeded = candidate.succeeded;
}

/**
 * ISS-5098: null out `agent_id` / `parent_agent_id` values that no `agents` row
 * satisfies, BEFORE the batched insert binds them.
 *
 * Both columns carry a FOREIGN KEY to `agents` (schema.prisma), but every id
 * that reaches here is derived, not verified:
 *  - the parse-derived builder mints `<session>-sub-<toolUseId>` for a delegation
 *    it could not pair to a parser-lane subagent, ASSUMING the events phase minted
 *    that twin row — an assumption ISS-4592 broke when it started re-pointing the
 *    spawn event at the parser-lane row and skipping the twin;
 *  - the stored-event builder copies `events.agent_id`, a column that carries an
 *    index but deliberately NO foreign key (events may precede their parent row).
 *
 * Either way an unsatisfiable id fails the WHOLE multi-row insert with
 * `SQLITE_CONSTRAINT: FOREIGN KEY constraint failed` (code 787), which the import
 * phase catches, marks incomplete, and retries forever — the session never seals
 * and its invocation rows never land.
 *
 * Both columns are nullable and their relations declare `onDelete: SetNull`, so
 * "agent unknown" is an explicitly supported state: dropping the reference keeps
 * the invocation row (its evidence, anchor, and component identity are unaffected)
 * instead of losing the session. It is NOT swallowed — the REQUIRED `log` reports
 * the dropped count so a mint/insert divergence stays visible rather than becoming
 * silent attribution loss. Required, not optional (wongk, #4355): the legacy
 * bootstrap and the stored-row rebuild both build from `events.agent_id`, the very
 * column with no FK, so they are the paths MOST likely to drop a reference — an
 * omittable reporter would have made exactly those two commit in silence.
 *
 * Existence is checked by ID, not by session, because that is exactly what the FK
 * checks: `agents.id` is global, so a legitimate cross-session reference must not
 * be nulled here.
 */
async function nullUnresolvableAgentReferences(
  tx: Prisma.TransactionClient,
  sessionId: string,
  rows: AgentComponentInvocationCandidate[],
  log: (message: string) => void
): Promise<void> {
  const referenced = new Set<string>();
  for (const row of rows) {
    if (row.agentId) {
      referenced.add(row.agentId);
    }
    if (row.parentAgentId) {
      referenced.add(row.parentAgentId);
    }
  }
  if (referenced.size === 0) {
    return;
  }

  const ids = [...referenced];
  const known = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += AGENT_ID_LOOKUP_CHUNK) {
    const chunk = ids.slice(offset, offset + AGENT_ID_LOOKUP_CHUNK);
    const found = await tx.agent.findMany({
      where: { id: { in: chunk } },
      select: { id: true },
    });
    for (const row of found) {
      known.add(row.id);
    }
  }

  let droppedAgents = 0;
  let droppedParents = 0;
  for (const row of rows) {
    if (row.agentId && !known.has(row.agentId)) {
      row.agentId = null;
      droppedAgents += 1;
    }
    if (row.parentAgentId && !known.has(row.parentAgentId)) {
      row.parentAgentId = null;
      droppedParents += 1;
    }
  }
  if (droppedAgents > 0 || droppedParents > 0) {
    const missing = ids.filter((id) => !known.has(id));
    log(
      `component_invocations ${sessionId}: dropped ${droppedAgents} agent_id and ${droppedParents} parent_agent_id reference(s) with no agents row (would fail the FK); example: ${missing[0]}`
    );
  }
}
