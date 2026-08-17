/**
 * Durable Desktop runtime-component invocation materialization (FEA-3294).
 *
 * The normalized transcript is the authoritative complete set. A session
 * import replaces that set transactionally, but evidence already frozen for a
 * stable external invocation id is monotonic: collector evidence can upgrade
 * an unresolved row and transcript evidence can upgrade collector evidence;
 * neither can be weakened or silently reinterpreted on a later import.
 */
import { createHash } from "node:crypto";
import {
  computeDefinitionHash,
  NORMALIZER_CONTRACT_VERSION,
} from "@repo/api/src/definition-fingerprint";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  type AgentComponentInvocationCompleteGeneration,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  type AgentComponentInvocationSyncItem,
} from "@repo/api/src/types/agent-component-invocation";
import { hookComponentKey } from "@repo/lib/harness/hook-identity";
import type {
  NormalizedDefinitionSnapshot,
  NormalizedInvocationDefinitionEvidence,
  NormalizedSession,
  NormalizedSubagent,
  NormalizedToolUse,
} from "@repo/lib/harness/types";
import { OutboxStatus } from "../../shared/sync-lane-contract.js";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
  AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID,
} from "../agent-sync/agent-component-invocation-sync-constants.js";
import {
  AgentComponentInvocationSyncPayloadLimitError,
  computeAgentComponentInvocationGenerationId,
} from "../agent-sync/agent-component-invocation-sync-payload.js";
import { DATA_REVISION } from "../collectors/engine/data-revision.js";
import { commandCandidates } from "./component-invocation-command-candidates.js";
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
  type AgentComponentInvocationCandidate,
  type EvidencePointer,
  evidenceRank,
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
import { parserSubagentCandidates } from "./component-invocation-subagent-candidates.js";
import {
  parseEvidencePointer,
  readStoredInvocationRows,
  storedRowToSyncItem,
} from "./component-invocation-sync-item.js";
import { BRANCH_WRITE_METHOD_VALUES, sqlStringList } from "./db-constants.js";
import { toolInvocationPredicate } from "./db-helpers.js";
import { deterministicEventId } from "./deterministic-event-id.js";
import type { Prisma } from "./generated/client.js";
import { sanitizeSubagentIdSegment } from "./import-metadata-builders.js";
import { buildInvocationSyncParts } from "./invocation-sync-parts-builder.js";
import { DELEGATION_TOOL_NAMES, delegationClaimKey } from "./subagent-dedup.js";
import { pairDelegationsWithSubagents } from "./subagent-spawn-matching.js";

/**
 * Local-only queue identity. Authentication selects the compute target when
 * the sync service drains these rows; persistence never invents cloud ids.
 */
export type InvocationKind =
  (typeof AgentComponentInvocationKind)[keyof typeof AgentComponentInvocationKind];
type EvidenceClass =
  (typeof AgentComponentInvocationEvidenceClass)[keyof typeof AgentComponentInvocationEvidenceClass];

type PriorInvocationEvidenceRow = {
  external_invocation_id: string;
  external_source_id: string | null;
  child_session_id: string | null;
  component_kind: InvocationKind;
  component_key: string;
  relationship: string;
  anchor_kind: string;
  anchor_value: string;
  provider_tool_use_id: string | null;
  attribution_status: string;
  evidence_class: EvidenceClass;
  evidence_pointer: string | EvidencePointer | null;
  definition_hash: string | null;
  normalizer_contract_version: number | null;
  definition_content: string | null;
  local_component_version_id: string | null;
  created_at: string;
  updated_at: string;
};

type StoredSessionFreshnessRow = {
  id: string;
  updated_at: string;
  data_revision: number;
};

export type ToolCandidateContext = {
  session: NormalizedSession;
  mainAgentId: string;
  parserAgentIdById: ReadonlyMap<string, string>;
  externalAgentIdById: ReadonlyMap<string, string>;
  evidenceByInvocationId: ReadonlyMap<
    string,
    NormalizedInvocationDefinitionEvidence
  >;
  now: string;
};

/** Build the canonical, database-independent complete invocation set. */
export function deriveAgentComponentInvocationCandidates(
  session: NormalizedSession,
  mainAgentId: string,
  now: string
): AgentComponentInvocationCandidate[] {
  const context = buildToolCandidateContext(session, mainAgentId, now);
  const spawned = spawnedSubagentCandidates(context);
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
    ...hookCandidates(context),
    ...spawned.candidates,
    ...parserSubagentCandidates(
      context,
      markdownCandidate,
      spawned.representedSubagentIds
    ),
  ];
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

function buildToolCandidateContext(
  session: NormalizedSession,
  mainAgentId: string,
  now: string
): ToolCandidateContext {
  const parserSubagents = session.subagents ?? [];
  return {
    session,
    mainAgentId,
    parserAgentIdById: new Map(
      parserSubagents.map((subagent) => [
        subagent.id,
        parserAgentId(session.sessionId, subagent.id),
      ])
    ),
    externalAgentIdById: new Map(
      parserSubagents.map((subagent) => [
        subagent.id,
        subagent.nativeSubagentId ?? subagent.id,
      ])
    ),
    evidenceByInvocationId: new Map(
      (session.invocationDefinitionEvidence ?? []).map((entry) => [
        entry.invocationId,
        entry,
      ])
    ),
    now,
  };
}

function toolCandidates(
  context: ToolCandidateContext
): AgentComponentInvocationCandidate[] {
  const candidates: AgentComponentInvocationCandidate[] = [];
  const seenToolIds = new Set<string>();
  for (const [index, toolUse] of (context.session.toolUses ?? []).entries()) {
    if (toolUse.name === "Skill" && toolUse.skillName) {
      continue;
    }
    if (toolUse.id) {
      seenToolIds.add(toolUse.id);
    }
    candidates.push(toolInvocationCandidate(toolUse, index, index, context));
  }
  appendSidecarSubagentToolCandidates(context, candidates, seenToolIds);
  return candidates;
}

function appendSidecarSubagentToolCandidates(
  context: ToolCandidateContext,
  candidates: AgentComponentInvocationCandidate[],
  seenToolIds: Set<string>
): void {
  let sourceOrder = context.session.toolUses?.length ?? 0;
  for (const subagent of context.session.subagents ?? []) {
    for (const toolUse of subagent.toolUses ?? []) {
      if (toolUse.name === "Skill" && toolUse.skillName) {
        continue;
      }
      if (toolUse.id && seenToolIds.has(toolUse.id)) {
        continue;
      }
      candidates.push(
        toolInvocationCandidate(toolUse, sourceOrder, sourceOrder, context)
      );
      sourceOrder++;
    }
  }
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
 * FEA-4093: one invocation candidate per captured Hook firing
 * (`session.hooks`, from transcript `attachment` hook_success/hook_error
 * records). Before this, hooks produced no candidates, so `Hook` inventory
 * rows aggregated to zero usage even though hooks fire regularly — the bug this
 * fixes.
 *
 * `componentKey` is the normalized per-handler identity from
 * `hookComponentKey(hook.name, hook.command)` — the harness `hookName` (e.g.
 * `"PreToolUse:Bash"`) plus the machine-independent normalized `command` as a
 * discriminator. `hookName` alone collapses distinct handlers that share a
 * matcher (in the corpus `PreToolUse:Bash` maps to three different commands),
 * while the raw command leaks host-specific home paths; the normalizer keeps
 * handlers distinct without leaking paths (see `hook-identity.ts`).
 *
 * A hook attachment is not a transcript turn item, so it has no tool/message
 * ordinal to resolve a Timestamp anchor against (a timestamp collision would
 * mis-link to an unrelated row). It therefore anchors to the Session — its
 * per-firing distinctness lives in `externalInvocationId` and the normalized
 * `componentKey`, and the failed-firing rollup reads `succeeded` directly, not
 * the anchor. Hooks run on the orchestrator (there is no per-firing subagent
 * axis in the transcript), so they attribute to `mainAgentId` with a Direct
 * relationship.
 */
function hookCandidates(
  context: ToolCandidateContext
): AgentComponentInvocationCandidate[] {
  const { session, mainAgentId, now } = context;
  return (session.hooks ?? []).map((hook, index) => {
    const componentKey = hookComponentKey(hook.name, hook.command);
    const externalInvocationId = `hook:${index}:${hook.timestamp ?? "unknown"}:${componentKey}`;
    return markdownCandidate({
      session,
      mainAgentId,
      externalInvocationId,
      externalSourceId: null,
      providerToolUseId: null,
      componentKind: AgentComponentInvocationKind.Hook,
      componentKey,
      rawName: hook.name,
      normalizedName: componentKey,
      invokedAt: hook.timestamp,
      sourceOrder: 250_000 + index,
      agentId: mainAgentId,
      parentAgentId: null,
      relationship: AgentComponentInvocationRelationship.Direct,
      anchorKind: AgentComponentInvocationAnchorKind.Session,
      anchorValue: session.sessionId,
      snapshot: undefined,
      focusedEvidence: context.evidenceByInvocationId.get(externalInvocationId),
      externalAgentId: null,
      parentExternalInvocationId: null,
      succeeded: hook.succeeded,
      now,
    });
  });
}

function spawnedSubagentCandidates(context: ToolCandidateContext): {
  candidates: AgentComponentInvocationCandidate[];
  representedSubagentIds: Set<string>;
} {
  const { session, mainAgentId, now } = context;
  // ISS-5099: pairing lives in `subagent-spawn-matching.ts` so the invocation
  // lane and the `agents` write lane settle exact spawn claims from ONE
  // correlation; see `pairDelegationsWithSubagents` for why order matters.
  const { pairs, representedSubagentIds } = pairDelegationsWithSubagents(
    session,
    context.parserAgentIdById
  );
  const candidates = pairs.map(({ index, toolUse, parserSubagent }) =>
    spawnedSubagentCandidate(
      context,
      toolUse,
      index,
      parserSubagent,
      mainAgentId,
      now
    )
  );
  return { candidates, representedSubagentIds };
}

function spawnedSubagentCandidate(
  context: ToolCandidateContext,
  toolUse: NormalizedToolUse,
  index: number,
  parserSubagent: NormalizedSubagent | null,
  mainAgentId: string,
  now: string
): AgentComponentInvocationCandidate {
  const { session } = context;
  // The canonical delegation key, shared with tier-0, the whole-session
  // pre-pass, and write-core's twin retirement — never re-derived here.
  const providerId = delegationClaimKey(toolUse);
  const externalInvocationId = parserSubagent
    ? `subagent:${parserSubagent.id}`
    : `subagent:${providerId ?? `${index}:${toolUse.timestamp ?? "unknown"}`}`;
  const input = asRecord(toolUse.input);
  const rawName =
    parserSubagent?.rawName ??
    stringValue(input?.subagent_type) ??
    stringValue(input?.agent_type) ??
    parserSubagent?.type ??
    "general-purpose";
  const normalizedName =
    parserSubagent?.normalizedName ?? parserSubagent?.type ?? rawName;
  const agentId = parserSubagent
    ? (context.parserAgentIdById.get(parserSubagent.id) ?? null)
    : `${session.sessionId}-sub-${toolUse.id ?? index}`;
  return markdownCandidate({
    session,
    mainAgentId,
    externalInvocationId,
    externalSourceId: parserSubagent?.nativeSubagentId ?? providerId ?? null,
    providerToolUseId: providerId,
    childSessionId: parserSubagent?.childSessionId ?? null,
    componentKind: AgentComponentInvocationKind.Subagent,
    componentKey: normalizedName,
    rawName,
    normalizedName,
    invokedAt: parserSubagent?.startedAt ?? toolUse.timestamp,
    sourceOrder: 300_000 + index,
    agentId,
    parentAgentId: mainAgentId,
    relationship: parserSubagent?.childSessionId
      ? AgentComponentInvocationRelationship.ChildSession
      : AgentComponentInvocationRelationship.Direct,
    anchorKind: agentId
      ? AgentComponentInvocationAnchorKind.Agent
      : AgentComponentInvocationAnchorKind.Session,
    anchorValue: agentId ?? session.sessionId,
    snapshot: parserSubagent?.definitionSnapshot ?? toolUse.definitionSnapshot,
    focusedEvidence: context.evidenceByInvocationId.get(externalInvocationId),
    externalAgentId:
      parserSubagent?.nativeSubagentId ?? parserSubagent?.id ?? providerId,
    transcriptFileId: parserSubagent?.id ?? null,
    parentExternalInvocationId: null,
    now,
  });
}

/** Replace one session's complete invocation set and queue its exact parts. */
export async function materializeAgentComponentInvocations(
  tx: Prisma.TransactionClient,
  session: NormalizedSession,
  mainAgentId: string,
  now: string,
  /* ISS-5098: REQUIRED so the row writer can REPORT an agent reference it had to
     drop (see nullUnresolvableAgentReferences) instead of silently losing the
     attribution. Same precedent as ImportSessionContext.log -> persistArtifactLinks.
     REQUIRED (wongk, #4355): optional here would let a caller re-open the silent
     path `insertInvocationRows` now forbids. The only caller passes the required
     `ImportSessionContext.log`. */
  log: (message: string) => void
): Promise<void> {
  const candidates = deriveAgentComponentInvocationCandidates(
    session,
    mainAgentId,
    now
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

  await ensureInvocationComponents(tx, candidates, now, log);
  await ensureInvocationVersions(tx, candidates, now);
  await tx.$executeRawUnsafe(
    "DELETE FROM agent_component_invocations WHERE session_id = $1",
    session.sessionId
  );
  await insertInvocationRows(tx, session.sessionId, candidates, log);
  await relinkInvocationRows(tx, [session.sessionId]);
  /* ISS-4572: the invocation-sync outbox records the DERIVATION revision of the
     invocation set, which is the current DATA_REVISION regardless of the session
     row's transient gate value. The isolated import path (write-core.ts) stamps
     the session row with the DATA_REVISION_IMPORT_PENDING sentinel at the gate and
     seals the real revision in a later group; reading `data_revision` off the
     session row here would otherwise leak that sentinel into the outbox
     `data_revision`/`part_hash`/payload (and the seal does not re-derive the
     outbox, since the generation id is revision-independent). Pin the outbox to
     DATA_REVISION directly so it always matches the sealed session row. */
  await enqueueInvocationGeneration(tx, session.sessionId, now, {
    dataRevision: DATA_REVISION,
  });
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
     This is one of the two paths wongk (#4355) named: it builds candidates from
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
     The second of the two paths wongk (#4355) named; it too builds from
     `events.agent_id`, so an omittable reporter would have gone quiet here. */
  log: (message: string) => void
): Promise<{ invocationSetChanged: boolean }> {
  const before = await loadAgentComponentInvocationCompleteGeneration(
    tx,
    sessionId
  );
  // wongk (#4255): prior evidence must be read BEFORE the candidates are built.
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
  await ensureInvocationComponents(tx, candidates, now, log);
  await ensureInvocationVersions(tx, candidates, now);
  await tx.$executeRawUnsafe(
    "DELETE FROM agent_component_invocations WHERE session_id = $1",
    sessionId
  );
  await insertInvocationRows(tx, sessionId, candidates, log);
  await relinkInvocationRows(tx, [sessionId]);
  await rebuildAgentComponentSessionUsageFromInvocations(
    tx,
    [sessionId],
    storedUtcDayExpression
  );
  const after = await loadAgentComponentInvocationCompleteGeneration(
    tx,
    sessionId
  );
  const invocationSetChanged =
    before?.externalGenerationId !== after?.externalGenerationId;
  if (invocationSetChanged) {
    await tx.$executeRawUnsafe(
      `UPDATE sessions
          SET updated_at = CASE WHEN updated_at > $1 THEN updated_at ELSE $1 END
        WHERE id = $2`,
      now,
      sessionId
    );
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

/**
 * Rebuild the legacy aggregate from durable invocations, preserving its
 * pre-FEA-3294 per-event branch fallback without weakening exact invocation
 * attribution stored on the invocation rows themselves.
 */
export async function rebuildAgentComponentSessionUsageFromInvocations(
  tx: Prisma.TransactionClient,
  sessionIds: string[],
  dayExpression: (column: string) => string
): Promise<void> {
  if (sessionIds.length === 0) {
    return;
  }
  const placeholders = sessionIds.map((_, index) => `$${index + 1}`).join(", ");
  await tx.$executeRawUnsafe(
    `DELETE FROM agent_component_session_usage WHERE session_id IN (${placeholders})`,
    ...sessionIds
  );
  await tx.$executeRawUnsafe(
    `WITH timestamp_event_branch AS (
       SELECT
         session_id,
         created_at,
         tool_name,
         CASE
           WHEN COUNT(DISTINCT COALESCE(git_branch, '')) = 1
             THEN MAX(git_branch)
           ELSE NULL
         END AS git_branch
       FROM events
       WHERE session_id IN (${placeholders})
       GROUP BY session_id, created_at, tool_name
     ),
     provider_event_branch AS (
       SELECT
         session_id,
         json_extract(data, '$.providerToolUseId') AS provider_tool_use_id,
         CASE
           WHEN COUNT(DISTINCT COALESCE(git_branch, '')) = 1
             THEN MAX(git_branch)
           ELSE NULL
         END AS git_branch
       FROM events
       WHERE session_id IN (${placeholders})
         AND json_type(data, '$.providerToolUseId') = 'text'
       GROUP BY session_id, json_extract(data, '$.providerToolUseId')
     )
     INSERT INTO agent_component_session_usage
       (session_id, component_kind, component_key, git_branch,
        agent_component_id, harness, invocations, error_count,
        component_version_hash, first_invoked_at, last_invoked_at, started_day)
     SELECT
       i.session_id,
       i.component_kind,
       i.component_key,
       COALESCE(
         i.git_branch,
         anchor_event.git_branch,
         provider_event_branch.git_branch,
         timestamp_event_branch.git_branch,
         ''
       ),
       MAX(i.local_component_id),
       COALESCE(NULLIF(s.harness, ''), 'claude'),
       COUNT(*),
       SUM(CASE
             -- FEA-4093: a Hook firing carries its own success fact (it anchors
             -- to a Timestamp, not an error-bearing event/agent), so count a
             -- persisted succeeded=0 directly as an error.
             WHEN i.succeeded = 0 THEN 1
             WHEN i.anchor_kind = 'event' AND EXISTS (
               SELECT 1 FROM events e
                WHERE e.id = i.anchor_value
                  AND (lower(e.event_type) LIKE '%error%'
                       OR lower(e.event_type) LIKE '%fail%'
                       OR json_extract(e.data, '$.isError') = 1)
             ) THEN 1
             WHEN i.anchor_kind = 'agent' AND EXISTS (
               SELECT 1 FROM agents a
                WHERE a.id = i.anchor_value
                  AND (lower(a.status) LIKE '%error%'
                       OR lower(a.status) LIKE '%fail%')
             ) THEN 1
             ELSE 0
           END),
       CASE
         WHEN COUNT(i.definition_hash) = COUNT(*)
          AND COUNT(DISTINCT i.definition_hash) = 1
           THEN MAX(i.definition_hash)
         ELSE NULL
       END,
       MIN(i.invoked_at),
       MAX(i.invoked_at),
       ${dayExpression("s.started_at")}
     FROM agent_component_invocations i
     JOIN sessions s ON s.id = i.session_id
     LEFT JOIN events anchor_event
       ON i.anchor_kind = 'event'
      AND anchor_event.id = i.anchor_value
      AND anchor_event.session_id = i.session_id
     LEFT JOIN provider_event_branch
       ON i.anchor_kind = 'event'
      AND provider_event_branch.session_id = i.session_id
      AND provider_event_branch.provider_tool_use_id = i.provider_tool_use_id
     LEFT JOIN timestamp_event_branch
       ON i.anchor_kind = 'timestamp'
      AND timestamp_event_branch.session_id = i.session_id
      AND timestamp_event_branch.created_at = i.invoked_at
      AND timestamp_event_branch.tool_name = CASE
        WHEN i.component_kind = 'skill' THEN 'Skill'
        ELSE i.raw_name
      END
     WHERE i.session_id IN (${placeholders})
     GROUP BY i.session_id, i.component_kind, i.component_key,
              COALESCE(
                i.git_branch,
                anchor_event.git_branch,
                provider_event_branch.git_branch,
                timestamp_event_branch.git_branch,
                ''
              ),
              s.harness, s.started_at`,
    ...sessionIds
  );
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
    if (!(error instanceof AgentComponentInvocationSyncPayloadLimitError)) {
      throw error;
    }
    externalGenerationId = computeOversizedInvocationSetId(sessionId, items);
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

async function enqueueInvocationGeneration(
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
            source_sequence, payload, status, attempt_count, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $12)
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
  await tx.$executeRawUnsafe(
    `INSERT INTO agent_component_invocation_sync_cursors
       (source_key, external_session_id, external_generation_id,
        source_sequence, updated_at)
     VALUES ($1, $2, $2, 1, $3)
     ON CONFLICT (source_key, external_session_id) DO UPDATE SET
       source_sequence = agent_component_invocation_sync_cursors.source_sequence + 1,
       updated_at = excluded.updated_at`,
    AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
    AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID,
    now
  );
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
    sourceOrder,
    agentId: agentIdForTool(toolUse, context),
    parentAgentId: parentAgentIdForTool(toolUse, context),
    relationship: relationshipForTool(toolUse),
    anchorKind: anchor.anchorKind,
    anchorValue: anchor.anchorValue,
    providerToolUseId: providerId,
    evidencePointer:
      toolUse.subagentId == null
        ? null
        : {
            externalAgentId:
              context.externalAgentIdById.get(toolUse.subagentId) ??
              toolUse.subagentId,
          },
    now,
  });
}

function classifyToolInvocationKind(
  toolUse: NormalizedToolUse,
  isMcp: boolean
): InvocationKind {
  if (isMcp) {
    return AgentComponentInvocationKind.Mcp;
  }
  if (toolUse.kind === "harness") {
    return AgentComponentInvocationKind.Orchestration;
  }
  return AgentComponentInvocationKind.Tool;
}

export type MarkdownCandidateInput = {
  session: NormalizedSession;
  mainAgentId: string;
  externalInvocationId: string;
  externalSourceId: string | null;
  providerToolUseId: string | null;
  childSessionId?: string | null;
  componentKind: InvocationKind;
  componentKey: string;
  rawName: string;
  normalizedName: string;
  invokedAt: string | null;
  sourceOrder: number;
  agentId: string | null;
  parentAgentId: string | null;
  relationship: string;
  anchorKind: string;
  anchorValue: string;
  snapshot: NormalizedDefinitionSnapshot | undefined;
  focusedEvidence: NormalizedInvocationDefinitionEvidence | undefined;
  externalAgentId: string | null;
  transcriptFileId?: string | null;
  parentExternalInvocationId: string | null;
  succeeded?: boolean | null;
  now: string;
};

/**
 * The `markdownCandidate` factory signature, exported so sibling candidate
 * builders (e.g. `component-invocation-command-candidates.ts`) can receive it by
 * injection rather than duplicating the shared candidate-shaping logic.
 */
export type MarkdownCandidateFn = (
  input: MarkdownCandidateInput
) => AgentComponentInvocationCandidate;

export function markdownCandidate(
  input: MarkdownCandidateInput
): AgentComponentInvocationCandidate {
  const evidence = exactEvidence(
    input.snapshot,
    input.focusedEvidence,
    input.componentKind,
    input.componentKey
  );
  return baseCandidate({
    session: input.session,
    externalInvocationId: input.externalInvocationId,
    externalSourceId: input.externalSourceId,
    childSessionId: input.childSessionId,
    componentKind: input.componentKind,
    componentKey: input.componentKey,
    rawName: input.rawName,
    normalizedName: input.normalizedName,
    invokedAt: input.invokedAt,
    sourceOrder: input.sourceOrder,
    agentId: input.agentId,
    parentAgentId: input.parentAgentId,
    relationship: input.relationship,
    anchorKind: input.anchorKind,
    anchorValue: input.anchorValue,
    providerToolUseId: input.providerToolUseId,
    attributionStatus: evidence
      ? AgentComponentInvocationAttributionStatus.Matched
      : AgentComponentInvocationAttributionStatus.Unresolved,
    evidenceClass:
      evidence?.evidenceClass ?? AgentComponentInvocationEvidenceClass.None,
    evidencePointer:
      evidence ||
      input.externalAgentId ||
      input.transcriptFileId ||
      input.parentExternalInvocationId
        ? {
            ...(evidence?.pointer ?? {}),
            ...(input.externalAgentId
              ? { externalAgentId: input.externalAgentId }
              : {}),
            ...(input.transcriptFileId
              ? { transcriptFileId: input.transcriptFileId }
              : {}),
            ...(input.parentExternalInvocationId
              ? {
                  parentExternalInvocationId: input.parentExternalInvocationId,
                }
              : {}),
          }
        : null,
    definitionHash: evidence?.definitionHash ?? null,
    normalizerContractVersion: evidence?.normalizerContractVersion ?? null,
    definitionContent: evidence?.content ?? null,
    succeeded: input.succeeded ?? null,
    now: input.now,
  });
}

function baseCandidate(input: {
  session: NormalizedSession;
  externalInvocationId: string;
  externalSourceId: string | null;
  childSessionId?: string | null;
  componentKind: InvocationKind;
  componentKey: string;
  rawName: string | null;
  normalizedName: string | null;
  invokedAt: string | null;
  sourceOrder: number;
  agentId: string | null;
  parentAgentId: string | null;
  relationship: string;
  anchorKind: string;
  anchorValue: string;
  providerToolUseId: string | null;
  attributionStatus?: string;
  evidenceClass?: EvidenceClass;
  evidencePointer?: EvidencePointer | null;
  definitionHash?: string | null;
  normalizerContractVersion?: number | null;
  definitionContent?: string | null;
  gitBranch?: string | null;
  succeeded?: boolean | null;
  now: string;
}): AgentComponentInvocationCandidate {
  return {
    externalInvocationId: input.externalInvocationId,
    externalSourceId: input.externalSourceId,
    childSessionId: input.childSessionId ?? null,
    agentId: input.agentId,
    parentAgentId: input.parentAgentId,
    componentKind: input.componentKind,
    componentKey: input.componentKey,
    rawName: input.rawName,
    normalizedName: input.normalizedName,
    relationship: input.relationship,
    invokedAt: input.invokedAt,
    sourceOrder: input.sourceOrder,
    sequence: 0,
    anchorKind: input.anchorKind,
    anchorValue: input.anchorValue,
    providerToolUseId: input.providerToolUseId,
    attributionStatus:
      input.attributionStatus ??
      AgentComponentInvocationAttributionStatus.Unresolved,
    evidenceClass:
      input.evidenceClass ?? AgentComponentInvocationEvidenceClass.None,
    evidencePointer: input.evidencePointer ?? null,
    definitionHash: input.definitionHash ?? null,
    normalizerContractVersion: input.normalizerContractVersion ?? null,
    definitionContent: input.definitionContent ?? null,
    localComponentId: null,
    localComponentVersionId: null,
    gitBranch: input.gitBranch ?? null,
    repositoryFullName: null,
    succeeded: input.succeeded ?? null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function exactEvidence(
  snapshot: NormalizedDefinitionSnapshot | undefined,
  focused: NormalizedInvocationDefinitionEvidence | undefined,
  expectedKind: InvocationKind,
  expectedComponentKey: string
): {
  evidenceClass: EvidenceClass;
  pointer: EvidencePointer;
  content: string;
  definitionHash: string;
  normalizerContractVersion: number;
} | null {
  if (
    snapshot?.kind === expectedKind &&
    snapshot.normalizedName === expectedComponentKey
  ) {
    const fingerprint = computeDefinitionHash({
      frontmatter: "",
      body: snapshot.content,
      kind: snapshot.kind,
    });
    return {
      evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
      pointer: {
        definitionFormat: "md",
        ...(snapshot.capturedAt ? { capturedAt: snapshot.capturedAt } : {}),
      },
      content: snapshot.content,
      ...fingerprint,
    };
  }
  if (
    !focused ||
    focused.kind !== expectedKind ||
    focused.normalizedName !== expectedComponentKey
  ) {
    return null;
  }
  return {
    evidenceClass: AgentComponentInvocationEvidenceClass.CollectorSnapshot,
    pointer: {
      definitionFormat: focused.definitionFormat,
      sourcePath: focused.sourcePath,
      sourceModifiedAt: focused.sourceModifiedAt,
      capturedAt: focused.capturedAt,
    },
    content: focused.content,
    definitionHash: focused.definitionHash,
    normalizerContractVersion: focused.normalizerContractVersion,
  };
}

function readPriorEvidence(
  tx: Prisma.TransactionClient,
  sessionId: string
): Promise<PriorInvocationEvidenceRow[]> {
  return tx.$queryRawUnsafe<PriorInvocationEvidenceRow[]>(
    `SELECT external_invocation_id, external_source_id, child_session_id,
            component_kind, component_key, relationship, anchor_kind,
            anchor_value, provider_tool_use_id, attribution_status,
            evidence_class, evidence_pointer, definition_hash,
            normalizer_contract_version, definition_content,
            local_component_version_id, created_at, updated_at
       FROM agent_component_invocations
      WHERE session_id = $1`,
    sessionId
  );
}

function preserveStrongerEvidence(
  candidate: AgentComponentInvocationCandidate,
  previous: PriorInvocationEvidenceRow | undefined
): void {
  if (!previous) {
    return;
  }
  candidate.createdAt = previous.created_at;
  const previousPointer = parseEvidencePointer(previous.evidence_pointer);
  if (previousPointer) {
    candidate.evidencePointer = {
      ...previousPointer,
      ...(candidate.evidencePointer ?? {}),
    };
  }
  if (
    evidenceRank(previous.evidence_class) <
    evidenceRank(candidate.evidenceClass)
  ) {
    return;
  }
  if (previous.definition_hash) {
    candidate.attributionStatus = previous.attribution_status;
    candidate.evidenceClass = previous.evidence_class;
    candidate.evidencePointer = parseEvidencePointer(previous.evidence_pointer);
    candidate.definitionHash = previous.definition_hash;
    candidate.normalizerContractVersion =
      previous.normalizer_contract_version == null
        ? NORMALIZER_CONTRACT_VERSION
        : Number(previous.normalizer_contract_version);
    candidate.definitionContent = previous.definition_content;
    candidate.localComponentVersionId = previous.local_component_version_id;
  }
}

function restoreStableInvocationIdentities(
  candidates: AgentComponentInvocationCandidate[],
  priorRows: PriorInvocationEvidenceRow[]
): void {
  const priorByAnchor = new Map<string, PriorInvocationEvidenceRow[]>();
  const priorIds = new Set<string>();
  for (const row of priorRows) {
    priorIds.add(row.external_invocation_id);
    const key = `${row.anchor_kind}\u0000${row.anchor_value}\u0000${row.component_kind}\u0000${row.component_key}`;
    const rows = priorByAnchor.get(key) ?? [];
    rows.push(row);
    priorByAnchor.set(key, rows);
  }
  const claimedPriorIds = new Set<string>();
  for (const candidate of candidates) {
    if (priorIds.has(candidate.externalInvocationId)) {
      claimedPriorIds.add(candidate.externalInvocationId);
      continue;
    }
    const anchorMatches =
      priorByAnchor
        .get(
          `${candidate.anchorKind}\u0000${candidate.anchorValue}\u0000${candidate.componentKind}\u0000${candidate.componentKey}`
        )
        ?.filter((row) => !claimedPriorIds.has(row.external_invocation_id)) ??
      [];
    const sourceMatch = anchorMatches.find(
      (row) =>
        (candidate.externalSourceId !== null &&
          row.external_source_id === candidate.externalSourceId) ||
        (candidate.providerToolUseId !== null &&
          row.provider_tool_use_id === candidate.providerToolUseId)
    );
    const prior =
      sourceMatch ??
      (anchorMatches.length === 1 ? anchorMatches[0] : undefined);
    if (!prior) {
      continue;
    }
    claimedPriorIds.add(prior.external_invocation_id);
    candidate.externalInvocationId = prior.external_invocation_id;
    candidate.externalSourceId =
      prior.external_source_id ?? candidate.externalSourceId;
    candidate.childSessionId =
      prior.child_session_id ?? candidate.childSessionId;
    candidate.relationship = prior.relationship;
    // The FRESH derivation wins (ISS-5099, wongk review). This restores stable
    // IDENTITY, not stale pairing: when a candidate already resolved which
    // delegation it belongs to — from the transcript, or from the durable spawn
    // events via `applyStoredSpawnClaimKeys` — copying the stored value over it
    // would re-impose exactly the mispair the rebuild exists to correct, and the
    // bridge would then seal that. The prior value is still the fallback for a
    // candidate that resolved none.
    candidate.providerToolUseId =
      candidate.providerToolUseId ?? prior.provider_tool_use_id;
  }
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

async function relinkInvocationRows(
  tx: Prisma.TransactionClient,
  sessionIds: string[]
): Promise<void> {
  if (sessionIds.length === 0) {
    return;
  }
  const placeholders = sessionIds.map((_, index) => `$${index + 1}`).join(", ");
  const ambiguousParam = `$${sessionIds.length + 1}`;
  const matchedParam = `$${sessionIds.length + 2}`;
  const unmatchedParam = `$${sessionIds.length + 3}`;
  const unresolvedParam = `$${sessionIds.length + 4}`;
  await tx.$executeRawUnsafe(
    `WITH component_matches AS (
       SELECT invocation.id AS invocation_id,
              COUNT(component.id) AS match_count,
              MIN(component.id) AS matched_component_id
         FROM agent_component_invocations invocation
         LEFT JOIN agent_components component
           ON component.component_kind = invocation.component_kind
          AND component.component_key = invocation.component_key
        WHERE invocation.session_id IN (${placeholders})
        GROUP BY invocation.id
     )
     UPDATE agent_component_invocations
        SET local_component_id = CASE
              WHEN (SELECT match_count FROM component_matches
                     WHERE invocation_id = agent_component_invocations.id) = 1
                THEN (SELECT matched_component_id FROM component_matches
                      WHERE invocation_id = agent_component_invocations.id)
              ELSE NULL
            END,
            local_component_version_id = CASE
              WHEN definition_hash IS NULL OR
                   (SELECT match_count FROM component_matches
                    WHERE invocation_id = agent_component_invocations.id) <> 1
                THEN NULL
              ELSE (
                SELECT av.id FROM agent_component_versions av
                 WHERE av.component_kind = agent_component_invocations.component_kind
                   AND av.component_key = agent_component_invocations.component_key
                   AND av.content_hash = agent_component_invocations.definition_hash
                 ORDER BY av.id LIMIT 1
              )
            END,
            attribution_status = CASE
              WHEN (SELECT match_count FROM component_matches
                    WHERE invocation_id = agent_component_invocations.id) > 1
                THEN ${ambiguousParam}
              WHEN definition_hash IS NOT NULL AND
                   (SELECT match_count FROM component_matches
                    WHERE invocation_id = agent_component_invocations.id) = 1
                THEN ${matchedParam}
              WHEN definition_hash IS NOT NULL THEN ${unmatchedParam}
              ELSE ${unresolvedParam}
            END
      WHERE session_id IN (${placeholders})`,
    ...sessionIds,
    AgentComponentInvocationAttributionStatus.Ambiguous,
    AgentComponentInvocationAttributionStatus.Matched,
    AgentComponentInvocationAttributionStatus.Unmatched,
    AgentComponentInvocationAttributionStatus.Unresolved
  );
}

async function storedCandidates(
  tx: Prisma.TransactionClient,
  sessionId: string,
  now: string,
  priorResolvedCommandKeys: ReadonlySet<string>
): Promise<AgentComponentInvocationCandidate[]> {
  const sessionRows = await tx.$queryRawUnsafe<{ metadata: string | null }[]>(
    "SELECT metadata FROM sessions WHERE id = $1",
    sessionId
  );
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
    sessionRow.metadata,
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
  // ISS-5099 (wongk review): recover each subagent's delegation from the
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
  sessionMetadata: string | null,
  repositoryFullName: string | null,
  now: string
): Promise<AgentComponentInvocationCandidate[]> {
  const [rows, agentRows] = await Promise.all([
    tx.$queryRawUnsafe<StoredEventRow[]>(
      // ISS-5493 (wongk review): the same one definition the tool-count reads
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
  const metadataMessageCounts = storedTimelineMessageCounts(sessionMetadata);
  const precedingEventCounts = new Map<string, number>();
  return rows.map((row, index) => {
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
      sessionId,
      row,
      index,
      timestampOrdinal,
      repositoryFullName,
      now,
      parentAgentId
    );
  });
}

function storedEventCandidate(
  sessionId: string,
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
  return storedBaseCandidate({
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
    gitBranch: null,
    repositoryFullName,
    now,
  });
}

function classifyStoredTool(
  toolName: string,
  data: Record<string, unknown> | null
): { kind: InvocationKind; key: string } {
  const toolInput = asRecord(data?.tool_input);
  const skillName =
    stringValue(data?.skillName) ??
    stringValue(toolInput?.skill) ??
    stringValue(data?.skill);
  if (toolName === "Skill" && skillName) {
    return { kind: AgentComponentInvocationKind.Skill, key: skillName };
  }
  if (toolName.startsWith("mcp__")) {
    return {
      kind: AgentComponentInvocationKind.Mcp,
      key: stringValue(data?.mcpServer) ?? toolName,
    };
  }
  if (data?.kind === "harness") {
    return {
      kind: AgentComponentInvocationKind.Orchestration,
      key: toolName,
    };
  }
  return { kind: AgentComponentInvocationKind.Tool, key: toolName };
}

function agentIdForTool(
  toolUse: NormalizedToolUse,
  context: ToolCandidateContext
): string {
  return toolUse.subagentId == null
    ? context.mainAgentId
    : (context.parserAgentIdById.get(toolUse.subagentId) ??
        context.mainAgentId);
}

function parentAgentIdForTool(
  toolUse: NormalizedToolUse,
  context: ToolCandidateContext
): string | null {
  return toolUse.subagentId == null
    ? null
    : parentAgentIdFor(
        context.session,
        toolUse.subagentId,
        context.mainAgentId
      );
}

function parentAgentIdFor(
  session: NormalizedSession,
  subagentId: string,
  mainAgentId: string
): string {
  const subagent = (session.subagents ?? []).find(
    (candidate) => candidate.id === subagentId
  );
  return subagent?.parentId
    ? parserAgentId(session.sessionId, subagent.parentId)
    : mainAgentId;
}

function relationshipForTool(toolUse: NormalizedToolUse): string {
  return toolUse.subagentId == null
    ? AgentComponentInvocationRelationship.Direct
    : AgentComponentInvocationRelationship.Associated;
}

function parserAgentId(sessionId: string, subagentId: string): string {
  // The sanitize step is shared with write-core's `agents`-row minting
  // (`import-metadata-builders.ts`) so the two lanes cannot drift — a drift
  // here would point every paired invocation row's `agent_id` at an `agents`
  // row that does not exist.
  return `${sessionId}-parser-sub-${sanitizeSubagentIdSegment(subagentId)}`;
}

function compareCandidates(
  left: AgentComponentInvocationCandidate,
  right: AgentComponentInvocationCandidate
): number {
  const leftTs = left.invokedAt ?? "";
  const rightTs = right.invokedAt ?? "";
  const byTimestamp = leftTs.localeCompare(rightTs);
  return byTimestamp === 0 ? left.sourceOrder - right.sourceOrder : byTimestamp;
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

function storedProviderToolUseId(
  data: Record<string, unknown> | null
): string | null {
  return (
    stringValue(data?.providerToolUseId) ??
    stringValue(data?.provider_tool_use_id) ??
    stringValue(data?.toolUseId) ??
    stringValue(data?.tool_use_id)
  );
}

function storedUtcDayExpression(column: string): string {
  return `CASE WHEN ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN substr(${column}, 1, 10) ELSE NULL END`;
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

type InvocationArtifactAttribution = {
  branchName: string;
  identityKey: string;
  repositoryFullName: string | null;
  observedAt: string;
};

function loadInvocationArtifactAttributions(
  tx: Prisma.TransactionClient,
  sessionId: string
): Promise<InvocationArtifactAttribution[]> {
  return tx.$queryRawUnsafe<InvocationArtifactAttribution[]>(
    `SELECT a.branch_name AS "branchName",
            a.identity_key AS "identityKey",
            a.repo_full_name AS "repositoryFullName",
            sal.observed_at AS "observedAt"
       FROM session_artifact_links sal
       JOIN artifacts a ON a.id = sal.artifact_id
      WHERE sal.session_id = $1
        AND sal.relation = 'created'
        AND sal.method IN (${sqlStringList(BRANCH_WRITE_METHOD_VALUES)})
        AND a.kind = 'branch'
        AND a.branch_name IS NOT NULL
      ORDER BY sal.observed_at ASC, a.identity_key ASC`,
    sessionId
  );
}

function applyArtifactLinkAttribution(
  candidates: AgentComponentInvocationCandidate[],
  attributions: readonly InvocationArtifactAttribution[]
): void {
  for (const candidate of candidates) {
    const invokedAtMs = parseFiniteTimestamp(candidate.invokedAt);
    let attribution: InvocationArtifactAttribution | null = null;
    let attributionObservedAtMs = Number.NEGATIVE_INFINITY;
    for (const entry of attributions) {
      const observedAtMs = parseFiniteTimestamp(entry.observedAt);
      if (
        invokedAtMs === null ||
        observedAtMs === null ||
        observedAtMs > invokedAtMs ||
        observedAtMs < attributionObservedAtMs
      ) {
        continue;
      }
      if (
        observedAtMs === attributionObservedAtMs &&
        attribution &&
        entry.identityKey <= attribution.identityKey
      ) {
        continue;
      }
      attribution = entry;
      attributionObservedAtMs = observedAtMs;
    }
    candidate.gitBranch = attribution?.branchName ?? null;
    candidate.repositoryFullName = attribution?.repositoryFullName ?? null;
  }
}

function parseFiniteTimestamp(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function computeOversizedInvocationSetId(
  sessionId: string,
  items: readonly AgentComponentInvocationSyncItem[]
): string {
  const hash = createHash("sha256");
  hash.update("oversized-agent-component-invocations:v1\0");
  hash.update(sessionId);
  for (const item of items) {
    hash.update("\0");
    hash.update(JSON.stringify(item));
  }
  return hash.digest("hex");
}

/** One stored `events` row as the stored-row candidate rebuild reads it. */
type StoredEventRow = {
  id: string;
  agent_id: string | null;
  tool_name: string;
  data: string | null;
  created_at: string;
};
