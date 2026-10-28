import { IssueStatus } from "@repo/api/src/types/document";
import { ARTIFACT_PRIORITY_UNSET_FLAG_KEY } from "@repo/app/documents/lib/artifact-priority-unset-flag";
import { NO_PRIORITY_LABEL } from "@repo/app/documents/lib/group-by";
import {
  ISSUE_DESIGN_ARTIFACT,
  ISSUE_DESIGN_STATUS_STRIP,
} from "@repo/app/issues/components/detail-design/issue-detail-design-fixtures";
import { IssueStatusStrip } from "@repo/app/issues/components/status-strip/issue-status-strip";
import { ARTIFACT_TAGS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";

// The Issue Detail page's status strip (ISS-12578, DI-08): the issue's key
// fields on the left of the issue canvas's toolbar, which stays at the top of
// the canvas while the issue scrolls, on the Artifact tab only (Ottilie,
// 2026-10-21). It is not under the tab bar and not on the other tabs: the
// Details tab shows the same fields with more room. It is the shipped
// document metadata bar (status on the issue lifecycle, the person field,
// priority, attach files) without the type badge, led by the issue's slug
// and followed by its due date. The slug carries the issue icon its sub-issue
// rows carry, and the slug and due date are bordered like the controls
// beside them (Nerys, 2026-10-22). Project, milestone and tags are on the
// Details tab (Nerys, 2026-10-21).
// Decision pending: the person field keeps its current label until DI-03
// ruling 1 (ISS-12572: one person field on issues, labelled Owner).
// The finished page is Surfaces/Labs/Issues/Issue Detail.
//
// Controls table:
// | Prop | Control | Why |
// |---|---|---|
// No-control table:
// | Prop | Reason |
// |---|---|
// | issueId, slug, metadata | the page's fixture issue; edits are no-ops |
// | dueDate | a fixture fact; each story picks its own |

const strip = ISSUE_DESIGN_STATUS_STRIP;

const meta = {
  title: "Composites/Labs/Issues/Issue Detail/Status Strip",
  component: IssueStatusStrip,
  tags: ["preview"],
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    // Tags stay off the strip even with the artifact tags flag on, and a null
    // priority folds to Medium unless the unset-priority flag is on (ISS-9665).
    appCore: {
      enabledFlags: [
        ARTIFACT_TAGS_FEATURE_FLAG_KEY,
        ARTIFACT_PRIORITY_UNSET_FLAG_KEY,
      ],
    },
  },
  args: {
    issueId: "issue-design-iss-0005",
    slug: ISSUE_DESIGN_ARTIFACT.slug,
    metadata: strip.metadata,
    dueDate: strip.dueDate,
  },
} satisfies Meta<typeof IssueStatusStrip>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A finished issue: its slug, Done, its owner, priority and due date. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(ISSUE_DESIGN_ARTIFACT.slug)).toBeVisible();
    await expect(canvas.getByText("Due date")).toBeVisible();
    await expect(canvas.queryByText("Add tag")).toBeNull();
  },
};

/** Nothing set yet: no owner, no priority, no due date. */
export const Empty: Story = {
  args: {
    metadata: {
      ...strip.metadata,
      assignee: null,
      priority: null,
      status: IssueStatus.Triage,
    },
    dueDate: null,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(NO_PRIORITY_LABEL)).toBeVisible();
    await expect(canvas.queryByText("Medium")).toBeNull();
  },
};

/** Work under way: In progress, no due date. */
export const InProgress: Story = {
  args: {
    metadata: {
      ...strip.metadata,
      status: IssueStatus.InProgress,
    },
    dueDate: null,
  },
};

export const Dark: Story = { globals: { theme: "dark" } };
