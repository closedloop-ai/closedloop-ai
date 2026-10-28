/**
 * @file agent-component-invocation-session-tree.ts
 * @description ISS-10737: the SESSION-scoped invocation read the Trace tab runs
 * on -- one keyset page of it -- and the disclosure a consumer owes when it
 * stops walking.
 *
 * WHY THIS IS NOT THE COMPONENT-SCOPED READ.
 * `AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS` (500) bounds
 * `loadAgentComponentInvocationReadPage` and its desktop twin, and both answer
 * "the invocations of ONE component, newest first". The Trace tab asks a
 * different question -- every invocation in THIS session, as a tree -- and the
 * reference session behind the prototype carries 516 rows, already past that cap.
 *
 * A TRUNCATED TREE IS NOT A SMALLER TREE. Drop a row and every descendant of it
 * loses its parent, re-roots at the top level, and reports an ancestry chain
 * that is WRONG rather than short -- and the ancestry chain is the whole point
 * of the surface (DOC-37 section 1).
 *
 * WHICH IS WHY THE PAGE BOUND IS FOLLOWABLE AND NOT A CEILING. A constant cap
 * with nothing to page past it serves a retained prefix as if it were the
 * population (PRD-666; the `no-terminal-cap` source gate refuses one). Each page
 * therefore carries a `nextCursor` the caller passes straight back, so the walk
 * reaches the whole tree. `nextCursor` is OMITTED, never null, on the last page
 * -- its absence is exhaustion, and nothing else.
 *
 * The disclosure lives with the CONSUMER, because only the walker knows how many
 * pages it took: {@link agentComponentInvocationSessionTreeBound} turns the
 * population `total` and the rows actually gathered into a `droppedCount` that
 * is non-zero only when the walker stopped early at its own ceiling. A quietly
 * short tree is the "number that is quietly low" failure DOC-37 section 10
 * records against ISS-10722 -- worse than an absent one, because it gets acted
 * on.
 */

import type { AgentComponentInvocationReadRow } from "./agent-component-invocation";

/**
 * Rows one session-tree PAGE returns. A page size, not an availability ceiling:
 * every page past the first is reached with the `nextCursor` the previous one
 * minted.
 */
export const AGENT_COMPONENT_INVOCATION_SESSION_TREE_PAGE_ROWS = 1000;

/**
 * Pages one consumer will walk before it stops and DISCLOSES that it stopped.
 *
 * A walk needs a bound or a producer bug becomes an unbounded client loop; what
 * it must not do is stop silently. 100,000 rows is two orders of magnitude above
 * the largest session measured while building this surface (516).
 */
export const AGENT_COMPONENT_INVOCATION_SESSION_TREE_MAX_PAGES = 100;

/** One keyset page of a session's invocation tree. */
export type AgentComponentInvocationSessionTreePage = {
  items: AgentComponentInvocationReadRow[];
  /**
   * Every invocation the session holds, counted on the unbounded predicate. It
   * is what lets a walker say whether it gathered the whole tree.
   */
  total: number;
  /**
   * Keyset position of the last row on this page, passed straight back as the
   * next read's cursor. OMITTED, never null, when the walk is exhausted.
   */
  nextCursor?: string;
};

/** The request both producers (cloud route, desktop-local read) accept. */
export type AgentComponentInvocationSessionTreeRequest = {
  /** The session artifact id on the cloud; the local session id on desktop. */
  sessionId: string;
  /** A `nextCursor` from a previous page. Absent reads the head. */
  cursor?: string;
};

/** What a gathered tree says about its own completeness. */
export type AgentComponentInvocationSessionTreeBound = {
  /** Pages the walker was willing to read. */
  maxPages: number;
  /**
   * How many of the session's invocations the walker does NOT hold. Zero on a
   * complete walk; never negative, because `total` and the rows are separate
   * reads and a delete landing between them must not be published as rows this
   * walk dropped.
   */
  droppedCount: number;
  /** `droppedCount > 0`. Stated rather than derived so a renderer cannot forget. */
  truncated: boolean;
};

/** The keyset position a page ends at. */
export type AgentComponentInvocationSessionTreeCursor = {
  sequence: number;
  externalInvocationId: string;
  id: string;
};

/**
 * Field separator for the encoded cursor. A unit separator, because it cannot
 * occur in any of the three values and so needs no escaping.
 */
const CURSOR_SEPARATOR = String.fromCharCode(31);

/**
 * Build the disclosure from the two numbers the walker actually measured.
 *
 * `gathered` is the row count in hand, NOT `Math.min(total, ...)`: the count and
 * the rows are separate statements against a table that can change between them,
 * so a delete landing in that window must not be published as rows this walk
 * dropped. Clamped at zero for exactly that case.
 */
export function agentComponentInvocationSessionTreeBound(
  total: number,
  gathered: number,
  maxPages: number = AGENT_COMPONENT_INVOCATION_SESSION_TREE_MAX_PAGES
): AgentComponentInvocationSessionTreeBound {
  const droppedCount = Math.max(0, total - gathered);
  return { maxPages, droppedCount, truncated: droppedCount > 0 };
}

export function encodeAgentComponentInvocationSessionTreeCursor(
  cursor: AgentComponentInvocationSessionTreeCursor
): string {
  const raw = [
    String(cursor.sequence),
    cursor.externalInvocationId,
    cursor.id,
  ].join(CURSOR_SEPARATOR);
  return Buffer.from(raw, "utf8").toString("base64url");
}

/**
 * `null` for anything this codec could not have minted -- a truncated token, a
 * non-integer sequence, an empty segment. A malformed cursor must never fall
 * back to the head: a walking caller silently restarted at row 1 never
 * terminates.
 */
export function decodeAgentComponentInvocationSessionTreeCursor(
  raw: string | null | undefined
): AgentComponentInvocationSessionTreeCursor | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  const parts = Buffer.from(raw, "base64url")
    .toString("utf8")
    .split(CURSOR_SEPARATOR);
  if (parts.length !== 3) {
    return null;
  }
  const [rawSequence, externalInvocationId, id] = parts;
  const sequence = Number(rawSequence);
  if (
    !Number.isSafeInteger(sequence) ||
    externalInvocationId === undefined ||
    externalInvocationId.length === 0 ||
    id === undefined ||
    id.length === 0
  ) {
    return null;
  }
  return { sequence, externalInvocationId, id };
}
