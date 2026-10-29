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
  type AgentComponentFindingsDisposition,
  isAgentComponentFindingsDispositionConsistentWithFunnel,
  isAgentComponentFindingsIngestDisposition,
} from "@repo/api/src/types/agent-component-findings-disposition";
import {
  AgentComponentFindingsCellsReading,
  readStoredAgentComponentFindingsCells,
} from "@repo/api/src/types/agent-component-findings-funnel";
import type { AgentComponentFootprint } from "@repo/api/src/types/agent-component-footprint";
import {
  AgentComponentInvocationEvidenceClass,
  type AgentComponentInvocationKind,
  AgentComponentInvocationUsageMeasurement,
  LINE_BEARING_INVOCATION_KINDS,
} from "@repo/api/src/types/agent-component-invocation";
import { invocationDurationFields } from "@repo/api/src/types/agent-component-invocation-duration";
import { isValidInvocationLineCount } from "@repo/api/src/types/agent-component-invocation-lines";
import type {
  NormalizedComponentUsage,
  NormalizedTokenRecord,
} from "@repo/lib/harness/types";
import {
  areInvocationUsageCountsValid,
  invocationEstimatedCostUsd,
} from "../cost/invocation-usage-cost.js";
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
  /** Undefined is missing evidence; null records contradictory timing witnesses. */
  durationMs?: number | null;
  /** Set when this call's call/result timestamps could not form an elapsed span. */
  durationRefusedInvalidEvidence?: true;
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
  /**
   * ISS-7795: per-invocation telemetry measured from the harness's own per-turn
   * attribution stamp. `null` throughout means the transcript attributed no turn
   * to this invocation — "no telemetry", never a measured zero, so the columns
   * stay NULL rather than taking a fabricated 0.
   */
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /**
   * ISS-7261: what those counts cost, priced by the shared engine. `null` when
   * the counts could not be priced — a mixed-model row or an unknown model id —
   * so an unpriced invocation never reads as a free one.
   */
  estimatedCost: number | null;
  /**
   * Which population the counts above belong to. Set iff any of them is, which
   * is the invariant the wire boundary re-checks as
   * `usage_measurement_requires_telemetry`.
   */
  usageMeasurement: string | null;
  /**
   * ISS-10736: the kind-agnostic CONTEXT FOOTPRINT — tokens this component
   * injected into the consuming turn. `null` means "not measured" and is not a
   * zero: the source text was absent, or was a size-capped prefix whose count
   * would under-state the real injection. Which text each kind is counted from
   * is declared once, exhaustively, in
   * `@repo/api/src/types/agent-component-footprint`.
   */
  footprintTokens: number | null;
  /**
   * ISS-10730: the lines THIS invocation changed, from the tool call's own
   * `diffDelta`. `null` on every kind outside `LINE_BEARING_INVOCATION_KINDS`,
   * and on a call the harness recorded no per-edit delta for — never a
   * fabricated 0, which would read as "this call changed nothing" for a call
   * nobody measured. Set together or not at all: a half-known delta is not a
   * delta.
   */
  linesAdded: number | null;
  linesRemoved: number | null;
  /**
   * ISS-10725: the ISS-7796 findings funnel for this invocation. `null` on both
   * means no code-review run was attributed to it — "not measured", never a
   * measured zero. Both-or-neither is enforced at the WRITE, not by this type:
   * the two fields are independently nullable, so {@link persistableFindings}
   * is what turns a half-set or inadmissible pair into NULL/NULL before it is
   * bound.
   */
  findingsEmitted: number | null;
  findingsInvalidated: number | null;
  /**
   * ISS-11325: WHY the pair above reads what it reads — measured by this run,
   * carried forward from an earlier one, or withheld for one of the ingest's
   * three named reasons. `null` when nothing said, which is every kind the
   * findings ingest does not reach.
   *
   * Consistency with the pair is enforced at the WRITE, not by this type: the
   * two are independently assignable, so {@link persistableFindingsDisposition}
   * is what refuses a label contradicting the pair actually bound.
   */
  findingsDisposition: AgentComponentFindingsDisposition | null;
  /**
   * ISS-10720: which source attributed this invocation to its component, or
   * NULL for the transcript. A SECOND AXIS beside `evidenceClass`, which
   * answers where the DEFINITION came from — the cloud read keys the
   * component-detail source pointer off that one, so folding attribution into
   * it would delete a pointer that is still perfectly well known.
   */
  attributionSource: string | null;
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
  /**
   * ISS-7261: TRANSIENT (never persisted — the insert maps an explicit column
   * list). Set when a measured `usage` was refused for corrupt counts, so the
   * writer can REPORT the refusal instead of losing it: the stored NULL is
   * otherwise indistinguishable from "nothing ever measured this", which is the
   * distinction the whole telemetry label exists to keep. Same reporting seam
   * as the dropped-`agent_id` diagnostic below.
   */
  usageRefusedCorruptCounts?: boolean;
  /**
   * ISS-10736: TRANSIENT (never persisted — the insert maps an explicit column
   * list). Set when a resolved footprint was withheld because the row's single
   * `usage_measurement` column already states a different derivation. Same
   * reporting seam, and the same reason, as `usageRefusedCorruptCounts` above.
   */
  footprintRefusedUnlabelled?: boolean;
};

const INVOCATION_COLUMNS_PER_ROW = 46;
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

/**
 * How strongly a class holds a row's DEFINITION — the only question its two
 * consumers ask. `preserveStrongerEvidence` uses it to decide whether a prior
 * row's definition should be restored onto a fresh candidate, and
 * {@link mergeStrongerEvidenceInto} uses it to decide which of two colliding
 * candidates' definitions the survivor keeps.
 *
 * ISS-10720 ranks `otelCounter` WITH `none`, at the bottom, and that is not a
 * demotion of the harness's word. An OTel counter carries no file, no hash and
 * no commit, so it has no definition to be strong about; which SOURCE
 * attributed a row is now its own column (`attribution_source`) and no longer
 * competes here. Ranking it at the top instead — the first cut of this change
 * — let a stamped candidate with no definition displace a colliding
 * candidate's real one in the merge below, and made
 * `preserveStrongerEvidence`'s `previous.definition_hash` gate load-bearing in
 * a way nothing had ever required of it.
 */
export function evidenceRank(value: EvidenceClass): number {
  if (value === AgentComponentInvocationEvidenceClass.OtelCounter) {
    return 0;
  }
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
  /* REQUIRED (whitlockk, #4355): `nullUnresolvableAgentReferences` below rewrites a
     bad `agent_id`/`parent_agent_id` to NULL, so a caller that supplies no
     reporter loses the attribution with no diagnostic — exactly the failure this
     guard exists to surface. Non-optional so the omission is a compile error
     rather than a convention every future caller must remember; a caller that
     genuinely has no logger must pass one explicitly, as a reviewable choice. */
  log: (message: string) => void
): Promise<void> {
  const rows = mergeInvocationRowsByExternalId(candidates);
  reportRefusedCorruptTelemetry(sessionId, rows, log);
  reportWithheldFootprints(sessionId, rows, log);
  reportRefusedInvocationTimings(sessionId, rows, log);
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
        invocationDurationFields(candidate.durationMs).durationMs ?? null,
        candidate.durationMs === null ? 1 : 0,
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
        candidate.model,
        candidate.inputTokens,
        candidate.outputTokens,
        candidate.cacheReadTokens,
        candidate.cacheWriteTokens,
        candidate.estimatedCost,
        candidate.usageMeasurement,
        candidate.footprintTokens,
        candidate.linesAdded,
        candidate.linesRemoved,
        ...persistableFindings(candidate),
        persistableFindingsDisposition(candidate),
        candidate.attributionSource,
        candidate.createdAt,
        candidate.updatedAt,
      ];
      /* ISS-10725 review (tamsinb): `INVOCATION_COLUMNS_PER_ROW` is what keeps
         this batched insert under SQLite's ~999-variable ceiling, and it has
         been hand-bumped once per column added. Checked against the tuple it
         actually describes so a future column overshoots the chunker HERE,
         deterministically on the first row, rather than throwing out of the
         driver only on a batch large enough to span the ceiling. */
      if (values.length !== INVOCATION_COLUMNS_PER_ROW) {
        throw new Error(
          `component_invocations: bound ${values.length} values per row but INVOCATION_COLUMNS_PER_ROW is ${INVOCATION_COLUMNS_PER_ROW}; update the chunk width with the column list`
        );
      }
      const start = params.length;
      params.push(...values);
      return `(${values.map((_, index) => `$${start + index + 1}`).join(", ")})`;
    });
    await tx.$executeRawUnsafe(
      `INSERT INTO agent_component_invocations
         (id, session_id, external_invocation_id, external_source_id,
          child_session_id, agent_id, parent_agent_id, component_kind,
          component_key, raw_name, normalized_name, relationship, invoked_at, duration_ms, duration_ambiguous,
          sequence, anchor_kind, anchor_value, provider_tool_use_id,
          attribution_status, evidence_class, evidence_pointer, definition_hash,
          normalizer_contract_version, definition_content, local_component_id,
          local_component_version_id, git_branch, repository_full_name,
          succeeded, model, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, estimated_cost, usage_measurement,
          footprint_tokens, lines_added, lines_removed, findings_emitted,
          findings_invalidated, findings_disposition, attribution_source,
          created_at, updated_at)
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
         duration_ms = excluded.duration_ms,
         duration_ambiguous = excluded.duration_ambiguous,
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
         model = excluded.model,
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         cache_read_tokens = excluded.cache_read_tokens,
         cache_write_tokens = excluded.cache_write_tokens,
         estimated_cost = excluded.estimated_cost,
         usage_measurement = excluded.usage_measurement,
         footprint_tokens = excluded.footprint_tokens,
         lines_added = excluded.lines_added,
         lines_removed = excluded.lines_removed,
         findings_emitted = excluded.findings_emitted,
         findings_invalidated = excluded.findings_invalidated,
         findings_disposition = excluded.findings_disposition,
         attribution_source = excluded.attribution_source,
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
  survivor.durationMs = candidate.durationMs;
  survivor.durationRefusedInvalidEvidence =
    candidate.durationRefusedInvalidEvidence;
  if (candidate.durationMs != null) {
    survivor.invokedAt = candidate.invokedAt;
  }
  // ISS-7795: telemetry follows the evidence that won. Leaving it on the
  // survivor would keep counts measured for a component the merge just decided
  // this row is NOT — an attribution error, not merely a stale number. A
  // stronger candidate that measured nothing correctly clears it to NULL.
  survivor.model = candidate.model;
  survivor.inputTokens = candidate.inputTokens;
  survivor.outputTokens = candidate.outputTokens;
  survivor.cacheReadTokens = candidate.cacheReadTokens;
  survivor.cacheWriteTokens = candidate.cacheWriteTokens;
  survivor.estimatedCost = candidate.estimatedCost;
  survivor.usageMeasurement = candidate.usageMeasurement;
  // The footprint describes the component the merge just decided this row IS,
  // so it follows the winning evidence for the same reason the counts above do.
  survivor.footprintTokens = candidate.footprintTokens;
  // ISS-10730: line attribution describes the tool call the winning candidate
  // names, so it follows the same winner for the same reason the telemetry
  // above does — keeping the loser's delta would attribute lines to a component
  // this merge just decided the row is not.
  survivor.linesAdded = candidate.linesAdded;
  survivor.linesRemoved = candidate.linesRemoved;
  // ISS-10725: the funnel is an attribution of the WINNING component's output,
  // so it follows the evidence exactly as the telemetry above does. Keeping the
  // loser's counts beside the winner's identity would report one component's
  // findings as another's.
  survivor.findingsEmitted = candidate.findingsEmitted;
  survivor.findingsInvalidated = candidate.findingsInvalidated;
  // ISS-11325: the disposition is a statement ABOUT those counts, so it has to
  // travel with them. Keeping the loser's label beside the winner's pair would
  // say "measured this run" over a carried-forward pair, or "withheld" over a
  // row that plainly holds counts.
  survivor.findingsDisposition = candidate.findingsDisposition;
  // The refusal describes the telemetry above, so it follows the same winner —
  // otherwise the merge keeps the loser's diagnostic beside the winner's values.
  survivor.usageRefusedCorruptCounts = candidate.usageRefusedCorruptCounts;
  survivor.footprintRefusedUnlabelled = candidate.footprintRefusedUnlabelled;
  // ISS-10720: attribution follows the evidence that won, for the same reason
  // the telemetry above does — a source stamped for the component the merge
  // just decided this row is NOT would be an attribution error, not a stale
  // label.
  survivor.attributionSource = candidate.attributionSource;
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
 * silent attribution loss. Required, not optional (whitlockk, #4355): the legacy
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

export type InvocationTelemetryInput = {
  usage: NormalizedComponentUsage | undefined;
  /** ISS-7361: the round-trips `usage` was folded from, when still in hand. */
  usageRecords?: readonly NormalizedTokenRecord[];
  invokedAt: string | null;
  sessionId: string;
};

type InvocationTelemetryColumns = Pick<
  AgentComponentInvocationCandidate,
  | "usageRefusedCorruptCounts"
  | "model"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "estimatedCost"
  | "usageMeasurement"
>;

type InvocationLineColumns = Pick<
  AgentComponentInvocationCandidate,
  "linesAdded" | "linesRemoved"
>;

/** No per-invocation line delta was measured. NULL, never a measured zero. */
export const NO_INVOCATION_LINES: InvocationLineColumns = {
  linesAdded: null,
  linesRemoved: null,
};

/**
 * ISS-10730: project one tool call's `diffDelta` onto the line columns.
 *
 * All-or-nothing, for the same reason {@link invocationTelemetryColumns} is: a
 * delta is a PAIR, so a half-valid one is not a smaller measurement but a
 * corrupt one, and persisting its good half would publish a confident wrong
 * number. `isValidInvocationLineCount` is the SSOT predicate — it rejects the
 * whole impossible set (fractional, non-finite, negative, past the safe-integer
 * ceiling), not just the two halves a comparison would catch, because every one
 * of those reaches this projection: `diffDelta` is reconstructed by three
 * different parsers from transcript JSON, and a worker payload round-trip
 * (`historical-parse-worker-session-schema`) is a trust boundary the in-process
 * types do not constrain.
 *
 * Gated on the kind rather than on the tool NAME: the same cohort the wire
 * boundary admits, so a row this producer legally writes can never be reported
 * by the store-integrity probe as corruption.
 */
export function invocationLineColumns(input: {
  componentKind: InvocationKind;
  diffDelta: { add: number; del: number } | undefined;
}): InvocationLineColumns {
  if (
    !(input.diffDelta && LINE_BEARING_INVOCATION_KINDS.has(input.componentKind))
  ) {
    return NO_INVOCATION_LINES;
  }
  const { add, del } = input.diffDelta;
  if (!(isValidInvocationLineCount(add) && isValidInvocationLineCount(del))) {
    return NO_INVOCATION_LINES;
  }
  return { linesAdded: add, linesRemoved: del };
}

/**
 * ISS-10725: the findings pair as it may be persisted — a complete, admissible
 * funnel, or NULL/NULL.
 *
 * The candidate type cannot express both-or-neither, so this is where that
 * claim is made good: a half-set pair, an inverted one, or a count outside the
 * admissible range is written as "not measured" rather than stored. A
 * partially-corrupt row would otherwise survive here and then be refused by the
 * cloud `.strict()` boundary, which drops the WHOLE part and re-drops it on
 * every retry. The predicate is {@link readStoredAgentComponentFindingsCells}, the
 * same one the read projections use, so writer and reader cannot disagree about
 * which pairs are real.
 */
function persistableFindings(
  candidate: AgentComponentInvocationCandidate
): [number | null, number | null] {
  const result = readStoredAgentComponentFindingsCells(
    candidate.findingsEmitted,
    candidate.findingsInvalidated
  );
  return result.reading === AgentComponentFindingsCellsReading.Measured
    ? [result.funnel.findingsEmitted, result.funnel.findingsInvalidated]
    : [null, null];
}

/**
 * ISS-11325: the disposition as it may be persisted — only when it is a member
 * an ingest may declare AND it agrees with the pair {@link persistableFindings}
 * actually binds.
 *
 * The pair is what the writer may have had to refuse: an inadmissible one is
 * written NULL/NULL, and a `measured-this-run` label surviving beside those NULLs
 * would state that this run measured a funnel the row does not hold. The reverse
 * is the same defect mirrored — a `withheld-*` label beside real counts. Neither
 * is persisted; the refusal itself is already reported by
 * {@link findingsRefusedCorruptPair}.
 */
function persistableFindingsDisposition(
  candidate: AgentComponentInvocationCandidate
): string | null {
  const disposition = candidate.findingsDisposition;
  if (!isAgentComponentFindingsIngestDisposition(disposition)) {
    return null;
  }
  const [emitted] = persistableFindings(candidate);
  return isAgentComponentFindingsDispositionConsistentWithFunnel(
    disposition,
    emitted !== null
  )
    ? disposition
    : null;
}

/**
 * ISS-10725 review (tamsinb): whether this candidate carried findings that
 * could not be persisted.
 *
 * The refusal is the fact {@link persistableFindings} would otherwise destroy:
 * it writes NULL/NULL, and NULL is the value this whole contract spends its
 * docblocks arguing means "nothing ever measured this". Without this predicate
 * an inverted or half-set pair from a buggy attributor lands in the column
 * indistinguishable from a component no attributor ever touched — the same gap
 * `usageRefusedCorruptCounts` exists to close on the telemetry columns.
 */
function findingsRefusedCorruptPair(
  candidate: AgentComponentInvocationCandidate
): boolean {
  return (
    readStoredAgentComponentFindingsCells(
      candidate.findingsEmitted,
      candidate.findingsInvalidated
    ).reading === AgentComponentFindingsCellsReading.Invalid
  );
}

/**
 * ISS-10725: the findings columns of a candidate nothing has attributed a
 * code-review run to.
 *
 * Its own constant rather than a member of {@link NO_INVOCATION_TELEMETRY},
 * because the two are independent populations: a subagent turn can have measured
 * usage and no adjudicated findings, and an invocation can carry a funnel on a
 * lane that measured no tokens. Folding them would make one absence imply the
 * other.
 */
export const NO_INVOCATION_FINDINGS: Pick<
  AgentComponentInvocationCandidate,
  "findingsEmitted" | "findingsInvalidated" | "findingsDisposition"
> = {
  findingsEmitted: null,
  findingsInvalidated: null,
  // ISS-11325: absent, not `withheld-*`. A kind the findings ingest never
  // reaches has no withholding to report, and a row that says it was withheld
  // when nothing was withheld is the disclosure becoming decoration.
  findingsDisposition: null,
};

export const NO_INVOCATION_TELEMETRY: InvocationTelemetryColumns = {
  model: null,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  estimatedCost: null,
  usageMeasurement: null,
};

/**
 * ISS-7795: project measured per-invocation usage onto the telemetry columns.
 *
 * All-or-nothing by construction: with no measurement every column is NULL, so
 * a row can never carry counts without the label that says how they were
 * arrived at — the invariant the wire boundary re-checks as
 * `usage_measurement_requires_telemetry`. `Measured` is the only label this
 * producer emits, because every value it writes is a count the provider itself
 * reported for the turns the harness attributed to that invocation.
 *
 * ISS-7261 adds the money column and one more all-or-nothing case: counts that
 * are not finite and non-negative are corrupt, so the row is written with no
 * telemetry rather than with a partially-valid measurement. `estimatedCost` is
 * independently nullable INSIDE a measured row — real counts the pricing table
 * cannot price are still real counts, and NULL there says "unpriced" where a 0
 * would say "free".
 */
export function invocationTelemetryColumns(
  input: InvocationTelemetryInput
): InvocationTelemetryColumns {
  const { usage } = input;
  if (!usage) {
    return NO_INVOCATION_TELEMETRY;
  }
  if (!areInvocationUsageCountsValid(usage)) {
    return { ...NO_INVOCATION_TELEMETRY, usageRefusedCorruptCounts: true };
  }
  return {
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    estimatedCost: invocationEstimatedCostUsd({
      usage,
      ...(input.usageRecords ? { usageRecords: input.usageRecords } : {}),
      invokedAt: input.invokedAt,
      sessionId: input.sessionId,
    }),
    usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
  };
}

/**
 * ISS-7261: report the measured rows whose counts were too corrupt to persist.
 *
 * Bounded to ONE line per batch, like the dropped-`agent_id` diagnostic: the
 * point is that a collector emitting impossible counts is discoverable at all,
 * not a line per row. Nothing row-identifying is emitted, only the count — a
 * corrupt value must never be echoed into a log.
 */
function reportRefusedCorruptTelemetry(
  sessionId: string,
  rows: readonly AgentComponentInvocationCandidate[],
  log: (message: string) => void
): void {
  const refused = rows.filter((row) => row.usageRefusedCorruptCounts).length;
  if (refused > 0) {
    log(
      `component_invocations ${sessionId}: withheld measured telemetry on ${refused} row(s) whose token counts were not finite and non-negative`
    );
  }
  const refusedFindings = rows.filter(findingsRefusedCorruptPair).length;
  if (refusedFindings > 0) {
    log(
      `component_invocations ${sessionId}: withheld a findings funnel on ${refusedFindings} row(s) whose emitted/invalidated pair was not admissible`
    );
  }
}

/**
 * ISS-10736: fold a resolved footprint into the row's telemetry columns.
 *
 * `usage_measurement` is ONE column and it labels the WHOLE row's telemetry —
 * `hasAgentComponentInvocationTelemetry` counts `footprintTokens` among the
 * fields it describes, and the wire boundary rejects any item carrying telemetry
 * without it (`telemetry_requires_usage_measurement`). A row carrying BOTH
 * populations therefore has two derivations and one column to state them in:
 * ISS-7795's turn counts are `Measured` (the provider reported them) and this
 * footprint is `Estimated` (it is derived from text).
 *
 * WHEN THE TWO DISAGREE THE FOOTPRINT IS WITHHELD, NOT RELABELLED — in either
 * direction. Writing `Measured` would publish a derived number as a measurement.
 * Writing `Estimated` would retroactively demote ISS-7795's provider-reported
 * counts on a shipped read contract, which is a different wrong answer, not a
 * safer one. The genuinely absent operand is a SECOND LABEL: this contract has
 * one column and two populations, so until `footprintMeasurement` exists on
 * `AgentComponentInvocationSyncItem` there is no truthful way to state both.
 * That is named rather than silently swallowed — `footprintRefusedUnlabelled`
 * is reported by {@link reportWithheldFootprints} exactly as a refused corrupt
 * count is, so the NULL stays distinguishable from "nothing computed one".
 *
 * Measured 2026-09-23 on the local desktop corpus: 3,589 of 461,011 rows (0.78%)
 * carry a measured turn label, so this withholds the footprint on under 1% of
 * rows and publishes it on the rest.
 */
export function invocationFootprintColumns(input: {
  footprint: AgentComponentFootprint | undefined;
  telemetry: Pick<InvocationTelemetryColumns, "usageMeasurement">;
}): Pick<
  AgentComponentInvocationCandidate,
  "footprintTokens" | "usageMeasurement"
> &
  Pick<AgentComponentInvocationCandidate, "footprintRefusedUnlabelled"> {
  const { usageMeasurement } = input.telemetry;
  if (!input.footprint) {
    return { footprintTokens: null, usageMeasurement };
  }
  if (
    usageMeasurement !== null &&
    usageMeasurement !== input.footprint.usageMeasurement
  ) {
    return {
      footprintTokens: null,
      usageMeasurement,
      footprintRefusedUnlabelled: true,
    };
  }
  return {
    footprintTokens: input.footprint.footprintTokens,
    usageMeasurement: input.footprint.usageMeasurement,
  };
}

/**
 * ISS-10736: report the footprints withheld because the row's single
 * `usage_measurement` column was already spoken for by a different derivation.
 *
 * Required, not optional, for the same reason the corrupt-count reporter is: a
 * stored NULL is otherwise indistinguishable from "nothing ever computed one",
 * which is the very distinction this whole telemetry label exists to keep.
 */
function reportWithheldFootprints(
  sessionId: string,
  rows: readonly AgentComponentInvocationCandidate[],
  log: (message: string) => void
): void {
  const withheld = rows.filter((row) => row.footprintRefusedUnlabelled).length;
  if (withheld > 0) {
    log(
      `component_invocations ${sessionId}: withheld context footprint on ${withheld} row(s) whose usage_measurement column already states a different derivation`
    );
  }
}

export function compareCandidates(
  left: AgentComponentInvocationCandidate,
  right: AgentComponentInvocationCandidate
): number {
  const leftTs = left.invokedAt ?? "";
  const rightTs = right.invokedAt ?? "";
  const byTimestamp = leftTs.localeCompare(rightTs);
  return byTimestamp === 0 ? left.sourceOrder - right.sourceOrder : byTimestamp;
}

/** ISS-10713: one line per batch, counts only, like the corrupt-count reporter. */
function reportRefusedInvocationTimings(
  sessionId: string,
  rows: readonly AgentComponentInvocationCandidate[],
  log: (message: string) => void
): void {
  const refused = rows.filter(
    (row) => row.durationRefusedInvalidEvidence
  ).length;
  if (refused > 0) {
    log(
      `component_invocations ${sessionId}: withheld measured duration on ${refused} row(s) whose call/result timestamps were unreadable or out of order`
    );
  }
}
