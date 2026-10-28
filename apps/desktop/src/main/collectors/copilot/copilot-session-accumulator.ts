/**
 * @file copilot-session-accumulator.ts
 * @description The running state both Copilot entrypoints accumulate into.
 * Extracted from `copilot-parser.ts` (ISS-6885) so the chat parser and the CLI
 * event handlers can share it without either importing the other's module.
 */
import type {
  NormalizedApiError,
  NormalizedMessage,
  NormalizedSession,
  NormalizedTokenRecord,
  NormalizedToolUse,
  NormalizedTurnDuration,
} from "../types.js";
import type { TokenFields } from "./copilot-token-fields.js";

/**
 * Running state common to every per-session accumulator. Both the chat-loop
 * accumulator (`ChatAccumulator`) and the CLI-event accumulator
 * (`CliEventAccumulator`) extend this with their format-specific fields.
 */
export type BaseSessionAccumulator = {
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  userMessageCount: number;
  assistantMessageCount: number;
  thinkingBlockCount: number;
  pendingTurnStartedAt: string | null;
  messageTimestamps: string[];
  toolUses: NormalizedToolUse[];
  turnDurations: NormalizedTurnDuration[];
  apiErrors: NormalizedApiError[];
  toolResultErrors: NormalizedSession["toolResultErrors"];
  tokenFields: TokenFields;
  normalizedMessages: NormalizedMessage[];
  tokenSeries: NormalizedTokenRecord[];
};
