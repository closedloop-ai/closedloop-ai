/**
 * Shared utilities for extracting text from Claude CLI stream-json events.
 * Used by the review route (streaming to client) and the review-extract endpoint.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractClaudeText(event: any): string | null {
  // assistant message with content blocks — append newline to separate turns
  if (event.type === "assistant" && event.message?.content) {
    const texts: string[] = [];
    for (const block of event.message.content) {
      if (block.type === "text" && block.text) {
        texts.push(block.text);
      }
    }
    if (texts.length === 0) {
      return null;
    }
    const joined = texts.join("");
    return joined.endsWith("\n") ? joined : `${joined}\n`;
  }

  // Streaming text deltas
  if (
    event.type === "content_block_delta" &&
    event.delta?.type === "text_delta" &&
    event.delta.text
  ) {
    return event.delta.text;
  }

  // Result event with text in content (can be a plain string or array of content blocks)
  if (event.type === "result" && event.result) {
    if (typeof event.result === "string") {
      return event.result.endsWith("\n") ? event.result : `${event.result}\n`;
    }
    const texts: string[] = [];
    for (const block of event.result ?? []) {
      if (block.type === "text" && block.text) {
        texts.push(block.text);
      }
    }
    if (texts.length === 0) {
      return null;
    }
    const joined = texts.join("");
    return joined.endsWith("\n") ? joined : `${joined}\n`;
  }

  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function describeClaudeEvent(event: any): string {
  if (event.type === "assistant" && event.message?.content) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blockTypes = event.message.content.map((b: any) => b.type).join(", ");
    return `assistant [${blockTypes}]`;
  }
  if (event.type === "user") {
    return "tool_result";
  }
  if (event.type === "content_block_start") {
    return `block_start [${event.content_block?.type ?? "?"}]`;
  }
  if (event.type === "content_block_stop") {
    return "block_stop";
  }
  if (event.type === "init") {
    return "init";
  }
  if (event.type === "result") {
    const r = event.result;
    if (typeof r === "string") {
      return `result (${r.length} chars)`;
    }
    if (Array.isArray(r)) {
      return `result (${r.length} blocks)`;
    }
    return `result (subtype=${event.subtype ?? "?"})`;
  }
  return event.type;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractClaudeSessionId(event: any): string | null {
  if (event.type === "init" && event.sessionId) {
    return event.sessionId;
  }
  if (event.type === "result" && event.session_id) {
    return event.session_id;
  }
  return null;
}
