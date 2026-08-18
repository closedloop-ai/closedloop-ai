/**
 * URL codec for multi-select facet-filter state (FEA-3560).
 *
 * List surfaces keep facet selections in component state, which dies when the
 * list unmounts (navigating into a detail page, reload). The page index and
 * other list state already live in the URL, so a detail→back restore brought
 * back "page N" without the filter that produced it. These helpers mirror the
 * facet selections into the list URL (written with `navigation.replace`, so
 * they never add history entries) and parse them back when the list mounts —
 * making back-from-detail, reload, and shared links restore the same rows.
 *
 * Encoding: one repeated query param per facet (`status=failed&status=active`),
 * so values never need escaping beyond standard URL encoding. Empty facets are
 * omitted entirely; a URL with no facet params parses back to `defaults` (the
 * same object, so referential no-change checks keep working).
 */

/** Maps each facet key of a filter object to its URL query-param name. */
export type FacetFilterParamMap<TFilters> = Readonly<
  Record<Extract<keyof TFilters, string>, string>
>;

/**
 * Parses facet selections from URL search params. Facets without params keep
 * their `defaults` value; when NO mapped param is present the `defaults`
 * object itself is returned so callers can cheaply detect "nothing to restore".
 */
export function parseFacetFilterParams<
  TFilters extends Record<string, string[]>,
>(
  params: Pick<URLSearchParams, "getAll">,
  defaults: TFilters,
  paramMap: FacetFilterParamMap<TFilters>
): TFilters {
  let changed = false;
  const next: Record<string, string[]> = { ...defaults };
  for (const key of Object.keys(paramMap) as Extract<
    keyof TFilters,
    string
  >[]) {
    const values = dedupeNonEmpty(params.getAll(paramMap[key]));
    if (values.length > 0) {
      next[key] = values;
      changed = true;
    }
  }
  return changed ? (next as TFilters) : defaults;
}

/**
 * Writes facet selections into `params`, replacing any previous values for the
 * mapped names. Empty facets delete their param so default state produces a
 * clean URL.
 */
export function writeFacetFilterParams<
  TFilters extends Record<string, string[]>,
>(
  params: URLSearchParams,
  filters: TFilters,
  paramMap: FacetFilterParamMap<TFilters>
): void {
  for (const key of Object.keys(paramMap) as Extract<
    keyof TFilters,
    string
  >[]) {
    const name = paramMap[key];
    params.delete(name);
    // `?? []` guards callers that pass a partial filter object (test doubles,
    // adapters built from narrower shapes) — a missing facet means "empty".
    for (const value of dedupeNonEmpty(filters[key] ?? [])) {
      params.append(name, value);
    }
  }
}

/**
 * Chooses the params source for the mount-time facet seed. On the web App
 * Router, the search-params snapshot can still be reconciling (empty) on the
 * first client render after a reload or deep link — the same gap the sessions
 * page-param reader already guards with a browser-URL fallback. When the
 * snapshot is empty but the browser URL carries a query, seed from the browser
 * URL so a reloaded/shared filtered link doesn't initialize to defaults. On
 * the desktop hash router the snapshot is synchronous and `location.search`
 * sits outside the hash (always empty for list routes), so the fallback never
 * fires there.
 */
export function initialFacetParamsSource(
  snapshot: Pick<URLSearchParams, "getAll" | "toString">
): Pick<URLSearchParams, "getAll"> {
  if (snapshot.toString() !== "") {
    return snapshot;
  }
  const browserSearch =
    globalThis.window === undefined ? "" : globalThis.location.search;
  return browserSearch ? new URLSearchParams(browserSearch) : snapshot;
}

function dedupeNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))];
}
