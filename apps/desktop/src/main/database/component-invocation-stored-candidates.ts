/**
 * ISS-4811: the stored-row rebuild bridge's command unit — the twin of
 * `component-invocation-command-candidates.ts` for sessions that CANNOT be
 * reparsed (source transcript gone, or parser output rejected). Extracted from
 * `component-invocations.ts` (grandfathered, shrink-only) so both halves of the
 * skill-shadow contract sit in cohesive sibling modules rather than growing that
 * file — see root AGENTS.md on touched grandfathered files.
 *
 * `storedBaseCandidate` lives here rather than in the materializer because it is
 * the stored-row candidate constructor every stored-* producer shares.
 */
import { ComponentResolvedState } from "@repo/api/src/types/agent-component";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import {
  commandUserTurnId,
  isAdmissibleCommandComponentKey,
  normalizeCommandComponentKey,
} from "@repo/lib/sessions/command-user-turn-id";
import {
  asRecord,
  parseRecord,
  stringValue,
} from "./component-invocation-json.js";
import type { AgentComponentInvocationCandidate } from "./component-invocation-row-writer.js";
import {
  bareComponentName,
  type SkillShadowSkillOccurrence,
  skillShadowedCommandIndexes,
} from "./component-invocation-skill-shadow.js";
import type { Prisma } from "./generated/client.js";

type InvocationKind = AgentComponentInvocationKind;

/**
 * ISS-4811: the stored-row twin of `commandCandidates`. It applies the SAME
 * per-occurrence skill-shadow correlation (`component-invocation-skill-shadow.ts`)
 * against the Skill rows `storedEventCandidates` emitted for this session, so a
 * transcript-less session reconstructed from stored rows converges on the same
 * invocation set a reparse would produce.
 *
 * A stored slash entry carries no `definitionSnapshot` of its own on most
 * sessions, so "this `/foo` is a genuine command that merely shares a bare name
 * with a `foo` skill" is proved by THREE witnesses, any one of which makes the
 * command unclaimable:
 *
 *  1. `hasDefinitionSnapshot` — the persisted entry did carry a resolving
 *     snapshot (`buildImportMetadata` writes the parser's value verbatim).
 *  2. `storedResolvedCommandKeys` (ISS-4778, #4247) — the durable inventory
 *     holds a `command` component with this key in `resolved_state = resolved`.
 *     Kept from the landed ISS-4778 carve-out; dropping it would re-suppress a
 *     resolved command whose evidence lives only in `agent_components`.
 *  3. `priorResolvedCommandKeys` — wongk (#4255): this session already proved
 *     the command genuine through `invocationDefinitionEvidence` (a prior row
 *     with a `definition_hash`). The rebuild used to load that evidence only
 *     AFTER candidates were built, so a real `/foo` sharing a bare name with a
 *     `foo` skill was dropped here and `preserveStrongerEvidence` never got the
 *     chance to restore it — the evidence arrived for a candidate that no
 *     longer existed. The caller now reads it first and passes it in, so exact
 *     prior evidence participates in the claimability decision instead of
 *     arriving too late to matter.
 */
export async function storedCommandCandidates(input: {
  tx: Pick<Prisma.TransactionClient, "$queryRawUnsafe">;
  sessionId: string;
  metadata: string | null;
  gitBranch: string | null;
  repositoryFullName: string | null;
  now: string;
  skillOccurrences: readonly SkillShadowSkillOccurrence[];
  priorResolvedCommandKeys: ReadonlySet<string>;
}): Promise<AgentComponentInvocationCandidate[]> {
  const {
    sessionId,
    gitBranch,
    repositoryFullName,
    now,
    skillOccurrences,
    priorResolvedCommandKeys,
  } = input;
  const commands = storedSlashCommands(input.metadata);
  const inventoryResolvedKeys = await storedResolvedCommandKeys(
    input.tx,
    commands.map((command) => normalizeCommandComponentKey(command.name))
  );
  // ISS-5260: computed ONCE so the inventory-evidence re-point reads exactly the
  // genuineness fact this correlation gates on, rather than a weaker proxy. All
  // three witnesses count, matching the transcript path's single one.
  const resolvedByIndex = commands.map(
    (command) =>
      command.hasDefinitionSnapshot ||
      inventoryResolvedKeys.has(normalizeCommandComponentKey(command.name)) ||
      priorResolvedCommandKeys.has(normalizeCommandComponentKey(command.name))
  );
  const shadowed = skillShadowedCommandIndexes(
    commands.map((command, index) => ({
      bareName: bareComponentName(normalizeCommandComponentKey(command.name)),
      invokedAt: command.timestamp,
      resolved: resolvedByIndex[index] ?? false,
    })),
    skillOccurrences
  );
  return commands.flatMap((command, index) => {
    if (shadowed.has(index)) {
      return [];
    }
    const componentKey = normalizeCommandComponentKey(command.name);
    // ISS-4796: same admission gate as the live derivation
    // (`component-invocation-command-candidates.ts`), so the stored-row rebuild
    // bridge cannot re-admit a placeholder the live path rejected.
    if (!isAdmissibleCommandComponentKey(componentKey)) {
      return [];
    }
    const userTurnId = commandUserTurnId(command, index);
    const candidate = storedBaseCandidate({
      sessionId,
      externalInvocationId: userTurnId,
      externalSourceId: command.userTurnId,
      agentId: null,
      parentAgentId: null,
      componentKind: AgentComponentInvocationKind.Command,
      componentKey,
      rawName: command.name,
      normalizedName: componentKey,
      invokedAt: command.timestamp,
      sourceOrder: 200_000 + index,
      anchorKind: AgentComponentInvocationAnchorKind.UserTurn,
      anchorValue: userTurnId,
      gitBranch,
      repositoryFullName,
      now,
    });
    candidate.commandDefinitionWitness = resolvedByIndex[index] ?? false;
    return [candidate];
  });
}

export function storedBaseCandidate(input: {
  sessionId: string;
  externalInvocationId: string;
  externalSourceId: string | null;
  childSessionId?: string | null;
  agentId: string | null;
  parentAgentId: string | null;
  componentKind: InvocationKind;
  componentKey: string;
  rawName: string | null;
  normalizedName: string | null;
  invokedAt: string | null;
  sourceOrder: number;
  anchorKind: string;
  anchorValue: string;
  providerToolUseId?: string | null;
  gitBranch: string | null;
  repositoryFullName: string | null;
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
    relationship: input.childSessionId
      ? AgentComponentInvocationRelationship.ChildSession
      : AgentComponentInvocationRelationship.Direct,
    invokedAt: input.invokedAt,
    sourceOrder: input.sourceOrder,
    sequence: 0,
    anchorKind: input.anchorKind,
    anchorValue: input.anchorValue,
    providerToolUseId: input.providerToolUseId ?? null,
    attributionStatus: AgentComponentInvocationAttributionStatus.Unresolved,
    evidenceClass: AgentComponentInvocationEvidenceClass.None,
    evidencePointer: null,
    definitionHash: null,
    normalizerContractVersion: null,
    definitionContent: null,
    localComponentId: null,
    localComponentVersionId: null,
    gitBranch: input.gitBranch,
    repositoryFullName: input.repositoryFullName,
    // Stored-row rebuild derives from events/agents/command metadata, which
    // never yields Hook candidates — the only kind that carries a success fact —
    // so a reconstructed candidate has no success signal.
    succeeded: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function storedSlashCommands(metadata: string | null): Array<{
  name: string;
  timestamp: string;
  userTurnId: string | null;
  /**
   * ISS-4811: whether the persisted slash entry carried its own RESOLVING
   * `.claude/commands/<name>.md` snapshot. `buildImportMetadata` persists the
   * parser's `NormalizedSlashCommand` verbatim, so this is the same
   * resolved-command signal the transcript-reparse path gates suppression on.
   *
   * wongk (#4255): `definitionSnapshot` is persisted JSON, so object PRESENCE
   * is not the same fact as a snapshot that actually resolves — an empty `{}`
   * (or a partially-written one) would otherwise mark a phantom Command
   * "resolved" and preserve exactly the row ISS-4775 exists to drop. Validate
   * the full `NormalizedDefinitionSnapshot` shape instead, and require
   * non-empty `content`: a snapshot with no content resolved to nothing.
   */
  hasDefinitionSnapshot: boolean;
}> {
  const parsed = parseRecord(metadata);
  const commands = parsed?.slashCommands;
  if (!Array.isArray(commands)) {
    return [];
  }
  return commands.flatMap((value) => {
    const record = asRecord(value);
    const name = stringValue(record?.name);
    const timestamp = stringValue(record?.timestamp);
    return name && timestamp
      ? [
          {
            name,
            timestamp,
            userTurnId: stringValue(record?.userTurnId),
            hasDefinitionSnapshot: resolvesDefinitionSnapshot(
              record?.definitionSnapshot
            ),
          },
        ]
      : [];
  });
}

/**
 * Does this persisted `definitionSnapshot` actually resolve its command?
 *
 * wongk (#4255): the stored path reads untrusted persisted JSON, so it must
 * validate the full `NormalizedDefinitionSnapshot` shape rather than trust
 * object presence. Every field the parser emits must be a string, and `content`
 * must be non-empty — an empty or half-written snapshot resolved to nothing and
 * must NOT protect a phantom Command from skill-shadow suppression.
 * (`capturedAt` is nullable in the contract, so it is not required here.)
 */
function resolvesDefinitionSnapshot(value: unknown): boolean {
  const snapshot = asRecord(value);
  if (!snapshot) {
    return false;
  }
  const content = stringValue(snapshot.content);
  return (
    stringValue(snapshot.kind) !== null &&
    stringValue(snapshot.rawName) !== null &&
    stringValue(snapshot.normalizedName) !== null &&
    content !== null &&
    content.length > 0
  );
}

/**
 * The command component keys this session already proved genuine, read from its
 * prior invocation rows.
 *
 * wongk (#4255): a `definition_hash` on an existing Command row is exact
 * evidence that `/foo` resolved against a real `.claude/commands/foo.md` — the
 * durable twin of the transcript path's `definitionSnapshot`. A command with
 * that evidence is never a skill shadow, even when a `foo` skill shares its
 * bare name, so it must never be claimable. Structurally typed over the raw row
 * so the grandfathered materializer keeps its private row type.
 */
export function priorResolvedCommandKeys(
  rows: readonly {
    component_kind: string;
    component_key: string;
    definition_hash: string | null;
  }[]
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    if (
      row.component_kind === AgentComponentInvocationKind.Command &&
      row.definition_hash
    ) {
      keys.add(row.component_key);
    }
  }
  return keys;
}

/**
 * ISS-4778 (#4247): the component keys among `componentKeys` that the durable
 * inventory records as a RESOLVED `command` — the stored-row witness that a
 * slash entry really did resolve against a `.claude/commands/<name>.md`.
 *
 * Carried over verbatim from the landed ISS-4778 suppression when ISS-4811
 * replaced its session-wide set membership with per-occurrence correlation: the
 * correlation changed WHICH occurrence is claimed, not which commands are
 * genuine, so this witness stays.
 */
async function storedResolvedCommandKeys(
  tx: Pick<Prisma.TransactionClient, "$queryRawUnsafe">,
  componentKeys: string[]
): Promise<ReadonlySet<string>> {
  const unique = [...new Set(componentKeys)];
  if (unique.length === 0) {
    return new Set<string>();
  }
  const placeholders = unique.map((_, index) => `$${index + 3}`).join(", ");
  const rows = await tx.$queryRawUnsafe<{ component_key: string }[]>(
    `SELECT component_key
       FROM agent_components
      WHERE component_kind = $1
        AND resolved_state = $2
        AND component_key IN (${placeholders})`,
    AgentComponentInvocationKind.Command,
    ComponentResolvedState.Resolved,
    ...unique
  );
  return new Set(rows.map((row) => row.component_key));
}

/**
 * ISS-4592/ISS-5099: the stored-row twin of the parser lane's subagent
 * candidates. Moved here from `component-invocations.ts` (grandfathered,
 * shrink-only) alongside its ISS-5099 spawn-claim repair below.
 */
export async function storedAgentCandidates(
  tx: Prisma.TransactionClient,
  sessionId: string,
  gitBranch: string | null,
  repositoryFullName: string | null,
  now: string
): Promise<AgentComponentInvocationCandidate[]> {
  const agents = await tx.$queryRawUnsafe<
    {
      id: string;
      parent_agent_id: string | null;
      subagent_type: string | null;
      name: string | null;
      started_at: string | null;
      metadata: string | null;
    }[]
  >(
    `SELECT id, parent_agent_id, subagent_type, name, started_at, metadata
       FROM agents
      WHERE session_id = $1 AND type = 'subagent'
      ORDER BY started_at, id`,
    sessionId
  );
  return agents.map((agent, index) => {
    const metadata = parseRecord(agent.metadata);
    const key = agent.subagent_type ?? "general-purpose";
    const externalAgentId = stringValue(metadata?.nativeSubagentId);
    const transcriptFileId = stringValue(metadata?.transcriptFileId);
    const childSessionId = stringValue(metadata?.childSessionId);
    const candidate = storedBaseCandidate({
      sessionId,
      externalInvocationId: `subagent:${agent.id}`,
      externalSourceId: externalAgentId,
      childSessionId,
      agentId: agent.id,
      parentAgentId: agent.parent_agent_id,
      componentKind: AgentComponentInvocationKind.Subagent,
      componentKey: key,
      rawName: agent.name ?? key,
      normalizedName: key,
      invokedAt: agent.started_at,
      sourceOrder: 300_000 + index,
      anchorKind: AgentComponentInvocationAnchorKind.Agent,
      anchorValue: agent.id,
      gitBranch,
      repositoryFullName,
      now,
    });
    if (externalAgentId || transcriptFileId) {
      candidate.evidencePointer = {
        ...(externalAgentId ? { externalAgentId } : {}),
        ...(transcriptFileId ? { transcriptFileId } : {}),
      };
    }
    return candidate;
  });
}

/**
 * ISS-5099 (wongk review): re-derive which delegation each stored subagent
 * candidate belongs to, from the DURABLE `Agent`/`Task` spawn event, before the
 * missing-source bridge seals the session at the current `DATA_REVISION`.
 *
 * Without this the bridge is a one-way seal over a known-bad state. A session
 * sealed with the pre-fix mispair stores a cross-paired parser row (carrying
 * the WRONG delegation's `provider_tool_use_id`) beside an ISS-5098-nulled row
 * for the delegation that was actually claimed. `storedAgentCandidates` rebuilds
 * subagent candidates from the surviving `agents` rows and carries no delegation
 * identity at all, so `restoreStableInvocationIdentities` had nothing better to
 * offer than the stored — wrong — pairing, which it copied back onto the
 * candidate. The bridge then stamped the new revision and nothing selected the
 * session again: the mispair became permanent, and the nulled row's identity was
 * lost with it.
 *
 * The join that fixes it is already durable and needs no transcript. Write-core
 * re-points the delegation's `PreToolUse` event at the SURVIVING parser agent
 * row (see `write-core.ts`, ISS-4592), and `importToolEventData` records that
 * tool use's `providerToolUseId ?? id` — i.e. its `delegationClaimKey` — in the
 * event payload. So `events.agent_id` × the event's provider tool use id IS the
 * (delegation → subagent) pairing, surviving in local rows after the transcript
 * is gone. Stamping it back onto the candidate lets the bridge seal the CORRECT
 * pairing rather than freeze the wrong one.
 *
 * A subagent whose spawn events disagree on the delegation is left alone: that
 * is corrupt input, and the same trust-boundary rule `buildSubagentDedupIndex`
 * applies makes "no claim" the safe reading, not "the last one wins".
 */
export function applyStoredSpawnClaimKeys(
  subagentCandidates: AgentComponentInvocationCandidate[],
  storedEventCandidates: readonly AgentComponentInvocationCandidate[],
  delegationToolNames: ReadonlySet<string>
): void {
  const claimKeyByAgentId = new Map<string, string>();
  const ambiguousAgentIds = new Set<string>();
  for (const event of storedEventCandidates) {
    const { agentId, providerToolUseId, rawName } = event;
    if (!(agentId && providerToolUseId && rawName)) {
      continue;
    }
    if (!delegationToolNames.has(rawName)) {
      continue;
    }
    const existing = claimKeyByAgentId.get(agentId);
    if (existing !== undefined && existing !== providerToolUseId) {
      ambiguousAgentIds.add(agentId);
      continue;
    }
    claimKeyByAgentId.set(agentId, providerToolUseId);
  }
  for (const candidate of subagentCandidates) {
    if (!candidate.agentId || ambiguousAgentIds.has(candidate.agentId)) {
      continue;
    }
    const claimKey = claimKeyByAgentId.get(candidate.agentId);
    if (claimKey) {
      candidate.providerToolUseId = claimKey;
    }
  }
}
