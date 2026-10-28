import type { AgentSessionEventsPage } from "@repo/api/src/types/agent-session-events-page";

/**
 * ISS-9857: the page-param vocabulary of the session events walk — the request
 * for one page, or the refusal minted when a producer offers a position the
 * walk has already read.
 *
 * The refusal is a PAGE PARAM rather than a throw at the point it is detected,
 * for the same reason `token-trend-pages.ts` shapes its walk that way: TanStack
 * evaluates `getNextPageParam` to answer `hasNextPage` on every render, so a
 * throw there would fire on render, not on fetch. The sentinel reaches the page
 * fetch, which throws {@link SessionEventsCursorLoopError} and the query lands
 * in its error state — where the control's error copy reads it. That sibling's
 * `isRepeatedCursor` is typed to its own request shape and cannot be reused.
 */
export type SessionEventsPageRequest = { cursor: string };

export type SessionEventsRepeatedCursor = { repeatedCursor: string };

export type SessionEventsPageParam =
  | SessionEventsPageRequest
  | SessionEventsRepeatedCursor;

/**
 * Deterministic — a retry would loop again — so the hook marks it
 * non-retryable.
 */
export class SessionEventsCursorLoopError extends Error {
  constructor() {
    super("the server sent inconsistent results, so loading stopped");
    this.name = "SessionEventsCursorLoopError";
  }
}

/**
 * The active source offers no `eventsPage`. Reachable only when a caller
 * mounts the walk without checking the port first — the transcript panel
 * checks — so it is deterministic and, like the loop error, never retried.
 */
export class SessionEventsUnpageableSourceError extends Error {
  constructor() {
    super("This source cannot page session events.");
    this.name = "SessionEventsUnpageableSourceError";
  }
}

/** The two refusals the walk raises itself; neither is worth a retry. */
export function isSessionEventsWalkRefusal(error: unknown): boolean {
  return (
    error instanceof SessionEventsCursorLoopError ||
    error instanceof SessionEventsUnpageableSourceError
  );
}

export function isSessionEventsRepeatedCursor(
  param: SessionEventsPageParam
): param is SessionEventsRepeatedCursor {
  return "repeatedCursor" in param;
}

/**
 * The request for the page after `lastPage`, or `undefined` when the walk is
 * done (the producer offered no cursor). A cursor the walk has already asked
 * for — the first cursor or any page's — comes back as the refusal sentinel.
 */
export function nextSessionEventsPageParam(
  lastPage: AgentSessionEventsPage,
  allParams: readonly SessionEventsPageParam[]
): SessionEventsPageParam | undefined {
  const cursor = lastPage.nextCursor;
  if (!cursor) {
    return undefined;
  }
  const alreadyAsked = allParams.some(
    (param) => !isSessionEventsRepeatedCursor(param) && param.cursor === cursor
  );
  return alreadyAsked ? { repeatedCursor: cursor } : { cursor };
}

/**
 * The walk's first page param, typed as the WHOLE param union. TanStack infers
 * its page-param type from `initialPageParam`, and an object literal there
 * (or a union-typed const holding one, which assignment narrows) would fix it
 * to the request half and refuse the refusal sentinel `getNextPageParam` mints.
 */
export function firstSessionEventsPageParam(
  cursor: string
): SessionEventsPageParam {
  return { cursor };
}
