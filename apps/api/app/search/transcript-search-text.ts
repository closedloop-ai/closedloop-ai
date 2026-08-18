/**
 * FEA-3930 (parent FEA-3800, PLN-1456) — extract a bounded, plain-text
 * searchable body from an archived AI session transcript (JSONL) so its content
 * can be indexed into the unified-search projection.
 *
 * The transcript archive is newline-delimited JSON: one object per turn. This
 * helper reads the human/assistant MESSAGE TEXT out of the turns the Claude
 * Code / Codex harnesses emit and concatenates it into a single plain string,
 * capped at {@link MAX_SEARCH_BODY_CHARS}. Everything else (tool calls, tool
 * results, images, usage/diagnostics, system-meta rows) is skipped: the goal is
 * a human-legible full-text body, not a faithful transcript reconstruction.
 *
 * BOUNDED + PURE: no I/O. The caller supplies a (already length-bounded) byte
 * buffer — see `getTranscriptObjectBytesRange` — and this parses it. Parsing is
 * defensive: a malformed line is skipped, not thrown, because a partial ranged
 * read almost always ends mid-line.
 */

import { MAX_SEARCH_BODY_CHARS } from "@repo/api/src/types/search";
import { z } from "zod";

/** A single `{type:"text", text}` content block in a Claude message. */
const textContentBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

/**
 * The message envelope on a Claude Code turn: `message.role` is user/assistant
 * and `message.content` is either a plain string (user turns) or an array of
 * content blocks (assistant turns / structured user turns). Only text blocks
 * carry indexable prose; tool_use / tool_result / image blocks are ignored.
 */
const messageEnvelopeSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(z.unknown())]),
});

/** A Claude Code transcript turn carrying a message envelope. */
const claudeTurnSchema = z.object({
  type: z.enum(["user", "assistant"]),
  message: messageEnvelopeSchema,
});

/**
 * A Codex `input_text` (user) / `output_text` (assistant) content block. Codex
 * rollout messages carry prose in these blocks; reasoning, tool-call, and
 * function-output blocks are skipped, mirroring the Claude tool-block handling.
 */
const codexTextContentBlockSchema = z.object({
  type: z.enum(["input_text", "output_text"]),
  text: z.string(),
});

/**
 * A Codex rollout `response_item` turn carrying a `message` payload. Codex
 * archives wrap each record as `{type, payload}`; the canonical transcript is
 * the `response_item` `message` records (the `event_msg` user_message/
 * agent_message records are echoes of the same prose, so indexing the
 * `response_item` side avoids double-counting). Only user/assistant roles carry
 * human-legible prose — the `developer` role is injected system instructions
 * (permissions, AGENTS.md), so it is skipped like Claude system-meta rows.
 */
const codexResponseItemSchema = z.object({
  type: z.literal("response_item"),
  payload: z.object({
    type: z.literal("message"),
    role: z.enum(["user", "assistant"]),
    content: z.array(z.unknown()),
  }),
});

/**
 * Build a bounded plain-text search body from raw transcript JSONL bytes. Reads
 * the human/assistant message text from each turn, joins with newlines, and
 * caps the result at `maxChars`. Returns null when no indexable text was found
 * (an empty/blank result should become SQL NULL in the projection, not `""`).
 */
export function extractTranscriptSearchText(
  raw: string,
  maxChars: number = MAX_SEARCH_BODY_CHARS
): string | null {
  const parts: string[] = [];
  let total = 0;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const text = turnText(trimmed);
    if (text === null || text.length === 0) {
      continue;
    }
    parts.push(text);
    // +1 for the joining newline; stop scanning once we have enough to fill the
    // cap so a huge transcript does not parse every line needlessly.
    total += text.length + 1;
    if (total >= maxChars) {
      break;
    }
  }

  if (parts.length === 0) {
    return null;
  }
  const joined = parts.join("\n").trim();
  if (joined.length === 0) {
    return null;
  }
  return joined.length <= maxChars ? joined : joined.slice(0, maxChars);
}

/**
 * Parse one JSONL line and return its human/assistant message text, or null
 * when the line is not a text-bearing user/assistant turn (or is malformed).
 * Handles BOTH harness archive shapes: the Claude Code `{type,message}` envelope
 * and the Codex rollout `{type:"response_item",payload:{type:"message",…}}`
 * record. A line that matches neither is skipped.
 */
function turnText(line: string): string | null {
  const parsed = safeParseJson(line);
  if (parsed === null) {
    return null;
  }
  const claudeTurn = claudeTurnSchema.safeParse(parsed);
  if (claudeTurn.success) {
    return messageText(claudeTurn.data.message.content);
  }
  const codexTurn = codexResponseItemSchema.safeParse(parsed);
  if (codexTurn.success) {
    return codexMessageText(codexTurn.data.payload.content);
  }
  return null;
}

/** Extract the concatenated text of a Claude message's content (string/blocks). */
function messageText(content: string | unknown[]): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const texts: string[] = [];
  for (const block of content) {
    const parsed = textContentBlockSchema.safeParse(block);
    if (parsed.success) {
      const trimmed = parsed.data.text.trim();
      if (trimmed.length > 0) {
        texts.push(trimmed);
      }
    }
  }
  return texts.length > 0 ? texts.join("\n") : null;
}

/**
 * Extract the concatenated prose of a Codex `response_item` message's content
 * blocks (`input_text`/`output_text`). Non-text blocks (reasoning, tool calls,
 * function outputs) are skipped, mirroring the Claude tool-block handling.
 */
function codexMessageText(content: unknown[]): string | null {
  const texts: string[] = [];
  for (const block of content) {
    const parsed = codexTextContentBlockSchema.safeParse(block);
    if (parsed.success) {
      const trimmed = parsed.data.text.trim();
      if (trimmed.length > 0) {
        texts.push(trimmed);
      }
    }
  }
  return texts.length > 0 ? texts.join("\n") : null;
}

/** JSON.parse that returns null instead of throwing on malformed input. */
function safeParseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
