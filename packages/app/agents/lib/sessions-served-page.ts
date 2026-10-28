import {
  AgentSessionListCapability,
  type AgentSessionListPageInfo,
} from "@repo/api/src/types/agent-session-list-contract";

/**
 * The page index a Sessions list read actually served, read off its own echo.
 *
 * ISS-9555 slice 3. Every host used to derive the rendered position from its OWN
 * request plus `total` — several independent pieces of clamping arithmetic kept
 * in agreement by hand — so when one of them disagreed with the rows in hand the
 * footer named a page the reader was not looking at. When the producer says
 * which page it served, that answer is authoritative and nothing has to agree
 * about it.
 *
 * `null` means "no usable echo, derive in place exactly as before". It is
 * deliberately NOT an occasion to go looking for one: Branches re-issues its
 * whole read with legacy filters when `pageInfo` is absent, which it can because
 * it has an unpaginated mode to fall back to. Sessions has none, so a second
 * request here would fetch the same page again and learn nothing.
 *
 * A present-but-unusable echo also resolves to `null` rather than to a
 * fractional or negative page. `offset` must divide by `limit` to name a page at
 * all, and a producer that sends something else is telling us a position we
 * cannot render, which is a reason to fall back, never a reason to show a page
 * index with a decimal in it.
 *
 * `capability` is checked before any of the numbers are read, and that check is
 * a RUNTIME one rather than one the types already guarantee: this value arrives
 * as raw JSON off an HTTP response and, on desktop, off the IPC bridge, and
 * neither hop parses it through a schema. The field exists because a cursor
 * capability is expected to arrive later, under which `offset` stops being an
 * offset at all — so an unrecognized one means the numbers beside it are not the
 * ones this function knows how to divide, and the old derivation is the safe
 * answer. The Branches sibling gates its own echo the same way
 * (`hasServerPageCapability` in `branch-page-state.ts`).
 *
 * A `null` echo takes that same fallback and never throws. A producer on either
 * side of a version skew that serializes the absent field rather than omitting
 * it must not be able to error the list render.
 *
 * `expectedLimit` is the page size the READER is paging in, and an echo whose
 * own `limit` differs is rejected for the same reason: `offset / limit` is a
 * page index in the PRODUCER's units, and a consumer that renders it in its own
 * lands somewhere else entirely. The desktop local read clamps a limit to its
 * own ceiling rather than rejecting it, and a version-skewed Desktop build can
 * hold a different ceiling than the reader — either one answers in a size nobody
 * asked for.
 *
 * The echo describes the read whose rows are RENDERED, so `isPlaceholderPage`
 * disqualifies it outright: while `keepPreviousData` holds the previous page's
 * rows it is also holding that page's echo, and adopting it would report the
 * page the reader just left and undo their page turn.
 */
export function resolveSessionsServedPage({
  expectedLimit,
  isPlaceholderPage,
  isServerDriven,
  pageInfo,
}: {
  expectedLimit: number;
  isPlaceholderPage: boolean;
  isServerDriven: boolean;
  pageInfo: AgentSessionListPageInfo | null | undefined;
}): number | null {
  const describesTheseRows = isServerDriven && !isPlaceholderPage;
  if (!describesTheseRows || pageInfo === undefined || pageInfo === null) {
    return null;
  }
  const { capability, limit, offset } = pageInfo;
  const usable =
    capability === AgentSessionListCapability.ServerPaginationV1 &&
    Number.isSafeInteger(limit) &&
    limit > 0 &&
    limit === expectedLimit &&
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    offset % limit === 0;
  return usable ? offset / limit : null;
}
