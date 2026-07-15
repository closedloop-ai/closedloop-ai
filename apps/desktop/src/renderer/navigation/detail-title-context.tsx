import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/**
 * Publishes the currently-open detail page's name (a session/branch name) up to
 * the Topbar breadcrumb. The Topbar renders at the AppShell level — a sibling of
 * the page content — so it cannot read the detail data hooks itself (branch
 * detail in particular needs the BranchesDataSourceProvider that only its
 * wrapper mounts). Instead each detail view publishes its resolved name through
 * this context while mounted, and AppShell reads it to build the breadcrumb's
 * trailing "> [name]" segment — mirroring how the web app's detail pages pass a
 * `breadcrumbs` array to their Header.
 *
 * The title is published *keyed* to the detail it describes. AppShell only uses
 * it when the key matches the detail currently shown, because the visible route
 * (deferred session/branch ids) can flip to a different detail in a single
 * render while the publishing effect — which runs a commit later — still holds
 * the previous detail's name. Without the key check that stale name would flash
 * under the new list for one frame on a direct detail→detail navigation.
 */
export type DetailKind = "session" | "branch";

/** Stable key identifying which detail a published title belongs to. */
export function detailTitleKey(kind: DetailKind, id: string): string {
  return `${kind}:${id}`;
}

export type PublishedDetailTitle = {
  /** `detailTitleKey()` of the detail that published `title`, or null when none. */
  key: string | null;
  title: string | null;
};

/**
 * The breadcrumb title to show for the active detail: the published title only
 * when its key matches `activeKey` (the `detailTitleKey()` of the detail
 * currently shown), else null. Guards against a stale title from a
 * just-superseded detail rendering under the new list during a direct
 * detail→detail navigation, where the visible route flips a render before the
 * publishing effect settles.
 */
export function resolveDetailTitle(
  published: PublishedDetailTitle,
  activeKey: string | null
): string | null {
  return activeKey !== null && published.key === activeKey
    ? published.title
    : null;
}

const EMPTY_DETAIL_TITLE: PublishedDetailTitle = { key: null, title: null };

type DetailTitleContextValue = {
  detail: PublishedDetailTitle;
  setDetail: (detail: PublishedDetailTitle) => void;
};

const DetailTitleContext = createContext<DetailTitleContextValue | null>(null);

export function DetailTitleProvider({ children }: { children: ReactNode }) {
  const [detail, setDetail] =
    useState<PublishedDetailTitle>(EMPTY_DETAIL_TITLE);
  const value = useMemo(() => ({ detail, setDetail }), [detail]);
  return (
    <DetailTitleContext.Provider value={value}>
      {children}
    </DetailTitleContext.Provider>
  );
}

/** The published detail title plus the key of the detail it belongs to. */
export function useDetailTitle(): PublishedDetailTitle {
  return useContext(DetailTitleContext)?.detail ?? EMPTY_DETAIL_TITLE;
}

/**
 * Publishes a detail page's breadcrumb name (keyed by `key`, e.g.
 * `detailTitleKey("session", id)`) while the calling view is mounted, clearing
 * it on unmount. Pass null for `title` while the name is still loading; the
 * Topbar shows a generic fallback ("Session"/"Branch") until a real value
 * arrives or the key matches the shown detail.
 */
export function usePublishDetailTitle(key: string, title: string | null): void {
  const ctx = useContext(DetailTitleContext);
  const setDetail = ctx?.setDetail;
  useEffect(() => {
    if (!setDetail) {
      return;
    }
    setDetail({ key, title });
    return () => setDetail(EMPTY_DETAIL_TITLE);
  }, [setDetail, key, title]);
}
