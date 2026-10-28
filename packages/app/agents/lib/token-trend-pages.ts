/**
 * ISS-9851 — reading a component's whole token trend, one page at a time.
 *
 * `GET /agent-components/{slug}/token-trend` reads at most
 * `MAX_TOKEN_TREND_USAGE_ROWS` usage rows per request and hands back a
 * `nextCursor` naming the session it stopped on. Before this the chart drew
 * whatever the first read reached and the older sessions were unreachable
 * through any surface (PRD-666).
 *
 * The hook drives the walk through TanStack's infinite query, so each page is
 * one fetch with its own retry, and the chart draws every page that has landed
 * while the rest load (marisolashgrove, #6996). What lives here is the React-free
 * half: which request follows a page, and how the pages read so far merge into
 * the one response every consumer keeps reading.
 */

import type {
  TokenTrendPoint,
  TokenTrendResponse,
} from "@repo/api/src/types/agent-component-analytics";

/**
 * One page's request. The first page sends none of these; every later page
 * replays the window the FIRST page reported, because an absent `since` is
 * defaulted by the server against its own clock and would slide the window
 * forward between requests.
 */
export type TokenTrendPageRequest = {
  cursor?: string;
  since?: string;
  until?: string;
};

/** The first page: no cursor, and no window — the server states the one it applied. */
export const FIRST_TOKEN_TREND_PAGE: TokenTrendPageRequest = {};

/**
 * A page the client refuses to request: the server re-offered a position the
 * walk already read. It travels as a page param rather than being thrown where
 * it is detected, because TanStack evaluates `getNextPageParam` to answer
 * `hasNextPage` on every render — the refusal belongs in the page fetch, where
 * it becomes the query's error.
 */
export type TokenTrendRepeatedCursor = { repeatedCursor: string };

export type TokenTrendPageParam =
  | TokenTrendPageRequest
  | TokenTrendRepeatedCursor;

/**
 * The server offered a position the walk had already read. Deterministic — a
 * retry would loop again — so the hook marks it non-retryable.
 *
 * The message is rendered to the reader by `TokenTrendChart`'s error state.
 */
export class TokenTrendCursorLoopError extends Error {
  constructor() {
    super("the server sent inconsistent results, so loading stopped");
    this.name = "TokenTrendCursorLoopError";
  }
}

export function isRepeatedCursor(
  param: TokenTrendPageParam
): param is TokenTrendRepeatedCursor {
  return "repeatedCursor" in param;
}

/**
 * The request for the page after `lastPage`, or `undefined` when the walk is
 * done. It ends on a page that offers no cursor — or on one that offers a cursor
 * without an `appliedWindow` on page one to pin, which is a producer this client
 * cannot follow safely; `mergeTokenTrendPages` then keeps that prefix disclosed.
 * A cursor any earlier page was fetched with comes back as a refusal, not a
 * request.
 */
export function nextTokenTrendPageParam(
  lastPage: TokenTrendResponse,
  firstPage: TokenTrendResponse,
  priorParams: readonly TokenTrendPageParam[]
): TokenTrendPageParam | undefined {
  const cursor = lastPage.nextCursor;
  if (!cursor) {
    return undefined;
  }
  const appliedWindow = firstPage.appliedWindow;
  if (!appliedWindow) {
    return undefined;
  }
  const alreadyRead = priorParams.some(
    (param) => !isRepeatedCursor(param) && param.cursor === cursor
  );
  if (alreadyRead) {
    return { repeatedCursor: cursor };
  }
  return {
    cursor,
    since: appliedWindow.since,
    ...(appliedWindow.until ? { until: appliedWindow.until } : {}),
  };
}

/**
 * The pages read so far as one response, ordered exactly as a single unpaged
 * read would order them. `truncated` comes from the LAST page alone: an earlier
 * page setting it only meant more pages followed, and those have been read.
 *
 * The last page keeping a `nextCursor` means the merged set is a PREFIX of the
 * window — either the walk is still reading behind it, or it stopped on a
 * cursor it had no window to follow. Either way it says so, even if that
 * producer did not: a merged response with no disclosure is the lie this ticket
 * exists to end.
 */
export function mergeTokenTrendPages(
  pages: readonly TokenTrendResponse[]
): TokenTrendResponse {
  const [first] = pages;
  if (!first) {
    throw new Error("no token-trend page to merge");
  }
  const last = pages.at(-1) ?? first;
  const stoppedShort = Boolean(last.nextCursor);
  return {
    slug: first.slug,
    points: pages.flatMap((page) => page.points).sort(byStartThenSession),
    models: [...new Set(pages.flatMap((page) => page.models))].sort(),
    ...(first.appliedWindow ? { appliedWindow: first.appliedWindow } : {}),
    ...(last.truncated || stoppedShort ? { truncated: true } : {}),
  };
}

/**
 * The server's own order: session start ascending, then session id — which is
 * the `agentSessionId asc` tiebreak the read declares. Sorting on the timestamp
 * alone would leave two sessions that started in the same instant in whichever
 * order the pages happened to arrive, so a trend split across a page boundary
 * would order them opposite to an unpaged read of the same data.
 */
function byStartThenSession(a: TokenTrendPoint, b: TokenTrendPoint): number {
  const byStart =
    Date.parse(a.sessionStartedAt) - Date.parse(b.sessionStartedAt);
  if (byStart !== 0 && !Number.isNaN(byStart)) {
    return byStart;
  }
  if (a.sessionId < b.sessionId) {
    return -1;
  }
  if (a.sessionId > b.sessionId) {
    return 1;
  }
  return 0;
}
