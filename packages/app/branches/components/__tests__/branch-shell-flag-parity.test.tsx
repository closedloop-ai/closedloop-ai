import { BRANCH_DETAIL_MEASURED_CHECKS_FLAG_KEY } from "@repo/api/src/types/branch-detail-measured-checks-flag";
import { BRANCH_DETAIL_METRIC_HONESTY_FLAG_KEY } from "@repo/api/src/types/branch-detail-metric-honesty-flag";
import { BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FLAG_KEY } from "@repo/api/src/types/branch-detail-pr-base-and-author-flag";
import { BRANCH_TIMELINE_COST_FALLBACK_MARKER_FLAG_KEY } from "@repo/api/src/types/branch-timeline-cost-fallback-marker-flag";
import { BRANCH_TRACE_PARTIAL_SESSION_FLAG_KEY } from "@repo/api/src/types/branch-trace-partial-session-flag";
import { ONE_LABEL_PER_METRIC_FLAG_KEY } from "@repo/api/src/types/one-label-per-metric-flag";
import { PENSERO_POINTS_PER_DOLLAR_FLAG_KEY } from "@repo/api/src/types/pensero-points-per-dollar-flag";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import type { FeatureFlagAdapter } from "@repo/app/shared/feature-flags/feature-flag-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import {
  ARTIFACT_DETAIL_TAB_LABELS,
  ArtifactDetailTab,
} from "@repo/app/shared/lib/artifact-detail-tab";
import {
  ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY,
  METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { BranchesDataSourceProvider } from "../../data-source/provider";
import { BranchDetailPage } from "../branch-detail-page";
import { BranchShellView } from "../branch-shell-view";
import {
  baseProps,
  inertBranchesDataSource,
  makeDetail,
  makeSelectedPullRequest,
} from "./branch-detail-page.fixtures";

/**
 * ISS-10797 — the shipped Branch detail variants must still SWITCH after the
 * shared shell takes over the surface.
 *
 * Each key below gates behavior a user already has, decided inside a panel the
 * shell now mounts. The shell is a container swap, so a panel that stops being
 * composed takes its flag read with it, silently: the variant disappears for
 * every enrolled user and every one of those keys' own specs keeps passing,
 * because each mounts its panel directly.
 *
 * So the contract here is narrow and deliberately not a second copy of those
 * specs: the shell's tree QUERIES each key. What the key then does is pinned by
 * its own suite (e.g. `branch-detail-metric-honesty.spec.ts`).
 *
 * Every flag is pinned ON, because a read site reached only on the enabled
 * branch of a sibling flag is not reached at all with the defaults.
 */
const SHELL_PANEL_FLAG_KEYS = [
  BRANCH_DETAIL_MEASURED_CHECKS_FLAG_KEY,
  BRANCH_DETAIL_METRIC_HONESTY_FLAG_KEY,
  BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FLAG_KEY,
  BRANCH_TIMELINE_COST_FALLBACK_MARKER_FLAG_KEY,
  BRANCH_TRACE_PARTIAL_SESSION_FLAG_KEY,
  METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY,
  ONE_LABEL_PER_METRIC_FLAG_KEY,
  PENSERO_POINTS_PER_DOLLAR_FLAG_KEY,
] as const;

/**
 * Read only by `BranchPropertiesPanel`, which ISS-12267 (operator ruling)
 * removed from the shell. The legacy page still mounts that panel, so the key
 * stays pinned ON for it but is no longer owed by the shell.
 */
const LEGACY_ONLY_FLAG_KEYS: ReadonlySet<string> = new Set([
  UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY,
]);

const ALL_PINNED = [
  ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY,
  ...SHELL_PANEL_FLAG_KEYS,
  ...LEGACY_ONLY_FLAG_KEYS,
];

/**
 * Carries a `selectedPullRequest`, which the PR-scoped evidence panels gate on:
 * without one they render nothing and two of the keys below are never reached.
 */
const DETAIL_ID = "b-1";
const SHELL_DETAIL = makeDetail({
  id: DETAIL_ID,
  selectedPullRequest: makeSelectedPullRequest(),
});

/**
 * Records the key of every read instead of answering from a fixed set, which is
 * what lets a DROPPED read site fail rather than merely resolve false.
 */
function createRecordingFeatureFlagAdapter(enabled: readonly string[]) {
  const queried = new Set<string>();
  const on = new Set(enabled);
  const adapter: FeatureFlagAdapter = {
    useFeatureFlagEnabled: (key: string) => {
      queried.add(key);
      return on.has(key);
    },
  };
  return { adapter, queried };
}

/**
 * The files read fails rather than resolving: the panel's own error arm is a
 * shipped state, where a canned success would need this fixture to carry the
 * whole immutable-files response shape to say nothing more.
 */
const FILES_ROUTE: FixtureRoute = {
  method: "GET",
  path: `/branches/${DETAIL_ID}/selected-pull-request/files`,
  respond: () => null,
  status: 500,
};

function renderShell(ui: ReactElement, adapter: FeatureFlagAdapter) {
  return render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <AppCoreStoryProviders apiRoutes={[FILES_ROUTE]}>
        <FeatureFlagAdapterProvider adapter={adapter}>
          <BranchesDataSourceProvider dataSource={inertBranchesDataSource()}>
            {children}
          </BranchesDataSourceProvider>
        </FeatureFlagAdapterProvider>
      </AppCoreStoryProviders>
    ),
  });
}

afterEach(cleanup);

describe("Branch shell feature-flag parity", () => {
  it("queries every shipped Branch detail flag across the shell's tabs", async () => {
    const queried = await collectShellFlagReads();

    // Reported as the missing set so a failure names the dropped flag rather
    // than printing two sorted key lists to diff by eye.
    const dropped = SHELL_PANEL_FLAG_KEYS.filter((key) => !queried.has(key));
    expect(dropped).toEqual([]);
  });

  /**
   * The self-maintaining half. The named list above is a floor that still has to
   * be edited; this arm compares the shell against the surface it replaces under
   * one fixture, so a variant NEITHER list mentions is covered the day it lands.
   */
  it("queries everything the surface it replaces queries", async () => {
    const legacy = await collectLegacyFlagReads();
    const shell = await collectShellFlagReads();

    const dropped = [...legacy]
      .filter((key) => !(shell.has(key) || LEGACY_ONLY_FLAG_KEYS.has(key)))
      .sort((a, b) => a.localeCompare(b));
    expect(dropped).toEqual([]);
  });
});

async function collectShellFlagReads(): Promise<ReadonlySet<string>> {
  const { adapter, queried } = createRecordingFeatureFlagAdapter(ALL_PINNED);
  renderShell(
    <BranchShellView {...baseProps({ detail: SHELL_DETAIL })} />,
    adapter
  );
  await waitFor(() =>
    expect(
      screen.getByRole("tab", {
        name: ARTIFACT_DETAIL_TAB_LABELS[ArtifactDetailTab.Artifact],
      })
    ).toBeVisible()
  );
  // Each tab mounts its own panel, so a key read only on Sessions is not
  // queried until Sessions is opened.
  for (const tab of [
    ArtifactDetailTab.Details,
    ArtifactDetailTab.Sessions,
    ArtifactDetailTab.Activity,
    ArtifactDetailTab.Artifact,
  ]) {
    await userEvent.click(
      screen.getByRole("tab", { name: ARTIFACT_DETAIL_TAB_LABELS[tab] })
    );
  }
  cleanup();
  return queried;
}

/**
 * The legacy page names its own two tabs, so this walks whatever tabs it
 * renders rather than the shell's four.
 */
async function collectLegacyFlagReads(): Promise<ReadonlySet<string>> {
  const { adapter, queried } = createRecordingFeatureFlagAdapter(ALL_PINNED);
  renderShell(
    <BranchDetailPage {...baseProps({ detail: SHELL_DETAIL })} />,
    adapter
  );
  await waitFor(() =>
    expect(screen.getAllByRole("tab").length).toBeGreaterThan(0)
  );
  for (const tab of screen.getAllByRole("tab")) {
    await userEvent.click(tab);
  }
  cleanup();
  return queried;
}
