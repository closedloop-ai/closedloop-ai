/**
 * @file launch-attribution.ts
 * @description ISS-7259: the ONE normalized shape for harness-stamped attribution
 * about how a session came to run, shared by the Claude and Codex parsers.
 *
 * The two harnesses speak different vocabularies — Claude stamps
 * `attributionSkill: "cl-produce"` per assistant turn, Codex stamps
 * `thread_source` / `agent_role` once on `session_meta` — and neither is
 * internally consistent enough to adopt wholesale, so they are normalized here
 * and a consumer reads one shape without branching on harness.
 *
 * The two halves are NOT equally strong evidence, and the member names say so.
 * Codex's `threadSource` / `agentRole` / `parentThreadId` are genuine SPAWN
 * facts: the harness states them once, at session start, about how the thread
 * was created. Claude's {@link HarnessLaunchAttribution.firstAttributedSkill} is
 * not — it is the earliest per-turn attribution in the file, which may sit deep
 * inside the session. Do not write a consumer that treats the two as
 * interchangeable "launched by" evidence.
 *
 * NOT to be confused with `resolveSessionAttribution`
 * (apps/desktop/src/main/agent-sync/agent-session-attribution.ts), which resolves
 * the ClosedLoop ARTIFACT a session was launched against from a `launch-metadata.json`
 * sidecar. That answers "which ticket"; this answers "which agent or skill".
 */

/**
 * Whether the harness said this thread was started by a person or spawned by
 * another agent.
 *
 * `Unstated` and `Unknown` are two different facts and are kept apart on purpose.
 * `Unstated` means the harness stamped no thread source at all — the case for
 * every Claude transcript today, which carries skill attribution but no spawn
 * discriminator. `Unknown` means it stamped one this build does not recognise.
 * Collapsing them would make a harness that renamed its values look identical to
 * one that never emitted them, and these are open sets owned by upstream
 * Claude/Codex, so an unfamiliar value is expected rather than exceptional.
 */
export const LaunchThreadSource = {
  User: "user",
  Subagent: "subagent",
  Unstated: "unstated",
  Unknown: "unknown",
} as const;

export type LaunchThreadSource =
  (typeof LaunchThreadSource)[keyof typeof LaunchThreadSource];

/**
 * A normalized account of what launched one session. Every member is optional and
 * OMITTED when unknown rather than serialized as `null`: this rides the desktop →
 * cloud wire, where a version-skewed reader must be able to tell "this build did
 * not capture it" from "the harness said it was empty".
 */
export type HarnessLaunchAttribution = {
  /**
   * Normalized user-vs-agent spawn.
   *
   * REQUIRED, and the only required member — which is load-bearing twice over.
   * It makes this a closed shape rather than an all-optional one that
   * `Record<string, unknown>` structurally satisfies, so the worker boundary's
   * `UnknownPayloadCoverageOf` guard can tell a bounded facet from an arbitrary
   * payload. And it means a facet always answers the spawn question, with
   * {@link LaunchThreadSource.Unstated} as the honest answer when the harness
   * never asked it — never by omitting the key and leaving a reader to guess.
   */
  threadSource: LaunchThreadSource;
  /**
   * Claude `attributionSkill` from the EARLIEST record in the transcript that
   * carried one SHORT ENOUGH TO RECORD — a name past
   * {@link MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS} is not a skill name, and is
   * skipped in favour of the next one that is, rather than emptying the member.
   *
   * Named for what it is, because it is weaker than "the skill that launched
   * this session" and must not be read as that. The harness stamps
   * `attributionSkill` per assistant turn and never marks a launch, and in this
   * repo's own frozen corpus the first stamped turn is routinely deep inside the
   * session — record 251 of 381 in dossier
   * `4eba5e9a-6b1e-473a-9882-3c1c06cc32ce`, record 146 of 413 in
   * `3870c244-d8be-4a45-9d1a-2c5bf2b0d38f`. So "launched by X" and "ran
   * unattributed for 200 turns, then invoked X" produce an identical value here.
   * ISS-7508 added the POSITION that at least tells those two apart
   * ({@link firstAttributedRecordIndex} over {@link observedRecordCount}); it
   * does NOT make "launched by" derivable, and neither does this member.
   */
  firstAttributedSkill?: string;
  /**
   * How many DISTINCT `attributionSkill` values the transcript carried.
   *
   * Present whenever {@link firstAttributedSkill} is, and NEVER without it,
   * because one value alone reads as "the only one" and that is not always true
   * — 6 of 60 sampled transcripts carried more than one. `1` means exactly one
   * skill was ever attributed in this session; higher means the recorded one is
   * merely the earliest. It says nothing about which skill launched anything.
   *
   * It counts only skills the record can NAME: a value past
   * {@link MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS} never enters the count, so the
   * number can never assert a skill this facet is unable to identify. Both
   * halves of that co-presence rule are enforced in
   * {@link buildHarnessLaunchAttribution}, not left to each producer.
   */
  observedSkillCount?: number;
  /**
   * ISS-7508. The 1-BASED ordinal of the record that supplied
   * {@link firstAttributedSkill}, within the records the scan processed.
   *
   * It exists because the NAME alone cannot answer the question a reader asks of
   * it. `attributionSkill` is stamped per assistant turn and never marks a
   * launch, so "launched by X" and "ran unattributed for 200 turns, then invoked
   * X" produce the identical name; the position is what tells them apart. In this
   * repo's own frozen corpus the first attributed record sits at 251 of 381 in
   * dossier `4eba5e9a-6b1e-473a-9882-3c1c06cc32ce` and 146 of 413 in
   * `3870c244-d8be-4a45-9d1a-2c5bf2b0d38f`, and NOT ONE of the 105 scanned
   * transcripts carried an attribution on its first record.
   *
   * That last fact is the reason this is a position and not a launcher: "launched
   * by" REMAINS UNDERIVABLE for Claude. This member lets a consumer judge how far
   * in the first attribution sat — and so how weak the name is as launch evidence
   * — it does not repair the name into a launch fact. A reader wanting "the skill
   * that started this session" still has no signal here, and inventing one from a
   * low index would be a guess.
   *
   * Codex never populates this: it stamps no per-turn skill, and its genuine
   * launch facts ({@link agentRole}, {@link parentThreadId}) ride `session_meta`
   * at record 1 instead.
   */
  firstAttributedRecordIndex?: number;
  /**
   * How many records the scan processed in that transcript — the denominator
   * that makes {@link firstAttributedRecordIndex} legible ("251 of 381").
   *
   * Without it an index is unreadable: record 251 is late in a 381-record session
   * and early in a 4000-record one. It counts the records that reached the
   * session-attribute pass, so `firstAttributedRecordIndex <= observedRecordCount`
   * always holds — a resume/compaction replay or a malformed line is skipped
   * before either is touched, and so is absent from both.
   */
  observedRecordCount?: number;
  /**
   * Claude `promptSource` of the first user turn (`typed`, `sdk`, `system`,
   * `queued`). Deliberately a bounded string rather than a closed union: the
   * value set is owned by upstream Claude Code, so an unrecognised one is
   * recorded verbatim rather than mapped onto a member this build invented.
   */
  promptSource?: string;
  /** Codex `agent_role` — the role the spawning agent assigned this thread. */
  agentRole?: string;
  /** Codex `agent_nickname` — the harness's generated codename for the thread. */
  agentNickname?: string;
  /** Codex `thread_spawn.parent_thread_id` — the thread that spawned this one. */
  parentThreadId?: string;
  /** Codex `thread_spawn.depth` — `1` for a direct child of a user thread. */
  depth?: number;
};

/**
 * Claude `promptSource` meaning the prompt was produced by a driver rather than
 * typed by a person.
 *
 * `queued` is NOT here: it is a person queueing their own turns while the agent
 * works. `system` is not either — it is unattributed rather than stated
 * non-human, and admitting it would let this assert on a guess.
 */
const DRIVER_INJECTED_PROMPT_SOURCE = "sdk";

/**
 * Whether the harness itself STATED that nobody was attending this run.
 *
 * Two statements qualify, and both are spawn/authorship facts rather than
 * inferences: the thread was spawned by another agent, or the first prompt was
 * injected by a driver instead of typed. Neither can be true of a person's
 * hands-on session, which is the bar `permissionMode` failed — an interactive
 * operator routinely skips permissions, so that leg could assert a human session
 * was autonomous. `firstAttributedSkill` is excluded for the reason its own
 * docstring gives: it is a per-turn stamp, not a statement about the launch.
 */
export function isAgentDrivenLaunch(
  attribution: HarnessLaunchAttribution | undefined
): boolean {
  if (!attribution) {
    return false;
  }
  return (
    attribution.threadSource === LaunchThreadSource.Subagent ||
    attribution.promptSource === DRIVER_INJECTED_PROMPT_SOURCE
  );
}

const KNOWN_LAUNCH_THREAD_SOURCES: ReadonlySet<string> = new Set(
  Object.values(LaunchThreadSource)
);

function isLaunchThreadSource(value: string): value is LaunchThreadSource {
  return KNOWN_LAUNCH_THREAD_SOURCES.has(value);
}

/**
 * Map a raw harness `thread_source` onto a member.
 *
 * Absent, non-string, and empty become {@link LaunchThreadSource.Unstated}; an
 * unrecognised non-empty value becomes {@link LaunchThreadSource.Unknown} rather
 * than throwing, because this runs inside a parse that must not fail a whole
 * session over one unfamiliar word.
 */
export function normalizeLaunchThreadSource(
  value: unknown
): LaunchThreadSource {
  if (typeof value !== "string" || value.length === 0) {
    return LaunchThreadSource.Unstated;
  }
  return isLaunchThreadSource(value) ? value : LaunchThreadSource.Unknown;
}

/**
 * Ceiling for the identifier-like string members (`skill`, `promptSource`,
 * `agentRole`, `agentNickname`, `parentThreadId`).
 *
 * These are meant to be short tokens — the longest real values observed are a
 * 40-char agent role and a 36-char UUID — so the generic 8 KB short-text cap the
 * worker boundary applies to free-form fields like `gitBranch` is the wrong
 * bound here. Without a tight one, a malformed or hostile transcript could put
 * kilobytes of task text into `attributionSkill` or `agent_role` and reach cloud
 * metadata through a field nobody reads as free text — smuggling in through the
 * front door that excluding `agent_path` closed. An over-long value is dropped
 * rather than truncated: a clipped identifier is not a shorter identifier, it is
 * a different one, and a wrong attribution is worse than a missing one.
 */
export const MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS = 128;

/** The optional half of the facet — everything except the required spawn word. */
type HarnessLaunchAttributionParts = Omit<
  HarnessLaunchAttribution,
  "threadSource"
> & { threadSource?: LaunchThreadSource };

/**
 * Assemble a facet from individually-optional parts, dropping every absent member
 * and returning `undefined` when the harness said nothing worth recording.
 *
 * Both parsers route through here so two rules are enforced in one place. Absent
 * members are OMITTED rather than serialized as `null`, because this rides the
 * desktop → cloud wire where the two must stay distinguishable. And a bare
 * `Unstated` spawn word does not on its own make a facet: were it to, every
 * session in the corpus would gain one, every metadata blob would change, and the
 * byte-identity that keeps unattributed sessions off the re-import path would be
 * lost for a fact that says nothing.
 */
export function buildHarnessLaunchAttribution(
  parts: HarnessLaunchAttributionParts
): HarnessLaunchAttribution | undefined {
  const { threadSource, ...rest } = parts;
  // The numbers about the skill and the name itself are a documented set, and the
  // value cap can drop the name while the numbers sail through — they are not
  // strings. An orphan number asserts a skill was observed and cannot say which,
  // which no reader can tell from a genuine one. Producers are expected not to
  // offer the set broken (the Claude parser excludes an over-long skill before it
  // is ever counted or positioned), but this is the choke point BOTH parsers
  // route through, so the invariant is enforced where it cannot be bypassed. A
  // skill-dependent number is never ADDED rather than added and removed, because
  // this facet's contract is omission — a key present with an undefined value
  // would not satisfy it.
  const skillRecorded = isRecordableFacetValue(rest[SKILL_NAME_KEY]);
  const optional: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (!isRecordableFacetValue(value)) {
      continue;
    }
    if (SKILL_DEPENDENT_KEYS.has(key) && !skillRecorded) {
      continue;
    }
    optional[key] = value;
  }
  const statedSpawn =
    threadSource !== undefined && threadSource !== LaunchThreadSource.Unstated;
  if (Object.keys(optional).length === 0 && !statedSpawn) {
    return;
  }
  return {
    threadSource: threadSource ?? LaunchThreadSource.Unstated,
    ...optional,
  };
}

/**
 * The skill NAME, as a key.
 *
 * `satisfies keyof HarnessLaunchAttribution` rather than a bare literal so that
 * renaming the member fails typecheck here, instead of silently turning the
 * co-presence guard above into a lookup that never matches.
 */
const SKILL_NAME_KEY =
  "firstAttributedSkill" satisfies keyof HarnessLaunchAttribution;

/**
 * Every member that describes the recorded skill and is meaningless without it —
 * how many distinct skills were seen, and where the recorded one sat.
 *
 * A SET rather than one key because ISS-7508 added a second and a third: each
 * says something ABOUT a skill this facet must be able to name, so each is
 * dropped by the same rule. Every entry carries the same
 * `satisfies keyof HarnessLaunchAttribution` protection as {@link SKILL_NAME_KEY}
 * — a renamed member fails typecheck rather than quietly falling out of the set
 * and shipping as an orphan number.
 */
const SKILL_DEPENDENT_KEYS: ReadonlySet<string> = new Set([
  "observedSkillCount" satisfies keyof HarnessLaunchAttribution,
  "firstAttributedRecordIndex" satisfies keyof HarnessLaunchAttribution,
  "observedRecordCount" satisfies keyof HarnessLaunchAttribution,
]);

/**
 * Whether a value is one this facet can carry: stated, non-empty, and — for the
 * identifier-like strings — within {@link MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS}.
 *
 * Shared by the member loop and the skill-pair check so the two can never
 * disagree about what "recorded" means.
 */
function isRecordableFacetValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") {
    return false;
  }
  return !(
    typeof value === "string" &&
    value.length > MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS
  );
}
