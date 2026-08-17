/**
 * Data hook for the two-pane Help view (FEA-3844 / PRD-555 M2).
 *
 * Owns the read-only conversation with the M1 `docs-help` IPC bridge
 * (`window.desktopApi.docsHelp.{status,nav,getPage,search}`): loads the bundle
 * status + `meta.json` nav tree once, fetches the selected page on demand
 * (cached per path), and debounces search. All state is derived from those
 * read-only calls — the Help view never mutates anything.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DocsHelpGetPageResult,
  DocsHelpNavGroup,
  DocsHelpPage,
  DocsHelpSearchHit,
  DocsHelpStatus,
} from "../../../shared/docs-help-contract";

const SEARCH_DEBOUNCE_MS = 150;

/** Bundle availability lifecycle for the left/right panes. */
export type DocsHelpBundleState = "loading" | "unavailable" | "ready";

/** Per-page reader lifecycle. */
export type DocsHelpPageState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "found"; page: DocsHelpPage }
  | { kind: "missing" };

export type UseDocsHelp = {
  bundleState: DocsHelpBundleState;
  status: DocsHelpStatus | null;
  navGroups: readonly DocsHelpNavGroup[];
  /** The path of the currently selected page, or null before first selection. */
  selectedPath: string | null;
  pageState: DocsHelpPageState;
  /** Select a page and (optionally) a heading anchor to scroll to after load. */
  selectPage: (path: string, headingSlug?: string) => void;
  /** The heading slug to scroll to for the current selection, consumed once. */
  pendingHeadingSlug: string | null;
  clearPendingHeadingSlug: () => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  searchHits: readonly DocsHelpSearchHit[];
  isSearching: boolean;
};

type DocsHelpApi = NonNullable<Window["desktopApi"]>["docsHelp"];

/**
 * An externally-requested page (and optional heading anchor) to open in the
 * reader — used by the command-palette Docs group (FEA-3845 / PRD-555 M3), which
 * navigates to `/help?page=…&heading=…` so Enter opens the picked page. Each
 * distinct target (`path` + `headingSlug`) selects once; re-picking the same hit
 * yields a new object, so the effect re-fires and re-scrolls even when the page
 * is already open.
 */
export type DocsHelpInitialTarget = {
  path: string;
  headingSlug?: string;
};

export type UseDocsHelpOptions = {
  /**
   * A page to auto-select on mount / when it changes, overriding the default
   * first-navigable-page selection. Pass a fresh object per navigation so a
   * repeat request for the same page still re-selects and re-scrolls.
   */
  initialTarget?: DocsHelpInitialTarget | null;
};

function getDocsHelpApi(): DocsHelpApi | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.desktopApi?.docsHelp ?? null;
}

export function useDocsHelp(options: UseDocsHelpOptions = {}): UseDocsHelp {
  const { initialTarget = null } = options;
  const [bundleState, setBundleState] =
    useState<DocsHelpBundleState>("loading");
  const [status, setStatus] = useState<DocsHelpStatus | null>(null);
  const [navGroups, setNavGroups] = useState<readonly DocsHelpNavGroup[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [pageState, setPageState] = useState<DocsHelpPageState>({
    kind: "idle",
  });
  // The pending heading anchor is tied to the path it was requested for, so a
  // cross-page search-jump only scrolls once its OWN page has rendered — never
  // against the previously shown page (which would consume + clear the slug
  // before the target loads).
  const [pendingHeading, setPendingHeading] = useState<{
    path: string;
    slug: string;
  } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<readonly DocsHelpSearchHit[]>(
    []
  );
  const [isSearching, setIsSearching] = useState(false);

  // Per-path page cache so re-selecting a visited page is instant and doesn't
  // re-cross IPC. Lives in a ref (not state) — it's a cache, not rendered.
  const pageCacheRef = useRef<Map<string, DocsHelpPage>>(new Map());

  // Latest external target, read (not depended on) by the mount effect so a
  // present target suppresses the first-page auto-select without re-running it.
  const initialTargetRef = useRef<DocsHelpInitialTarget | null>(initialTarget);
  initialTargetRef.current = initialTarget;

  // Load status + nav tree once on mount. First navigable page is auto-selected
  // so the right pane is never blank when a bundle is present.
  useEffect(() => {
    const api = getDocsHelpApi();
    if (!api) {
      setBundleState("unavailable");
      return;
    }
    let cancelled = false;
    Promise.all([api.status(), api.nav()])
      .then(([nextStatus, nav]) => {
        if (cancelled) {
          return;
        }
        setStatus(nextStatus);
        const groups = nextStatus.available ? nav.groups : [];
        setNavGroups(groups);
        // An external target (command-palette Docs pick) wins over the default
        // first-page auto-select; the initialTarget effect below applies it.
        // Still resolve bundle readiness so the panes render, then defer page
        // selection to that effect.
        if (initialTargetRef.current) {
          setBundleState(nextStatus.available ? "ready" : "unavailable");
          return;
        }
        const firstPath = groups[0]?.pages[0]?.path ?? null;
        // A bundle that reports available but exposes no navigable page is a
        // broken/empty snapshot: there is nothing to select, so treat it as
        // unavailable (the "view online" escape hatch) rather than leaving the
        // reader on an idle prompt the user can never satisfy.
        setBundleState(firstPath ? "ready" : "unavailable");
        if (firstPath) {
          setSelectedPath(firstPath);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBundleState("unavailable");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch the selected page (cached per path). getPage resolves to found/missing;
  // "missing" drives the reader's not-found state.
  useEffect(() => {
    if (selectedPath === null) {
      setPageState({ kind: "idle" });
      return;
    }
    const cached = pageCacheRef.current.get(selectedPath);
    if (cached) {
      setPageState({ kind: "found", page: cached });
      return;
    }
    const api = getDocsHelpApi();
    if (!api) {
      setPageState({ kind: "missing" });
      return;
    }
    let cancelled = false;
    setPageState({ kind: "loading" });
    api
      .getPage(selectedPath)
      .then((result: DocsHelpGetPageResult) => {
        if (cancelled) {
          return;
        }
        if (result.kind === "found") {
          pageCacheRef.current.set(result.page.path, result.page);
          setPageState({ kind: "found", page: result.page });
        } else {
          setPageState({ kind: "missing" });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPageState({ kind: "missing" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPath]);

  // Debounced search over the local index. An empty query clears results.
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (trimmed.length === 0) {
      setSearchHits([]);
      setIsSearching(false);
      return;
    }
    const api = getDocsHelpApi();
    if (!api) {
      setSearchHits([]);
      return;
    }
    setIsSearching(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .search(trimmed)
        .then((result) => {
          if (!cancelled) {
            setSearchHits(result.hits);
            setIsSearching(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSearchHits([]);
            setIsSearching(false);
          }
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery]);

  const selectPage = useCallback((path: string, headingSlug?: string) => {
    setSelectedPath(path);
    setPendingHeading(headingSlug ? { path, slug: headingSlug } : null);
  }, []);

  const clearPendingHeadingSlug = useCallback(() => {
    setPendingHeading(null);
  }, []);

  // Apply an external target (command-palette Docs pick): select its page and
  // heading anchor. Fires whenever the caller passes a new target object — a
  // repeat pick of the same hit is a fresh object, so re-selecting re-scrolls to
  // the heading even when that page is already open.
  useEffect(() => {
    if (!initialTarget) {
      return;
    }
    selectPage(initialTarget.path, initialTarget.headingSlug);
  }, [initialTarget, selectPage]);

  // Only hand the reader a slug once the page it targets is the one on screen,
  // so the scroll effect can't fire (and clear the slug) against a stale page
  // while the target is still loading.
  const pendingHeadingSlug =
    pendingHeading &&
    pageState.kind === "found" &&
    pageState.page.path === pendingHeading.path
      ? pendingHeading.slug
      : null;

  return useMemo(
    () => ({
      bundleState,
      status,
      navGroups,
      selectedPath,
      pageState,
      selectPage,
      pendingHeadingSlug,
      clearPendingHeadingSlug,
      searchQuery,
      setSearchQuery,
      searchHits,
      isSearching,
    }),
    [
      bundleState,
      status,
      navGroups,
      selectedPath,
      pageState,
      selectPage,
      pendingHeadingSlug,
      clearPendingHeadingSlug,
      searchQuery,
      searchHits,
      isSearching,
    ]
  );
}
