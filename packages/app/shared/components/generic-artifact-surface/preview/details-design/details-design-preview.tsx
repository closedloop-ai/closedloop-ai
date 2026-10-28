"use client";

import { SESSIONS_ARTIFACT_TAGS_FLAG_KEY } from "@repo/api/src/types/sessions-artifact-tags-flag";
import { ArtifactDetailShell } from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import type { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import {
  SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY,
  SESSION_LAUNCH_ATTRIBUTION_FEATURE_FLAG_KEY,
  SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY,
  SESSION_TIMELINE_COVERAGE_DISCLOSURE_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { ModeToggle } from "@repo/design-system/components/ui/mode-toggle";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { useState } from "react";
import {
  branchDetailsConfig,
  issueDetailsConfig,
  sessionDetailsConfig,
} from "./details-design-fixtures";
import {
  DetailsAvailability,
  type DetailsConfig,
  type DetailsDesignHost,
  type DetailsPriorityEditor,
  forViewer,
} from "./details-design-model";
import { DetailsSections } from "./details-sections";

/**
 * ISS-10792 design-review harness, for Ottilie's approval, NOT the Details tab
 * implementation: nothing in production imports it, and it is deleted once
 * the approved layout is built for real.
 *
 * It renders the v1 Details tab inside the real ISS-10790 shell
 * for a Session and a Branch (the two PRD-751 types), plus an Issue as a
 * reuse check. The other tabs are intentionally empty here. The priority
 * control and the href builders are injected by the documents-slice host,
 * because `shared/` may not import a feature slice.
 */

const DesignType = {
  Session: "session",
  Branch: "branch",
  Issue: "issue",
} as const;
type DesignType = (typeof DesignType)[keyof typeof DesignType];

const TYPE_SETUP: Readonly<
  Record<
    DesignType,
    {
      config: (host: DetailsDesignHost) => DetailsConfig;
      label: string;
      tabs: readonly ArtifactDetailTab[];
      title: string;
    }
  >
> = {
  session: {
    config: sessionDetailsConfig,
    label: "Session",
    tabs: ["artifact", "details", "activity"],
    title:
      "Fixture: SES-0001 · Rebuild Storybook after component tests stalled",
  },
  branch: {
    config: branchDetailsConfig,
    label: "Branch",
    tabs: ["artifact", "details", "sessions", "activity"],
    title: "Fixture: fixture/graduate-row-range-drag",
  },
  issue: {
    config: issueDetailsConfig,
    label: "Issue (reuse check)",
    tabs: ["artifact", "details", "sessions", "activity"],
    title: "Fixture: ISS-0005 · Details tab",
  },
};

/**
 * Production gates some Session rows and disclosures behind these flags,
 * read at the leaf; the harness turns them on so every row can be reviewed.
 * A bare render is the flag-off case.
 */
const DISCLOSURE_FLAGS_ON = createStaticFeatureFlagAdapter({
  enabledFlags: [
    SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY,
    SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY,
    SESSION_TIMELINE_COVERAGE_DISCLOSURE_FEATURE_FLAG_KEY,
    SESSION_LAUNCH_ATTRIBUTION_FEATURE_FLAG_KEY,
    SESSIONS_ARTIFACT_TAGS_FLAG_KEY,
  ],
});

const OUT_OF_SCOPE = (
  <p className="p-6 text-muted-foreground text-sm">
    Harness text: not part of the Details design. Open the Details tab.
  </p>
);

export function DetailsDesignPreview({
  host,
  priorityEditor,
}: {
  host: DetailsDesignHost;
  priorityEditor: DetailsPriorityEditor;
}) {
  const [type, setType] = useState<DesignType>(DesignType.Session);
  const [availability, setAvailability] = useState<DetailsAvailability>(
    DetailsAvailability.CanEdit
  );
  const [activeTab, setActiveTab] = useState<ArtifactDetailTab>("details");
  const setup = TYPE_SETUP[type];

  return (
    <FeatureFlagAdapterProvider adapter={DISCLOSURE_FLAGS_ON}>
      <TooltipProvider>
        <div className="flex min-h-svh flex-col bg-background">
          <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
            <div className="mr-auto min-w-0">
              <p className="font-medium text-sm">Details tab: v1 layout</p>
              <p className="text-muted-foreground text-xs">
                For review. ISS-12197's fields, in its order; see the notes
                below.
              </p>
            </div>
            <ToggleGroup
              aria-label="Artifact type"
              onValueChange={(value) => {
                if (value) {
                  setType(value as DesignType);
                  setActiveTab("details");
                }
              }}
              size="sm"
              type="single"
              value={type}
              variant="outline"
            >
              {Object.values(DesignType).map((value) => (
                <ToggleGroupItem key={value} value={value}>
                  {TYPE_SETUP[value].label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <ToggleGroup
              aria-label="Viewer situation"
              onValueChange={(value) => {
                if (value) {
                  setAvailability(value as DetailsAvailability);
                }
              }}
              size="sm"
              type="single"
              value={availability}
              variant="outline"
            >
              <ToggleGroupItem value={DetailsAvailability.CanEdit}>
                Can edit
              </ToggleGroupItem>
              <ToggleGroupItem value={DetailsAvailability.Offline}>
                Desktop offline
              </ToggleGroupItem>
              <ToggleGroupItem value={DetailsAvailability.NoPermission}>
                No permission
              </ToggleGroupItem>
            </ToggleGroup>
            <ModeToggle />
          </header>

          <div className="border-b px-4 py-3">
            <p className="truncate font-semibold text-base">{setup.title}</p>
          </div>

          <div className="flex min-h-[36rem] flex-1 flex-col">
            <ArtifactDetailShell
              activeTab={activeTab}
              onActiveTabChange={setActiveTab}
              panels={{
                activity: OUT_OF_SCOPE,
                artifact: OUT_OF_SCOPE,
                details: (
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    <DetailsSections
                      config={forViewer(setup.config(host), availability)}
                      key={type}
                      priorityEditor={priorityEditor}
                    />
                  </div>
                ),
                sessions: OUT_OF_SCOPE,
              }}
              tabs={setup.tabs}
            />
          </div>

          <DesignNotes />
        </div>
      </TooltipProvider>
    </FeatureFlagAdapterProvider>
  );
}

function DesignNotes() {
  return (
    <details className="border-t px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium">Harness notes</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
        <li>
          Layout and editing follow the web-master generic-artifact prototype's
          Details tab: one label and value table, then Custom fields and Linked
          artifacts. One renderer draws every type from typed configuration; a
          block with no rows is left out.
        </li>
        <li>
          Session and Branch rows are ISS-12197's field set in its order, the
          generic artifact rows first, under its labels; flag-gated rows ship
          behind their flag (on here). A read-only row with no value is not
          drawn, an editable one always is. Editable where production writes the
          field (priority, custom field values, Branch and Issue tags, the
          Issue's name, status, assignee, project and due date) and Session
          tags, whose write ISS-10995 delivers.
        </li>
        <li>
          Each field carries a save callback or a read-only reason (not
          editable, desktop offline, no permission). The lock in the pencil's
          place opens it on click or tap. All reason wording comes from the
          host; here it is fixture text.
        </li>
        <li>
          Session Cost, Duration, the pill rows, the counts, the date-times and
          the copyable IDs are the host's own read-only cells. Cost is
          production's value with its flag-gated sentences; the flags are on
          here.
        </li>
        <li>
          Required by the ticket, unlike the prototype: no Version history and
          no Activity section (Activity is its own tab); status and priority use
          the canonical components; collaborators are derived and read-only, and
          a list not fully read shows the unknown dash, never an empty one.
        </li>
        <li>
          Links point at production routes. The fixtures have no records behind
          them, so those destinations do not exist here.
        </li>
      </ul>
    </details>
  );
}
