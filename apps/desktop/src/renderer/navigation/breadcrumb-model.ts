import type { BranchBackLabel } from "@repo/app/branches/lib/branch-back-href";
import { parsePath } from "@repo/navigation/href-store";
import type { TopbarBreadcrumb } from "../components/layout/Topbar";
import { DETAIL_FALLBACK_LABELS } from "../components/route-fallbacks";
import { detailTitleKey } from "./detail-title-context";
import { NAV_SECTION_LABELS, navEntryFor, navSectionFor } from "./nav-config";
import { hrefForNavId, matchRoute, NavId } from "./route-table";

/**
 * The Topbar breadcrumb model for the desktop shell, extracted from `App.tsx`
 * (wongk review on PR #4266): the trail is a self-contained concern — route ids
 * and a published detail title in, `TopbarBreadcrumb[]` out — with no React
 * state of its own, and `App.tsx` was over the repo's file-size smell line with
 * it inlined. Keeping it here also makes the ISS-4839 pending/settled rules
 * directly unit-testable without mounting the shell.
 */

/**
 * The `detailTitleKey()` of the detail currently shown (session takes
 * precedence, matching the content render order), or null on a list page. Used
 * to confirm a published breadcrumb title belongs to the shown detail.
 */
export function activeDetailTitleKey(
  detailSessionId: string | null,
  detailBranchId: string | null,
  detailAgentSlug: string | null
): string | null {
  if (detailSessionId) {
    return detailTitleKey("session", detailSessionId);
  }
  if (detailBranchId) {
    return detailTitleKey("branch", detailBranchId);
  }
  if (detailAgentSlug) {
    // Use a raw string key to avoid extending the DetailKind type in
    // detail-title-context. The format mirrors detailTitleKey() convention.
    return `agent:${detailAgentSlug}`;
  }
  return null;
}

/**
 * The href the breadcrumb's "Sessions" parent links to: the originating sessions
 * list (with its page/filter query) when the detail was opened from a sessions
 * route, else the canonical list. Guarding on the route kind keeps the "Sessions"
 * label from pointing at another section when the detail was reached from there.
 */
export function sessionsBreadcrumbHref(sessionBackHref: string): string {
  const match = matchRoute(parsePath(sessionBackHref));
  return match?.kind === "nav" && match.navId === NavId.Sessions
    ? sessionBackHref
    : hrefForNavId(NavId.Sessions);
}

/**
 * Builds the Topbar breadcrumb segments. Detail pages get a two-segment
 * "<List> / <name>" trail whose list segment links back to its list. List pages
 * get their nav section (when one is shown) plus the page label, preserving the
 * prior Topbar behavior.
 *
 * ISS-4839: while the detail's name is still resolving, the trailing slot is
 * held as a PENDING segment — a skeleton carrying the label as its accessible
 * name — instead of parking a generic noun where a name goes. ISS-4772 keyed the
 * tail off the LIVE detail ids so it switches in lockstep with the URL; the side
 * effect was that "Sessions / Session" appeared the instant the route changed
 * and sat there for the whole detail chunk load. A placeholder noun in the name
 * slot is a claim the UI cannot yet support, so the honest state while it loads
 * is a slot that is visibly not-yet-a-name.
 *
 * `detailTitleSettled` is what stops that pending slot becoming a lie in the
 * other direction (codex review on PR #4266): a detail whose read SETTLES with
 * no name — not-found, or a provider error — publishes a null title exactly like
 * a still-loading one, so a purely title-driven rule would spin a skeleton
 * forever in the trail while the body renders "Session not found". Once the read
 * settles the trail drops back to the static noun, which agrees with the settled
 * body instead of contradicting it.
 */
export function buildBreadcrumbs({
  detailSessionId,
  detailBranchId,
  detailAgentSlug,
  detailTitle,
  detailTitleSettled,
  navId,
  sessionsListHref,
  branchBackHref,
  branchBackLabel,
  agentsListHref,
}: {
  detailSessionId: string | null;
  detailBranchId: string | null;
  detailAgentSlug: string | null;
  detailTitle: string | null;
  detailTitleSettled: boolean;
  navId: NavId;
  sessionsListHref: string;
  branchBackHref: string;
  branchBackLabel: BranchBackLabel;
  agentsListHref: string;
}): TopbarBreadcrumb[] {
  if (detailSessionId) {
    return detailCrumbs({
      detailTitle,
      detailTitleSettled,
      parent: {
        label: navEntryFor(NavId.Sessions)?.label ?? "Sessions",
        href: sessionsListHref,
      },
      pendingLabel: DETAIL_FALLBACK_LABELS.session,
      placeholderLabel: "Session",
    });
  }
  if (detailBranchId) {
    // FEA-4262: the parent segment tracks the resolved branch-detail Back
    // destination (Sessions when opened via `?from=session`, else the Branches
    // list) so the breadcrumb honors the referrer instead of always linking the
    // static Branches list. Label and href derive from the same resolver.
    return detailCrumbs({
      detailTitle,
      detailTitleSettled,
      parent: { label: branchBackLabel, href: branchBackHref },
      pendingLabel: DETAIL_FALLBACK_LABELS.branch,
      placeholderLabel: "Branch",
    });
  }
  if (detailAgentSlug) {
    return detailCrumbs({
      detailTitle,
      detailTitleSettled,
      parent: {
        label: navEntryFor(NavId.Agents)?.label ?? "Agents",
        href: agentsListHref,
      },
      pendingLabel: DETAIL_FALLBACK_LABELS.agent,
      placeholderLabel: "Component",
    });
  }
  const entry = navEntryFor(navId);
  const section = navSectionFor(navId);
  const sectionLabel = section ? NAV_SECTION_LABELS[section] : null;
  const crumbs: TopbarBreadcrumb[] = [];
  if (sectionLabel) {
    crumbs.push({ label: sectionLabel });
  }
  crumbs.push({ label: entry?.label ?? navId });
  return crumbs;
}

/**
 * ISS-4839: the detail breadcrumb trail, shared by all three detail kinds.
 *
 * Resolved name → "<List> / <name>". Name still unresolved and the read still
 * in flight → the trailing slot is held as a PENDING segment (a skeleton
 * carrying `pendingLabel` as its accessible name); a read that has SETTLED
 * without a name falls back to `placeholderLabel`. Holding is the honest state
 * while loading: "Sessions / Session" reads as a name the user does not
 * recognize, and it SETTLES into a different string, which is the flash the
 * ticket is about.
 *
 * The pending segment is kept rather than dropped on purpose. Returning
 * `[parent]` alone would make the PARENT the final segment, and `Topbar` renders
 * a final segment as `aria-current="page"` with its link suppressed — so a
 * loading session detail would announce itself as the Sessions LIST and lose the
 * breadcrumb, which `SessionDetailView` documents as the page's back affordance.
 * Keeping the slot also means the trail does not reflow when the name lands, the
 * same no-reflow rule `DetailRouteFallback` follows for the body. One helper so
 * the three kinds cannot drift on the pending state.
 *
 * `detailTitleSettled` bounds the hold to the LOADING window it describes. A
 * read that settled without a name (not-found / provider error) is not pending
 * — the body has already committed to "not found" — so the slot reverts to the
 * static noun rather than skeletoning indefinitely against a settled page.
 */
function detailCrumbs({
  detailTitle,
  detailTitleSettled,
  parent,
  pendingLabel,
  placeholderLabel,
}: {
  detailTitle: string | null;
  detailTitleSettled: boolean;
  parent: TopbarBreadcrumb;
  pendingLabel: string;
  placeholderLabel: string;
}): TopbarBreadcrumb[] {
  if (detailTitle) {
    return [parent, { label: detailTitle }];
  }
  if (!detailTitleSettled) {
    return [parent, { label: pendingLabel, pending: true }];
  }
  return [parent, { label: placeholderLabel }];
}
