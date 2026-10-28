import { isRecord } from "@repo/lib/harness/type-guards";
import { DOCS_MATCH_FIELD_LABEL } from "./docs-help-labels";
import type {
  DocsHelpNavGroup,
  DocsHelpNavPage,
  DocsHelpPage,
  DocsHelpSearchHit,
} from "./docs-help-payload";

/**
 * ISS-10005 AC2 — read a docs payload, or refuse the part that is malformed.
 *
 * What arrives crossed a process boundary from a snapshot built by a possibly
 * older or newer generator. `HelpNavTree` calls `group.pages.map(...)` during
 * render, so one group that lost its `pages` unwinds the shell — on the route a
 * reader reached BECAUSE something was already wrong. Each group and each page
 * answers for itself, so a corrupt one costs only itself.
 *
 * Depth reaches every value the renderer INDEXES INTO, RENDERS AS A CHILD, or
 * CONCATENATES INTO A HREF, because two failures live there and the quiet one is
 * worse: a THROWN render (`.map` on a non-array, React on a non-primitive child,
 * and — measured — react-markdown on a non-nullish non-string body), or a SILENT
 * WRONG RENDER (a nullish body, which react-markdown draws as an empty document,
 * and a non-string `path`, which links to `.../undefined`).
 *
 * Leaf values beyond that are not checked: a second copy of the contract drifts.
 */

/** React throws on a non-primitive child and misrenders the rest. */
function isRenderableText(value: unknown): value is string {
  return typeof value === "string";
}

/** Absent is a claim ("un-navigated page"); present-but-wrong is not. */
function isOptionalText(value: unknown): boolean {
  return value === undefined || isRenderableText(value);
}

function isNavPageShaped(value: unknown): value is DocsHelpNavPage {
  return (
    isRecord(value) &&
    isRenderableText(value.path) &&
    isRenderableText(value.title) &&
    isOptionalText(value.group)
  );
}

function isNavGroupShaped(value: unknown): value is DocsHelpNavGroup {
  return (
    isRecord(value) &&
    isRenderableText(value.group) &&
    Array.isArray(value.pages) &&
    value.pages.every(isNavPageShaped)
  );
}

/**
 * What survived the nav tree, and how much did not.
 *
 * The count is separate from `groups.length`: a bundle with no groups and a
 * bundle whose groups were refused are different claims, and the second is
 * `CompleteSurfaceState.Partial` — what renders is true, what is missing must be
 * SAID. The surface cannot tell them apart unless the read reports both.
 */
export type DocsHelpNavRead = {
  readonly groups: readonly DocsHelpNavGroup[];
  readonly refusedGroups: number;
  /**
   * The tree itself was unreadable — not an array at all — so NOTHING could be
   * counted (marisolashgrove review). Kept apart from `refusedGroups` because the
   * old shape reported this as `refusedGroups: 1`, which rendered as "1 section
   * of the docs index couldn't be read": a count lying about its own magnitude,
   * and the most reassuring possible sentence for the worst case.
   */
  readonly treeUnreadable: boolean;
};

/**
 * The nav tree, with every group the renderer could not survive removed. A group
 * is refused WHOLE when any one row is unrenderable — React throws on the row
 * rather than skipping it.
 */
export function readNavGroups(
  navGroups: readonly DocsHelpNavGroup[]
): DocsHelpNavRead {
  if (!Array.isArray(navGroups)) {
    return { groups: [], refusedGroups: 0, treeUnreadable: true };
  }
  const groups = navGroups.filter(isNavGroupShaped);
  return {
    groups,
    refusedGroups: navGroups.length - groups.length,
    treeUnreadable: false,
  };
}

/**
 * The first page a host can open by default, chosen over the READ tree.
 *
 * A host deriving it itself indexes into an unchecked payload: `groups[0]?.pages[0]`
 * throws on a first group that lost its pages, and the catch around it then
 * reports the whole bundle unavailable, losing every intact group.
 */
export function firstNavigablePath(
  navGroups: readonly DocsHelpNavGroup[]
): string | null {
  for (const group of readNavGroups(navGroups).groups) {
    const first = group.pages[0];
    if (first !== undefined) {
      return first.path;
    }
  }
  return null;
}

/**
 * The search hits the pane may render, with every unrenderable row dropped.
 *
 * davetho review: `search()` crossed the same process boundary as the nav and
 * the page, and was the one payload nothing checked. A reply missing `hits`
 * threw on `hits.length` before a row was even reached, and a row whose `title`
 * or `excerpt` came back as an object threw inside React while rendering — both
 * of which take down the Help route, not just the search pane.
 *
 * Rows are dropped INDIVIDUALLY rather than refusing the set, which is the same
 * call {@link readNavGroups} makes one level up: a corrupt row costs the reader
 * that row, not every result beside it. `matchField` is checked against the
 * label map it INDEXES, because an unknown key renders `undefined` as the
 * facet — silent, and wrong.
 */
export function readSearchHits(
  hits: readonly DocsHelpSearchHit[]
): DocsHelpSearchHit[] {
  if (isSearchHitsUnreadable(hits)) {
    return [];
  }
  return hits.filter(
    (hit) =>
      isRecord(hit) &&
      isRenderableText(hit.path) &&
      isRenderableText(hit.title) &&
      isOptionalText(hit.headingSlug) &&
      isOptionalText(hit.excerpt) &&
      typeof hit.matchField === "string" &&
      hit.matchField in DOCS_MATCH_FIELD_LABEL
  );
}

/**
 * The page the reader may render, or `null` when it is malformed.
 *
 * `body` must be a string even though react-markdown tolerates a nullish one:
 * tolerating it draws an empty document, indistinguishable from a page with
 * nothing in it. `renderBody` WINS over `body`, so a non-nullish non-string
 * there throws; `path` is concatenated into the "View online" href.
 */
export function readReaderPage(page: DocsHelpPage): DocsHelpPage | null {
  if (
    !(
      isRecord(page) &&
      isRenderableText(page.path) &&
      isRenderableText(page.title) &&
      isOptionalText(page.description) &&
      isRenderableText(page.body) &&
      isOptionalText(page.renderBody)
    )
  ) {
    return null;
  }
  return page;
}

/**
 * ISS-10044 (whitlockk review) — did the reply carry a hit LIST at all?
 *
 * {@link readSearchHits} answers `[]` both for a search that ran and matched
 * nothing and for a reply nothing could read, and the surface renders those as
 * OPPOSITE sentences: `No results for "…"` is a claim about the corpus, which a
 * reply that was refused does not support. Without this the version-skew path
 * kept the very false-content claim the rejection path was fixed to stop
 * making.
 *
 * Asked here rather than re-derived at the call site, so the read and the
 * question about the read cannot drift apart — one owner, like
 * {@link DocsHelpNavRead.treeUnreadable} one level up.
 */
export function isSearchHitsUnreadable(
  hits: readonly DocsHelpSearchHit[]
): boolean {
  return !Array.isArray(hits);
}
