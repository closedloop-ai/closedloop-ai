import {
  INSIGHTS_SCOPE_OPTIONS,
  InsightsScope,
} from "@closedloop-ai/loops-api/insights";
import { DashboardScopeControl } from "./dashboard-scope-control";

// ISS-5112: the dashboard's Me / Organization scope toggle, in the three states
// its two booleans produce.
// `gated` is the one worth having a fixture for. It pins the DISPLAYED value to
// Organization while the underlying `scope` state is still `Me`, which is the
// right behaviour while the ask is on screen and a bug the moment it outlives
// it: the cr-44060 regression was `scope` being cleared without `orgGated`,
// leaving this control showing Organization over personal-scope data.
// `analytics-range-toggle.stories.tsx` cannot cover this — it exercises the
// generic primitive, and the gating is entirely this wrapper's.
/**
 * A two option toggle for switching the dashboard between your own data and
 * your organization's, labeled Me and Organization. It renders nothing at
 * all when there's no organization to switch to, such as for a guest
 * browsing without an account. In a gated state aimed at exactly that guest,
 * the toggle visually stays on Organization even though the data underneath
 * is still personal, so clicking it doesn't look like it silently reverted
 * while a sign up prompt is on screen.
 */
const meta = {
  title: "Composites/Insights/Scope Control",
  component: DashboardScopeControl,
  tags: ["autodocs"],
  argTypes: {
    available: { control: "boolean" },
    gated: {
      control: "boolean",
      description:
        "Holds the DISPLAYED value on Organization while the sign-up ask is on screen.",
    },
    scope: { control: { type: "radio" }, options: INSIGHTS_SCOPE_OPTIONS },
    onValueChange: { control: false, table: { category: "Events" } },
  },
  parameters: { layout: "padded" },
};

export default meta;

/**
 * Signed in with an organization: both scopes real, the toggle reflects the
 * actual selection.
 */
export const Available = {
  args: {
    available: true,
    gated: false,
    scope: InsightsScope.Me,
    onValueChange: () => undefined,
  },
};

/**
 * A guest who selected Organization. The display is HELD on Organization while
 * the ask stands, so the click does not visibly snap back — note that `scope` is
 * still `Me` underneath, which is the mismatch this state exists to make
 * deliberate rather than accidental.
 */
export const GatedOnOrganization = {
  args: {
    available: true,
    gated: true,
    scope: InsightsScope.Me,
    onValueChange: () => undefined,
  },
};

/**
 * Signed out with guest mode off — the shipped default. `orgScopeAvailable` is
 * false because the source advertises only personal scope, and the control
 * renders nothing at all rather than offering a scope the app cannot serve.
 * This is the state that made an account's value invisible on this page, which
 * is why guest mode shows the toggle gated instead.
 */
export const Unavailable = {
  args: {
    available: false,
    gated: false,
    scope: InsightsScope.Me,
    onValueChange: () => undefined,
  },
};
