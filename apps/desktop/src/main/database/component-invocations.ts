/**
 * Durable Desktop runtime-component invocation materialization (FEA-3294).
 *
 * The normalized transcript is the authoritative complete set. A session
 * import replaces that set transactionally, but evidence already frozen for a
 * stable external invocation id is monotonic: collector evidence can upgrade
 * an unresolved row and transcript evidence can upgrade collector evidence;
 * neither can be weakened or silently reinterpreted on a later import.
 */
import {
  AgentComponentInvocationAnchorKind,
  type AgentComponentInvocationCompleteGeneration,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import type {
  Harness,
  NormalizedSession,
  NormalizedToolUse,
} from "@repo/lib/harness/types";
import { OutboxStatus } from "../../shared/sync-lane-contract.js";
import { AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY } from "../agent-sync/agent-component-invocation-sync-constants.js";
import { computeAgentComponentInvocationGenerationId } from "../agent-sync/agent-component-invocation-sync-payload.js";
import { dataRevisionFor } from "../collectors/engine/data-revision.js";
import type { ParsePolicy } from "../parse-policy/parse-policy.js";
import {
  applyArtifactLinkAttribution,
  loadInvocationArtifactAttributions,
} from "./component-invocation-artifact-link-attribution.js";
import {
  agentIdForTool,
  buildToolCandidateContext,
  parentAgentIdFor,
  parentAgentIdForTool,
  relationshipForTool,
  type ToolCandidateContext,
} from "./component-invocation-candidate-context.js";
import { commandCandidates } from "./component-invocation-command-candidates.js";
import {
  measuredToolInvocationTiming,
  omitAmbiguousInvocationTimings,
  stampInvocationDurations,
} from "./component-invocation-duration.js";
import {
  reportFindingsAttribution,
  stampCodeReviewFindingsOnCandidates,
} from "./component-invocation-findings-attribution.js";
import {
  storedResultPayloadFootprint,
  withCandidateFootprint,
} from "./component-invocation-footprint-sources.js";
import { hookCandidates } from "./component-invocation-hook-candidates.js";
import {
  preserveStrongerEvidence,
  readPriorEvidence,
  restoreStableInvocationIdentities,
  restoreStoredTimingAmbiguity,
} from "./component-invocation-identity-restore.js";
import {
  ensureInvocationComponents,
  ensureInvocationVersions,
} from "./component-invocation-inventory-writes.js";
import {
  asRecord,
  parseRecord,
  stringValue,
} from "./component-invocation-json.js";
import {
  reportInvocationLineReconciliation,
  storedDiffDelta,
} from "./component-invocation-line-reconciliation.js";
import {
  baseCandidate,
  classifyToolInvocationKind,
  markdownCandidate,
} from "./component-invocation-markdown-candidate.js";
import { relinkInvocationRows } from "./component-invocation-relink.js";
import {
  type AgentComponentInvocationCandidate,
  compareCandidates,
  insertInvocationRows,
} from "./component-invocation-row-writer.js";
import {
  type SkillShadowSkillOccurrence,
  skillShadowSkillOccurrences,
} from "./component-invocation-skill-shadow.js";
import {
  applyStoredSpawnClaimKeys,
  priorResolvedCommandKeys,
  storedAgentCandidates,
  storedBaseCandidate,
  storedCommandCandidates,
} from "./component-invocation-stored-candidates.js";
import {
  classifyStoredTool,
  storedProviderToolUseId,
} from "./component-invocation-stored-event-fields.js";
import {
  parserSubagentCandidates,
  spawnedSubagentCandidates,
} from "./component-invocation-subagent-candidates.js";
import {
  readStoredInvocationRows,
  storedRowToSyncItem,
} from "./component-invocation-sync-item.js";
import { collectToolCandidates } from "./component-invocation-tool-candidates.js";
import { undeliverableInvocationSetId } from "./component-invocation-undeliverable-id.js";
import { rebuildAgentComponentSessionUsageFromInvocations } from "./component-session-usage-rollup.js";
import { toolInvocationPredicate } from "./db-helpers.js";
import { deterministicEventId } from "./deterministic-event-id.js";
import type { Prisma } from "./generated/client.js";
import { buildInvocationSyncParts } from "./invocation-sync-parts-builder.js";
import { bumpInvocationSyncTemplateRevision } from "./invocation-sync-template-revision.js";
import { stampOtelAttributionOnCandidates } from "./otel-seeded-invocation-candidate.js";
import { advanceSessionSyncWatermark } from "./session-sync-watermark.js";
import { DELEGATION_TOOL_NAMES } from "./subagent-dedup.js";
import {
  storedToolResultSucceeded,
  toolUseSucceeded,
} from "./tool-result-outcome.js";

/**
 * Local-only queue identity. Authentication selects the compute target when
 * the sync service drains these rows; persistence never invents cloud ids.
 */
export type InvocationKind =
  (typeof AgentComponentInvocationKind)[keyof typeof AgentComponentInvocationKind];

type StoredSessionFreshnessRow = {
  id: string;
  updated_at: string;
  data_revision: number;
};

/** Build the canonical, database-independent complete invocation set. */
export function deriveAgentComponentInvocationCandidates(
  session: NormalizedSession,
  mainAgentId: string,
  now: string,
  harness: Harness | null = null,
  policy?: ParsePolicy
): AgentComponentInvocationCandidate[] {
  const context = buildToolCandidateContext(
    session,
    mainAgentId,
    now,
    harness,
    policy
  );
  const spawned = spawnedSubagentCandidates(context, markdownCandidate);
  // ISS-4810: the Skill rows this derivation emits are the suppression
  // population `commandCandidates` correlates slash invocations against, so
  // build them once and hand over their occurrences rather than re-reading the
  // raw parser lists (which double-count a skill described by BOTH
  // `session.skills` and a legacy `Skill` tool_use).
  const skills = skillCandidates(context);
  const candidates = [
    ...toolCandidates(context),
    ...skills.candidates,
    ...commandCandidates(context, markdownCandidate, skills.shadowOccurrences),
    ...hookCandidates(context, markdownCandidate),
    ...spawned.candidates,
    ...parserSubagentCandidates(
      context,
      markdownCandidate,
      spawned.representedSubagentIds
    ),
  ];
  stampInvocationDurations(session, candidates);
  candidates.sort(compareCandidates);
  for (const [sequence, candidate] of candidates.entries()) {
    candidate.sequence = sequence;
    // Harness branch fields describe the session CWD and are not attribution
    // evidence for worktree flows. The transactional materializer replaces
    // these nulls only from created session_artifact_links below.
    candidate.gitBranch = null;
    candidate.repositoryFullName = null;
  }
  const deduped = dedupeCandidates(candidates);
  linkSubagentParentExternalInvocations(deduped);
  return deduped;
}

function toolCandidates(
  context: ToolCandidateContext
): AgentComponentInvocationCandidate[] {
  return collectToolCandidates(
    context.session,
    (toolUse, sourceOrder) =>
      toolInvocationCandidate(toolUse, sourceOrder, sourceOrder, context),
    context.parsePolicy
  );
}

/**
 * ISS-4810: emits one `shadowOccurrence` per emitted Skill candidate, recorded
 * HERE so the skill-shadow correlation population is the deduped surviving Skill
 * set by construction. It cannot be recovered from the candidates afterwards: a
 * legacy `Skill` tool_use keys its candidate off `normalizedName` (the TOOL
 * identity, e.g. `"Skill"`) while the command it shadows carries the skill's own
 * name.
 */
function skillCandidates(context: ToolCandidateContext): {
  candidates: AgentComponentInvocationCandidate[];
  shadowOccurrences: SkillShadowSkillOccurrence[];
} {
  const candidates: AgentComponentInvocationCandidate[] = [];
  const shadowOccurrences: SkillShadowSkillOccurrence[] = [];
  const seenIds = new Set<string>();
  for (const [index, skill] of (context.session.skills ?? []).entries()) {
    const externalInvocationId =
      skill.providerToolUseId ??
      `skill:${index}:${skill.timestamp ?? "unknown"}:${skill.name}`;
    seenIds.add(externalInvocationId);
    const candidate = skillCandidate(
      context,
      skill,
      index,
      externalInvocationId
    );
    candidates.push(candidate);
    shadowOccurrences.push({
      bareName: skill.normalizedName ?? skill.name,
      invokedAt: skill.timestamp,
      // Read back off the emitted candidate so ownership can never drift from
      // the row it describes: a subagent-invoked skill carries a parent agent.
      subagent: candidate.parentAgentId !== null,
    });
  }
  appendLegacySkillToolCandidates(
    context,
    candidates,
    seenIds,
    shadowOccurrences
  );
  return { candidates, shadowOccurrences };
}

function skillCandidate(
  context: ToolCandidateContext,
  skill: NormalizedSession["skills"][number],
  index: number,
  externalInvocationId: string
): AgentComponentInvocationCandidate {
  const { session, mainAgentId, now } = context;
  const subagentId = skill.subagentId ?? null;
  const hasSubagent = subagentId !== null;
  const toolUseIndex = skillToolUseIndex(session, index);
  const timestampOrdinal =
    skill.timestamp && toolUseIndex !== null
      ? toolTimestampOrdinal(session, toolUseIndex)
      : null;
  const anchor = invocationEventAnchor({
    session,
    timestamp: skill.timestamp,
    providerId: skill.providerToolUseId ?? null,
    timestampOrdinal,
    eventType: "PostToolUse",
    toolName: "Skill",
  });
  return markdownCandidate({
    session,
    mainAgentId,
    externalInvocationId,
    externalSourceId: skill.providerToolUseId ?? null,
    providerToolUseId: skill.providerToolUseId ?? null,
    componentKind: AgentComponentInvocationKind.Skill,
    componentKey: skill.normalizedName ?? skill.name,
    rawName: skill.rawName ?? skill.name,
    normalizedName: skill.normalizedName ?? skill.name,
    invokedAt: skill.timestamp,
    sourceOrder: 100_000 + index,
    agentId: hasSubagent
      ? (context.parserAgentIdById.get(subagentId) ?? mainAgentId)
      : mainAgentId,
    parentAgentId: hasSubagent
      ? parentAgentIdFor(session, subagentId, mainAgentId)
      : null,
    relationship: hasSubagent
      ? AgentComponentInvocationRelationship.Associated
      : AgentComponentInvocationRelationship.Direct,
    anchorKind: anchor.anchorKind,
    anchorValue: anchor.anchorValue,
    snapshot: skill.definitionSnapshot,
    ...(skill.usage ? { usage: skill.usage } : {}),
    focusedEvidence: context.evidenceByInvocationId.get(externalInvocationId),
    externalAgentId: hasSubagent
      ? (context.externalAgentIdById.get(subagentId) ?? subagentId)
      : null,
    parentExternalInvocationId: null,
    now,
  });
}

function appendLegacySkillToolCandidates(
  context: ToolCandidateContext,
  candidates: AgentComponentInvocationCandidate[],
  seenIds: ReadonlySet<string>,
  shadowOccurrences: SkillShadowSkillOccurrence[]
): void {
  const { session } = context;
  for (const [index, toolUse] of (session.toolUses ?? []).entries()) {
    if (!(toolUse.name === "Skill" && toolUse.skillName)) {
      continue;
    }
    const externalInvocationId =
      toolUse.providerToolUseId ??
      toolUse.id ??
      `skill:${index}:${toolUse.timestamp ?? "unknown"}:${toolUse.skillName}`;
    if (seenIds.has(externalInvocationId)) {
      continue;
    }
    const candidate = legacySkillToolCandidate(
      context,
      toolUse,
      index,
      externalInvocationId
    );
    candidates.push(candidate);
    // ISS-4810: the skill's OWN identity, not this candidate's componentKey —
    // a legacy tool_use keys that off `normalizedName` ("Skill").
    shadowOccurrences.push({
      bareName: toolUse.skillName,
      invokedAt: toolUse.timestamp,
      subagent: candidate.parentAgentId !== null,
    });
  }
}

function legacySkillToolCandidate(
  context: ToolCandidateContext,
  toolUse: NormalizedToolUse,
  index: number,
  externalInvocationId: string
): AgentComponentInvocationCandidate {
  const { session, mainAgentId, now } = context;
  const skillName = toolUse.skillName ?? toolUse.name;
  const providerId = toolUse.providerToolUseId ?? toolUse.id ?? null;
  const anchor = invocationEventAnchor({
    session,
    timestamp: toolUse.timestamp,
    providerId,
    timestampOrdinal: toolTimestampOrdinal(session, index),
    eventType: "PostToolUse",
    toolName: "Skill",
  });
  return markdownCandidate({
    session,
    mainAgentId,
    externalInvocationId,
    externalSourceId: toolUse.providerToolUseId ?? toolUse.id ?? null,
    providerToolUseId: toolUse.providerToolUseId ?? toolUse.id ?? null,
    componentKind: AgentComponentInvocationKind.Skill,
    componentKey: toolUse.normalizedName ?? skillName,
    rawName: toolUse.rawName ?? skillName,
    normalizedName: toolUse.normalizedName ?? skillName,
    invokedAt: toolUse.timestamp,
    sourceOrder: 150_000 + index,
    agentId: agentIdForTool(toolUse, context),
    parentAgentId: parentAgentIdForTool(toolUse, context),
    relationship: relationshipForTool(toolUse),
    anchorKind: anchor.anchorKind,
    anchorValue: anchor.anchorValue,
    snapshot: toolUse.definitionSnapshot,
    focusedEvidence: context.evidenceByInvocationId.get(externalInvocationId),
    externalAgentId:
      toolUse.subagentId == null
        ? null
        : (context.externalAgentIdById.get(toolUse.subagentId) ??
          toolUse.subagentId),
    parentExternalInvocationId: null,
    now,
  });
}

/**
 * Replace one session's complete invocation set and queue its exact parts.
 *
 * Returns whether the COMPLETE-set identity changed, so the import pipeline can
 * advance the sync watermark (ISS-5801, whitlockk on #6166): a deriver upgrade can
 * change the invocation set of a session whose synced payload is byte-identical
 * (`sessionDataChanged` false), and without a watermark bump a previously
 * withheld parent stays behind the incremental cursor while this function has
 * queued its children — which then terminally reject with `session_missing`.
 */
export async function materializeAgentComponentInvocations(
  tx: Prisma.TransactionClient,
  session: NormalizedSession,
  mainAgentId: string,
  now: string,
  harness: Harness,
  /* ISS-5098: REQUIRED so the row writer REPORTS an agent reference it had to drop
     (nullUnresolvableAgentReferences) instead of silently losing the attribution;
     optional would re-open the silent path `insertInvocationRows` forbids (whitlockk,
     #4355). The only caller passes the required `ImportSessionContext.log`. */
  log: (message: string) => void,
  parsePolicy: ParsePolicy
): Promise<{ invocationSetChanged: boolean }> {
  const before = await loadAgentComponentInvocationCompleteGeneration(
    tx,
    session.sessionId
  );
  const candidates = deriveAgentComponentInvocationCandidates(
    session,
    mainAgentId,
    now,
    harness,
    parsePolicy
  );
  applyArtifactLinkAttribution(
    candidates,
    await loadInvocationArtifactAttributions(tx, session.sessionId)
  );
  const priorRows = await readPriorEvidence(tx, session.sessionId);
  restoreStableInvocationIdentities(candidates, priorRows);
  linkSubagentParentExternalInvocations(candidates);
  const priorById = new Map(
    priorRows.map((row) => [row.external_invocation_id, row])
  );
  for (const candidate of candidates) {
    preserveStrongerEvidence(
      candidate,
      priorById.get(candidate.externalInvocationId)
    );
  }

  /* ISS-10720: the harness's own OTel attribution is the LAST word on which
     source named the component, so it lands after `preserveStrongerEvidence`
     and before the rows are written — the generation hash computed below then
     includes it and the stamp reaches the cloud on the ordinary changed path. */
  await stampOtelAttributionOnCandidates(
    tx,
    session.sessionId,
    candidates,
    now,
    log
  );
  /* ISS-11238: the code-review findings funnel is attributed from the run
     envelopes on disk, so it lands after every candidate exists — including the
     rows the OTel join above may have seated — and before the insert, so the
     persisted row carries it and the generation hash below includes it. */
  reportFindingsAttribution(
    session.sessionId,
    await stampCodeReviewFindingsOnCandidates(session, candidates),
    log
  );
  await ensureInvocationComponents(tx, candidates, now, log);
  await ensureInvocationVersions(tx, candidates, now);
  await tx.$executeRawUnsafe(
    "DELETE FROM agent_component_invocations WHERE session_id = $1",
    session.sessionId
  );
  await insertInvocationRows(tx, session.sessionId, candidates, log);
  reportInvocationLineReconciliation(session, candidates, log);
  await relinkInvocationRows(tx, [session.sessionId]);
  /* ISS-4572: the outbox records the DERIVATION revision of the invocation set
     (the import's revision), not the session row's transient gate value: the
     isolated import stamps DATA_REVISION_IMPORT_PENDING at the gate and seals the
     real revision later, so reading `data_revision` off the row would leak that
     sentinel into the outbox `data_revision`/`part_hash`/payload, and the seal
     does not re-derive the outbox (the generation id is revision-independent). */
  await enqueueInvocationGeneration(tx, session.sessionId, now, {
    dataRevision: dataRevisionFor(parsePolicy),
  });
  const after = await loadAgentComponentInvocationCompleteGeneration(
    tx,
    session.sessionId
  );
  // Content-hash identity (revision-independent), the same change detector the
  // stored-row rebuild uses — a byte-identical re-derivation reports unchanged,
  // so re-imports do not re-sync the whole corpus.
  return {
    invocationSetChanged:
      before?.externalGenerationId !== after?.externalGenerationId,
  };
}

/**
 * Bootstrap invocation rows for legacy/stored-only sessions. This never reads
 * current definition files and therefore never mints version evidence.
 */
export async function ensureStoredAgentComponentInvocations(
  tx: Prisma.TransactionClient,
  sessionIds: string[],
  now: string,
  /* ISS-5098: REQUIRED so this legacy-bootstrap path REPORTS a dropped agent
     reference like the import path does — `insertInvocationRows` requires it.
     This is one of the two paths whitlockk (#4355) named: it builds candidates from
     `events.agent_id`, the column with no FK, so it is the likeliest to drop. */
  log: (message: string) => void
): Promise<void> {
  for (const sessionId of sessionIds) {
    const countRows = await tx.$queryRawUnsafe<{ n: number }[]>(
      "SELECT COUNT(*) AS n FROM agent_component_invocations WHERE session_id = $1",
      sessionId
    );
    if (Number(countRows[0]?.n ?? 0) > 0) {
      continue;
    }
    // This branch only runs when the session has ZERO invocation rows, so there
    // is no prior definition evidence to consult — the empty set is a fact, not
    // a shortcut.
    const candidates = await storedCandidates(tx, sessionId, now, new Set());
    /* ISS-10720 (tamsinb, codex on #7731): the THIRD write path, and it needs
       the stamp for the same reason the other two do. Without it a legacy
       bootstrap writes every row with `attribution_source` NULL, and because
       this pass skips any session that already has invocation rows, nothing
       re-derives it until some later rebuild happens to run on that session —
       so the harness's attribution would be absent indefinitely on exactly the
       sessions that have no transcript left to re-import. */
    await stampOtelAttributionOnCandidates(tx, sessionId, candidates, now, log);
    await ensureInvocationComponents(tx, candidates, now, log);
    await insertInvocationRows(tx, sessionId, candidates, log);
    await relinkInvocationRows(tx, [sessionId]);
  }
}

/**
 * Atomically rebuild one missing-source session from durable local rows only.
 * The caller supplies a transaction; the revision stamp is deliberately the
 * final statement so any candidate, aggregate, or outbox failure rolls the
 * whole reconstruction back and leaves the session retryable.
 */
export async function rebuildAgentComponentInvocationsFromStoredRows(
  tx: Prisma.TransactionClient,
  sessionId: string,
  targetDataRevision: number,
  now: string,
  /* ISS-5098: REQUIRED so this stored-row rebuild REPORTS a dropped agent
     reference like the import path does — `insertInvocationRows` requires it.
     The second of the two paths whitlockk (#4355) named; it too builds from
     `events.agent_id`, so an omittable reporter would have gone quiet here. */
  log: (message: string) => void
): Promise<{ invocationSetChanged: boolean }> {
  const before = await loadAgentComponentInvocationCompleteGeneration(
    tx,
    sessionId
  );
  // whitlockk (#4255): prior evidence must be read BEFORE the candidates are built.
  // Skill-shadow suppression runs inside `storedCandidates`, so a genuine
  // command proved by an earlier exact-evidence row has to be known at that
  // point — restoring it afterwards is impossible once the candidate is gone.
  const priorRows = await readPriorEvidence(tx, sessionId);
  const candidates = await storedCandidates(
    tx,
    sessionId,
    now,
    priorResolvedCommandKeys(priorRows)
  );
  restoreStableInvocationIdentities(candidates, priorRows);
  restoreStoredTimingAmbiguity(candidates, priorRows);
  linkSubagentParentExternalInvocations(candidates);
  const priorById = new Map(
    priorRows.map((row) => [row.external_invocation_id, row])
  );
  for (const candidate of candidates) {
    preserveStrongerEvidence(
      candidate,
      priorById.get(candidate.externalInvocationId)
    );
  }
  await stampOtelAttributionOnCandidates(tx, sessionId, candidates, now, log);
  await ensureInvocationComponents(tx, candidates, now, log);
  await ensureInvocationVersions(tx, candidates, now);
  await tx.$executeRawUnsafe(
    "DELETE FROM agent_component_invocations WHERE session_id = $1",
    sessionId
  );
  await insertInvocationRows(tx, sessionId, candidates, log);
  await relinkInvocationRows(tx, [sessionId]);
  await rebuildAgentComponentSessionUsageFromInvocations(tx, [sessionId]);
  const after = await loadAgentComponentInvocationCompleteGeneration(
    tx,
    sessionId
  );
  const invocationSetChanged =
    before?.externalGenerationId !== after?.externalGenerationId;
  if (invocationSetChanged) {
    await advanceSessionSyncWatermark(tx, sessionId, now);
    await enqueueInvocationGeneration(tx, sessionId, now, {
      dataRevision: targetDataRevision,
    });
  }
  await tx.$executeRawUnsafe(
    "UPDATE sessions SET data_revision = $1 WHERE id = $2",
    targetDataRevision,
    sessionId
  );
  return { invocationSetChanged };
}

/** Clone-safe complete generation projection used by the dedicated sync lane. */
export async function loadAgentComponentInvocationCompleteGeneration(
  tx: Pick<Prisma.TransactionClient, "$queryRawUnsafe">,
  sessionId: string,
  sourceSequence = 0
): Promise<AgentComponentInvocationCompleteGeneration | null> {
  const sessions = await tx.$queryRawUnsafe<StoredSessionFreshnessRow[]>(
    "SELECT id, updated_at, data_revision FROM sessions WHERE id = $1",
    sessionId
  );
  const session = sessions[0];
  if (!session) {
    return null;
  }
  const rows = await readStoredInvocationRows(tx, sessionId);
  const items = rows.map(storedRowToSyncItem);
  let externalGenerationId: string;
  try {
    externalGenerationId = computeAgentComponentInvocationGenerationId(
      sessionId,
      items
    );
  } catch (error) {
    externalGenerationId = undeliverableInvocationSetId(
      error,
      sessionId,
      items
    );
  }
  return {
    externalSessionId: sessionId,
    externalGenerationId,
    sourceUpdatedAt: session.updated_at,
    dataRevision: Number(session.data_revision),
    sourceSequence,
    items,
  };
}

/* ISS-10720: exported for `otel-invocation-attribution-refresh.ts`, which
   re-stamps stored rows when a cost export lands after the import that derived
   them and must re-enqueue exactly the same way this file's own writers do. */
export async function enqueueInvocationGeneration(
  tx: Prisma.TransactionClient,
  sessionId: string,
  now: string,
  freshnessOverride?: { dataRevision: number }
): Promise<void> {
  const cursors = await tx.$queryRawUnsafe<
    { external_generation_id: string; source_sequence: number }[]
  >(
    `SELECT external_generation_id, source_sequence
       FROM agent_component_invocation_sync_cursors
      WHERE source_key = $1 AND external_session_id = $2
      LIMIT 1`,
    AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
    sessionId
  );
  const cursor = cursors[0];
  const nextSequence = Number(cursor?.source_sequence ?? -1) + 1;
  const projected = await loadAgentComponentInvocationCompleteGeneration(
    tx,
    sessionId,
    nextSequence
  );
  const generation =
    projected && freshnessOverride
      ? { ...projected, ...freshnessOverride }
      : projected;
  if (
    !generation ||
    cursor?.external_generation_id === generation.externalGenerationId
  ) {
    return;
  }
  // This source key is a local latest-generation template, not a delivery
  // queue. Target-scoped queues clone it below, so superseded template parts
  // can be replaced atomically without affecting any target's pending rows.
  await tx.$executeRawUnsafe(
    `DELETE FROM agent_component_invocation_sync_outbox
      WHERE source_key = $1 AND external_session_id = $2`,
    AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
    sessionId
  );
  const { parts, localError, localErrorDetail } =
    buildInvocationSyncParts(generation);
  if (localError) {
    await tx.$executeRawUnsafe(
      `INSERT INTO agent_component_invocation_sync_outbox
         (source_key, external_session_id, external_generation_id, part_index,
          part_count, part_hash, source_updated_at, data_revision,
          source_sequence, payload, status, attempt_count, next_attempt_at,
          last_error, created_at, updated_at)
       VALUES ($1, $2, $3, 0, 1, $3, $4, $5, $6, $7, $8, 0, NULL,
               $9, $10, $10)`,
      AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
      sessionId,
      generation.externalGenerationId,
      generation.sourceUpdatedAt,
      generation.dataRevision,
      generation.sourceSequence,
      JSON.stringify({
        error: localError,
        ...(localErrorDetail ? { detail: localErrorDetail } : {}),
        itemCount: generation.items.length,
      }),
      OutboxStatus.DeadLettered,
      localError,
      now
    );
  } else {
    for (const part of parts) {
      await tx.$executeRawUnsafe(
        `INSERT INTO agent_component_invocation_sync_outbox
           (source_key, external_session_id, external_generation_id, part_index,
            part_count, part_hash, source_updated_at, data_revision,
            source_sequence, payload, status, attempt_count, pending_since,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $12, $12)
         ON CONFLICT (source_key, external_session_id, external_generation_id, part_index)
         DO NOTHING`,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        sessionId,
        part.externalGenerationId,
        part.partIndex,
        part.partCount,
        part.partHash,
        part.sourceUpdatedAt,
        part.dataRevision,
        part.sourceSequence,
        JSON.stringify(part),
        OutboxStatus.Pending,
        now
      );
    }
  }
  await tx.$executeRawUnsafe(
    `INSERT INTO agent_component_invocation_sync_cursors
       (source_key, external_session_id, external_generation_id,
        source_sequence, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source_key, external_session_id) DO UPDATE SET
       external_generation_id = excluded.external_generation_id,
       source_sequence = excluded.source_sequence,
       updated_at = excluded.updated_at`,
    AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
    sessionId,
    generation.externalGenerationId,
    generation.sourceSequence,
    now
  );
  await bumpInvocationSyncTemplateRevision(tx, now);
}

function toolInvocationCandidate(
  toolUse: NormalizedToolUse,
  index: number,
  sourceOrder: number,
  context: ToolCandidateContext
): AgentComponentInvocationCandidate {
  const { session, now } = context;
  const providerId = toolUse.providerToolUseId ?? toolUse.id ?? null;
  const externalInvocationId =
    providerId ??
    `tool:${index}:${toolUse.timestamp ?? "unknown"}:${toolUse.name}`;
  const isMcp = toolUse.kind === "mcp" || toolUse.name.startsWith("mcp__");
  const componentKind = classifyToolInvocationKind(toolUse, isMcp);
  const componentKey = isMcp
    ? (toolUse.mcpServer ?? toolUse.name)
    : (toolUse.normalizedName ?? toolUse.name);
  const timestamp = toolUse.timestamp;
  const eventType =
    toolUse.name === "Agent" || toolUse.name === "Task"
      ? "PreToolUse"
      : "PostToolUse";
  const anchor = invocationEventAnchor({
    session,
    timestamp,
    providerId,
    timestampOrdinal: toolTimestampOrdinal(session, index),
    eventType,
    toolName: toolUse.name,
  });
  return baseCandidate({
    session,
    externalInvocationId,
    externalSourceId: providerId,
    componentKind,
    componentKey,
    rawName: toolUse.rawName ?? toolUse.name,
    normalizedName: toolUse.normalizedName ?? toolUse.name,
    invokedAt: toolUse.timestamp,
    ...(providerId === null
      ? measuredToolInvocationTiming(
          componentKind,
          toolUse.timestamp,
          toolUse.resultTimestamp
        )
      : {}),
    sourceOrder,
    agentId: agentIdForTool(toolUse, context),
    parentAgentId: parentAgentIdForTool(toolUse, context),
    relationship: relationshipForTool(toolUse),
    anchorKind: anchor.anchorKind,
    anchorValue: anchor.anchorValue,
    providerToolUseId: providerId,
    succeeded: toolUseSucceeded(toolUse, context.harness),
    // ISS-10730: the lines this call changed. `baseCandidate` gates the value on
    // the resolved `componentKind` and on the SSOT validity predicate, so a
    // `Skill`-shadow or hook candidate can never pick one up here.
    ...(toolUse.diffDelta ? { diffDelta: toolUse.diffDelta } : {}),
    evidencePointer:
      toolUse.subagentId == null
        ? null
        : {
            externalAgentId:
              context.externalAgentIdById.get(toolUse.subagentId) ??
              toolUse.subagentId,
          },
    // ISS-10736: the result payload this call injected, counted at parse time
    // over the untruncated text (`NormalizedToolUse.outputFootprintTokens`).
    // Absent when the parser saw no result — a call whose result never arrived
    // injected nothing we measured, which is not the same fact as zero.
    //
    // A DELEGATING call is the exception and carries none. `Task`/`Agent` yields
    // BOTH this `tool` row and a `subagent` row built from the very same
    // `outputFootprintTokens`, because the delegating call's result IS the text
    // the subagent returned. `subagent` is the kind whose declared source is
    // that returned text, so it owns the count; putting it on both rows would
    // double every delegation in the first per-session footprint aggregate.
    //
    // Gated on `DELEGATION_TOOL_NAMES` — the set the PAIRING reads — and not on
    // a second set of the same names (tamsinb review). What makes skipping
    // safe here is that a `subagent` row exists to own the count, and that is
    // decided by the pairing's set alone. Two sets agree today; the day one
    // gains a name the other lacks, the double count returns with no failure.
    ...(DELEGATION_TOOL_NAMES.has(toolUse.name)
      ? {}
      : withCandidateFootprint(toolUse.outputFootprintTokens)),
    now,
  });
}

function linkSubagentParentExternalInvocations(
  candidates: AgentComponentInvocationCandidate[]
): void {
  const externalInvocationIdByAgentId = new Map(
    candidates.flatMap((candidate) => {
      if (
        candidate.componentKind !== AgentComponentInvocationKind.Subagent ||
        !candidate.agentId
      ) {
        return [];
      }
      return [[candidate.agentId, candidate.externalInvocationId] as const];
    })
  );
  for (const candidate of candidates) {
    if (candidate.componentKind !== AgentComponentInvocationKind.Subagent) {
      continue;
    }
    const parentExternalInvocationId = candidate.parentAgentId
      ? externalInvocationIdByAgentId.get(candidate.parentAgentId)
      : undefined;
    if (!parentExternalInvocationId) {
      continue;
    }
    candidate.evidencePointer = {
      ...(candidate.evidencePointer ?? {}),
      parentExternalInvocationId,
    };
  }
}

async function storedCandidates(
  tx: Prisma.TransactionClient,
  sessionId: string,
  now: string,
  priorResolvedCommandKeys: ReadonlySet<string>
): Promise<AgentComponentInvocationCandidate[]> {
  const sessionRows = await tx.$queryRawUnsafe<
    { metadata: string | null; harness: string | null }[]
  >("SELECT metadata, harness FROM sessions WHERE id = $1", sessionId);
  const sessionRow = sessionRows[0];
  if (!sessionRow) {
    return [];
  }
  // ISS-4811: the stored event candidates carry this session's Skill rows, so
  // the same per-occurrence shadow correlation the transcript-reparse path runs
  // applies here — otherwise a session whose transcript is gone keeps the
  // phantom Command and its Skill/Command split diverges from an otherwise
  // identical session that could be reparsed.
  const storedEvents = await storedEventCandidates(
    tx,
    sessionId,
    sessionRow,
    null,
    now
  );
  const storedSubagents = await storedAgentCandidates(
    tx,
    sessionId,
    null,
    null,
    now
  );
  // ISS-5099 (whitlockk review): recover each subagent's delegation from the
  // durable spawn events BEFORE `restoreStableInvocationIdentities` runs, so a
  // session sealed with the pre-fix mispair re-derives the correct pairing
  // instead of having the stored — wrong — one copied back over it and frozen.
  applyStoredSpawnClaimKeys(
    storedSubagents,
    storedEvents,
    DELEGATION_TOOL_NAMES
  );
  const candidates = [
    ...storedEvents,
    ...storedSubagents,
    ...(await storedCommandCandidates({
      tx,
      sessionId,
      metadata: sessionRow.metadata,
      gitBranch: null,
      repositoryFullName: null,
      now,
      skillOccurrences: skillShadowSkillOccurrences(storedEvents),
      priorResolvedCommandKeys,
    })),
  ];
  applyArtifactLinkAttribution(
    candidates,
    await loadInvocationArtifactAttributions(tx, sessionId)
  );
  candidates.sort(compareCandidates);
  for (const [sequence, candidate] of candidates.entries()) {
    candidate.sequence = sequence;
  }
  const deduped = dedupeCandidates(candidates);
  linkSubagentParentExternalInvocations(deduped);
  return deduped;
}

async function storedEventCandidates(
  tx: Prisma.TransactionClient,
  sessionId: string,
  sessionRow: { metadata: string | null; harness: string | null },
  repositoryFullName: string | null,
  now: string
): Promise<AgentComponentInvocationCandidate[]> {
  const [rows, agentRows] = await Promise.all([
    tx.$queryRawUnsafe<StoredEventRow[]>(
      // ISS-5493 (whitlockk review): the same one definition the tool-count reads
      // use. `IS NOT NULL` alone let an empty hook `tool_name` through here and
      // materialized it as a Tool component with an empty `component_key` —
      // a row analytics drops but the inventory kept.
      `SELECT id, agent_id, tool_name, data, created_at
         FROM events
        WHERE session_id = $1 AND ${toolInvocationPredicate("tool_name")}
        ORDER BY created_at, id`,
      sessionId
    ),
    tx.$queryRawUnsafe<
      {
        id: string;
        parent_agent_id: string | null;
      }[]
    >(
      `SELECT id, parent_agent_id
         FROM agents
        WHERE session_id = $1`,
      sessionId
    ),
  ]);
  const agentParentMap = new Map(
    agentRows.map((a) => [a.id, { parentAgentId: a.parent_agent_id }])
  );
  const metadataMessageCounts = storedTimelineMessageCounts(
    sessionRow.metadata
  );
  const precedingEventCounts = new Map<string, number>();
  return omitAmbiguousInvocationTimings(
    rows.map((row, index) => {
      const timestampOrdinal =
        (metadataMessageCounts.get(row.created_at) ?? 0) +
        (precedingEventCounts.get(row.created_at) ?? 0);
      precedingEventCounts.set(
        row.created_at,
        (precedingEventCounts.get(row.created_at) ?? 0) + 1
      );
      const parentAgentId = row.agent_id
        ? (agentParentMap.get(row.agent_id)?.parentAgentId ?? null)
        : null;
      return storedEventCandidate(
        { sessionId, harness: sessionRow.harness },
        row,
        index,
        timestampOrdinal,
        repositoryFullName,
        now,
        parentAgentId
      );
    })
  );
}

function storedEventCandidate(
  { sessionId, harness }: { sessionId: string; harness: string | null },
  row: StoredEventRow,
  index: number,
  timestampOrdinal: number,
  repositoryFullName: string | null,
  now: string,
  parentAgentId?: string | null
): AgentComponentInvocationCandidate {
  const data = parseRecord(row.data);
  const classified = classifyStoredTool(row.tool_name, data);
  const providerToolUseId = storedProviderToolUseId(data);
  const diffDelta = storedDiffDelta(data);
  const timing = measuredToolInvocationTiming(
    classified.kind,
    row.created_at,
    data?.resultTimestamp
  );
  return storedBaseCandidate({
    // ISS-10736: the result-payload footprint this stored row may carry.
    ...storedResultPayloadFootprint(classified.kind, data),
    ...timing,
    sessionId,
    externalInvocationId: providerToolUseId ?? row.id,
    externalSourceId: providerToolUseId,
    agentId: row.agent_id,
    parentAgentId: parentAgentId ?? null,
    componentKind: classified.kind,
    componentKey: classified.key,
    rawName: row.tool_name,
    normalizedName: classified.key,
    invokedAt: row.created_at,
    sourceOrder: index,
    anchorKind: providerToolUseId
      ? AgentComponentInvocationAnchorKind.Event
      : AgentComponentInvocationAnchorKind.Timestamp,
    anchorValue: providerToolUseId
      ? row.id
      : timestampAnchorValue(row.created_at, timestampOrdinal),
    providerToolUseId,
    succeeded: storedToolResultSucceeded(classified.kind, data, harness),
    gitBranch: null,
    repositoryFullName,
    ...(diffDelta ? { diffDelta } : {}),
    now,
  });
}

function dedupeCandidates(
  candidates: AgentComponentInvocationCandidate[]
): AgentComponentInvocationCandidate[] {
  const byId = new Map<string, AgentComponentInvocationCandidate>();
  for (const candidate of candidates) {
    if (!byId.has(candidate.externalInvocationId)) {
      byId.set(candidate.externalInvocationId, candidate);
    }
  }
  const deduped = [...byId.values()];
  for (const [sequence, candidate] of deduped.entries()) {
    candidate.sequence = sequence;
  }
  return deduped;
}

function timestampAnchorValue(timestamp: string, ordinal: number): string {
  return JSON.stringify({ timestamp, ordinal });
}

function storedTimelineMessageCounts(
  metadata: string | null
): Map<string, number> {
  const counts = new Map<string, number>();
  const messages = parseRecord(metadata)?.messages;
  if (!Array.isArray(messages)) {
    return counts;
  }
  for (const value of messages) {
    const message = asRecord(value);
    const timestamp = stringValue(message?.timestamp);
    if (
      !(
        timestamp &&
        (message?.role === "human" || message?.role === "assistant")
      )
    ) {
      continue;
    }
    counts.set(timestamp, (counts.get(timestamp) ?? 0) + 1);
  }
  return counts;
}

function invocationEventAnchor({
  session,
  timestamp,
  providerId,
  timestampOrdinal,
  eventType,
  toolName,
}: {
  session: NormalizedSession;
  timestamp: string | null;
  providerId: string | null;
  timestampOrdinal: number | null;
  eventType: string;
  toolName: string;
}): Pick<AgentComponentInvocationCandidate, "anchorKind" | "anchorValue"> {
  if (!timestamp) {
    return {
      anchorKind: AgentComponentInvocationAnchorKind.Session,
      anchorValue: session.sessionId,
    };
  }
  if (providerId) {
    return {
      anchorKind: AgentComponentInvocationAnchorKind.Event,
      anchorValue: deterministicEventId(
        session.sessionId,
        eventType,
        timestamp,
        toolName,
        providerId
      ),
    };
  }
  if (timestampOrdinal !== null) {
    return {
      anchorKind: AgentComponentInvocationAnchorKind.Timestamp,
      anchorValue: timestampAnchorValue(timestamp, timestampOrdinal),
    };
  }
  return {
    anchorKind: AgentComponentInvocationAnchorKind.Session,
    anchorValue: session.sessionId,
  };
}

/** Match the stable timestamp ordinal assigned by the shared trace projection. */
function toolTimestampOrdinal(
  session: NormalizedSession,
  toolUseIndex: number
): number {
  const timestamp = session.toolUses[toolUseIndex]?.timestamp;
  if (!timestamp) {
    return 0;
  }
  const precedingMessageCount = session.messages.filter(
    (message) =>
      message.timestamp === timestamp &&
      (message.role === "human" || message.role === "assistant")
  ).length;
  const precedingToolCount = session.toolUses
    .slice(0, toolUseIndex)
    .filter((toolUse) => toolUse.timestamp === timestamp).length;
  return precedingMessageCount + precedingToolCount;
}

function skillToolUseIndex(
  session: NormalizedSession,
  skillIndex: number
): number | null {
  let seenSkillCount = 0;
  for (const [toolUseIndex, toolUse] of session.toolUses.entries()) {
    if (!(toolUse.name === "Skill" && toolUse.skillName)) {
      continue;
    }
    if (seenSkillCount === skillIndex) {
      return toolUseIndex;
    }
    seenSkillCount += 1;
  }
  return null;
}

/** One stored `events` row as the stored-row candidate rebuild reads it. */
type StoredEventRow = {
  id: string;
  agent_id: string | null;
  tool_name: string;
  data: string | null;
  created_at: string;
};
