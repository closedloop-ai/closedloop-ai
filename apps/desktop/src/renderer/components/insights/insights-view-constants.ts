import { pageTitleForNav } from "../../navigation/nav-config";
import { NavId } from "../../navigation/route-table";

// FEA-3989: the "Insights" nav entry must share its name with this view's page
// heading. The body title was "Agent Monitoring" while the nav read "Insights";
// derive the <h1> from the nav label (pageTitleForNav) so the breadcrumb →
// title is one source and cannot drift. This constant is that <h1> for both the
// Insights view and its lazily-loaded bounded surface.
//
// NOTE: the final Insights vs "Agent Monitoring" product vocabulary is a
// separate, blocked decision (PLN-1486 / FEA-3970 analytics "canonical home" +
// FEA-3983). This change only reconciles the desktop nav↔heading using the
// view's current nav term; it does not settle that vocabulary. When FEA-3970
// lands, revisit the nav-config label (this constant follows it automatically).
//
// Kept in its own lightweight module (nav-config + route-table are plain
// data/const modules, no component/runtime imports) so the lazily-loaded
// bounded view can share the value without a module cycle back into
// insights-view (which dynamically imports the bounded view).
export const INSIGHTS_PAGE_TITLE = pageTitleForNav(NavId.Insights);

// One sentence for the page subtitle, used in both the pre-load gate and the
// loaded bounded view so the same route never says two different things. The
// per-card heading/paragraph inside the bounded view carry their own, distinct
// copy — this is only the page-level orientation line.
export const INSIGHTS_PAGE_DESCRIPTION =
  "Aggregated agent-session activity across your synced compute targets.";
