/**
 * Runtime docs-anchor publishing (FEA-3846 / PRD-555 M4).
 *
 * The "Help on this" affordance lives in the Topbar, which renders at the
 * AppShell level — a sibling of the page content — so it cannot read a screen's
 * hooks directly. A screen that wants a docs anchor beyond (or instead of) its
 * {@link NAV_DOCS_ANCHORS} static default calls {@link useDocsAnchor} to publish
 * one through this context while mounted; AppShell resolves it for the active
 * `NavId` and hands the Topbar the anchor to link.
 *
 * Published *keyed* by the screen's `NavId`, mirroring `DetailTitleProvider`:
 * keep-alive keeps non-active screens mounted (hidden), so several screens can
 * publish at once. The resolver only reads the entry whose key matches the
 * active nav id, so a hidden screen's anchor never leaks onto another screen's
 * Topbar. Unmount clears only that screen's entry.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { type DocsAnchor, staticDocsAnchorFor } from "./docs-anchor";
import type { NavId } from "./route-table";

type DocsAnchorContextValue = {
  /** Runtime-published anchors, keyed by the publishing screen's NavId. */
  anchorsByNav: Readonly<Partial<Record<NavId, DocsAnchor>>>;
  publish: (navId: NavId, anchor: DocsAnchor | null) => void;
};

const DocsAnchorContext = createContext<DocsAnchorContextValue | null>(null);

export function DocsAnchorProvider({ children }: { children: ReactNode }) {
  const [anchorsByNav, setAnchorsByNav] = useState<
    Partial<Record<NavId, DocsAnchor>>
  >({});
  // Stable across renders (functional state update, no captured state) so
  // publishing an anchor does not invalidate the `useDocsAnchor` effect that
  // published it — otherwise the effect's `publish`-dep cleanup would clear and
  // re-publish on every render, an endless update loop while the screen mounts.
  const publish = useCallback<DocsAnchorContextValue["publish"]>(
    (navId, anchor) => {
      setAnchorsByNav((prev) => {
        if (anchor === null) {
          if (prev[navId] === undefined) {
            return prev;
          }
          const next = { ...prev };
          delete next[navId];
          return next;
        }
        const current = prev[navId];
        if (
          current &&
          current.page === anchor.page &&
          current.heading === anchor.heading
        ) {
          return prev;
        }
        return { ...prev, [navId]: anchor };
      });
    },
    []
  );
  const value = useMemo<DocsAnchorContextValue>(
    () => ({ anchorsByNav, publish }),
    [anchorsByNav, publish]
  );
  return (
    <DocsAnchorContext.Provider value={value}>
      {children}
    </DocsAnchorContext.Provider>
  );
}

/**
 * Declares the docs anchor for a screen while it is mounted (FEA-3846 M4).
 * Publishes it keyed by `navId` so the Topbar can deep-link "Help on this" to
 * that page/section, and clears it on unmount. A runtime anchor overrides the
 * screen's {@link NAV_DOCS_ANCHORS} static default.
 *
 * Passing `null` publishes nothing (equivalent to not calling the hook), so the
 * screen's static default — if any — still resolves. This hook adds or overrides
 * a runtime anchor; it does not suppress a static default.
 */
export function useDocsAnchor(navId: NavId, anchor: DocsAnchor | null): void {
  const ctx = useContext(DocsAnchorContext);
  const publish = ctx?.publish;
  const page = anchor?.page ?? null;
  const heading = anchor?.heading ?? null;
  useEffect(() => {
    if (!publish) {
      return;
    }
    publish(
      navId,
      page === null ? null : { page, heading: heading ?? undefined }
    );
    return () => publish(navId, null);
  }, [publish, navId, page, heading]);
}

/**
 * The docs anchor to link "Help on this" to for the active `navId`: the
 * runtime-published anchor for that screen when present, else its static
 * {@link NAV_DOCS_ANCHORS} default, else null (no affordance). Reading only the
 * active nav id's key guards against a hidden keep-alive screen's published
 * anchor leaking onto another screen.
 */
export function useResolvedDocsAnchor(navId: NavId | null): DocsAnchor | null {
  const ctx = useContext(DocsAnchorContext);
  const published = navId === null ? undefined : ctx?.anchorsByNav[navId];
  if (published) {
    return published;
  }
  return navId === null ? null : staticDocsAnchorFor(navId);
}
