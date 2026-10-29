/**
 * Behavior tests for the arg-driven read states of two Surface story modules
 * — `stories/surfaces/settings.stories.tsx` and
 * `stories/surfaces/dashboard.stories.tsx`. Each module exposes its state
 * matrix as args; the named stories cover some cells, and the ones below are
 * the cells no story names (policy error, frustration loading/error, privacy
 * signals hidden, metrics hidden, sessions loading).
 */
import { DashboardTourAnchor } from "@repo/app/insights/components/overview/dashboard-tour-anchors";
import { FRUSTRATION_TOGGLE_LABEL } from "@repo/app/settings/components/session-frustration-card";
import { composeStory } from "@storybook/react";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import dashboardMeta, {
  Default as dashboardDefault,
} from "../stories/surfaces/dashboard.stories";
import settingsMeta, {
  Default as settingsDefault,
} from "../stories/surfaces/settings.stories";

const FAILED_READ = "Request failed with status 500";
const LOADING_SETTINGS = "Loading settings…";
const FRUSTRATION_TITLE = "Session frustration insights";
const LOADING_SESSIONS = "Loading sessions…";
const RECENT_SESSIONS = "Recent Sessions";

type SettingsArgs = NonNullable<typeof settingsDefault.args>;
type DashboardArgs = NonNullable<typeof dashboardDefault.args>;

async function runSettings(args: SettingsArgs) {
  await composeStory({ ...settingsDefault, args }, settingsMeta).run();
}

async function runDashboard(args: DashboardArgs) {
  await composeStory({ ...dashboardDefault, args }, dashboardMeta).run();
}

describe("Settings surface read states", () => {
  it("renders the org policy cards' error reading with the server message", async () => {
    await runSettings({ policyReadState: "error" });
    expect(screen.getAllByText(FAILED_READ).length).toBeGreaterThan(0);
    expect(screen.queryByText(LOADING_SETTINGS)).toBeNull();
  });

  it("renders the frustration card's loading reading", async () => {
    await runSettings({ frustrationReadState: "loading" });
    expect(screen.getByText(FRUSTRATION_TITLE)).toBeVisible();
    expect(
      screen.queryByRole("switch", { name: namesFrustrationToggle })
    ).toBeNull();
    expect(screen.queryByText(FAILED_READ)).toBeNull();
  });

  it("renders the frustration card's error reading", async () => {
    await runSettings({ frustrationReadState: "error" });
    expect(screen.getByText(FRUSTRATION_TITLE)).toBeVisible();
    expect(screen.getByText(FAILED_READ)).toBeVisible();
  });

  it("withholds every privacy-signal card when the section is hidden", async () => {
    await runSettings({ showPrivacySignals: false });
    expect(screen.queryByText(FRUSTRATION_TITLE)).toBeNull();
    expect(screen.queryByText(LOADING_SETTINGS)).toBeNull();
    expect(screen.queryByText(FAILED_READ)).toBeNull();
  });
});

describe("Dashboard surface read states", () => {
  it("renders the Recent Sessions card's loading reading", async () => {
    await runDashboard({ sessionsState: "loading" });
    expect(screen.getByText(RECENT_SESSIONS)).toBeVisible();
    expect(
      document.querySelector(`[data-tour="${DashboardTourAnchor.Impact}"]`)
    ).not.toBeNull();
    expect(screen.getByText(LOADING_SESSIONS)).toBeVisible();
    expect(screen.queryAllByRole("row")).toHaveLength(0);
  });

  it("withholds the stats row and the impact card when metrics are hidden", async () => {
    await runDashboard({ showMetrics: false });
    expect(
      document.querySelector(`[data-tour="${DashboardTourAnchor.Impact}"]`)
    ).toBeNull();
    expect(
      document.querySelector(`[data-tour="${DashboardTourAnchor.Stats}"]`)
    ).toBeNull();
    expect(screen.getByText(RECENT_SESSIONS)).toBeVisible();
  });
});

function namesFrustrationToggle(name: string): boolean {
  return name.toLowerCase().includes(FRUSTRATION_TOGGLE_LABEL.toLowerCase());
}
