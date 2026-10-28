import {
  buildHarnessLaunchAttribution,
  type HarnessLaunchAttribution,
  MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS,
} from "../launch-attribution";
import {
  asRecord,
  baseName,
  boundedStringValue,
  collectArtifacts,
  countValue,
  isMeaningfulCwd,
  stringValue,
  toIso,
} from "../parser-utils";
import type {
  NormalizedCompaction,
  NormalizedSession,
  NormalizedSkillUse,
  NormalizedToolUse,
} from "../types";
import { createNormalizedSession, emptyUsageExtras } from "../types";
import { foldDedupMap } from "../usage-dedup";
import { extractDedupedUsage } from "./claude-usage";
import { attachComponentUsage } from "./component-usage-attribution";
import {
  forkParentSessionId,
  isForkReplayedRecord,
  isLineageReplayedRecord,
} from "./fork-replay";
import {
  API_ERROR_MAX_CHARS,
  ClaudeRecordType,
  createSessionAccumulator,
  type ParseSessionLogger,
  type SessionAccumulator,
} from "./parse-claude-accumulator";
import { processAssistantRecord } from "./parse-claude-assistant";
import {
  attachDefinitionSnapshot,
  deriveSkills,
} from "./parse-claude-definitions";
import { applyDelegationToSubagent } from "./parse-claude-delegations";
import {
  countUnknownRecordType,
  reportUnknownRecords,
} from "./parse-claude-drift";
import {
  processAiTitleRecord,
  processAttachmentRecord,
  processFileHistorySnapshotRecord,
  processLastPromptRecord,
  processModeRecord,
  processPermissionModeRecord,
  processPrLinkRecord,
  processQueueOperationRecord,
  processSystemRecord,
  processWorktreeStateRecord,
} from "./parse-claude-metadata";
import { normalizeSidechainSubagentId } from "./parse-claude-subagents";
import { processUserRecord } from "./parse-claude-user";
import { isReplayedTranscriptEntry } from "./replayed-entry";

/**
 * Record types this parser has SEEN and deliberately decodes nothing from.
 *
 * ONE inventory, and it must stay that way: {@link processRecord} skips these,
 * and {@link collectSessionAttributes} refuses them as a `sessionKind` source.
 * Naming a member in either place instead of reading this set lets the two
 * drift (ISS-10593).
 *
 * No attribute-level drift detection runs for these, because nothing is read.
 * Giving one a real handler owes a `collectUnknownAttributes` call, a
 * known-attribute set, and removal from here.
 *
 * `bridge-session` and `artifact-autoreact-ledger` are undecoded as a
 * REQUIREMENT, not as unfinished work: both carry third-party Anthropic account
 * or organization UUIDs that may never be persisted or reported.
 */
const UNDECODED_RECORD_TYPES: ReadonlySet<string> = new Set<string>([
  ClaudeRecordType.Relocated,
  ClaudeRecordType.AgentSetting,
  ClaudeRecordType.AgentName,
  ClaudeRecordType.CustomTitle,
  ClaudeRecordType.FileHistoryDelta,
  ClaudeRecordType.AtisLatch,
  ClaudeRecordType.BridgeSession,
  ClaudeRecordType.FrameLink,
  ClaudeRecordType.ArtifactCommentMonitor,
  ClaudeRecordType.ArtifactAutoreactLedger,
]);

/**
 * Handle one parsed record.
 *
 * Session attributes are gathered from every record regardless of `type`, then
 * anything this parser does not decode is TALLIED. The count is reported once at
 * the end of the parse rather than per record: the fact is constant per type,
 * and a transcript can carry thousands of one kind.
 */
function processRecord(
  record: Record<string, unknown>,
  accumulator: SessionAccumulator
): void {
  // ISS-8659: decided ONCE per record and passed down, rather than re-derived at
  // each tallying site. One verdict per record is what keeps the gated sites
  // consistent with each other — a call and the result answering it must agree,
  // or a kept result joins a dropped call — and an explicit parameter forces a
  // new handler to take a position instead of silently inheriting "counted".
  const replayed =
    isForkReplayedRecord(record) ||
    isLineageReplayedRecord(record, accumulator.lineageReplay);
  collectSessionAttributes(record, accumulator, replayed);

  const type = stringValue(record.type);

  // Every case below is a `type` this parser has seen. Anything reaching
  // `default` is a record kind it has not — a harness that has moved on — which
  // is a different problem from a type we know about but have not finished
  // decoding.
  switch (type) {
    case ClaudeRecordType.Assistant:
      processAssistantRecord(record, accumulator, replayed);
      break;
    case ClaudeRecordType.User:
      processUserRecord(record, accumulator, replayed);
      break;
    case ClaudeRecordType.Attachment:
      processAttachmentRecord(record, accumulator, replayed);
      break;
    case ClaudeRecordType.AiTitle:
      processAiTitleRecord(record, accumulator);
      break;
    case ClaudeRecordType.LastPrompt:
      processLastPromptRecord(record, accumulator);
      break;
    case ClaudeRecordType.Mode:
      processModeRecord(record, accumulator);
      break;
    case ClaudeRecordType.PermissionMode:
      processPermissionModeRecord(record, accumulator);
      break;
    case ClaudeRecordType.PrLink:
      processPrLinkRecord(record, accumulator, replayed);
      break;
    case ClaudeRecordType.FileHistorySnapshot:
      processFileHistorySnapshotRecord(record, accumulator);
      break;
    case ClaudeRecordType.System:
      processSystemRecord(record, accumulator, replayed);
      break;
    case ClaudeRecordType.QueueOperation:
      processQueueOperationRecord(record, accumulator);
      break;
    case ClaudeRecordType.WorktreeState:
      processWorktreeStateRecord(record, accumulator);
      break;
    default:
      // An UNDECODED_RECORD_TYPES member lands here too, and must not be
      // counted: the no-op is a decision about a type we have seen, not a
      // harness that has moved on. The tail below still runs for it.
      if (type === null || !UNDECODED_RECORD_TYPES.has(type)) {
        countUnknownRecordType(record, accumulator);
      }
      break;
  }

  // LAST, deliberately: the harness emits a definition's exact body in a
  // following record, so the call or command it belongs to is only registered
  // once the dispatch above has run.
  attachDefinitionSnapshot(record, accumulator);
}

/**
 * Gather one record's session-level metadata into the accumulator.
 *
 * Runs for EVERY record regardless of `type` — these fields are stamped across
 * the whole transcript rather than carried by one record kind, so a session
 * whose first line is a `user` turn states them just as a session-start record
 * would.
 */
function collectSessionAttributes(
  record: Record<string, unknown>,
  accumulator: SessionAccumulator,
  replayed: boolean
): void {
  // ISS-7508. FIRST, before any early return below can skip it: this counter is
  // both the transcript's record total and the source of each record's own
  // ordinal, so a record that states no readable timestamp still occupies a
  // position. Counting here rather than in the caller's loop is what keeps the
  // ordinal aligned with what this pass actually READ — a malformed line, or one
  // the resume/compaction filter dropped, never reaches this function and so
  // never consumes a position.
  //
  // ISS-8659: a FORK-replayed record does reach it, and does consume one. It is
  // deliberately not gated: this is a census of what was read, not a tally of
  // what the session did, and the fork genuinely read those lines. Keeping it
  // whole is also what keeps it consistent with the attribution ordinal below,
  // which is gated — "record 155 of 184" then truthfully says the fork's own
  // first attributed record sits 155 lines into a 184-line transcript.
  accumulator.observedRecordCount += 1;

  // Captured OUTSIDE the replay gate, because only a replayed record carries the
  // stamp — gating this would make a fork's lineage unknowable.
  accumulator.forkParentSessionId ??=
    forkParentSessionId(record) ??
    (replayed ? (accumulator.lineageReplay?.parentSessionId ?? null) : null);

  // First-wins throughout: a later record restating a field cannot revise it.
  // `cwd` additionally has to be MEANINGFUL — a harness launched from a daemon
  // context records `/` on its first turn before the agent moves into the real
  // worktree, and recording that would resolve the repository to "/".
  if (!accumulator.cwd) {
    const cwd = stringValue(record.cwd);
    if (isMeaningfulCwd(cwd)) {
      accumulator.cwd = cwd;
    }
  }
  accumulator.version ??= stringValue(record.version);
  accumulator.slug ??= stringValue(record.slug);
  accumulator.gitBranch ??= stringValue(record.gitBranch);
  accumulator.entrypoint ??= stringValue(record.entrypoint);
  accumulator.permissionMode ??= stringValue(record.permissionMode);
  // ISS-7258: stamped on every record kind, not one, so it belongs here with the
  // other session-level facts rather than in any single handler.
  //
  // EXCEPT every `UNDECODED_RECORD_TYPES` member: letting one be the first-wins
  // source of a session-level fact would have the session described by a record
  // the parser has decided not to read. Read the SET — naming a member here goes
  // stale the next time that group grows (ISS-10593). The bound is the same one
  // the worker boundary enforces: over-cap here would reject the whole source
  // there.
  const recordType = stringValue(record.type);
  if (recordType === null || !UNDECODED_RECORD_TYPES.has(recordType)) {
    accumulator.sessionKind ??= boundedStringValue(record.sessionKind);
  }

  // ISS-7259: launch attribution. `attributionSkill` rides only on `assistant`
  // records and `promptSource` only on `user` ones, but both are collected here
  // rather than in those handlers for the reason this function exists — a field
  // stamped across the transcript is a fact about the SESSION, and reading it
  // where every record passes keeps first-wins meaning "earliest in the file"
  // rather than "earliest of the type that handler happened to see".
  // A skill too long to record is excluded HERE rather than dropped later by the
  // facet builder's cap. `observedSkillCount` is derived from this set, so
  // admitting a value the record can never name would make the count assert a
  // skill it cannot identify — and a reader cannot tell that from a genuine
  // count. Excluding it at the source keeps the count measuring exactly what the
  // record can name, and lets a later, nameable skill still be the first one.
  // ISS-8659: first-wins over the fork's OWN records only. A replayed record
  // states how the PARENT was launched, and inheriting it made every fork report
  // its parent's launch skill as its own.
  const attributionSkill = replayed
    ? null
    : stringValue(record.attributionSkill);
  if (
    attributionSkill &&
    attributionSkill.length <= MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS
  ) {
    // ISS-7508: the POSITION is captured in the same statement as the name, so
    // it can only ever point at the record whose value was actually kept. Taking
    // it anywhere else — at the top of this function, or before the cap check —
    // would let a skipped over-long skill donate its ordinal to the skill that
    // replaced it, and the facet would then report an attribution as earlier
    // than it was.
    if (accumulator.firstAttributionSkill === null) {
      accumulator.firstAttributionSkill = attributionSkill;
      accumulator.firstAttributionSkillRecordIndex =
        accumulator.observedRecordCount;
    }
    accumulator.attributionSkills.add(attributionSkill);
  }
  if (!replayed) {
    accumulator.firstPromptSource ??= stringValue(record.promptSource);
  }

  // Accumulated rather than first-wins: a session can be stamped with more than
  // one team, and each is a fact about the session.
  const teamName = stringValue(record.teamName);
  if (teamName) {
    accumulator.teams.add(teamName);
  }

  collectRecordFaults(record, accumulator, replayed);

  // The span widens to cover every timestamped record. ISO 8601 orders lexically,
  // so the comparison needs no Date parse.
  const timestamp = toIso(record.timestamp);
  if (!timestamp) {
    // ISS-6738 (whitlockk): separate "carried something unreadable" from "carried
    // nothing". Only the former is a drift signal — see
    // `SessionAccumulator.unreadableTimestamps` for why a silent drop here can
    // cost the whole transcript and then loop.
    if (record.timestamp !== undefined && record.timestamp !== null) {
      accumulator.unreadableTimestamps += 1;
    }
    return;
  }
  // ISS-8659: the fork's span is its OWN work. A replayed record carries the
  // parent's original timestamp, so widening to it dragged `startedAt` back to
  // the parent's first line — on the `aff9f567` dossier, reporting a 1.5-minute
  // session as 35 minutes, and feeding that overstatement to runtime, activity
  // segments and the heatmap.
  widenSpan(accumulator, timestamp, replayed);
}

/**
 * Widen the session's span to cover `timestamp`, into the replayed span when the
 * record is a fork replay and the real one otherwise. The two are never merged;
 * `SessionAccumulator.replayedStartedAt` says what the replayed one is for.
 */
function widenSpan(
  accumulator: SessionAccumulator,
  timestamp: string,
  replayed: boolean
): void {
  if (replayed) {
    if (
      !accumulator.replayedStartedAt ||
      timestamp < accumulator.replayedStartedAt
    ) {
      accumulator.replayedStartedAt = timestamp;
    }
    if (
      !accumulator.replayedEndedAt ||
      timestamp > accumulator.replayedEndedAt
    ) {
      accumulator.replayedEndedAt = timestamp;
    }
    return;
  }
  if (!accumulator.startedAt || timestamp < accumulator.startedAt) {
    accumulator.startedAt = timestamp;
  }
  if (!accumulator.endedAt || timestamp > accumulator.endedAt) {
    accumulator.endedAt = timestamp;
  }
}

/**
 * Collect what a record reports about itself, whatever its type: API errors, the
 * compaction marker, and (ISS-7258) the `compact_boundary` scalars that describe
 * one.
 *
 * API errors arrive in two shapes — a flagged record whose message content holds
 * the text, and a raw error object at the message level — and both must be
 * caught or a rate-limited session looks clean. A compaction summary marks where
 * the runtime discarded earlier context, which is what makes the surrounding
 * turn counts explicable; the boundary record carrying its scalars is a separate
 * record entirely, which is why `collectCompactBoundary` is called here rather
 * than folded into the `isCompactSummary` branch above it.
 */
function collectRecordFaults(
  record: Record<string, unknown>,
  accumulator: SessionAccumulator,
  replayed: boolean
): void {
  // ISS-8659: a replayed compaction or API error happened to the PARENT. Counting
  // it here reported the parent's rate-limit as this session's, and its
  // compaction marker as a gap in a timeline that never had one.
  if (replayed) {
    return;
  }
  const timestamp = toIso(record.timestamp);

  if (record.isCompactSummary) {
    accumulator.compactions.push({
      uuid: stringValue(record.uuid),
      // `toIso`, not `stringValue`: the harness may stamp an epoch NUMBER here,
      // and rejecting it would leave the compaction marker off the timeline.
      timestamp: toIso(record.timestamp),
    });
  }

  collectCompactBoundary(record, accumulator);

  if (record.isApiErrorMessage) {
    const content = asRecord(record.message).content;
    const first = asRecord(Array.isArray(content) ? content[0] : undefined);
    accumulator.apiErrors.push({
      type: stringValue(record.error) ?? "unknown_error",
      message:
        typeof first.text === "string"
          ? first.text.slice(0, API_ERROR_MAX_CHARS)
          : "Unknown error",
      timestamp,
    });
  }

  const message = asRecord(record.message ?? record);
  if (message.type === "error" && message.error) {
    const error = asRecord(message.error);
    accumulator.apiErrors.push({
      type: stringValue(error.type) ?? "unknown_error",
      message: stringValue(error.message) ?? "Unknown API error",
      timestamp,
    });
  }
}

/**
 * The session's display name, derived from what the transcript revealed about
 * where it ran. The project comes from the working directory, falling back to
 * the slug and then to a truncated session id; the slug, when present, is what
 * distinguishes two sessions in the same project. Used only when the harness
 * supplied no `ai-title` of its own.
 */
function deriveSessionName(
  accumulator: SessionAccumulator,
  sessionId: string
): string {
  const shortId = sessionId.slice(0, 8);
  // ISS-6576: each token appears at most once. The suffixes exist to
  // DISAMBIGUATE the project, so they are only earned when something else
  // supplied it: `(slug)` when the cwd named the project, `- shortId` when the
  // cwd did. Without a cwd the slug IS the project, and appending it to itself
  // rendered `only-slug (only-slug)`; with neither, `Session abcdef12` already
  // carries the short id and rendered `Session abcdef12 - abcdef12`. Reachable
  // in production because `collectSessionAttributes` refuses a non-meaningful
  // cwd via `isMeaningfulCwd`, so a daemon-launched session recording `/` has
  // no cwd here.
  if (!accumulator.cwd) {
    return accumulator.slug ?? `Session ${shortId}`;
  }
  const project = baseName(accumulator.cwd);
  return accumulator.slug
    ? `${project} (${accumulator.slug})`
    : `${project} - ${shortId}`;
}

/** How much of a transcript was actually readable, line by line. */
export type ClaudeParseQuality = {
  totalLines: number;
  malformedLines: number;
  truncatedFinalLine: boolean;
};

/**
 * FEA-1459. A session's billable round-trips, derived once from the dedup map.
 *
 * ISS-5426. `tokensByModel` and `tokenSeries` are handed over MUTABLE on purpose: the
 * desktop importer merges each delegated agent's file into them before the
 * session is built. `assistantMessages` is snapshotted here instead, because it
 * counts this transcript's own turns and must not move when an agent's file is
 * merged in.
 */
export type ClaudeSessionUsage = {
  tokensByModel: NormalizedSession["tokensByModel"];
  tokenSeries: NormalizedSession["tokenSeries"];
  messageTimestamps: string[];
  assistantMessages: number;
  /** Dedup keys already billed here, so a second source cannot bill them again. */
  billedKeys: Set<string>;
};

/**
 * Read every line into the accumulator, and report what was readable.
 *
 * A malformed FINAL line is the benign shape of a truncated in-progress write;
 * a malformed line anywhere earlier silently drops that turn's messages and
 * token usage with no other trace, so the two stay distinguishable. Blank lines
 * are skipped and not counted.
 */
export async function scanTranscriptLines(
  lines: AsyncIterable<string> | Iterable<string>,
  accumulator: SessionAccumulator
): Promise<ClaudeParseQuality> {
  // FEA-3453: on resume or compaction the harness rewrites earlier lines VERBATIM into the
  // continued log. Scoped to this transcript: an agent's own file gets its own.
  const seenEntryUuids = new Set<string>();
  let totalLines = 0;
  let malformedLines = 0;
  let lastLineMalformed = false;
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    totalLines++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines++;
      lastLineMalformed = true;
      continue;
    }
    // `JSON.parse` succeeds for `null`, a scalar and an array — all legal JSON,
    // none of them a transcript record. Casting straight to `Record` asserted a
    // shape nothing had checked, and a `null` line then crashed the scan on its
    // first property read. This is a narrowing guard rather than a Zod schema on
    // purpose: it runs per line of a streaming parse, and the question is only
    // whether the value is an object at all, not what fields it carries.
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      malformedLines++;
      // ISS-6576: counted malformed, but NOT a truncated final line. That flag
      // means "the writer was cut off mid-line", which callers discount as a
      // benign partial write. A COMPLETE `null`, scalar, or array line parsed
      // fine — it is corruption, and reporting it as truncation invites the
      // wrong response. Assigned false rather than merely left alone, so a
      // preceding parse failure cannot leak through as this line's verdict.
      lastLineMalformed = false;
      continue;
    }
    const record = parsed as Record<string, unknown>;
    lastLineMalformed = false;
    // BEFORE any accumulation, so a replayed line contributes to nothing.
    if (isReplayedTranscriptEntry(seenEntryUuids, record)) {
      continue;
    }
    processRecord(record, accumulator);
  }
  // ISS-8659: applied here rather than at either caller's `!startedAt` test, so
  // the lib parser and the desktop shell cannot disagree about what counts as an
  // unreadable transcript.
  if (!accumulator.startedAt && accumulator.replayedStartedAt) {
    accumulator.startedAt = accumulator.replayedStartedAt;
    accumulator.endedAt = accumulator.replayedEndedAt;
  }
  // A fork that has not produced an assistant turn of its own yet still ran on
  // the model its inherited conversation shows. Reporting null there would hide
  // a model the session demonstrably used; reporting it over the fork's OWN id
  // is the defect this guards, which is why it is a fallback and not a merge.
  accumulator.model ??= accumulator.replayedModel;
  return { totalLines, malformedLines, truncatedFinalLine: lastLineMalformed };
}

/**
 * FEA-1459: one API turn spans many records sharing a `message.id` and repeating
 * the same usage snapshot, so the dedup map — not the record count — is the unit
 * of a billable round-trip. Both the token totals and the assistant-turn count
 * come from it, which is what keeps the two consistent.
 */
export function deriveSessionUsage(
  accumulator: SessionAccumulator
): ClaudeSessionUsage {
  const dedupedUsage = extractDedupedUsage(accumulator.assistantUsageRecords);
  const usage = foldDedupMap(dedupedUsage);
  const messageTimestamps: string[] = [];
  for (const entry of dedupedUsage.values()) {
    if (entry.firstTs) {
      messageTimestamps.push(entry.firstTs);
    }
  }
  return {
    tokensByModel: usage.tokensByModel,
    tokenSeries: usage.tokenSeries,
    messageTimestamps,
    assistantMessages: dedupedUsage.size,
    billedKeys: new Set(dedupedUsage.keys()),
  };
}

/** The lines this transcript authored itself, before any agent file is merged. */
export function ownDiffStats(
  accumulator: SessionAccumulator
): NormalizedSession["diffStats"] {
  if (accumulator.diffFiles.size === 0) {
    return null;
  }
  return {
    filesChanged: accumulator.diffFiles.size,
    linesAdded: accumulator.totalAdded,
    linesRemoved: accumulator.totalRemoved,
  };
}

/**
 * Turn a finished accumulator into a session.
 *
 * Call this only once every source that contributes to the session has been
 * read — on desktop that includes each delegated agent's own file, which is
 * merged into `usage` and `diffStats` before this runs.
 */
export function buildSession(
  accumulator: SessionAccumulator,
  options: {
    sessionId: string;
    parseQuality: ClaudeParseQuality;
    usage: ClaudeSessionUsage;
    diffStats: NormalizedSession["diffStats"];
    fileModifiedAt?: number | null;
  }
): NormalizedSession {
  // Agents this transcript created inline can be reconciled straight away — they
  // are already in the map, keyed on the same normalized id the delegation names.
  for (const delegation of accumulator.delegations) {
    if (!delegation.agentId) {
      continue;
    }
    const spawned = accumulator.subagents.get(
      normalizeSidechainSubagentId(delegation.agentId, delegation.agentId)
    );
    if (spawned) {
      applyDelegationToSubagent(spawned, delegation);
    }
  }

  // A real assistant-reported id always wins. The `/model` echo label fills in
  // only when no assistant record supplied one — otherwise the session would
  // report an unknown model despite the user having named it.
  const modelIsFallback =
    accumulator.model === null && accumulator.modelSwitchLabel !== null;

  // ISS-7259/ISS-7508: every number about the skill is emitted only alongside the
  // skill, so none can read as "zero skills observed" or "attributed at record 0"
  // on a session that simply stated none.
  const claudeLaunchAttribution = buildHarnessLaunchAttribution({
    ...claudeSkillAttributionParts(accumulator),
    ...(accumulator.firstPromptSource
      ? { promptSource: accumulator.firstPromptSource }
      : {}),
  });

  // ISS-7795: attributed BEFORE the session is assembled, so the skill and
  // command entries the invocation materializer reads already carry the token
  // counts the harness reported for their own turns.
  const skills = deriveSessionSkills(accumulator);
  attachComponentUsage(
    skills,
    accumulator.slashCommands,
    accumulator.assistantUsageRecords
  );

  return createNormalizedSession({
    sessionId: options.sessionId,
    // The harness's own title when it supplied one — that is the label a user
    // saw and will search for. The cwd/slug derivation is the fallback for a
    // transcript that carries no `ai-title` record.
    name:
      accumulator.aiTitle ?? deriveSessionName(accumulator, options.sessionId),
    cwd: accumulator.cwd,
    version: accumulator.version,
    slug: accumulator.slug,
    gitBranch: accumulator.gitBranch,
    startedAt: accumulator.startedAt,
    endedAt: accumulator.endedAt,
    permissionMode: accumulator.permissionMode,
    // A transcript predating the field is a plain Claude Code run.
    entrypoint: accumulator.entrypoint ?? "claude",
    model: accumulator.model ?? accumulator.modelSwitchLabel,
    // Emitted ONLY when true. Absent is the common case, and stamping `false`
    // would change the payload of every session that never used a fallback.
    ...(modelIsFallback ? { modelIsFallback: true } : {}),
    // ISS-7259: omitted entirely when the transcript stated no attribution, so a
    // session that carries none round-trips byte-identically.
    ...(claudeLaunchAttribution
      ? { harnessLaunchAttribution: claudeLaunchAttribution }
      : {}),
    // ISS-8659: stamped only when this transcript actually carried a fork replay,
    // so a root session omits it and round-trips byte-identically. The Claude
    // twin of `codexForkedFromId`; the `forked` lifecycle fact reads both.
    ...(accumulator.forkParentSessionId
      ? { claudeForkedFromSessionId: accumulator.forkParentSessionId }
      : {}),
    fileModifiedAt: options.fileModifiedAt ?? null,
    userMessages: accumulator.userMessageCount,
    messages: accumulator.messages,
    slashCommands: accumulator.slashCommands,
    toolResultErrors: accumulator.toolResultErrors,
    thinkingBlockCount: accumulator.thinkingBlockCount,
    assistantMessages: options.usage.assistantMessages,
    tokensByModel: options.usage.tokensByModel,
    tokenSeries: options.usage.tokenSeries,
    messageTimestamps: options.usage.messageTimestamps,
    usageExtras: {
      ...emptyUsageExtras(),
      service_tiers: [...accumulator.serviceTiers],
      speeds: [...accumulator.speeds],
      inference_geos: [...accumulator.inferenceGeos],
      web_search_requests: accumulator.webSearchRequests,
      // Omitted, never `[]`, for the reason on the field itself: a default would
      // drift every frozen normalized.json for a fact most sessions never state.
      ...(accumulator.efforts.size === 0
        ? {}
        : { efforts: [...accumulator.efforts] }),
    },
    teams: [...accumulator.teams],
    toolUses: ownToolUses(accumulator),
    subagents: [...accumulator.subagents.values()],
    diffStats: options.diffStats,
    turnDurations: accumulator.turnDurations,
    apiErrors: accumulator.apiErrors,
    compactions: mergeCompactionMetadata(accumulator),
    // ISS-7258: omitted, never `[]`/`null`, when the session states none — so a
    // blob that never carried these keys keeps not carrying them and no stored
    // metadata drifts.
    ...(accumulator.worktreeEntries.size === 0
      ? {}
      : { worktreeEntries: [...accumulator.worktreeEntries.values()] }),
    ...(accumulator.sessionKind === null
      ? {}
      : { sessionKind: accumulator.sessionKind }),
    hooks: accumulator.hooks,
    prLinks: accumulator.prLinks,
    plans: accumulator.plans,
    // An agent's calls are merged onto its row, and for an INLINE sidechain the
    // very same object is also in `toolUses` — one invocation reachable through
    // two arrays. Excluding by object identity is what makes this a union rather
    // than a double count; deduping by id would miss a call that carries none.
    skills,
    artifacts: collectArtifacts(ownToolUses(accumulator), accumulator.cwd),
    parseQuality:
      accumulator.malformedPrLinkNumbers > 0
        ? {
            ...options.parseQuality,
            malformedPrLinkNumbers: accumulator.malformedPrLinkNumbers,
          }
        : options.parseQuality,
  });
}

/**
 * Parse a Claude transcript from its lines.
 *
 * Returns null when the transcript carries no usable timestamp anywhere: it
 * cannot be placed on any timeline, so it is not a session. This form sees only
 * the lines it is given, which is the whole story for a caller reading one
 * archived transcript; the desktop importer composes the pieces above instead,
 * because a delegated agent's work lives in a sibling file on local disk.
 */
export async function parseClaudeTranscript(
  lines: AsyncIterable<string> | Iterable<string>,
  options: {
    sessionId: string;
    logger?: ParseSessionLogger;
    /** ISS-12552: see `SessionAccumulator.attributionEvidence`; default on. */
    attributionEvidence?: boolean;
  }
): Promise<NormalizedSession | null> {
  const accumulator = createSessionAccumulator({
    collectDiagnostics: options.logger !== undefined,
    attributionEvidence: options.attributionEvidence,
  });
  const parseQuality = await scanTranscriptLines(lines, accumulator);
  reportUnknownRecords(accumulator, options.logger);
  if (!accumulator.startedAt) {
    return null;
  }
  return buildSession(accumulator, {
    sessionId: options.sessionId,
    parseQuality,
    usage: deriveSessionUsage(accumulator),
    diffStats: ownDiffStats(accumulator),
  });
}

/**
 * Every skill this session invoked, counted once.
 *
 * A sidechain tool call is pushed onto the session's `toolUses` AND onto its
 * agent's row as the same object, so folding both lists naively bills one
 * invocation twice. The identity set is over object references rather than ids
 * because a tool call with no provider id still must not double.
 */
function deriveSessionSkills(
  accumulator: SessionAccumulator
): NormalizedSkillUse[] {
  const own = ownToolUses(accumulator);
  const ownSet = new Set(own);
  const skills = deriveSkills(own);
  for (const agent of accumulator.subagents.values()) {
    const merged = (agent.toolUses ?? []).filter(
      (toolUse) => !ownSet.has(toolUse)
    );
    skills.push(...deriveSkills(merged));
  }
  return skills;
}

/**
 * ISS-7508: the skill half of the Claude facet — the name plus every number that
 * describes it — assembled together because each number is meaningless, and
 * actively misleading, without the name it describes.
 *
 * Returns nothing at all when no nameable skill was attributed, rather than
 * numbers with the name omitted: `observedRecordCount` on a session that
 * attributed nothing would report a transcript length no consumer asked for and
 * change the metadata blob of every unattributed session in the corpus.
 */
function claudeSkillAttributionParts(
  accumulator: SessionAccumulator
): Pick<
  HarnessLaunchAttribution,
  | "firstAttributedSkill"
  | "observedSkillCount"
  | "firstAttributedRecordIndex"
  | "observedRecordCount"
> {
  const skill = accumulator.firstAttributionSkill;
  const recordIndex = accumulator.firstAttributionSkillRecordIndex;
  if (skill === null || recordIndex === null) {
    return {};
  }
  return {
    firstAttributedSkill: skill,
    observedSkillCount: accumulator.attributionSkills.size,
    firstAttributedRecordIndex: recordIndex,
    observedRecordCount: accumulator.observedRecordCount,
  };
}

/** The `system` subtype that carries `compactMetadata`. */
const COMPACT_BOUNDARY_SUBTYPE = "compact_boundary";

/** The numeric members of `compactMetadata`, all plain non-negative counts. */
const COMPACT_METADATA_COUNTS = [
  "preTokens",
  "postTokens",
  "cumulativeDroppedTokens",
  "durationMs",
] as const;

/**
 * Stash one `compact_boundary` record's scalars against the marker they describe.
 *
 * The scalars do NOT ride the compaction marker. They arrive on their own
 * `system` / `compact_boundary` record whose `isCompactSummary` is false, and
 * `preservedSegment.anchorUuid` names the marker — exact on 173 of 173 across
 * the live corpus, while the boundary's own uuid matches a marker 0 times.
 * Reading them off the marker record captures nothing.
 *
 * `preservedSegment` is therefore load-bearing as a JOIN KEY here even though
 * D3 drops it from storage; the two are different questions.
 */
function collectCompactBoundary(
  record: Record<string, unknown>,
  accumulator: SessionAccumulator
): void {
  if (stringValue(record.subtype) !== COMPACT_BOUNDARY_SUBTYPE) {
    return;
  }
  const metadata = asRecord(record.compactMetadata);
  const anchor = stringValue(asRecord(metadata.preservedSegment).anchorUuid);
  if (anchor === null) {
    return;
  }
  accumulator.compactMetadataByAnchor.set(
    anchor,
    compactMetadataScalars(metadata)
  );
}

/**
 * Attach each boundary's scalars to its marker.
 *
 * A marker with no boundary keeps exactly the two keys it always had, so every
 * session the harness reported no `compactMetadata` for — and every Codex
 * compaction — serializes byte-identically to before this shipped.
 */
function mergeCompactionMetadata(
  accumulator: SessionAccumulator
): NormalizedCompaction[] {
  return accumulator.compactions.map((compaction) => {
    const scalars =
      compaction.uuid === null
        ? undefined
        : accumulator.compactMetadataByAnchor.get(compaction.uuid);
    return scalars === undefined ? compaction : { ...compaction, ...scalars };
  });
}

/**
 * ISS-7258: the five scalars of Claude's `compactMetadata` worth storing.
 *
 * Every one is net new — a compaction entry recorded only WHERE it happened,
 * never its cause, magnitude, or cost. `preTokens` especially is not
 * reconstructible after the fact: rebuilt from the nearest preceding assistant
 * turn it matched 0 of 160 exactly, with a ratio spanning 0.207-1.743 (worst
 * case 470,599 actual against a 97,518 proxy). Store it or do not have it.
 *
 * Three sibling fields are deliberately dropped, all for the same reason — the
 * D3 ruling took flat scalars only. `preservedSegment` and `preservedMessages`
 * are uuid manifests nothing can join to, because `NormalizedMessage` carries no
 * uuid; they are also 96% of the worst-case 13KB entry and one of them holds a
 * 154-item array. `preCompactDiscoveredTools` is likewise an array.
 *
 * Every key is OMITTED rather than nulled when the harness reported nothing
 * usable, so a compaction without `compactMetadata` — and every Codex compaction
 * — serializes byte-identically to before this shipped.
 */
function compactMetadataScalars(
  metadata: Record<string, unknown>
): Partial<NormalizedCompaction> {
  const scalars: Partial<NormalizedCompaction> = {};
  const trigger = stringValue(metadata.trigger);
  if (trigger !== null) {
    scalars.trigger = trigger;
  }
  for (const key of COMPACT_METADATA_COUNTS) {
    const count = countValue(metadata[key]);
    if (count !== null) {
      scalars[key] = count;
    }
  }
  return scalars;
}

/**
 * ISS-8659: the tool calls this session actually made, with a fork's replayed
 * ones removed.
 *
 * The exclusion happens HERE, at the emit boundary, rather than at the push:
 * `toolUseIdIndex` holds indices into the unfiltered array and `applyToolResult`
 * resolves every `tool_result` through it, so a replayed call has to stay in
 * place to keep its own replayed result off the orphan path.
 *
 * Filtering the list rather than marking each entry is deliberate. Downstream
 * surfaces count `toolUses.length`, so a marker would have to be understood by
 * every one of them — one fact re-decided in N places, each able to be wrong and
 * each able to be fixed at a different time. The cost is that a fork's inherited
 * trace shows the conversation but not the inherited tool calls.
 */
export function ownToolUses(
  accumulator: SessionAccumulator
): NormalizedToolUse[] {
  if (accumulator.forkReplayedToolUses.size === 0) {
    return accumulator.toolUses;
  }
  return accumulator.toolUses.filter(
    (toolUse) => !accumulator.forkReplayedToolUses.has(toolUse)
  );
}
