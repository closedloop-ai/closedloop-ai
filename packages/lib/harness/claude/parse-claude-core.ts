import {
  asRecord,
  baseName,
  collectArtifacts,
  isMeaningfulCwd,
  stringValue,
} from "../parser-utils";
import type { NormalizedSession, NormalizedSkillUse } from "../types";
import { createNormalizedSession, emptyUsageExtras } from "../types";
import { foldDedupMap } from "../usage-dedup";
import { extractDedupedUsage, isoTs } from "./parse-claude";
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
} from "./parse-claude-metadata";
import { normalizeSidechainSubagentId } from "./parse-claude-subagents";
import { processUserRecord } from "./parse-claude-user";
import { isReplayedTranscriptEntry } from "./replayed-entry";

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
  collectSessionAttributes(record, accumulator);

  // The eleven cases are the transcript schema's whole `type` enum. Anything
  // reaching `default` is a record kind the schema does not describe — a harness
  // that has moved on — which is a different problem from a type we know about
  // but have not finished decoding.
  switch (stringValue(record.type)) {
    case ClaudeRecordType.Assistant:
      processAssistantRecord(record, accumulator);
      break;
    case ClaudeRecordType.User:
      processUserRecord(record, accumulator);
      break;
    case ClaudeRecordType.Attachment:
      processAttachmentRecord(record, accumulator);
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
      processPrLinkRecord(record, accumulator);
      break;
    case ClaudeRecordType.FileHistorySnapshot:
      processFileHistorySnapshotRecord(record, accumulator);
      break;
    case ClaudeRecordType.System:
      processSystemRecord(record, accumulator);
      break;
    case ClaudeRecordType.QueueOperation:
      processQueueOperationRecord(record, accumulator);
      break;
    default:
      countUnknownRecordType(record, accumulator);
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
  accumulator: SessionAccumulator
): void {
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

  // Accumulated rather than first-wins: a session can be stamped with more than
  // one team, and each is a fact about the session.
  const teamName = stringValue(record.teamName);
  if (teamName) {
    accumulator.teams.add(teamName);
  }

  collectRecordFaults(record, accumulator);

  // The span widens to cover every timestamped record. ISO 8601 orders lexically,
  // so the comparison needs no Date parse.
  const timestamp = isoTs(record.timestamp);
  if (!timestamp) {
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
 * Collect the two faults a record can report about itself, whatever its type.
 *
 * API errors arrive in two shapes — a flagged record whose message content holds
 * the text, and a raw error object at the message level — and both must be
 * caught or a rate-limited session looks clean. A compaction summary marks where
 * the runtime discarded earlier context, which is what makes the surrounding
 * turn counts explicable.
 */
function collectRecordFaults(
  record: Record<string, unknown>,
  accumulator: SessionAccumulator
): void {
  const timestamp = isoTs(record.timestamp);

  if (record.isCompactSummary) {
    accumulator.compactions.push({
      uuid: stringValue(record.uuid),
      // `isoTs`, not `stringValue`: the harness may stamp an epoch NUMBER here,
      // and rejecting it would leave the compaction marker off the timeline.
      timestamp: isoTs(record.timestamp),
    });
  }

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
  const project = accumulator.cwd
    ? baseName(accumulator.cwd)
    : (accumulator.slug ?? `Session ${shortId}`);
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
      lastLineMalformed = true;
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
    },
    teams: [...accumulator.teams],
    toolUses: accumulator.toolUses,
    subagents: [...accumulator.subagents.values()],
    diffStats: options.diffStats,
    turnDurations: accumulator.turnDurations,
    apiErrors: accumulator.apiErrors,
    compactions: accumulator.compactions,
    hooks: accumulator.hooks,
    prLinks: accumulator.prLinks,
    plans: accumulator.plans,
    // An agent's calls are merged onto its row, and for an INLINE sidechain the
    // very same object is also in `toolUses` — one invocation reachable through
    // two arrays. Excluding by object identity is what makes this a union rather
    // than a double count; deduping by id would miss a call that carries none.
    skills: deriveSessionSkills(accumulator),
    artifacts: collectArtifacts(accumulator.toolUses, accumulator.cwd),
    parseQuality: options.parseQuality,
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
  options: { sessionId: string; logger?: ParseSessionLogger }
): Promise<NormalizedSession | null> {
  const accumulator = createSessionAccumulator({
    collectDiagnostics: options.logger !== undefined,
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
  const ownToolUses = new Set(accumulator.toolUses);
  const skills = deriveSkills(accumulator.toolUses);
  for (const agent of accumulator.subagents.values()) {
    const merged = (agent.toolUses ?? []).filter(
      (toolUse) => !ownToolUses.has(toolUse)
    );
    skills.push(...deriveSkills(merged));
  }
  return skills;
}
