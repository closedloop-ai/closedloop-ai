import { AppCoreReadSourceBadge } from "../app-core-read-source-badge";

/**
 * The desktop Dashboard's read-source affordance (PLN-1138), unified with the
 * Branches toolbar on the shared `ReadSourceBadge` so both surfaces show the
 * same `Local`/`Cloud` indicator.
 *
 * The dashboard insights carry no per-query readSource, so the source is derived
 * from the canonical app-core mode. ISS-5607 moved that derivation — and the
 * ISS-5477 cutover tooltip that goes with it — into
 * {@link AppCoreReadSourceBadge}, which the session detail pane now mounts too;
 * see there for why the two surfaces share one composition instead of each
 * deriving it.
 *
 * Kept as a named surface rather than inlining the shared badge at the mount
 * site: the dashboard header's own tests and stories address it by name, and the
 * surface noun ("dashboard") is a property of this surface, not of its caller.
 */
export function DashboardReadSourceBadge() {
  return <AppCoreReadSourceBadge surfaceLabel="dashboard" />;
}
