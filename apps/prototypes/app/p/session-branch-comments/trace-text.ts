import type { PrComment, TraceInline, TraceTurn } from "./mock";

// Flattens a turn's inline spans to plain text. Pure (no "use client"), so both
// the client trace renderer and the mock-data builder can share one excerpt
// derivation instead of duplicating it across the client boundary.
export function traceInlineText(span: TraceInline): string {
  if (typeof span === "string") {
    return span;
  }
  if ("code" in span) {
    return span.code;
  }
  return `#${span.pr}`;
}

// The plain-text excerpt of a trace turn: the first paragraph or list item,
// used as the "message being commented on" reference in the composer and as the
// rail comment's anchor preview.
export function turnExcerpt(turn: TraceTurn): string {
  for (const block of turn.blocks) {
    if (block.type === "p") {
      return block.spans.map(traceInlineText).join("");
    }
    if (block.type === "ul") {
      const first = block.items[0];
      if (first) {
        return first.map(traceInlineText).join("");
      }
    }
  }
  const tools = turn.blocks.find((block) => block.type === "tools");
  return tools ? tools.summary : "";
}

// Tallies how many comments are anchored to each trace turn, driving the
// persistent per-message count marker. Comments without an anchor (none, once
// the session rail is display-only) are ignored.
export function countCommentsByTurnId(
  comments: readonly PrComment[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const comment of comments) {
    if (comment.anchorTurnId) {
      counts[comment.anchorTurnId] = (counts[comment.anchorTurnId] ?? 0) + 1;
    }
  }
  return counts;
}
