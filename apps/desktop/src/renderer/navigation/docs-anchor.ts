/**
 * Contextual docs anchors (FEA-3846 / PRD-555 M4 — "Help on this").
 *
 * A screen declares the docs page (and optional heading) that documents it; the
 * Topbar renders a "Help on this" affordance that deep-links the in-app Help
 * view (M2) to that page/section via `helpPageHref` (built in M3). Two ways to
 * declare, both funnelling into one resolver so the Topbar has a single source:
 *
 *  1. **Static default** — {@link NAV_DOCS_ANCHORS} maps a `NavId` to its docs
 *     page. This is the flagship-screen declaration and the common case: the
 *     mapping is stable per screen, so pinning it here avoids a runtime publish
 *     (and the keep-alive stale-publish races that a mounted-but-hidden screen
 *     would otherwise create).
 *  2. **Runtime override** — a screen calls `useDocsAnchor(navId, { page, heading })`
 *     (see `docs-anchor-context.tsx`) to declare or override its anchor while
 *     mounted (e.g. a screen with a sub-tab that documents to different pages).
 *
 * `page` is the bundle path — the Fumadocs page id (`.mdx` path under
 * `apps/web/content/docs` minus extension, e.g. `mechanisms/desktop-gateway`),
 * matching {@link DocsHelpPage.path} and what `helpPageHref`/the Help view's
 * `page` query param expect. `heading` is a GitHub-style heading slug (see
 * `slugifyHeading` / the M1 bundle generator) to scroll the reader to a section.
 */
import { NavId } from "./route-table";

/** A screen's declared docs target: a bundle page path + optional heading slug. */
export type DocsAnchor = {
  /** Bundle page path, e.g. `mechanisms/desktop-gateway` (Fumadocs page id). */
  page: string;
  /** Optional GitHub-style heading slug to deep-link a section within `page`. */
  heading?: string;
};

/**
 * Static docs-anchor declarations for the flagship screens (FEA-3846 M4).
 *
 * Each maps to a REAL page in the M1 docs bundle (`apps/web/content/docs`) that
 * genuinely documents that screen — the "Help on this screen" tooltip must
 * deep-link to that screen's docs, not a generic page. Only screens with an
 * on-topic page get an entry: Settings → the desktop-gateway page's authenticated
 * endpoints, Diagnostics → the troubleshooting guide, Sessions → the canonical
 * Sessions surface page. Branches has no dedicated docs page yet, so it is
 * intentionally left out rather than pointed at a generic page — the button
 * self-hides when a screen declares no anchor, so no affordance appears until a
 * real page lands. When a dedicated page ships in `apps/web/content/docs`, add
 * the entry here.
 *
 * `Partial` on purpose: screens without an entry (and no runtime override)
 * simply render no "Help on this" affordance.
 */
export const NAV_DOCS_ANCHORS: Partial<Record<NavId, DocsAnchor>> = {
  // Settings — the gateway/relay + auth configuration this screen hosts.
  settings: {
    page: "mechanisms/desktop-gateway",
    heading: "authenticated-endpoints",
  },
  // Diagnostics — the desktop/gateway troubleshooting guide.
  diagnostics: { page: "resources/troubleshooting" },
  // Sessions — the canonical Sessions surface doc (list, filters, status model,
  // cost buckets, trace, PR/branch attribution). Wires the desktop "Help on
  // this" affordance on the Sessions screen to `mechanisms/sessions`.
  [NavId.Sessions]: { page: "mechanisms/sessions" },
};

/** The static docs anchor declared for `navId`, or null when none is declared. */
export function staticDocsAnchorFor(navId: NavId): DocsAnchor | null {
  return NAV_DOCS_ANCHORS[navId] ?? null;
}
