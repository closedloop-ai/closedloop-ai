// gardener-support: test and story data, not shipped
import {
  ARTIFACT_DETAIL_TABS,
  ArtifactDetailTab,
} from "@repo/app/shared/lib/artifact-detail-tab";
import { type ComponentProps, type ReactNode, useState } from "react";
import {
  ArtifactDetailNoticeTone,
  ArtifactDetailShell,
  type ArtifactDetailTabState,
  ArtifactDetailTabStateKind,
} from "./artifact-detail-shell";
/** Presentational fixtures shared by shell mechanics and feature availability stories. */
export const ActivityStateArg = {
  None: "none",
  Unsupported: "unsupported",
  Partial: "partial",
  Stale: "stale",
  Error: "error",
} as const;
export type ActivityStateArg =
  (typeof ActivityStateArg)[keyof typeof ActivityStateArg];

// Fixture rows: enough to overflow the 42rem harness at any width.
export const LONG_PANEL_ROWS = Array.from(
  { length: 80 },
  (_, index) => `Fixture: canvas row ${index + 1}`
);

export const ACTIVITY_STATES: Record<
  Exclude<ActivityStateArg, typeof ActivityStateArg.None>,
  ArtifactDetailTabState
> = {
  // Fixture wording only: the shell ships none, each host supplies its own.
  [ActivityStateArg.Unsupported]: {
    description: "Fixture: this host has no activity source yet.",
    kind: ArtifactDetailTabStateKind.Unsupported,
    title: "Fixture: Activity not connected yet",
  },
  [ActivityStateArg.Partial]: {
    description: "Fixture: Two sessions could not be read. Showing the rest.",
    kind: ArtifactDetailTabStateKind.Partial,
    title: "Fixture: Some activity is missing",
    tone: ArtifactDetailNoticeTone.Warning,
  },
  [ActivityStateArg.Stale]: {
    action: { label: "Retry", onSelect: () => undefined },
    description: "Fixture: Showing the last activity we could load.",
    kind: ArtifactDetailTabStateKind.Stale,
    title: "Fixture: Latest activity unavailable",
    tone: ArtifactDetailNoticeTone.Warning,
  },
  [ActivityStateArg.Error]: {
    action: { label: "Retry", onSelect: () => undefined },
    description: "Fixture: Showing the last activity we could load.",
    kind: ArtifactDetailTabStateKind.Stale,
    title: "Fixture: Activity could not refresh",
    tone: ArtifactDetailNoticeTone.Error,
  },
};

/**
 * One empty region of a page layout, named for the slot it is (Patterns
 * shows layout, never content). The name is a Storybook annotation, not
 * product copy.
 */
export function LayoutRegion({
  className,
  label,
  testId,
}: Readonly<{ className?: string; label: string; testId?: string }>) {
  return (
    <div
      className={`flex items-center justify-center rounded-md border border-muted-foreground/40 border-dashed text-muted-foreground text-xs ${className ?? ""}`}
      data-testid={testId}
    >
      {label}
    </div>
  );
}

const LAYOUT_PANEL_LABELS: Record<ArtifactDetailTab, string> = {
  [ArtifactDetailTab.Artifact]: "Artifact tab region",
  [ArtifactDetailTab.Details]: "Details tab region",
  [ArtifactDetailTab.Sessions]: "Sessions tab region",
  [ArtifactDetailTab.Activity]: "Activity tab region",
};

export function ShellHarness({
  activeTab: controlledActiveTab,
  activityState = ActivityStateArg.None,
  headerActionsTabs,
  headerEndLabel = "Header end",
  initialTab = ArtifactDetailTab.Artifact,
  keepMountedTabs,
  layoutOnly = false,
  longHeaderActions = false,
  longPanel = false,
  onActiveTabChange,
  pageHeader = false,
  railOpen = true,
  railTabs,
  tabLabels,
  tabs = ARTIFACT_DETAIL_TABS,
}: {
  activeTab?: ArtifactDetailTab;
  activityState?: ActivityStateArg;
  headerActionsTabs?: readonly ArtifactDetailTab[];
  /** The name of the header end region, for a page that knows what goes there. */
  headerEndLabel?: string;
  initialTab?: ArtifactDetailTab;
  keepMountedTabs?: readonly ArtifactDetailTab[];
  /**
   * Patterns: every slot is an empty, named region (header actions,
   * header end, each tab's panel, the comments rail) instead of fixture
   * content.
   */
  layoutOnly?: boolean;
  longHeaderActions?: boolean;
  longPanel?: boolean;
  onActiveTabChange?: (tab: ArtifactDetailTab) => void;
  /**
   * Adds the page header row above the shell, as a detail page lays it out:
   * the breadcrumbs, with the comments toggle at its end beside the rail.
   */
  pageHeader?: boolean;
  railOpen?: boolean;
  /**
   * The tabs the comments rail sits beside, as the host decides. Omitted, it
   * sits beside every tab but Details.
   */
  railTabs?: readonly ArtifactDetailTab[];
  /** A host's own wording for a tab, as Session renames Sessions (ISS-12167). */
  tabLabels?: Readonly<Partial<Record<ArtifactDetailTab, string>>>;
  tabs?: readonly ArtifactDetailTab[];
}) {
  // Uncontrolled by default (the fixed stories just want a working tab bar);
  // Default lifts this to Storybook's args so the Controls panel and the
  // canvas stay in sync both ways.
  const [internalActiveTab, setInternalActiveTab] =
    useState<ArtifactDetailTab>(initialTab);
  const activeTab = controlledActiveTab ?? internalActiveTab;
  const layoutBodies = Object.fromEntries(
    ARTIFACT_DETAIL_TABS.map((tab) => [
      tab,
      <LayoutRegion
        className="m-4 min-h-64 flex-1"
        key={tab}
        label={LAYOUT_PANEL_LABELS[tab]}
        testId={`panel-${tab}`}
      />,
    ])
  ) as Record<ArtifactDetailTab, ReactNode>;
  const contentBodies: Record<ArtifactDetailTab, ReactNode> = {
    artifact: longPanel ? (
      // The host's own scroll container, as real tab bodies bring one: the
      // shell's job is only to bound the panel's height so it can scroll.
      <div
        className="min-h-0 flex-1 overflow-y-auto p-4"
        data-testid="panel-artifact"
      >
        {LONG_PANEL_ROWS.map((row) => (
          <p className="py-1 text-sm" key={row}>
            {row}
          </p>
        ))}
      </div>
    ) : (
      <p className="p-4 text-sm" data-testid="panel-artifact">
        Artifact canvas fixture content.
      </p>
    ),
    details: (
      <p className="p-4 text-sm" data-testid="panel-details">
        Details fixture content.
      </p>
    ),
    sessions: (
      <div className="p-4" data-testid="panel-sessions">
        <label className="flex flex-col gap-1 text-sm">
          Sessions note
          <input className="rounded border px-2 py-1" type="text" />
        </label>
      </div>
    ),
    activity: (
      <p className="p-4 text-sm" data-testid="panel-activity">
        Activity fixture content.
      </p>
    ),
  };

  const bodies = layoutOnly ? layoutBodies : contentBodies;
  const railBesideTab = railTabs
    ? railTabs.includes(activeTab)
    : activeTab !== ArtifactDetailTab.Details;

  return (
    <div className="flex h-[42rem] flex-col bg-background">
      {pageHeader ? (
        <div
          className="flex h-12 shrink-0 items-center justify-between gap-4 border-b px-4"
          data-testid="page-header"
        >
          <LayoutRegion
            className="h-8 w-64"
            label="Breadcrumbs"
            testId="page-header-breadcrumbs"
          />
          {railBesideTab ? (
            <LayoutRegion
              className="h-8 w-36"
              label="Comments toggle"
              testId="page-header-comments-toggle"
            />
          ) : null}
        </div>
      ) : null}
      <ArtifactDetailShell
        activeTab={activeTab}
        comments={
          railOpen && railBesideTab ? (
            <aside
              aria-label="Comments"
              className="flex w-80 shrink-0 flex-col border-l p-4 max-md:hidden"
              data-testid="rail-content"
            >
              {layoutOnly ? (
                <LayoutRegion className="flex-1" label="Comments rail region" />
              ) : (
                <h2 className="font-medium text-sm">Comments</h2>
              )}
            </aside>
          ) : null
        }
        headerActions={
          layoutOnly ? (
            <LayoutRegion
              className="h-8 w-32"
              label="Header actions"
              testId="header-actions"
            />
          ) : (
            <>
              <button
                className="rounded border px-2 py-1 text-sm"
                type="button"
              >
                Refresh
              </button>
              {longHeaderActions ? (
                <>
                  <button
                    className="rounded border px-2 py-1 text-sm"
                    type="button"
                  >
                    Copy ID
                  </button>
                  <button
                    className="rounded border px-2 py-1 text-sm"
                    type="button"
                  >
                    Copy URL
                  </button>
                </>
              ) : null}
            </>
          )
        }
        headerActionsTabs={headerActionsTabs?.filter((tab) =>
          tabs.includes(tab)
        )}
        headerEnd={
          layoutOnly ? (
            <LayoutRegion
              className="h-8 w-28"
              label={headerEndLabel}
              testId="header-end"
            />
          ) : (
            <span
              className="text-muted-foreground text-sm"
              data-testid="header-end"
            >
              3 collaborators
            </span>
          )
        }
        keepMountedTabs={keepMountedTabs}
        onActiveTabChange={(tab) => {
          setInternalActiveTab(tab);
          onActiveTabChange?.(tab);
        }}
        panels={
          Object.fromEntries(tabs.map((tab) => [tab, bodies[tab]])) as Record<
            ArtifactDetailTab,
            ReactNode
          >
        }
        tabLabels={tabLabels}
        tabStates={
          activityState === ActivityStateArg.None
            ? undefined
            : { activity: ACTIVITY_STATES[activityState] }
        }
        tabs={tabs}
      />
    </div>
  );
}

/** A host whose tab strip starts below the page fold, for outer-scroll regression proof. */
export function TallShellHarness(props: ComponentProps<typeof ShellHarness>) {
  // Chromium scroll anchoring otherwise moves `scrollY` by a pixel when content
  // above the anchor node resizes, and the tall-host e2e asserts the exact
  // offset it scrolled to (ISS-12138).
  return (
    <div className="[overflow-anchor:none]">
      <div aria-hidden="true" className="h-screen" />
      <ShellHarness {...props} />
      <div aria-hidden="true" className="h-screen" />
    </div>
  );
}
