import { stringValue } from "../parser-utils";
import {
  ABSENT_RECORD_TYPE,
  type ClaudeRecordType,
  type ParseSessionLogger,
  type SessionAccumulator,
} from "./parse-claude-accumulator";

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
]);
export const ATTACHMENT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "attachment",
]);
export const AI_TITLE_ATTRIBUTES: ReadonlySet<string> = new Set(["aiTitle"]);
export const LAST_PROMPT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "lastPrompt",
  "leafUuid",
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
]);
export const QUEUE_OPERATION_ATTRIBUTES: ReadonlySet<string> = new Set([
  "operation",
  "content",
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
/** Per-name ceiling in the rendered report; a key can be arbitrarily long. */
const MAX_DIAGNOSTIC_NAME_CHARS = 120;
/** Whole-message ceiling, so one report line cannot become a durable log flood. */
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 2000;

// Matching control characters is the point here — they are what forge a second,
// fabricated log entry out of one transcript-controlled name.
// biome-ignore lint/suspicious/noControlCharactersInRegex: see above
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * Render one transcript-controlled name safe to interpolate into a log line.
 *
 * JSON permits a newline inside a record type or an object key, so an unescaped
 * name can forge a second log entry that reads as the collector's own — and can
 * be arbitrarily long. Control characters become a visible escape rather than
 * being stripped, so the report still shows that something odd arrived.
 */
function renderDiagnosticName(name: string): string {
  const escaped = name.replace(CONTROL_CHARACTERS, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return `\\x${code.toString(16).padStart(2, "0")}`;
  });
  if (escaped.length <= MAX_DIAGNOSTIC_NAME_CHARS) {
    return escaped;
  }
  return `${escaped.slice(0, MAX_DIAGNOSTIC_NAME_CHARS)}…(+${escaped.length - MAX_DIAGNOSTIC_NAME_CHARS} chars)`;
}

/** Bound a fully-rendered report line, saying how much it dropped. */
function boundMessage(message: string): string {
  if (message.length <= MAX_DIAGNOSTIC_MESSAGE_CHARS) {
    return message;
  }
  return `${message.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS)}…(+${message.length - MAX_DIAGNOSTIC_MESSAGE_CHARS} chars truncated)`;
}

export function countUnknownRecordType(
  record: Record<string, unknown>,
  accumulator: SessionAccumulator
): void {
  if (!accumulator.collectDiagnostics) {
    return;
  }
  const key = stringValue(record.type) ?? ABSENT_RECORD_TYPE;
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
  let unknown = accumulator.unknownAttributes.get(type);
  for (const attribute of Object.keys(record)) {
    if (COMMON_ATTRIBUTES.has(attribute) || known.has(attribute)) {
      continue;
    }
    if (!unknown) {
      unknown = new Set<string>();
      accumulator.unknownAttributes.set(type, unknown);
    }
    if (unknown.has(attribute)) {
      continue;
    }
    if (unknown.size >= MAX_UNKNOWN_ATTRIBUTES_PER_TYPE) {
      accumulator.droppedUnknownAttributes++;
      continue;
    }
    unknown.add(attribute);
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
    .map(([type, count]) => `${renderDiagnosticName(type)} (${count})`)
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
  const overflow =
    accumulator.droppedUnknownAttributes > 0
      ? ` (+${accumulator.droppedUnknownAttributes} past the ${MAX_UNKNOWN_ATTRIBUTES_PER_TYPE}-attribute cap)`
      : "";
  for (const [type, attributes] of types) {
    const listed = [...attributes]
      .sort((a, b) => a.localeCompare(b))
      .map(renderDiagnosticName)
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
}
