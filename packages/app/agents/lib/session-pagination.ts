import { resolveMaxPageIndex } from "@repo/api/src/utils/math";

/**
 * The Sessions list's URL param family and its page arithmetic, for every shell
 * that mounts the Sessions surface.
 *
 * ISS-9555 slice 1 — the web page and the desktop renderer each declared the
 * whole family, with two parsers and two clamps of different signatures, so
 * ISS-7633 had to edit both copies in one commit to floor them at zero and
 * ISS-9074 had to teach only one of them an offset ceiling. One declaration is
 * what stops the next such fix landing on one host and not the other.
 */

export const SESSIONS_PAGE_PARAM = "page";
export const SESSIONS_PAGE_SIZE_PARAM = "pageSize";

/**
 * One-based `?page=` in, zero-based table index out. An absent, non-integer, or
 * non-positive value resolves to the first page deliberately: a malformed page
 * query is a navigation the user cannot act on, and routing it to page one is
 * the only reading that cannot strand them on an empty table.
 */
export function parseSessionsPageIndex(value: string | null): number {
  if (value === null) {
    return 0;
  }

  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page - 1 : 0;
}

/** Page index 0 is represented by omitting the parameter; the URL is one-based. */
export function writeSessionsPageParam(
  params: URLSearchParams,
  pageIndex: number
): void {
  if (pageIndex <= 0) {
    params.delete(SESSIONS_PAGE_PARAM);
    return;
  }

  params.set(SESSIONS_PAGE_PARAM, String(pageIndex + 1));
}

/**
 * ISS-9074: `maxOffset` is the host read's offset ceiling, and it belongs HERE
 * rather than at either caller. The clamp effect and the dead-end classifier
 * both answer "is this page past the end", and a cap applied to only one of
 * them makes a page above the ceiling repairable by the first and still
 * in-range to the second. Omitted, a host whose source has no ceiling (local
 * SQLite) is unaffected.
 *
 * PLN-1928 / ISS-9074 triage: the ceiling is THREADED, never read here.
 * `SESSION_LIST_MAX_OFFSET` is the cloud route's limit, and a shared kernel that
 * imported it would silently apply the cloud's ceiling to a host that has none.
 */
export function clampSessionsPageIndex(
  pageIndex: number,
  total: number,
  pageSize: number,
  maxOffset?: number
): number {
  if (!(Number.isFinite(total) && total > 0 && pageSize > 0)) {
    return 0;
  }
  const lastServablePage =
    maxOffset === undefined
      ? Number.POSITIVE_INFINITY
      : resolveMaxPageIndex(maxOffset, pageSize);
  return Math.max(
    0,
    Math.min(pageIndex, Math.ceil(total / pageSize) - 1, lastServablePage)
  );
}

/**
 * The rows-per-page URL family below (ISS-8756) has exactly ONE caller, the
 * desktop Sessions host, and that is the intended state rather than a wiring
 * gap to close. The web host has never carried `?pageSize=` — it remembers
 * rows-per-page in the persisted saved view through `useSessionsViewState` — and
 * giving web the param is a user-visible product change ISS-9555 did not scope.
 * These live here because the param NAME and its parse/normalize/write rules
 * belong beside the page family they are written into the same URL with, not
 * because a second caller is wanted.
 */

/** Parse a supported rows-per-page value, falling back when absent or invalid. */
export function parseSessionsPageSizeParam(
  params: Pick<URLSearchParams, "getAll">,
  allowedPageSizes: readonly number[],
  fallbackPageSize: number
): number {
  const raw = params.getAll(SESSIONS_PAGE_SIZE_PARAM).at(0);
  return normalizeSessionsPageSize(
    raw === undefined ? Number.NaN : Number(raw),
    allowedPageSizes,
    fallbackPageSize
  );
}

/** Keep unsupported host inputs from escaping into URL/query state. */
export function normalizeSessionsPageSize(
  pageSize: number,
  allowedPageSizes: readonly number[],
  fallbackPageSize: number
): number {
  return Number.isSafeInteger(pageSize) && allowedPageSizes.includes(pageSize)
    ? pageSize
    : fallbackPageSize;
}

/** Persist rows-per-page only when it differs from the host's default. */
export function writeSessionsPageSizeParam(
  params: URLSearchParams,
  pageSize: number,
  defaultPageSize: number
): void {
  params.delete(SESSIONS_PAGE_SIZE_PARAM);
  if (pageSize !== defaultPageSize) {
    params.set(SESSIONS_PAGE_SIZE_PARAM, String(pageSize));
  }
}
