import { estimateAgentComponentFootprintTokens } from "@repo/api/src/types/agent-component-footprint";
import { parsePullRequestNumber } from "@repo/api/src/types/session-artifact-link";
import {
  asRecord,
  boundedStringValue,
  isValidTurnDurationMs,
  stringValue,
  toIso,
} from "../parser-utils";
import type { NormalizedWorktreeEntry } from "../types";
import {
  ClaudeRecordType,
  type SessionAccumulator,
} from "./parse-claude-accumulator";
import {
  AI_TITLE_ATTRIBUTES,
  ATTACHMENT_ATTRIBUTES,
  collectUnknownAttributes,
  FILE_HISTORY_SNAPSHOT_ATTRIBUTES,
  LAST_PROMPT_ATTRIBUTES,
  MODE_ATTRIBUTES,
  noteUnknownQueuedCommandMode,
  PERMISSION_MODE_ATTRIBUTES,
  PR_LINK_ATTRIBUTES,
  QUEUE_OPERATION_ATTRIBUTES,
  SYSTEM_ATTRIBUTES,
  WORKTREE_STATE_ATTRIBUTES,
} from "./parse-claude-drift";
import {
  contentBlockText,
  isHumanOrigin,
  pushHumanTurn,
} from "./parse-claude-user";

/**
 * Decode an `attachment` record.
 *
 * The runtime uses attachments for many kinds of injected context; the ones that
 * matter here describe a configured HOOK that fired. All three hook outcomes are
 * kept, because a hook that failed still ran — the two error shapes are recorded
 * as failed firings rather than dropped, so the rollup can count them.
 */
export function processAttachmentRecord(
  record: Record<string, unknown>,
  accumulator: SessionAccumulator,
  replayed: boolean
): void {
  const rawAttachment = asRecord(record.attachment);
  captureQueuedPrompt(rawAttachment, record, accumulator, replayed);
  // ISS-8659: `seenHooks` dedupes firings within ONE file, so it cannot tell that
  // a replayed firing already belongs to the parent session. Without this gate a
  // fork reports every hook the parent ever ran as its own.
  const attachment = replayed ? {} : rawAttachment;
  const attachmentType = stringValue(attachment.type);
  const succeeded = attachmentType === "hook_success";
  const failed =
    attachmentType === "hook_error" ||
    attachmentType === "hook_non_blocking_error";
  const name = stringValue(attachment.hookName)?.trim();
  if (name && (succeeded || failed)) {
    const timestamp = toIso(record.timestamp);
    const command = stringValue(attachment.command);
    // The command is part of the identity: two handlers configured on the same
    // matcher share a name, timestamp, and tool id, and are separate firings.
    // Only a true replay — identical command too — collapses.
    const identity = [
      name,
      timestamp ?? "",
      stringValue(attachment.toolUseID) ?? "",
      command ?? "",
    ].join("\u0000");
    if (!accumulator.seenHooks.has(identity)) {
      accumulator.seenHooks.add(identity);
      // ISS-10736: what the firing injected into the following turn, counted
      // here where the whole stdout still exists.
      const stdout = stringValue(attachment.stdout);
      accumulator.hooks.push({
        name,
        event: stringValue(attachment.hookEvent),
        command,
        succeeded,
        timestamp,
        ...(stdout === undefined || stdout === null
          ? {}
          : {
              stdoutFootprintTokens:
                estimateAgentComponentFootprintTokens(stdout),
            }),
      });
    }
  }
  collectUnknownAttributes(
    ClaudeRecordType.Attachment,
    record,
    ATTACHMENT_ATTRIBUTES,
    accumulator
  );
}

/**
 * Capture the harness-generated session title.
 *
 * Last-wins: the harness refines the label as the session goes on, and the newest
 * is what a user recognises. A blank title is ignored rather than stored, so it
 * can neither replace a real one nor shadow the derived fallback.
 */
export function processAiTitleRecord(
  record: Record<string, unknown>,
  accumulator: SessionAccumulator
): void {
  const title = stringValue(record.aiTitle)?.trim();
  if (title) {
    accumulator.aiTitle = title;
  }
  collectUnknownAttributes(
    ClaudeRecordType.AiTitle,
    record,
    AI_TITLE_ATTRIBUTES,
    accumulator
  );
}

export function processLastPromptRecord(
  record: Record<string, unknown>,
  accumulator: SessionAccumulator
): void {
  collectUnknownAttributes(
    ClaudeRecordType.LastPrompt,
    record,
    LAST_PROMPT_ATTRIBUTES,
    accumulator
  );
}

export function processModeRecord(
  record: Record<string, unknown>,
  accumulator: SessionAccumulator
): void {
  collectUnknownAttributes(
    ClaudeRecordType.Mode,
    record,
    MODE_ATTRIBUTES,
    accumulator
  );
}

export function processPermissionModeRecord(
  record: Record<string, unknown>,
  accumulator: SessionAccumulator
): void {
  collectUnknownAttributes(
    ClaudeRecordType.PermissionMode,
    record,
    PERMISSION_MODE_ATTRIBUTES,
    accumulator
  );
}

/**
 * Decode a `pr-link` record — the harness's own statement that this session
 * produced a pull request, which is higher fidelity than inferring one from
 * command text. Deduped by URL, since a session can restate the same link.
 */
export function processPrLinkRecord(
  record: Record<string, unknown>,
  accumulator: SessionAccumulator,
  replayed: boolean
): void {
  // ISS-8659: a replayed `pr-link` names a PR the PARENT opened or referenced.
  if (replayed) {
    return;
  }
  const url = stringValue(record.prUrl);
  const parsedNumber =
    typeof record.prNumber === "number"
      ? parsePullRequestNumber(record.prNumber)
      : null;
  if (typeof record.prNumber === "number" && parsedNumber === null) {
    accumulator.malformedPrLinkNumbers++;
  }
  const number = parsedNumber === null ? null : String(parsedNumber);
  if (url && number && !accumulator.seenPrLinks.has(url)) {
    accumulator.seenPrLinks.add(url);
    accumulator.prLinks.push({
      number,
      repo: stringValue(record.prRepository) ?? undefined,
      url,
    });
  }
  collectUnknownAttributes(
    ClaudeRecordType.PrLink,
    record,
    PR_LINK_ATTRIBUTES,
    accumulator
  );
}

export function processFileHistorySnapshotRecord(
  record: Record<string, unknown>,
  accumulator: SessionAccumulator
): void {
  collectUnknownAttributes(
    ClaudeRecordType.FileHistorySnapshot,
    record,
    FILE_HISTORY_SNAPSHOT_ATTRIBUTES,
    accumulator
  );
}

/**
 * Decode a `system` record. The runtime writes several subtypes here; the only
 * one carrying a fact this parser keeps is the measured turn duration, which is
 * the harness's own timing rather than anything derived from timestamps.
 */
export function processSystemRecord(
  record: Record<string, unknown>,
  accumulator: SessionAccumulator,
  replayed: boolean
): void {
  // ISS-8659: a replayed turn duration measures a turn the PARENT took, and these
  // are summed and averaged rather than deduped.
  const durationMs = replayed ? null : record.durationMs;
  // Finite and non-negative, not merely numeric: `JSON.parse` yields `Infinity`
  // for an overflowing literal, and one such turn makes every downstream
  // duration average `Infinity`; a negative one would otherwise be persisted
  // as a measurement. Same rule as the timestamp-pair harnesses (ISS-8886).
  if (
    record.subtype === "turn_duration" &&
    typeof durationMs === "number" &&
    isValidTurnDurationMs(durationMs)
  ) {
    accumulator.turnDurations.push({
      durationMs,
      timestamp: toIso(record.timestamp),
    });
  }
  collectUnknownAttributes(
    ClaudeRecordType.System,
    record,
    SYSTEM_ATTRIBUTES,
    accumulator
  );
}

export function processQueueOperationRecord(
  record: Record<string, unknown>,
  accumulator: SessionAccumulator
): void {
  collectUnknownAttributes(
    ClaudeRecordType.QueueOperation,
    record,
    QUEUE_OPERATION_ATTRIBUTES,
    accumulator
  );
}

/**
 * ISS-7258: decode a `worktree-state` record into one distinct worktree entry.
 *
 * The harness REWRITES this record on every change rather than appending, so a
 * session can hold thousands of copies of a handful of entries — one holds 652.
 * Keying the map on the entry's own content is what makes the stored list the
 * DISTINCT set instead of a transcript-length transcript artifact.
 *
 * Valid-or-absent: an entry missing any of the five common strings, or matching
 * neither the created nor the entered shape, is dropped rather than stored
 * half-formed. A worktree whose base branch is genuinely unrecoverable — three
 * sessions, all with their directories gone — is represented by the ABSENCE of
 * `originalBranch`, never by a guess.
 */
export function processWorktreeStateRecord(
  record: Record<string, unknown>,
  accumulator: SessionAccumulator
): void {
  collectUnknownAttributes(
    ClaudeRecordType.WorktreeState,
    record,
    WORKTREE_STATE_ATTRIBUTES,
    accumulator
  );
  const entry = worktreeEntry(asRecord(record.worktreeSession));
  if (entry !== null) {
    accumulator.worktreeEntries.set(worktreeEntryKey(entry), entry);
  }
}

function worktreeEntry(
  session: Record<string, unknown>
): NormalizedWorktreeEntry | null {
  const base = worktreeCommonFields(session);
  if (base === null) {
    return null;
  }
  const originalBranch = boundedStringValue(session.originalBranch);
  const originalHeadCommit = boundedStringValue(session.originalHeadCommit);
  if (originalBranch !== null && originalHeadCommit !== null) {
    return { ...base, originalBranch, originalHeadCommit };
  }
  // `enteredExisting` is only ever `true`; anything else is not the second shape.
  return session.enteredExisting === true
    ? { ...base, enteredExisting: true }
    : null;
}

/** The five strings both shapes state, or null if the record states any of them badly. */
function worktreeCommonFields(session: Record<string, unknown>): {
  worktreePath: string;
  worktreeName: string;
  worktreeBranch: string;
  originalCwd: string;
  preEnterOriginalCwd: string;
} | null {
  // Bounded, not bare: an over-cap field drops the WHOLE entry through the null
  // return below, which is the valid-or-absent shape a normalized record owes.
  // Storing four good fields beside one the boundary will refuse would take the
  // entire worker response down with it.
  const worktreePath = boundedStringValue(session.worktreePath);
  const worktreeName = boundedStringValue(session.worktreeName);
  const worktreeBranch = boundedStringValue(session.worktreeBranch);
  const originalCwd = boundedStringValue(session.originalCwd);
  const preEnterOriginalCwd = boundedStringValue(session.preEnterOriginalCwd);
  if (
    worktreePath === null ||
    worktreeName === null ||
    worktreeBranch === null ||
    originalCwd === null ||
    preEnterOriginalCwd === null
  ) {
    return null;
  }
  return {
    worktreePath,
    worktreeName,
    worktreeBranch,
    originalCwd,
    preEnterOriginalCwd,
  };
}

/** Stable identity for an entry, independent of the harness's key order. */
function worktreeEntryKey(entry: NormalizedWorktreeEntry): string {
  return JSON.stringify(
    Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : 1))
  );
}

const QUEUED_COMMAND_ATTACHMENT_TYPE = "queued_command";
const QUEUED_COMMAND_PROMPT_MODE = "prompt";
const QUEUED_COMMAND_TASK_NOTIFICATION_MODE = "task-notification";
/** The modes this parser has a ruling for; anything else is drift, not a drop. */
const KNOWN_QUEUED_COMMAND_MODES: ReadonlySet<string> = new Set([
  QUEUED_COMMAND_PROMPT_MODE,
  QUEUED_COMMAND_TASK_NOTIFICATION_MODE,
]);

/**
 * ISS-12625: a prompt typed while a turn was still running arrives as a
 * `queued_command` attachment rather than a `user` record, so every such turn
 * was missing from the conversation and from `userMessageCount`.
 *
 * `commandMode` is the discriminator. The other mode a transcript carries,
 * `task-notification`, is the harness announcing a finished background task to
 * itself; the ISS-12625 ruling drops those rather than recording them as
 * typing. A mode this parser does not know is also not counted, but it is
 * REPORTED as drift rather than dropped silently: it may be a human turn, and
 * an unreported gap is how this bug survived in the first place.
 */
function captureQueuedPrompt(
  attachment: Record<string, unknown>,
  record: Record<string, unknown>,
  accumulator: SessionAccumulator,
  replayed: boolean
): void {
  if (stringValue(attachment.type) !== QUEUED_COMMAND_ATTACHMENT_TYPE) {
    return;
  }
  const mode = stringValue(attachment.commandMode);
  if (mode === null || !KNOWN_QUEUED_COMMAND_MODES.has(mode)) {
    // An unreadable mode is reported under `(absent)`, not passed over: the
    // gate below admits one spelling, so a renamed or retyped discriminator
    // drops every queued prompt, and an unreported drop is the bug itself.
    noteUnknownQueuedCommandMode(
      ClaudeRecordType.Attachment,
      mode,
      accumulator
    );
  }
  const isQueuedPrompt = mode === QUEUED_COMMAND_PROMPT_MODE;
  // The origin rides on the ATTACHMENT here, where a `user` record carries its
  // own, and is absent on the harness versions predating the field — so it can
  // exclude a turn but never gate one in.
  if (!(isQueuedPrompt && isHumanOrigin(attachment.origin))) {
    return;
  }
  const text = contentBlockText(attachment.prompt).trim();
  if (text) {
    pushHumanTurn(accumulator, toIso(record.timestamp), text, replayed);
  }
}
