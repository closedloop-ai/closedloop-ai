import { asRecord, stringValue } from "../parser-utils";
import { isoTs } from "./parse-claude";
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
  PERMISSION_MODE_ATTRIBUTES,
  PR_LINK_ATTRIBUTES,
  QUEUE_OPERATION_ATTRIBUTES,
  SYSTEM_ATTRIBUTES,
} from "./parse-claude-drift";

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
  accumulator: SessionAccumulator
): void {
  const attachment = asRecord(record.attachment);
  const attachmentType = stringValue(attachment.type);
  const succeeded = attachmentType === "hook_success";
  const failed =
    attachmentType === "hook_error" ||
    attachmentType === "hook_non_blocking_error";
  const name = stringValue(attachment.hookName)?.trim();
  if (name && (succeeded || failed)) {
    const timestamp = isoTs(record.timestamp);
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
      accumulator.hooks.push({
        name,
        event: stringValue(attachment.hookEvent),
        command,
        succeeded,
        timestamp,
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
  accumulator: SessionAccumulator
): void {
  const url = stringValue(record.prUrl);
  const number =
    typeof record.prNumber === "number" ? String(record.prNumber) : null;
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
  accumulator: SessionAccumulator
): void {
  const durationMs = record.durationMs;
  // Finite, not merely numeric: `JSON.parse` yields `Infinity` for an overflowing
  // literal, and one such turn makes every downstream duration average `Infinity`.
  if (
    record.subtype === "turn_duration" &&
    typeof durationMs === "number" &&
    Number.isFinite(durationMs)
  ) {
    accumulator.turnDurations.push({
      durationMs,
      timestamp: isoTs(record.timestamp),
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
