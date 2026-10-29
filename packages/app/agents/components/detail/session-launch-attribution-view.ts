import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import {
  LaunchThreadSource,
  MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS,
  normalizeLaunchThreadSource,
} from "@repo/lib/harness/launch-attribution";
import { asRecord } from "@repo/lib/harness/type-guards";

/**
 * ISS-7259: the read-time view model for the persisted harness launch-attribution
 * facet (`metadata.harnessLaunchAttribution`), assembled from the session
 * `metadata` blob that both the cloud sync and the desktop local read carry
 * through unchanged — so one selector serves web AND desktop.
 *
 * Every member is independently nullable because the two harnesses populate
 * DISJOINT halves: Codex states spawn facts on `session_meta`, Claude states a
 * per-turn skill and nothing else. An all-or-nothing shape would blank one
 * harness to satisfy the other.
 *
 * The producer already caps and omits; this re-reads defensively anyway because
 * the blob is untyped, cloud-synced and version-skewed by the time it arrives —
 * a malformed or over-long value coerces to null per-field rather than reaching
 * a row.
 */
export type SessionLaunchAttributionView = {
  /**
   * The spawn word the harness actually STATED, or null.
   *
   * {@link LaunchThreadSource.Unstated} never survives into this member, and
   * that is the whole point of it being nullable: "the harness never asked" is
   * not a fact worth a row, while `Unknown` — the harness stated a word this
   * build does not recognise — is, because it tells the reader this build is
   * behind rather than that the run was ordinary. Collapsing the two would make
   * a renamed upstream value look identical to one that was never emitted.
   */
  threadSource: LaunchThreadSource | null;
  /** Codex `agent_role` — the role the spawning agent assigned this thread. */
  agentRole: string | null;
  /** Codex `agent_nickname` — the harness's generated codename for the thread. */
  agentNickname: string | null;
  /** Codex `thread_spawn.depth` — `1` for a direct child of a user thread. */
  depth: number | null;
  /**
   * Claude's EARLIEST per-turn `attributionSkill`. Deliberately not named or
   * rendered as "launched by": see {@link SESSION_LAUNCH_ATTRIBUTION_SKILL_LABEL}.
   */
  firstAttributedSkill: string | null;
  /** How many DISTINCT skills the transcript attributed. */
  observedSkillCount: number | null;
  /** 1-based ordinal of the record that supplied the skill. */
  firstAttributedRecordIndex: number | null;
  /** Records the scan processed — the denominator that makes the index legible. */
  observedRecordCount: number | null;
  /** Claude `promptSource` of the first user turn (`typed`, `sdk`, ...). */
  promptSource: string | null;
};

/**
 * The skill row's label.
 *
 * It says FIRST ATTRIBUTED, never "launched by", and that wording is load-bearing
 * rather than cautious. `packages/lib/harness/launch-attribution.ts` records that
 * Claude stamps `attributionSkill` per assistant turn and never marks a launch,
 * that in this repo's own frozen corpus the first stamped turn sits at record 251
 * of 381 and 146 of 413, and that NOT ONE of 105 scanned transcripts carried an
 * attribution on its first record. So "launched by X" and "ran unattributed for
 * 200 turns, then invoked X" produce an identical value here. A label promising
 * the launcher would turn a hedge into a fact on screen, which is precisely the
 * collapse the capture side refused to make.
 */
export const SESSION_LAUNCH_ATTRIBUTION_SKILL_LABEL = "First attributed skill";

/**
 * How a stated spawn word reads on the row.
 *
 * `Unknown` reads "Unknown", the same word the Status row two rows up already
 * uses for the same class of fact — this build did not recognise what the
 * producer said. A second vocabulary for one meaning inside one panel makes a
 * reader work out whether "Unrecognized" and "Unknown" are different findings.
 * It ships with {@link LAUNCH_THREAD_SOURCE_UNKNOWN_EXPLANATION} for the same
 * reason the Status row ships a tooltip: the bare word names our limitation and
 * would otherwise read as a fact about the run.
 *
 * `Unstated` never reaches a reader — {@link statedThreadSource} nulls it and
 * the row is skipped — but the key is required for the exhaustive `Record`,
 * which is what makes adding a member to `LaunchThreadSource` fail `tsc` here
 * instead of rendering `undefined`.
 */
export const LAUNCH_THREAD_SOURCE_LABELS: Readonly<
  Record<LaunchThreadSource, string>
> = {
  [LaunchThreadSource.User]: "User-started",
  [LaunchThreadSource.Subagent]: "Agent-spawned",
  [LaunchThreadSource.Unknown]: "Unknown",
  [LaunchThreadSource.Unstated]: "Not stated",
};

/**
 * Why the Thread row can say "Unknown" — our limitation, and ONLY that.
 *
 * It names what this build failed to read and stops there. The earlier wording
 * also said "The session is ordinary", which is a claim about the RUN that an
 * unread word cannot support: an unrecognised value is most likely a mode added
 * after this build shipped, and that mode may itself be agent-spawned or
 * otherwise not ordinary. Asserting it turned our own gap into a reassurance,
 * and contradicted {@link SessionLaunchAttributionView.threadSource}, whose
 * docstring keeps `Unknown` separate from `Unstated` precisely so the row says
 * this build is behind RATHER than that the run was ordinary.
 */
export const LAUNCH_THREAD_SOURCE_UNKNOWN_EXPLANATION =
  "The harness stated how this thread began, in a word this build does not recognise. The word may name a launch mode added after it shipped; this build is behind.";

/**
 * How a Claude `promptSource` reads on the row.
 *
 * A map with VERBATIM FALLBACK, not a closed union: the value set is owned by
 * upstream Claude Code, and the capture side deliberately records an
 * unrecognised one as-is rather than mapping it onto a member we invented. So
 * this names the four observed values and passes anything else through
 * untranslated — {@link formatPromptSource}. Shipping them all raw would put
 * `sdk` and `queued` on a user's screen as our internals; mapping them to a
 * closed union would drop the fifth value upstream adds tomorrow.
 */
const PROMPT_SOURCE_LABELS: Readonly<Record<string, string>> = {
  typed: "Typed by a person",
  sdk: "Injected by the SDK",
  system: "Sent by the system",
  queued: "Queued",
};

/** A prompt source in words, or the raw value when upstream added one we do not know. */
export function formatPromptSource(promptSource: string): string {
  return PROMPT_SOURCE_LABELS[promptSource] ?? promptSource;
}

/**
 * Assemble the view model from the untyped session metadata blob, or null when
 * the session carries no launch attribution at all — so every pre-ISS-7259
 * payload, and every session whose harness stamped nothing, renders no rows
 * rather than a block of em-dashes.
 */
export function extractSessionLaunchAttribution(
  metadata: AgentSessionDetail["metadata"]
): SessionLaunchAttributionView | null {
  const facet = asRecord(asRecord(metadata)?.harnessLaunchAttribution);
  if (!facet) {
    return null;
  }
  const threadSource = statedThreadSource(facet.threadSource);
  const firstAttributedSkill = boundedString(facet.firstAttributedSkill);
  // The numbers describing the skill are dropped with the name they describe.
  // The producer enforces this co-presence too, but a version-skewed or
  // hand-edited blob reaches here without passing through it, and an orphan
  // "1 of 3 skills" asserts skills were observed while naming none — a count no
  // reader can tell from a genuine one.
  const position = firstAttributedSkill
    ? legiblePosition(
        facet.firstAttributedRecordIndex,
        facet.observedRecordCount
      )
    : NO_ATTRIBUTED_POSITION;
  const view: SessionLaunchAttributionView = {
    threadSource,
    agentRole: boundedString(facet.agentRole),
    agentNickname: boundedString(facet.agentNickname),
    depth: nonNegativeInteger(facet.depth),
    firstAttributedSkill,
    observedSkillCount: firstAttributedSkill
      ? positiveInteger(facet.observedSkillCount)
      : null,
    firstAttributedRecordIndex: position.firstAttributedRecordIndex,
    observedRecordCount: position.observedRecordCount,
    promptSource: boundedString(facet.promptSource),
  };
  return hasAnyStatedMember(view) ? view : null;
}

/**
 * Whether the view carries at least one fact worth a row. A facet whose every
 * member coerced away — an unrecognized shape, or one whose only member was the
 * `Unstated` spawn word — must render nothing rather than an empty group.
 */
function hasAnyStatedMember(view: SessionLaunchAttributionView): boolean {
  return Object.values(view).some((value) => value !== null);
}

/**
 * A STATED spawn word, or null when the harness stated none.
 *
 * Routed through the capture side's own {@link normalizeLaunchThreadSource}
 * rather than a whitelist re-declared here, and that is a correctness rule and
 * not tidiness. A local whitelist takes `unknown`-typed input, so an upstream
 * value this build has not been taught — a newly added member, or a newer
 * desktop syncing a word an older web deploy never heard — falls off the end of
 * the disjunction and returns null, which this module's consumer renders as NO
 * ROW: byte-identical to `Unstated`. That is exactly the collapse the member's
 * docstring above forbids, and unlike the sibling label map it would not fail
 * `tsc`, so nothing would announce it. The canonical normalizer maps any
 * unrecognised stated word to {@link LaunchThreadSource.Unknown}, so the row
 * survives and says this build is behind.
 */
function statedThreadSource(value: unknown): LaunchThreadSource | null {
  const source = normalizeLaunchThreadSource(value);
  return source === LaunchThreadSource.Unstated ? null : source;
}

/**
 * A short identifier-like string, or null.
 *
 * The ceiling is the capture side's own {@link MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS}
 * rather than a second number declared here, so the read can never admit a value
 * the write refused. Over-long is DROPPED, not truncated, for the same reason the
 * producer drops it: a clipped identifier is a different identifier, and a wrong
 * attribution on screen is worse than an absent one.
 */
function boundedString(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS
    ? value
    : null;
}

/**
 * The skill row split into what stays ON SCREEN and what becomes the row's
 * `explanation` — the hedge sentence, which `PropertyValue` renders into both a
 * tooltip and the accessible name.
 *
 * The split exists because the panel's value track is a fixed `minmax(0, 1fr)`
 * that ellipsises, and the qualifier was overflowing it: a realistic skill name
 * plus `(record 251 of 381, 1 of 3 skills)` clipped mid-number, leaving exactly
 * the bare name that the position exists to stop a reader from trusting. The
 * hedge cannot live only in a hover tooltip either, so the POSITION — the one
 * fact that separates "launched by X" from "invoked X on turn 251" — stays
 * inline and short, and the count and the caveat go to `explanation`, which is
 * reachable by keyboard and read aloud rather than hover-only.
 */
export function formatAttributedSkill(
  attribution: SessionLaunchAttributionView
): {
  value: string;
  explanation: string;
} | null {
  const skill = attribution.firstAttributedSkill;
  if (skill === null) {
    return null;
  }
  const position =
    attribution.firstAttributedRecordIndex !== null &&
    attribution.observedRecordCount !== null
      ? ` (record ${attribution.firstAttributedRecordIndex} of ${attribution.observedRecordCount})`
      : "";
  const count =
    attribution.observedSkillCount === null
      ? ""
      : ` It is 1 of ${attribution.observedSkillCount} skill${attribution.observedSkillCount === 1 ? "" : "s"} attributed in this session.`;
  return {
    value: `${skill}${position}`,
    explanation: `${ATTRIBUTED_SKILL_CAVEAT}${count}`,
  };
}

/**
 * The sentence that keeps the skill name from reading as the launcher.
 *
 * Stated once, here, because it is the same caveat the capture side spends its
 * own docstring on: `attributionSkill` is stamped per assistant turn and never
 * marks a launch, so a name alone cannot answer the question a reader asks of it.
 */
const ATTRIBUTED_SKILL_CAVEAT =
  "The harness stamps this per turn and never marks a launch, so it names the earliest skill attributed in the transcript, not what started the session.";

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

/** The position members absent — the qualifier is skipped rather than guessed. */
const NO_ATTRIBUTED_POSITION: Pick<
  SessionLaunchAttributionView,
  "firstAttributedRecordIndex" | "observedRecordCount"
> = { firstAttributedRecordIndex: null, observedRecordCount: null };

/**
 * The record position as a PAIR, or neither half.
 *
 * The ordinal and its denominator are one fact — "record 251 of 381" — and the
 * facet's contract is that the index never exceeds the count, because both are
 * drawn from the same counter. Validating each number alone accepts a pair that
 * is individually well-formed and jointly impossible: `{ index: 251, count: 3 }`
 * clears both `positiveInteger` bounds and renders `record 251 of 3`, an
 * attribution positioned past the end of its own transcript, which reads as a
 * late attribution in a tiny session — plausible, wrong, and indistinguishable
 * from a real value on the one row whose whole job is to stop a skill name being
 * trusted as the launcher.
 *
 * The worker boundary's {@link checkAttributionPositionPair} rejects that pair
 * on the way IN, and that protects nothing here: this reads a cloud-synced,
 * untyped `metadata` blob that a version-skewed producer or a hand edit can
 * reach without passing through any producer at all. Same invariant, restated on
 * the read because the read is its own trust boundary.
 *
 * Both halves go rather than one, matching the producer's own rule that they
 * ship together: an index with no denominator is unreadable (record 251 is late
 * in a 381-record session and early in a 4000-record one) and a denominator with
 * no index asserts a scan whose result is missing. Dropping to no qualifier is
 * the honest degrade — the skill row still renders with its caveat, and nothing
 * on screen states a position that never existed. Neither number is repaired,
 * clamped, or swapped: a corrected position is a fabricated one.
 */
function legiblePosition(
  rawIndex: unknown,
  rawCount: unknown
): Pick<
  SessionLaunchAttributionView,
  "firstAttributedRecordIndex" | "observedRecordCount"
> {
  const index = positiveInteger(rawIndex);
  const count = positiveInteger(rawCount);
  if (index === null || count === null || index > count) {
    return NO_ATTRIBUTED_POSITION;
  }
  return { firstAttributedRecordIndex: index, observedRecordCount: count };
}
