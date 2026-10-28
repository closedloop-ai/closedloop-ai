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
 *
 * `routePath` is the path of the surface doing the seeding, and it is required
 * rather than optional: see {@link browserSearchParams}.
 */
export function initialFacetParamsSource(
  snapshot: Pick<URLSearchParams, "getAll" | "toString">,
  routePath: string
): Pick<URLSearchParams, "getAll"> {
  if (snapshot.toString() !== "") {
    return snapshot;
  }
  return browserSearchParams(routePath) ?? snapshot;
}

/**
 * The browser URL's query as params, or `null` when there is none to read —
 * on the server, when the address bar carries no query at all, or when the
 * address bar is not (yet) on `routePath`.
 *
 * The one place the raw `location.search` read lives. All three callers use it
 * for the same reconciliation gap ({@link initialFacetParamsSource} for the
 * facet seed, `useSessionsCustomDateWindow` for the explicit window,
 * `readSessionsPageIndex` for the page index), and a second copy of an
 * SSR-guarded global read is exactly the kind that acquires a divergent guard
 * later — which is what the page reader had, and what let it keep leaking
 * across surfaces after the facet seed was fixed.
 *
 * ISS-8187: `routePath` is what makes that read safe, and it has no default
 * because a permissive default is the bug. An unscoped read assumes the address
 * bar is converging TOWARD the mounting surface, which holds for a reload or a
 * deep link and is false for a client-side navigation: an App Router transition
 * renders the destination — running these mount-only seeds — while the address
 * bar still carries the ORIGIN surface's query. Sessions and Branches map
 * different identity vocabularies onto the same `owner`/`repo`/`status` param
 * names, so an unscoped seed silently adopted the other view's selection as its
 * own. Requiring the caller's own path means the fallback fires only when the
 * query on screen genuinely belongs to the surface reading it.
 */
export function browserSearchParams(routePath: string): URLSearchParams | null {
  if (globalThis.window === undefined) {
    return null;
  }
  if (globalThis.location.pathname !== routePath) {
    return null;
  }
  const browserSearch = globalThis.location.search;
  return browserSearch ? new URLSearchParams(browserSearch) : null;
}

function dedupeNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))];
}
