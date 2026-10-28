import { AgentSessionCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import { ArtifactTagAvailability, TagColor } from "@repo/api/src/types/tag";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import {
  SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY,
  SESSIONS_COMMENT_COUNT_TAG_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import type { Meta, StoryObj } from "@storybook/react";
import { ExternalLinkIcon } from "lucide-react";
import {
  createAgentSessionListItemFixture,
  mixedAgentSessionListFixtures,
  populatedAgentSessionListFixtures,
} from "./session-list-fixtures";
import { SyncedSessionsTable } from "./synced-sessions-table";

const meta = {
  title: "Composites v1.0/Sessions/Synced Sessions Table",
  tags: ["deprecated"],
  component: SyncedSessionsTable,
  parameters: {
    layout: "padded",
  },
  args: {
    getSessionHref: (item) => `/sessions/${item.id}`,
    items: populatedAgentSessionListFixtures,
  },
} satisfies Meta<typeof SyncedSessionsTable>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const MixedFallbacks: Story = {
  args: {
    items: mixedAgentSessionListFixtures,
  },
};

export const OrgMonitoringArtifactColumn: Story = {
  args: {
    extraColumnLabel: "Artifact",
    getSessionHref: (item) => `/acme/sessions/${item.id}`,
    renderExtraColumn: (item) => (
      <Button asChild size="sm" variant="ghost">
        <a href={`/acme/features/${item.sourceArtifact?.slug ?? "FEA-1515"}`}>
          View
          <ExternalLinkIcon className="size-3.5" />
        </a>
      </Button>
    ),
  },
};

export const NonOrgMonitoringNoArtifactColumn: Story = {
  args: {
    getSessionHref: (item) => `/sessions/${item.id}`,
  },
};

export const AttentionStates: Story = {
  args: {
    extraColumnLabel: "State",
    renderExtraColumn: (item) => (
      <Badge variant={item.awaitingInputSince ? "warning" : "outline"}>
        {item.awaitingInputSince ? "Awaiting input" : "Synced"}
      </Badge>
    ),
  },
};

// ISS-4774 / ISS-5036: the consolidated "Syncing" Status pill. A still-uploading
// row renders ONE pill reading "Syncing" in the Status column — replacing the
// "Active" pill, not joining it — while the inline name-cell sync pills are
// dropped and liveness rides a green dot beside the session name. The second row
// is the contrast: a synced Active row keeps its ordinary "Active" pill and no
// dot, because that pill already carries liveness.
//
// The fold keys on `transcriptDisposition === "syncing"`, NOT on
// `cloudSyncState` (ISS-4846: `reconcileCloudSyncState` maps both `syncing` and
// `failedTransient` onto `pending`, so a `pending`-only fixture would either not
// fold or, worse, imply a retrying row is a healthy one). The fixture carries the
// verdict for that reason.
//
// ISS-5697: this used to carry a bare `AppCoreStoryProviders` wrapper, annotated
// as being what "resolves the flag on". It never did — the wrapper passed no
// `enabledFlags`, so it was identical to the harness default — and there is no
// flag left to resolve either way: `isSyncStateFoldActive` reads only the
// visible-column set, ISS-5366 having retired the gate to its enabled state.
// The wrapper is gone (the preview mounts the harness globally, ISS-5665) and
// the fold presentation below is unchanged.
const syncStateStoryItems = [
  createAgentSessionListItemFixture({
    id: "uploading-session",
    name: "Uploading session",
    status: "active",
    cloudSyncState: AgentSessionCloudSyncState.Pending,
    transcriptDisposition: TranscriptDisposition.Syncing,
  }),
  createAgentSessionListItemFixture({
    id: "synced-session",
    name: "Synced session",
    status: "active",
    cloudSyncState: AgentSessionCloudSyncState.Synced,
  }),
];

export const SyncingStatusPill: Story = {
  render: () => (
    <SyncedSessionsTable
      getSessionHref={(item) => `/sessions/${item.id}`}
      items={syncStateStoryItems}
    />
  ),
};

/**
 * FEA-4204, gate OPEN. Without this story the tag is invisible in Storybook
 * until the flag flips for everyone.
 *
 * The rows are built here rather than reusing `populatedAgentSessionListFixtures`
 * because that set carries no `commentCount` at all — it would render the gate-on
 * state as four untagged rows and show nothing. All three cases are present on
 * purpose: a discussed row, a row COUNTED at zero, and a row nobody counted (the
 * key absent, which is what the desktop local read emits). The last two must look
 * identical and must not show a "0".
 */
const commentTagStoryItems = [
  createAgentSessionListItemFixture({
    id: "discussed-session",
    name: "Discussed session",
    commentCount: 3,
  }),
  createAgentSessionListItemFixture({
    id: "single-comment-session",
    name: "One comment session",
    commentCount: 1,
  }),
  createAgentSessionListItemFixture({
    id: "counted-zero-session",
    name: "Counted, no comments",
    commentCount: 0,
  }),
  createAgentSessionListItemFixture({
    id: "uncounted-session",
    name: "Never counted",
  }),
];

export const CommentCountTagFlagOn: Story = {
  args: { items: commentTagStoryItems },
  parameters: {
    appCore: { enabledFlags: [SESSIONS_COMMENT_COUNT_TAG_FEATURE_FLAG_KEY] },
  },
};

/**
 * ISS-8712: the `Tags` column, wired on. `showTagsColumn` alone is not
 * enough — `SessionsTable` additionally gates the column behind
 * `SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY`, so this story enables both. One
 * row carries applied tags, one is available-but-empty (the picker's own
 * empty affordance), and one never had the relation loaded at all (renders
 * the shared unknown-cell em dash, `ArtifactTagAvailability.Unavailable`).
 */
const tagsColumnStoryItems = [
  createAgentSessionListItemFixture({
    id: "tagged-session",
    name: "Flaky retry on desktop sync",
    tagAvailability: ArtifactTagAvailability.Available,
    tagPermissions: { canApply: true, canRemove: true },
    tags: [
      { id: "tag-regression", name: "Regression", color: TagColor.Red },
      { id: "tag-needs-review", name: "Needs review", color: TagColor.Amber },
    ],
  }),
  createAgentSessionListItemFixture({
    id: "untagged-session",
    name: "Onboarding polish pass",
    tagAvailability: ArtifactTagAvailability.Available,
    tagPermissions: { canApply: true, canRemove: true },
    tags: [],
  }),
  createAgentSessionListItemFixture({
    id: "tag-relation-unloaded-session",
    name: "Legacy import cleanup",
    tagAvailability: ArtifactTagAvailability.Unavailable,
  }),
];

export const TagsColumn: Story = {
  args: { items: tagsColumnStoryItems, showTagsColumn: true },
  parameters: {
    appCore: { enabledFlags: [SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY] },
  },
};
