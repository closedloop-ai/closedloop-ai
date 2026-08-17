/**
 * ISS-4775: slash-invoked-skill / command reconciliation for the invocation
 * materializer. Extracted from `component-invocations.ts` to keep that
 * (grandfathered, shrink-only) module from growing — see root AGENTS.md on
 * touched grandfathered files. `commandCandidates` and its skill-shadow
 * suppression live here as a single cohesive unit.
 */

import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import {
  commandUserTurnId,
  isAdmissibleCommandComponentKey,
  normalizeCommandComponentKey,
} from "@repo/lib/sessions/command-user-turn-id";
import type { AgentComponentInvocationCandidate } from "./component-invocation-row-writer.js";
import {
  bareComponentName,
  type SkillShadowSkillOccurrence,
  skillShadowedCommandIndexes,
} from "./component-invocation-skill-shadow.js";
import type {
  MarkdownCandidateFn,
  ToolCandidateContext,
} from "./component-invocations.js";

/**
 * ISS-4775 / ISS-4810: a slash-invoked SKILL yields BOTH a `<command-name>`
 * slash entry AND a Skill tool_use, so the transcript emits a Command candidate
 * keyed `/cl-ci-babysit` alongside the resolved Skill candidate keyed
 * `cl-ci-babysit`. That Command candidate can never resolve (a skill's
 * entrypoint is `SKILL.md`, not `.claude/commands/<name>.md`) and lingers as a
 * phantom unresolved component, so it is suppressed — but only PER OCCURRENCE,
 * paired against `skillOccurrences` (one per Skill row this same derivation
 * emits), so three `/foo` slash entries against two `foo` Skill invocations keep
 * the unpaired third Command row. See `component-invocation-skill-shadow.ts` for
 * the correlation contract; the stored-row rebuild bridge applies the identical
 * helper (ISS-4811) so both paths converge on the same invocation set.
 */
export function commandCandidates(
  context: ToolCandidateContext,
  markdownCandidate: MarkdownCandidateFn,
  skillOccurrences: readonly SkillShadowSkillOccurrence[]
): AgentComponentInvocationCandidate[] {
  const { session, mainAgentId, now } = context;
  const keyed = (session.slashCommands ?? []).map((command) => ({
    command,
    componentKey: normalizeCommandComponentKey(
      command.normalizedName ?? command.name
    ),
  }));
  // A `/foo` that DID resolve against a real `.claude/commands/foo.md` (carrying
  // a `definitionSnapshot`) is a genuine command that happens to share a bare
  // name with a `foo` skill; dropping it would undercount a correct Command row,
  // so it is never claimable.
  //
  // ISS-5260: computed ONCE and stamped onto the emitted candidate as
  // `commandDefinitionWitness`, because the inventory-evidence re-point needs the
  // SAME fact and cannot re-derive it. `definitionHash`/`definitionContent` are
  // NOT a usable proxy: `exactEvidence` only populates them when the snapshot's
  // un-normalized `normalizedName` equals the NORMALIZED component key, so a
  // `//deploy` entry carrying a real snapshot (the leading-slash-run population
  // ISS-4795 documented) has neither, and a re-point reading only those would
  // fold the very command this flag protects.
  const resolvedByIndex = keyed.map(
    ({ command }) => command.definitionSnapshot != null
  );
  const shadowed = skillShadowedCommandIndexes(
    keyed.map(({ command, componentKey }, index) => ({
      bareName: bareComponentName(componentKey),
      invokedAt: command.timestamp,
      resolved: resolvedByIndex[index] ?? false,
    })),
    skillOccurrences
  );
  return keyed.flatMap(({ command, componentKey }, index) => {
    if (shadowed.has(index)) {
      return [];
    }
    // ISS-4796: a truncated command-palette display string (`/...`, `/…`) is
    // not a command name. Reject it HERE, at the ingest boundary, so it never
    // mints an inventory component — a placeholder admitted as a real record
    // sorts to the top of the Commands tab, inflates its count, and resolves to
    // a detail page with no definition.
    if (!isAdmissibleCommandComponentKey(componentKey)) {
      return [];
    }
    const externalInvocationId = commandUserTurnId(command, index);
    return [
      withCommandDefinitionWitness(
        markdownCandidate({
          session,
          mainAgentId,
          externalInvocationId,
          externalSourceId: command.userTurnId ?? null,
          providerToolUseId: null,
          componentKind: AgentComponentInvocationKind.Command,
          componentKey,
          rawName: command.rawName ?? command.name,
          normalizedName: componentKey,
          invokedAt: command.timestamp,
          sourceOrder: 200_000 + index,
          agentId: mainAgentId,
          parentAgentId: null,
          relationship: AgentComponentInvocationRelationship.Direct,
          anchorKind: AgentComponentInvocationAnchorKind.UserTurn,
          anchorValue: externalInvocationId,
          snapshot: command.definitionSnapshot,
          focusedEvidence:
            context.evidenceByInvocationId.get(externalInvocationId),
          externalAgentId: null,
          parentExternalInvocationId: null,
          now,
        }),
        resolvedByIndex[index] ?? false
      ),
    ];
  });
}

/**
 * ISS-5260: stamp the "this slash entry carried its own resolving definition"
 * fact onto the candidate so the inventory-evidence re-point and the
 * per-occurrence correlation decide genuineness from ONE expression. Transient —
 * `insertInvocationRows` maps an explicit column list, so it is never persisted.
 */
function withCommandDefinitionWitness(
  candidate: AgentComponentInvocationCandidate,
  witness: boolean
): AgentComponentInvocationCandidate {
  candidate.commandDefinitionWitness = witness;
  return candidate;
}
