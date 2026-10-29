import { DocumentType } from "@repo/api/src/types/document";
import {
  ActivityArtifactKind,
  ActivityCard,
  ActivityCardLayout,
} from "@repo/app/documents/components/feed-sidebar/sources/activity-card";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import {
  ACTIVITY_CATALOG,
  ACTIVITY_FIXTURE_LINKS,
  ACTIVITY_FIXTURE_NOW,
  ACTIVITY_QUERY_DATA,
  type ActivityCatalogId,
  C02_ACTOR_VARIANTS,
  LONG_VALUE_ROW,
  MISSING_USER_ROW,
} from "./activity-catalog.fixtures";
import {
  type ActivityTimelineRow,
  ActivityTimelineRowKind,
} from "./activity-timeline";

/**
 * One activity row on the Activity tab (ISS-12117): the actor's avatar on the
 * timeline's line, then **Actor** [badge] phrase · context · time. This is the
 * production `ActivityCard` in its `timeline` look; switch `layout` to `rail`
 * to see the same row as the Document comments rail draws it (one adapter,
 * two looks).
 *
 * One story per item the ISS-10994 activity capture inventory lists (C01–C31,
 * and the Document feed's four projections P1–P4), then the actor variants and
 * the edge cases. Each story's description says where that item can be read
 * today; that availability is documentation only and never appears in the UI.
 *
 * Controls table:
 * | Prop | Control | Why |
 * |---|---|---|
 * | layout | select | the tab's timeline look or the comments rail's card |
 * | artifactKind | select | whose feed; a Session words statuses and moves its own way |
 * | documentType | select | the "created this …" noun and the status vocabulary |
 * No-control table:
 * | Prop | Reason |
 * |---|---|
 * | item | fixture rows copied from the inventory; each story picks its own |
 * | links | host-supplied links (version, run, report, related artifact), fixed fixtures |
 * | now | pinned to the fixtures' clock so relative times are deterministic |
 */
const meta = {
  title: "Composites/Shared/Activity/Activity Card",
  component: ActivityCard,
  tags: ["stable", "autodocs"],
  parameters: {
    layout: "padded",
    appCore: { queryData: ACTIVITY_QUERY_DATA },
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
  argTypes: {
    layout: { control: "select", options: Object.values(ActivityCardLayout) },
    artifactKind: {
      control: "select",
      options: Object.values(ActivityArtifactKind),
    },
    documentType: { control: "select", options: Object.values(DocumentType) },
    item: { control: false },
    links: { control: false },
    now: { control: false },
  },
  args: {
    item: activityItem(ACTIVITY_CATALOG.C02.row),
    layout: ActivityCardLayout.Timeline,
    artifactKind: ActivityArtifactKind.Document,
    documentType: DocumentType.Feature,
    links: ACTIVITY_FIXTURE_LINKS,
    now: ACTIVITY_FIXTURE_NOW,
  },
} satisfies Meta<typeof ActivityCard>;

export default meta;
type Story = StoryObj<typeof meta>;

function activityItem(row: ActivityTimelineRow) {
  if (row.kind !== ActivityTimelineRowKind.Activity) {
    throw new Error("Activity Card stories render activity rows only");
  }
  return row.item;
}

/** The args and docs for one catalog row. */
function catalogStory(id: ActivityCatalogId): Omit<Story, "name"> {
  const entry = ACTIVITY_CATALOG[id];
  return {
    args: {
      item: activityItem(entry.row),
      artifactKind: entry.artifactKind,
      documentType: entry.documentType ?? DocumentType.Feature,
    },
    parameters: {
      docs: {
        description: {
          story: [
            `${entry.id} · ${entry.name}. Availability: ${entry.availability}`,
            entry.note,
          ]
            .filter(Boolean)
            .join(" "),
        },
      },
    },
  };
}

export const C01DocumentCreated: Story = {
  name: "C01 Document Created",
  ...catalogStory("C01"),
};
export const C02SingleStatusEdit: Story = {
  name: "C02 Single Status Edit",
  ...catalogStory("C02"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Emily Carter")).toBeVisible();
    await expect(canvas.getByText("Draft")).toBeVisible();
    await expect(canvas.getByText("In Review")).toBeVisible();
    // The exact time ("Oct 7, 13:00" in the fixture's zone).
    await expect(canvasElement.querySelector("time")).toBeVisible();
  },
};
export const C03BulkStatusMove: Story = {
  name: "C03 Bulk Status Move",
  ...catalogStory("C03"),
};
export const C04DependentAutoUnblocked: Story = {
  name: "C04 Dependent Auto-Unblocked",
  ...catalogStory("C04"),
};
export const C05SessionStatusViaGroupingWrite: Story = {
  name: "C05 Session Status via Grouping Write",
  ...catalogStory("C05"),
};
export const C06SessionStatusByIngest: Story = {
  name: "C06 Session Status by Ingest",
  ...catalogStory("C06"),
};
export const C07StaleSessionReaped: Story = {
  name: "C07 Stale Session Reaped",
  ...catalogStory("C07"),
};
export const C08AssigneeChanged: Story = {
  name: "C08 Assignee Changed",
  ...catalogStory("C08"),
};
export const C09ApproverChanged: Story = {
  name: "C09 Approver Changed",
  ...catalogStory("C09"),
};
export const C10SessionOwnerChanged: Story = {
  name: "C10 Session Owner Changed",
  ...catalogStory("C10"),
};
export const C11SessionOwnersBulkAssigned: Story = {
  name: "C11 Session Owners Bulk-Assigned",
  ...catalogStory("C11"),
};
export const C12TitleChanged: Story = {
  name: "C12 Title Changed",
  ...catalogStory("C12"),
};
export const C13DueDateChanged: Story = {
  name: "C13 Due Date Changed",
  ...catalogStory("C13"),
};
export const C14PriorityChanged: Story = {
  name: "C14 Priority Changed",
  ...catalogStory("C14"),
};
export const C15PrioritiesBulkChanged: Story = {
  name: "C15 Priorities Bulk-Changed",
  ...catalogStory("C15"),
};
export const C16SessionPriorityChanged: Story = {
  name: "C16 Session Priority Changed",
  ...catalogStory("C16"),
};
export const C17BranchPriorityChanged: Story = {
  name: "C17 Branch Priority Changed",
  ...catalogStory("C17"),
};
export const C18SessionPrioritySeededBySync: Story = {
  name: "C18 Session Priority Seeded by Sync",
  ...catalogStory("C18"),
};
export const C19DocumentProjectChanged: Story = {
  name: "C19 Document Project Changed",
  ...catalogStory("C19"),
};
export const C20BatchMoveBetweenProjects: Story = {
  name: "C20 Batch Move Between Projects",
  ...catalogStory("C20"),
};
export const C21SessionProjectChanged: Story = {
  name: "C21 Session Project Changed",
  ...catalogStory("C21"),
};
export const C22SessionProjectChangedByIngest: Story = {
  name: "C22 Session Project Changed by Ingest",
  ...catalogStory("C22"),
};
export const C23SessionRenamed: Story = {
  name: "C23 Session Renamed",
  ...catalogStory("C23"),
};
export const C24SessionNameSeededBySync: Story = {
  name: "C24 Session Name Seeded by Sync",
  ...catalogStory("C24"),
};
export const C25TagAddedInBatch: Story = {
  name: "C25 Tag Added in Batch",
  ...catalogStory("C25"),
};
export const C26SingleSessionTagAdded: Story = {
  name: "C26 Single Session Tag Added",
  ...catalogStory("C26"),
};
export const C27SingleSessionTagRemoved: Story = {
  name: "C27 Single Session Tag Removed",
  ...catalogStory("C27"),
};
export const C28SingleBranchTagAdded: Story = {
  name: "C28 Single Branch Tag Added",
  ...catalogStory("C28"),
};
export const C29SingleBranchTagRemoved: Story = {
  name: "C29 Single Branch Tag Removed",
  ...catalogStory("C29"),
};
export const C30MonitoredBranchTargetRetained: Story = {
  name: "C30 Monitored Branch Target Retained",
  ...catalogStory("C30"),
};
export const C31MonitoredPrTargetRetained: Story = {
  name: "C31 Monitored PR Target Retained",
  ...catalogStory("C31"),
};
export const P1VersionCreated: Story = {
  name: "P1 Version Created",
  ...catalogStory("P1"),
};
export const P2Derivation: Story = {
  name: "P2 Derivation",
  ...catalogStory("P2"),
};
export const P4Evaluation: Story = {
  name: "P4 Evaluation",
  ...catalogStory("P4"),
};

/** C02 by a person: avatar and name, no badge. */
export const C02Human: Story = {
  name: "C02 Human",
  args: { item: activityItem(C02_ACTOR_VARIANTS.human) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Emily Carter")).toBeVisible();
    await expect(canvas.queryByText("API", { exact: true })).toBeNull();
  },
};

/**
 * C02 through Emily's API key: the key owner's avatar and name, plus the "API"
 * badge, so it never reads as Emily's own edit.
 */
export const C02AgentApi: Story = {
  name: "C02 Agent (API)",
  args: { item: activityItem(C02_ACTOR_VARIANTS.agent) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Emily Carter")).toBeVisible();
    await expect(canvas.getByText("API", { exact: true })).toBeVisible();
  },
};

/**
 * C02 by the system: the neutral System avatar and the word "System", no
 * badge (the kind is stated once, ISS-5972), never a person.
 */
export const C02System: Story = {
  name: "C02 System",
  args: { item: activityItem(C02_ACTOR_VARIANTS.system) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("System")).toBeVisible();
    await expect(canvas.queryByText("API", { exact: true })).toBeNull();
  },
};

/**
 * A title long enough to truncate on both sides. The full values stay in the
 * DOM and in a tooltip that hover or keyboard focus opens.
 */
export const LongValueTruncation: Story = {
  name: "Long Value Truncation",
  args: { item: activityItem(LONG_VALUE_ROW) },
};

/**
 * An assignment by, and to, a member who has since left. "Unknown user" is
 * said only once the directory has settled; a uuid is never shown.
 */
export const MissingUser: Story = {
  name: "Missing User",
  args: { item: activityItem(MISSING_USER_ROW) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText("Unknown user").length).toBe(2);
  },
};

/** The same row in the comments rail's compact card (one adapter, two looks). */
export const RailLook: Story = {
  name: "Rail Look",
  args: { layout: ActivityCardLayout.Rail },
};

/** The timeline look in the dark theme. */
export const Dark: Story = {
  ...catalogStory("C03"),
  globals: { theme: "dark" },
};
