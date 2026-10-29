import { Priority } from "@repo/api/src/types/common";
import type { ArtifactRepositorySnapshot } from "@repo/api/src/types/document";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { TagColor } from "@repo/api/src/types/tag";
import { ARTIFACT_PRIORITY_UNSET_FLAG_KEY } from "@repo/app/documents/lib/artifact-priority-unset-flag";
import { ARTIFACT_TAGS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import type { Meta, StoryObj } from "@storybook/react";
import {
  DocumentMetadataBar,
  type DocumentMetadataBarView,
} from "./document-metadata-bar";

const TEAM_MEMBERS: User[] = [
  { id: "user-1", name: "Ada Lovelace", email: "ada@example.com" },
  { id: "user-2", name: "Grace Hopper", email: "grace@example.com" },
];

const REPOSITORIES_WITH_PRIMARY: ArtifactRepositorySnapshot = {
  source: "loop_selection",
  repositories: [
    {
      fullName: "closedloop-ai/closedloop-ai",
      role: "primary",
      position: 1,
      branch: "codex/design-system-adoption-audit",
    },
    {
      fullName: "closedloop-ai/claude-plugins",
      role: "additional",
      position: 2,
    },
  ],
};

const NO_REPOSITORIES: ArtifactRepositorySnapshot = {
  source: "none",
  repositories: [],
};

const POPULATED_METADATA: DocumentMetadataBarView = {
  assignee: TEAM_MEMBERS[0],
  handleAssigneeChange: () => undefined,
  handlePriorityChange: () => undefined,
  handleStatusChange: () => undefined,
  priority: Priority.High,
  repositorySnapshot: REPOSITORIES_WITH_PRIMARY,
  status: DocumentStatus.InReview,
  teamMembers: TEAM_MEMBERS,
};

const EMPTY_METADATA: DocumentMetadataBarView = {
  assignee: null,
  handleAssigneeChange: () => undefined,
  handlePriorityChange: () => undefined,
  handleStatusChange: () => undefined,
  priority: null,
  repositorySnapshot: NO_REPOSITORIES,
  status: DocumentStatus.Draft,
  teamMembers: TEAM_MEMBERS,
};

/**
 * Same unset priority as {@link EMPTY_METADATA}, on an otherwise populated bar
 * — isolates what the flag default does to the priority trigger specifically,
 * rather than reading as "the empty state, minus tags".
 */
const UNSET_PRIORITY_METADATA: DocumentMetadataBarView = {
  ...POPULATED_METADATA,
  priority: null,
};

/**
 * The metadata bar rendered on every document editor page (status, priority,
 * assignee, tag picker, repositories summary, attach-files). `metadata` is
 * `DocumentMetadataBarView` — a plain pre-resolved slice of
 * `useDocumentMetadata`'s return, not the hook itself — so it is directly
 * storyable with no query/mutation harness underneath it.
 */
const meta = {
  title: "Composites v1.0/Documents/Document Metadata Bar",
  component: DocumentMetadataBar,
  tags: ["deprecated", "autodocs"],
  parameters: {
    layout: "padded",
    // Both stories need the tag picker rendered to show its populated vs.
    // empty state, and the unset-priority flag on so a genuinely null
    // priority shows the "No priority" trigger instead of folding to Medium
    // (ARTIFACT_PRIORITY_UNSET_FLAG_KEY's OFF default, ISS-9665).
    appCore: {
      enabledFlags: [
        ARTIFACT_TAGS_FEATURE_FLAG_KEY,
        ARTIFACT_PRIORITY_UNSET_FLAG_KEY,
      ],
    },
  },
  args: {
    documentId: "artifact-482",
    documentType: DocumentType.Prd,
    metadata: POPULATED_METADATA,
    tags: [
      { id: "tag-backend", name: "backend", color: TagColor.Blue },
      { id: "tag-urgent", name: "urgent", color: TagColor.Red },
    ],
  },
} satisfies Meta<typeof DocumentMetadataBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every field set: assignee, priority, repositories, and applied tags. */
export const Populated: Story = {};

/**
 * Nothing set yet: unassigned, no priority, no linked repositories, no tags.
 * Each field renders its own empty-value affordance rather than a blank gap
 * (the priority trigger's "No priority" label, the repositories chip's own
 * empty copy, and a tag picker with no chips) so the row stays scannable
 * instead of looking broken.
 */
export const Empty: Story = {
  args: {
    metadata: EMPTY_METADATA,
    tags: [],
  },
};

/**
 * Neither governing flag set — the real production default TODAY, not just
 * the meta-level convenience this file's other two stories opt into so the
 * tag picker and the honest "No priority" trigger are visible at all.
 * `ARTIFACT_PRIORITY_UNSET_FLAG_KEY` off folds a `null` priority to
 * `Medium` (ISS-9665's pre-rollout behavior) rather than showing "No
 * priority", and `artifact-tags` off drops the tag picker entirely — so a
 * document with no priority set still shows a priority, and applied tags
 * (irrelevant here, since nothing renders them) go unseen.
 */
export const DefaultFlags: Story = {
  args: {
    metadata: UNSET_PRIORITY_METADATA,
  },
  parameters: {
    appCore: { enabledFlags: [] },
  },
};

/**
 * Every Feature-type document (`DocumentType.Feature`) passes
 * `showRepositories={false}` — Features don't expose repos at the document
 * level (see the prop's own docstring on `DocumentMetadataBar`) — so the
 * `ArtifactRepositoriesSummary` chip that every other story here renders is
 * absent, not merely empty.
 */
export const Feature: Story = {
  args: {
    documentType: DocumentType.Feature,
    showRepositories: false,
  },
};
