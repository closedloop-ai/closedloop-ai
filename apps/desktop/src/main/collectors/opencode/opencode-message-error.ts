/**
 * @file opencode-message-error.ts
 * @description The API error an OpenCode message row records, if any.
 */
import { asRecord, extractErrorMessage } from "../parsing/parser-utils.js";
import type { NormalizedApiError } from "../types.js";

// OpenCode (1.18.34) stores a message error as `{ name, data: { message } }`,
// and reads its text as `data.message`, then `message`, then `name`. Its TUI
// renders every message error except this one, which it shows as "interrupted".
const OPENCODE_ABORTED_ERROR_NAME = "MessageAbortedError";

export function opencodeMessageApiError(
  error: unknown,
  timestamp: string | null
): NormalizedApiError | null {
  const record = asRecord(error);
  if (record.name === OPENCODE_ABORTED_ERROR_NAME) {
    return null;
  }
  const message =
    extractErrorMessage(error) ??
    extractErrorMessage(record.data) ??
    extractErrorMessage(record.name);
  return message ? { type: "error", message, timestamp } : null;
}
