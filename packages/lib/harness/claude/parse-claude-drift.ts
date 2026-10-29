import {
  boundMessage,
  renderDiagnosticName,
} from "../../diagnostics/log-safe-text";
import { stringValue } from "../parser-utils";
import {
  ABSENT_FIELD_VALUE,
  type ClaudeRecordType,
  type ParseSessionLogger,
  type SessionAccumulator,
} from "./parse-claude-accumulator";

/**
 * THESE SETS ARE A DRIFT DETECTOR, NOT A TO-DO LIST.
 *
 * They record every attribute the harness is KNOWN to emit — whether this parser
 * consumes it, deliberately ignores it, or has not decoded it yet. Against a
 * corpus of current transcripts the attribute report is therefore silent, and
 * the first thing it says is that the harness started sending something new.
 *
 * So: adding an attribute here is an assertion that we have SEEN it, not that we
 * handle it. What is still undecoded is tracked by the failing suites, not here.
 * When the report names an attribute, decide what it means and then add it.
 *
 * ISS-6576: these two blocks lived in `parse-claude-accumulator.ts` after the
 * module split, where they documented declarations that had moved here — and
 * the second one rendered as the JSDoc for `ParseSessionLogger` on hover.
 */

/** Envelope attributes that can ride on any record, whatever its type. */
const COMMON_ATTRIBUTES: ReadonlySet<string> = new Set([
  // Consumed by `collectSessionAttributes`.
  "type",
  "timestamp",
  "cwd",
  "version",
  "slug",
  "gitBranch",
  "entrypoint",
  "permissionMode",
  "teamName",
  // Seen everywhere and deliberately not consumed. The session id comes from the
  // transcript's filename, which is authoritative; these are the record's own
  // identity and threading, which nothing at this layer reads.
  "sessionId",
  "session_id",
  "uuid",
  "parentUuid",
  "userType",
  "isSidechain",
  // Read by `collectRecordFaults` on any record that carries them.
  "isCompactSummary",
  "isApiErrorMessage",
  // ISS-7258: CONSUMED, and genuinely COMMON — measured on `attachment`, `user`,
  // `assistant` and `system` alike, because it is a fact about the SESSION that
  // the harness stamps on every record. `collectSessionAttributes` reads it
  // first-wins for that reason.
  "sessionKind",
  // ISS-8659: CONSUMED, and common for the same reason on the same four record
  // types — a fork stamps it on every record it replayed out of its parent.
  // `processRecord` reads it once per record and passes the verdict to every
  // tallying site.
  "forkedFrom",
]);

/** Payload attributes belonging to one record type. */
export const USER_ATTRIBUTES: ReadonlySet<string> = new Set([
  "message",
  "imagePasteIds",
  "interruptedMessageId",
  "isMeta",
  "origin",
  "promptId",
  "promptSource",
  "sourceToolAssistantUUID",
  "sourceToolUseID",
  "toolDenialKind",
  "toolUseResult",
  // ISS-7258: measured against the live corpus's TOP-LEVEL transcripts and seen
  // on `user` alone, which is why each is here rather than in
  // COMMON_ATTRIBUTES. Consumed by nothing.
  "classifierMetaLines",
  "isVisibleInTranscriptOnly",
  "mcpMeta",
  // Named for the queue but carried by the `user` record the queue re-injected,
  // never by a `queue-operation` record — which is where the names put them and
  // where the measurement did not find them.
  "queueOrigin",
  "queuePriority",
  "turnCompanion",
  "userFeedback",
  // The same case as `queueOrigin` and `queuePriority` above, and it rides the
  // same re-injected `user` record.
  "queueSkipAttachments",
]);
export const ASSISTANT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "message",
  "requestId",
  "apiErrorStatus",
  "error",
  "isApiErrorMessage",
  // Both are CONSUMED by the assistant handler — `agentId` is the provider's own
  // sub-agent identity (`deriveSidechainSubagentId`) and `attributionAgent` its
  // attribution twin. A field the parser reads is by definition not undecoded,
  // which is the whole reason they belong here.
  //
  // An earlier version of this comment claimed their absence "tripped the drift
  // report on most of the corpus's agent files". That is not true and is worth
  // correcting rather than deleting: the desktop lane reads agent files through
  // `readAgentFile`, which never calls `collectUnknownAttributes`, and the
  // corpus carries `isSidechain` records in agent files only — none in a parent
  // transcript. So the omission was latent, not firing. It would have surfaced
  // the first time a parent transcript carried a sidechain record, or on any
  // caller that scans an agent file as a transcript in its own right.
  "agentId",
  "attributionAgent",
  "attributionMcpServer",
  "attributionMcpTool",
  "attributionPlugin",
  "attributionSkill",
  // ISS-7258: seen and not consumed. Whether a turn was cut off mid-stream is a
  // fact this layer does not model — listing it is not a plan to.
  "isAbortedMidStream",
  // ISS-7258: CONSUMED — `processAssistantRecord` reads it into
  // `usageExtras.efforts`. It rides the record, not `message.usage`, which is
  // why it is here and not among the usage fields.
  "effort",
  // `apiBlockIndex` numbers the content blocks WITHIN one
  // API turn, so every line sharing a `message.id` and `requestId` carries a
  // different index and the SAME `message.usage` — measured 0..5 over 3,550
  // records with one distinct usage per turn. It therefore splits nothing the
  // usage dedup collapses, and reading it as a second dedup dimension would
  // multiply a turn's tokens by its block count.
  "apiBlockIndex",
  // A per-turn override of `effort` above,
  // null on all 638 observations while `effort` read "high" — so what a
  // non-null value means relative to the session-level field is undecided, and
  // listing it here asserts only that the harness sends it.
  "perTurnEffort",
  // Keyed by tool-use id: the input as
  // the harness REWROTE it for execution, and the `cwd` it injected to do so.
  // The parser models the MODEL-authored input from `message.content`, so these
  // are a second spelling of a field it already has rather than a missing one.
  "wireIngestContext",
  "wireToolInputs",
]);
export const ATTACHMENT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "attachment",
  // The display copy of the same
  // attachment `attachment` already carries — the blocks as rendered into the
  // prompt, and the subset rendered into the human's own turn. The parser reads
  // the structured `attachment`, so taking these would store the transcript's
  // prose twice.
  "rendered",
  "renderedInHumanTurn",
]);
export const AI_TITLE_ATTRIBUTES: ReadonlySet<string> = new Set(["aiTitle"]);
export const LAST_PROMPT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "lastPrompt",
  "leafUuid",
  // ISS-7258: seen on `last-prompt` and consumed by nothing.
  "explicit",
]);
export const MODE_ATTRIBUTES: ReadonlySet<string> = new Set(["mode"]);
export const PERMISSION_MODE_ATTRIBUTES: ReadonlySet<string> = new Set();
export const PR_LINK_ATTRIBUTES: ReadonlySet<string> = new Set([
  "prNumber",
  "prRepository",
  "prUrl",
]);
export const FILE_HISTORY_SNAPSHOT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "isSnapshotUpdate",
  "messageId",
  "snapshot",
]);
export const SYSTEM_ATTRIBUTES: ReadonlySet<string> = new Set([
  "subtype",
  "content",
  "level",
  "durationMs",
  "isMeta",
  "toolUseID",
  "stopReason",
  "hasOutput",
  "messageCount",
  "preventedContinuation",
  "hookAdditionalContext",
  "hookCount",
  "hookErrors",
  "hookInfos",
  // ISS-7258: seen on `system` alone and consumed by nothing. `logicalParentUuid`
  // is a second threading link beside the envelope's `parentUuid`, which this
  // layer already declines to read.
  "cronKind",
  "logicalParentUuid",
  // ISS-7258: CONSUMED — `collectCompactBoundary` reads its five scalars onto
  // the compaction marker named by `preservedSegment.anchorUuid`. It rides a
  // `subtype: compact_boundary` record, never the `isCompactSummary` marker.
  "compactMetadata",
]);
export const QUEUE_OPERATION_ATTRIBUTES: ReadonlySet<string> = new Set([
  "operation",
  "content",
  // Why a queued prompt left the queue
  // — measured only on `operation: "remove"`, as `absorbed_mid_turn` or
  // `delivered_to_agent`. Nothing at this layer models the queue at all, so the
  // operation's own reason has no reader to give it to.
  "reason",
]);
// ISS-7258: CONSUMED. The record's only payload key; `type` and `sessionId` are
// both already common.
export const WORKTREE_STATE_ATTRIBUTES: ReadonlySet<string> = new Set([
  "worktreeSession",
]);

/**
 * Caps on retained diagnostics. These bound a STREAMING parse against a hostile
 * or merely broken transcript: both keys come from the file, so without a ceiling
 * one line per distinct `type` is one retained map entry. Generous enough that a
 * real harness drift — a handful of new types, a dozen new fields — is reported
 * in full, and the overflow counters say so when they are not.
 */
const MAX_UNKNOWN_RECORD_TYPES = 50;
const MAX_UNKNOWN_ATTRIBUTES_PER_TYPE = 50;

export function countUnknownRecordType(
  record: Record<string, unknown>,
  accumulator: SessionAccumulator
): void {
  if (!accumulator.collectDiagnostics) {
    return;
  }
  const key = renderDiagnosticName(
    stringValue(record.type) ?? ABSENT_FIELD_VALUE
  );
  const existing = accumulator.unknownRecordTypes.get(key);
  if (existing === undefined) {
    if (accumulator.unknownRecordTypes.size >= MAX_UNKNOWN_RECORD_TYPES) {
      accumulator.droppedUnknownTypes++;
      return;
    }
    accumulator.unknownRecordTypes.set(key, 1);
    return;
  }
  accumulator.unknownRecordTypes.set(key, existing + 1);
}

/**
 * Note every attribute on this record that neither the common pass nor the
 * type's own handler consumes. Collected per TYPE rather than per record: the
 * answer is a property of the record kind, and a transcript carries hundreds of
 * each.
 */
export function collectUnknownAttributes(
  type: ClaudeRecordType,
  record: Record<string, unknown>,
  known: ReadonlySet<string>,
  accumulator: SessionAccumulator
): void {
  if (!accumulator.collectDiagnostics) {
    return;
  }
  for (const attribute of Object.keys(record)) {
    if (COMMON_ATTRIBUTES.has(attribute) || known.has(attribute)) {
      continue;
    }
    noteUnknownName(type, attribute, accumulator);
  }
}

/**
 * Report the parse's undecoded record types as ONE line, ordered by count and
 * then by name so the same transcript always reports identically. Silent when
 * every record was decoded — which is the signal this rewrite is finished.
 */
function reportUnknownRecordTypes(
  accumulator: SessionAccumulator,
  logger?: ParseSessionLogger
): void {
  if (!logger || accumulator.unknownRecordTypes.size === 0) {
    return;
  }
  const summary = [...accumulator.unknownRecordTypes]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, count]) => `${type} (${count})`)
    .join(", ");
  const overflow =
    accumulator.droppedUnknownTypes > 0
      ? ` (+${accumulator.droppedUnknownTypes} record(s) past the ${MAX_UNKNOWN_RECORD_TYPES}-type cap)`
      : "";
  logger(boundMessage(`Unknown record types: ${summary}${overflow}`));
}

/**
 * Report, one line per record type, the attributes nothing consumes yet. Types
 * are ordered by name and attributes within a type likewise, so the same
 * transcript always reports identically.
 */
function reportUnknownAttributes(
  accumulator: SessionAccumulator,
  logger?: ParseSessionLogger
): void {
  if (!logger) {
    return;
  }
  const types = [...accumulator.unknownAttributes].sort((a, b) =>
    a[0].localeCompare(b[0])
  );
  for (const [type, attributes] of types) {
    const dropped = accumulator.droppedUnknownAttributes.get(type) ?? 0;
    const overflow =
      dropped > 0
        ? ` (+${dropped} past the ${MAX_UNKNOWN_ATTRIBUTES_PER_TYPE}-attribute cap)`
        : "";
    const listed = [...attributes]
      .sort((a, b) => a.localeCompare(b))
      .join(", ");
    logger(
      boundMessage(
        `Unknown attributes for record type ${renderDiagnosticName(type)}: ${listed}${overflow}`
      )
    );
  }
}

/**
 * Report everything the scan could not decode, once per parse.
 *
 * Silent without a logger, deliberately: the report is an operator signal, and a
 * surface with nowhere to put it should pay nothing for it. That also means a
 * caller that forgets one gets no drift detection at all — the desktop collector
 * passes the engine's log; the cloud renderer has no logger by design.
 */
export function reportUnknownRecords(
  accumulator: SessionAccumulator,
  logger?: ParseSessionLogger
): void {
  reportUnknownRecordTypes(accumulator, logger);
  reportUnknownAttributes(accumulator, logger);
  reportUnreadableTimestamps(accumulator, logger);
}

/**
 * ISS-6738 (whitlockk): report records whose timestamp carried a non-empty value no
 * `Date` could read.
 *
 * Reported HERE, beside the other drift signals, because this is the last point
 * that still knows the transcript: the caller's very next statement drops the
 * whole session when no timestamp survived, and from there the pass reports zero
 * sessions, the file is marked seen, and the orphan self-heal readmits it — an
 * unbounded silent rework loop that looks exactly like an empty transcript.
 *
 * Says whether the drop is TOTAL, because the two cases want different
 * responses: some unreadable stamps among good ones narrows the session's span,
 * while all of them costs the entire import.
 *
 * Silent when every timestamp read, and silent without a logger — the same rule
 * the reports above follow, so a surface with nowhere to put it pays nothing.
 */
function reportUnreadableTimestamps(
  accumulator: SessionAccumulator,
  logger?: ParseSessionLogger
): void {
  if (!logger || accumulator.unreadableTimestamps === 0) {
    return;
  }
  const total = accumulator.startedAt
    ? ""
    : " — NO timestamp survived, so this transcript imports no session at all and will be re-scanned on every pass";
  logger(
    boundMessage(
      `Unreadable timestamps: ${accumulator.unreadableTimestamps} record(s)${total}`
    )
  );
}

/**
 * ISS-12625: report an unrecognised `queued_command` mode instead of dropping
 * it. The capture gate admits only `commandMode: "prompt"`, so a mode the
 * harness adds later is silently discarded — and a discarded mode may be a
 * human turn, which is the exact failure this ticket was filed to fix. Routed
 * through the attribute channel (prefixed, so it cannot collide with a real
 * attribute name) rather than a new one, because `collectUnknownAttributes`
 * walks the OUTER record and never inspects the attachment's own keys.
 *
 * `null` is the unreadable mode — the field absent, or carrying something that
 * is not a non-empty string — and is reported rather than passed over: a
 * renamed or retyped discriminator takes every queued prompt with it, which is
 * this bug again (PR #8942 review, marisolashgrove).
 *
 * Widening the drift sets to reach nested payloads is ISS-12686.
 */
export function noteUnknownQueuedCommandMode(
  type: ClaudeRecordType,
  mode: string | null,
  accumulator: SessionAccumulator
): void {
  if (!accumulator.collectDiagnostics) {
    return;
  }
  noteUnknownName(
    type,
    `attachment.commandMode=${mode ?? ABSENT_FIELD_VALUE}`,
    accumulator
  );
}

/**
 * Retain one drift name under `type`, bounded by the per-type cap. The name is
 * transcript-derived, so it is rendered log-safe before storage.
 */
function noteUnknownName(
  type: ClaudeRecordType,
  name: string,
  accumulator: SessionAccumulator
): void {
  let unknown = accumulator.unknownAttributes.get(type);
  if (!unknown) {
    unknown = new Set<string>();
    accumulator.unknownAttributes.set(type, unknown);
  }
  const rendered = renderDiagnosticName(name);
  if (unknown.has(rendered)) {
    return;
  }
  if (unknown.size >= MAX_UNKNOWN_ATTRIBUTES_PER_TYPE) {
    // ISS-6576: per TYPE, not session-wide. One shared counter made every
    // type's line claim the overflow suffix, so a type that dropped nothing
    // reported as truncated.
    accumulator.droppedUnknownAttributes.set(
      type,
      (accumulator.droppedUnknownAttributes.get(type) ?? 0) + 1
    );
    return;
  }
  unknown.add(rendered);
}
