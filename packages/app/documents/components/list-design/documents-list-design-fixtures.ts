// gardener-support: test and story data, not shipped
import {
  BranchIdentityAvailability,
  BranchPersonProvider,
  type SourceCollaborators,
} from "@repo/api/src/types/branch-identity";
import { Priority } from "@repo/api/src/types/common";
import {
  type ArtifactStatus,
  DocumentStatus,
  DocumentType,
  type DocumentWithProject,
  SnapshotSource,
} from "@repo/api/src/types/document";
import { TagColor, type TagSummary } from "@repo/api/src/types/tag";
import type { BasicUser } from "@repo/api/src/types/user";
import type { ArtifactListDesignRow } from "./artifact-list-design-shell";

/**
 * ISS-12586 (DI-16) fixtures for the Documents List and Issues List design
 * previews. Every title is a placeholder: the operator exempted story
 * fixtures of design-only components from the no-placeholder rule
 * (2026-10-15). Times are relative to load, so "Updated" reads the same on
 * any day.
 */

const MINUTE_MS = 60_000;

export const LIST_DESIGN_PEOPLE = {
  taylor: person("list-design-user-taylor", "Taylor", "Morgan"),
  sam: person("list-design-user-sam", "Sam", "Lee"),
  jordan: person("list-design-user-jordan", "Jordan", "Kim"),
  riley: person("list-design-user-riley", "Riley", "Chen"),
} as const;

export const LIST_DESIGN_TAGS = {
  design: tag("list-design-tag-design", "Design system", TagColor.Blue),
  research: tag("list-design-tag-research", "Research", TagColor.Green),
  platform: tag("list-design-tag-platform", "Platform", TagColor.Amber),
} as const;

type ListDesignRowInput = Readonly<{
  assignee: BasicUser | null;
  collaborators: readonly BasicUser[];
  commentCount: number;
  favorite?: boolean;
  id: string;
  latestVersion: number;
  /** Issues only: the accountable owner, beside the assignee. */
  owner?: BasicUser | null;
  priority?: Priority;
  slug: string;
  status: ArtifactStatus;
  tags: readonly TagSummary[];
  title: string;
  type: DocumentType;
  updatedMinutesAgo: number;
}>;

/** One list row: the document as the list read serves it, plus its counts. */
export function listDesignRow(
  input: ListDesignRowInput
): ArtifactListDesignRow {
  const updatedAt = new Date(Date.now() - input.updatedMinutesAgo * MINUTE_MS);
  const document: DocumentWithProject = {
    id: input.id,
    organizationId: "list-design-org",
    projectId: null,
    type: input.type,
    title: input.title,
    slug: input.slug,
    fileName: null,
    status: input.status,
    priority: input.priority ?? Priority.Medium,
    latestVersion: input.latestVersion,
    createdById: input.assignee?.id ?? LIST_DESIGN_PEOPLE.taylor.id,
    assigneeId: input.assignee?.id ?? null,
    assignee: input.assignee,
    approverId: null,
    approver: null,
    repositorySnapshot: { repositories: [], source: SnapshotSource.None },
    templateForType: null,
    sortOrder: null,
    tags: [...input.tags],
    createdAt: new Date(updatedAt.getTime() - 3 * 24 * 60 * MINUTE_MS),
    updatedAt,
  };
  return {
    collaborators: collaboratorsOf(input.collaborators),
    commentCount: input.commentCount,
    document,
    favorite: input.favorite ?? false,
    ...(input.owner === undefined ? {} : { owner: input.owner }),
  };
}

const { jordan, riley, sam, taylor } = LIST_DESIGN_PEOPLE;
const { design, platform, research } = LIST_DESIGN_TAGS;

export const DOCUMENTS_LIST_DESIGN_ROWS: readonly ArtifactListDesignRow[] = [
  listDesignRow({
    id: "list-design-doc-0042",
    slug: "DOC-0042",
    title: "Fixture: Artifact detail pages",
    type: DocumentType.Doc,
    status: DocumentStatus.InReview,
    assignee: taylor,
    collaborators: [taylor, sam, jordan],
    commentCount: 6,
    latestVersion: 5,
    tags: [design, research],
    updatedMinutesAgo: 25,
    favorite: true,
  }),
  listDesignRow({
    id: "list-design-doc-0041",
    slug: "DOC-0041",
    title: "Fixture: List surface migration plan",
    type: DocumentType.Doc,
    status: DocumentStatus.Approved,
    assignee: sam,
    collaborators: [sam, riley],
    commentCount: 2,
    latestVersion: 3,
    tags: [platform],
    updatedMinutesAgo: 140,
  }),
  listDesignRow({
    id: "list-design-doc-0040",
    slug: "DOC-0040",
    title: "Fixture: Onboarding checklist",
    type: DocumentType.Doc,
    status: DocumentStatus.Draft,
    assignee: jordan,
    collaborators: [jordan],
    commentCount: 0,
    latestVersion: 1,
    tags: [],
    updatedMinutesAgo: 60 * 9,
  }),
  listDesignRow({
    id: "list-design-doc-0039",
    slug: "DOC-0039",
    title: "Fixture: Workspace settings",
    type: DocumentType.Doc,
    status: DocumentStatus.ChangesRequested,
    assignee: riley,
    collaborators: [riley, taylor, sam, jordan],
    commentCount: 11,
    latestVersion: 7,
    tags: [design],
    updatedMinutesAgo: 60 * 26,
    favorite: true,
  }),
  listDesignRow({
    id: "list-design-doc-0038",
    slug: "DOC-0038",
    title: "Fixture: Search index rebuild",
    type: DocumentType.Doc,
    status: DocumentStatus.Executed,
    assignee: taylor,
    collaborators: [taylor, riley],
    commentCount: 4,
    latestVersion: 2,
    tags: [platform, research],
    updatedMinutesAgo: 60 * 24 * 3,
  }),
  listDesignRow({
    id: "list-design-doc-0037",
    slug: "DOC-0037",
    title: "Fixture: Notification preferences",
    type: DocumentType.Doc,
    status: DocumentStatus.Obsolete,
    assignee: null,
    collaborators: [],
    commentCount: 1,
    latestVersion: 4,
    tags: [],
    updatedMinutesAgo: 60 * 24 * 12,
  }),
];

function person(id: string, firstName: string, lastName: string): BasicUser {
  return {
    id,
    email: `${firstName.toLowerCase()}@example.com`,
    firstName,
    lastName,
    avatarUrl: null,
  };
}

function tag(id: string, name: string, color: TagColor): TagSummary {
  return { id, name, color };
}

function collaboratorsOf(
  people: readonly BasicUser[]
): SourceCollaborators<string> {
  return {
    availability: BranchIdentityAvailability.Complete,
    people: people.map((member) => ({
      provider: BranchPersonProvider.ClosedLoop,
      id: member.id,
      userId: member.id,
      displayName: `${member.firstName} ${member.lastName}`,
    })),
    sources: {},
  };
}
