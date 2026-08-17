/**
 * ISS-4810 / ISS-4811: PER-OCCURRENCE skill-shadow correlation, shared by the
 * transcript-reparse path (`commandCandidates`) and the stored-row rebuild
 * bridge (`storedCommandCandidates`).
 *
 * A slash-invoked SKILL (e.g. `/cl-ci-babysit`) yields BOTH a `<command-name>`
 * slash entry AND a `Skill` tool_use, so a session emits a Command candidate
 * keyed `/cl-ci-babysit` alongside the resolved Skill candidate keyed
 * `cl-ci-babysit`. No `.claude/commands/<name>.md` exists for a skill (its
 * entrypoint is `SKILL.md`), so that Command candidate can never resolve and
 * lingers as a phantom unresolved component (ISS-4775).
 *
 * ISS-4775 suppressed by SESSION-WIDE set membership: any command whose bare
 * name appeared anywhere in the session's skill keys was dropped. That swapped
 * the overcount for an UNDERCOUNT — a session with three `/foo` slash entries
 * but only two `foo` Skill invocations (a `/foo` the user escaped before the
 * Skill tool fired, or a live-watch import that has the `<command-name>` entry
 * but not yet its matching tool_use) dropped ALL THREE Command rows against two
 * Skill rows, while the session trace still showed three user turns invoking
 * `/foo`.
 *
 * Correlation is therefore per occurrence: each Skill invocation claims AT MOST
 * ONE slash invocation of the same bare name — the nearest one that precedes it
 * (the user types `/foo`, then the Skill tool fires), falling back to the
 * earliest unclaimed one when no candidate precedes it. Unclaimed slash
 * invocations survive, so the residual Command count always reconciles with the
 * derived user turns.
 *
 * Both call sites feed this one occurrence per SKILL INVOCATION THEY THEMSELVES
 * EMIT rather than the raw parser lists, so the suppression population is
 * exactly the surviving Skill rows: `session.skills` and a legacy `Skill`
 * tool_use describing the same invocation dedupe to ONE candidate, and counting
 * the raw lists would double-count that single invocation and over-suppress
 * again.
 */
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import type { AgentComponentInvocationCandidate } from "./component-invocation-row-writer.js";

/** One slash invocation, reduced to what shadow correlation needs. */
export type SkillShadowCommandOccurrence = {
  /** Component key with any leading `/` stripped — the skill's own spelling. */
  bareName: string;
  invokedAt: string | null;
  /**
   * True when this command resolved against its own `.claude/commands/<name>.md`
   * definition snapshot. A resolved `/foo` is a genuine command that happens to
   * share a bare name with a `foo` skill, so it is never a shadow and never
   * claimable — dropping it would undercount a correct Command row.
   */
  resolved: boolean;
};

/**
 * One Skill invocation, reduced to what shadow correlation needs. `bareName` is
 * the SKILL's own identity (`skillName` for a legacy `Skill` tool_use), which is
 * not always the emitted candidate's `componentKey` — a legacy tool_use carries
 * `normalizedName: "Skill"` (the TOOL identity) and keys its candidate off that,
 * yet the command it shadows is `/review`.
 */
export type SkillShadowSkillOccurrence = {
  bareName: string;
  invokedAt: string | null;
  /**
   * True when a SUBAGENT (not the session's main agent) invoked this skill.
   *
   * Slash invocations are attributed to the main agent on BOTH derivation paths
   * (`commandCandidates` keys them off `mainAgentId`; the stored-row bridge
   * emits them with no agent at all), so a subagent that independently invokes
   * `foo` is not evidence that the user's `/foo` turn was a skill shadow.
   * Letting it claim would delete a genuine user turn — the same undercount
   * ISS-4810 exists to prevent, arriving through agent ownership instead of
   * count skew. Derived from `parentAgentId`, which both paths populate for a
   * subagent-owned invocation and leave null for the main agent.
   */
  subagent: boolean;
};

type ClaimableCommand = {
  /** Index into the caller's command array. */
  index: number;
  invokedAt: string | null;
};

/**
 * The indexes (into `commands`) of the slash invocations shadowed by a Skill
 * invocation of the same bare name, paired one-to-one. Never returns more
 * indexes for a name than that name has skill occurrences.
 */
export function skillShadowedCommandIndexes(
  commands: readonly SkillShadowCommandOccurrence[],
  skills: readonly SkillShadowSkillOccurrence[]
): ReadonlySet<number> {
  const shadowed = new Set<number>();
  const claimableByName = groupClaimableCommands(commands);
  if (claimableByName.size === 0) {
    return shadowed;
  }
  for (const [bareName, claimable] of claimableByName) {
    claimCommands(claimable, skillOccurrencesFor(skills, bareName), shadowed);
  }
  return shadowed;
}

/**
 * The Skill invocations a candidate set emits. Usable only where the emitted
 * `componentKey` IS the skill identity — true of the stored-row bridge, whose
 * `classifyStoredTool` keys a `Skill` event off its `skillName`. The
 * transcript-reparse path records its occurrences at emission instead, because
 * a legacy `Skill` tool_use keys its candidate off the tool identity.
 */
export function skillShadowSkillOccurrences(
  candidates: readonly AgentComponentInvocationCandidate[]
): SkillShadowSkillOccurrence[] {
  const occurrences: SkillShadowSkillOccurrence[] = [];
  // ISS-4810 review: the suppression population must be the set of Skill rows
  // that SURVIVE, which is what `dedupeCandidates` keeps — one row per
  // `externalInvocationId`. The stored-row bridge feeds this raw `events` rows,
  // and the live hook writes a SEPARATE PreToolUse and PostToolUse row for one
  // tool call (both carry `tool_name`, both resolve to the same
  // `providerToolUseId`, and `deterministicEventId` keys on eventType so
  // neither collapses at insert). Counting both would let ONE skill invocation
  // claim TWO slash commands and re-introduce the undercount. Dedupe on the
  // same identity here so the population matches the surviving rows.
  const seenInvocationIds = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.componentKind !== AgentComponentInvocationKind.Skill) {
      continue;
    }
    if (seenInvocationIds.has(candidate.externalInvocationId)) {
      continue;
    }
    seenInvocationIds.add(candidate.externalInvocationId);
    occurrences.push({
      bareName: candidate.componentKey,
      invokedAt: candidate.invokedAt,
      subagent: candidate.parentAgentId !== null,
    });
  }
  return occurrences;
}

/** Strip the leading `/` a Command component key carries and a skill key does not. */
export function bareComponentName(componentKey: string): string {
  return componentKey.startsWith("/") ? componentKey.slice(1) : componentKey;
}

/**
 * ISO-8601 timestamps compare correctly as strings; a null timestamp sorts last
 * so an unordered occurrence never displaces a positioned one.
 */
function compareInvokedAt(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return left < right ? -1 : 1;
}

function groupClaimableCommands(
  commands: readonly SkillShadowCommandOccurrence[]
): Map<string, ClaimableCommand[]> {
  const grouped = new Map<string, ClaimableCommand[]>();
  for (const [index, command] of commands.entries()) {
    if (command.resolved) {
      continue;
    }
    const entry: ClaimableCommand = { index, invokedAt: command.invokedAt };
    const bucket = grouped.get(command.bareName);
    if (bucket) {
      bucket.push(entry);
    } else {
      grouped.set(command.bareName, [entry]);
    }
  }
  for (const bucket of grouped.values()) {
    bucket.sort((left, right) =>
      compareInvokedAt(left.invokedAt, right.invokedAt)
    );
  }
  return grouped;
}

/**
 * The main-agent Skill invocations of `bareName`, oldest first. Subagent-owned
 * invocations are excluded: slash invocations belong to the main agent on both
 * paths, so a subagent's own `foo` call is not evidence about the user's `/foo`
 * turn.
 */
function skillOccurrencesFor(
  skills: readonly SkillShadowSkillOccurrence[],
  bareName: string
): SkillShadowSkillOccurrence[] {
  const matching: SkillShadowSkillOccurrence[] = [];
  for (const skill of skills) {
    if (skill.bareName === bareName && !skill.subagent) {
      matching.push(skill);
    }
  }
  matching.sort((left, right) =>
    compareInvokedAt(left.invokedAt, right.invokedAt)
  );
  return matching;
}

function claimCommands(
  claimable: readonly ClaimableCommand[],
  skills: readonly SkillShadowSkillOccurrence[],
  shadowed: Set<number>
): void {
  const claimed = new Set<number>();
  for (const skill of skills) {
    const position = claimPosition(claimable, claimed, skill.invokedAt);
    if (position === null) {
      // Either every slash invocation of this name is already paired, or none
      // of the remaining ones may be claimed by THIS skill (it precedes them
      // all). Later skill occurrences are positioned differently, so keep
      // going rather than abandoning the name.
      continue;
    }
    claimed.add(position);
    const command = claimable[position];
    if (command) {
      shadowed.add(command.index);
    }
  }
}

/**
 * The unclaimed slash invocation this Skill invocation shadows: the nearest one
 * at or before the Skill's timestamp (`claimable` is timestamp-sorted, so the
 * last match wins).
 *
 * ISS-4810 review: the fallback to an unclaimed command is for MISSING position
 * only, never for a skill that is positioned strictly before every unclaimed
 * command. A `foo` Skill the model fired autonomously at 10:00, followed by a
 * `/foo` the user typed at 10:05 and escaped before the tool fired, must leave
 * that 10:05 Command row standing — claiming it forward in time would drop the
 * user turn, which is the exact undercount this change exists to fix, merely
 * with the timestamps reversed. So the fallback applies when the SKILL has no
 * timestamp (an unpositioned live-watch occurrence), or to a command that
 * itself has no timestamp; a fully-positioned pair is decided by order alone.
 */
function claimPosition(
  claimable: readonly ClaimableCommand[],
  claimed: ReadonlySet<number>,
  skillTimestamp: string | null
): number | null {
  let preceding: number | null = null;
  let earliestUnclaimed: number | null = null;
  let earliestUnpositioned: number | null = null;
  for (const [position, command] of claimable.entries()) {
    if (claimed.has(position)) {
      continue;
    }
    if (earliestUnclaimed === null) {
      earliestUnclaimed = position;
    }
    if (earliestUnpositioned === null && command.invokedAt === null) {
      earliestUnpositioned = position;
    }
    if (precedes(command.invokedAt, skillTimestamp)) {
      preceding = position;
    }
  }
  if (preceding !== null) {
    return preceding;
  }
  return skillTimestamp === null ? earliestUnclaimed : earliestUnpositioned;
}

function precedes(
  commandTimestamp: string | null,
  skillTimestamp: string | null
): boolean {
  if (commandTimestamp === null || skillTimestamp === null) {
    return false;
  }
  return commandTimestamp <= skillTimestamp;
}
