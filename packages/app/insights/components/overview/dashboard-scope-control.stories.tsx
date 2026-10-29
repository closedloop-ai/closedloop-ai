import { InsightsScope } from "@closedloop-ai/loops-api/insights";
import { DashboardScopeControl } from "./dashboard-scope-control";

/**
 * The dashboard's Me / Organization scope toggle, in the two states `available`
 * produces.
 *
 * `analytics-range-toggle.stories.tsx` cannot cover these — it exercises the
 * generic primitive, and the availability rule is entirely this wrapper's.
 */
const meta = {
  title: "Composites/Dashboard/Dashboard Scope Control",
  tags: ["stable"],
  component: DashboardScopeControl,
  parameters: { layout: "padded" },
};

export default meta;

/**
 * Signed in with an organization: both scopes are real and the toggle reflects
 * the actual selection.
 */
export const Available = {
  args: {
    available: true,
    scope: InsightsScope.Me,
    onValueChange: () => undefined,
  },
};

/**
 * Signed out or offline — the source advertises only personal scope, so the
 * control renders nothing at all rather than offering a scope the app cannot
 * serve.
 */
export const Unavailable = {
  args: {
    available: false,
    scope: InsightsScope.Me,
    onValueChange: () => undefined,
  },
};
