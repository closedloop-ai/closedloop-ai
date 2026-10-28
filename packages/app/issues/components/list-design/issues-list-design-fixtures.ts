// gardener-support: test and story data, not shipped
import { Priority } from "@repo/api/src/types/common";
import { DocumentType, IssueStatus } from "@repo/api/src/types/document";
import type { ArtifactListDesignRow } from "@repo/app/documents/components/list-design/artifact-list-design-shell";
import {
  LIST_DESIGN_PEOPLE,
  LIST_DESIGN_TAGS,
  listDesignRow,
} from "@repo/app/documents/components/list-design/documents-list-design-fixtures";

/**
 * ISS-12586 (DI-16) fixtures for the Issues List design preview. Every title
 * is a placeholder: the operator exempted story fixtures of design-only
 * components from the no-placeholder rule (2026-10-15).
 */

const { jordan, riley, sam, taylor } = LIST_DESIGN_PEOPLE;
const { design, platform, research } = LIST_DESIGN_TAGS;

export const ISSUES_LIST_DESIGN_ROWS: readonly ArtifactListDesignRow[] = [
  listDesignRow({
    id: "list-design-iss-0118",
    slug: "ISS-0118",
    title: "Fixture: Add the count card to the list",
    type: DocumentType.Feature,
    status: IssueStatus.InProgress,
    priority: Priority.High,
    assignee: sam,
    owner: taylor,
    collaborators: [sam, taylor],
    commentCount: 3,
    latestVersion: 2,
    tags: [design],
    updatedMinutesAgo: 15,
    favorite: true,
  }),
  listDesignRow({
    id: "list-design-iss-0117",
    slug: "ISS-0117",
    title: "Fixture: Keep the toolbar on one row",
    type: DocumentType.Feature,
    status: IssueStatus.Todo,
    priority: Priority.Medium,
    assignee: jordan,
    owner: taylor,
    collaborators: [jordan],
    commentCount: 0,
    latestVersion: 1,
    tags: [design, research],
    updatedMinutesAgo: 95,
  }),
  listDesignRow({
    id: "list-design-iss-0116",
    slug: "ISS-0116",
    title: "Fixture: Retry a failed list read",
    type: DocumentType.Feature,
    status: IssueStatus.InReview,
    priority: Priority.Urgent,
    assignee: riley,
    owner: sam,
    collaborators: [riley, sam, jordan],
    commentCount: 8,
    latestVersion: 4,
    tags: [platform],
    updatedMinutesAgo: 60 * 5,
  }),
  listDesignRow({
    id: "list-design-iss-0115",
    slug: "ISS-0115",
    title: "Fixture: Blocked on the search index",
    type: DocumentType.Feature,
    status: IssueStatus.Blocked,
    priority: Priority.High,
    assignee: taylor,
    owner: riley,
    collaborators: [taylor, riley],
    commentCount: 5,
    latestVersion: 3,
    tags: [platform, research],
    updatedMinutesAgo: 60 * 30,
  }),
  listDesignRow({
    id: "list-design-iss-0114",
    slug: "ISS-0114",
    title: "Fixture: Document the column order",
    type: DocumentType.Feature,
    status: IssueStatus.Done,
    priority: Priority.Low,
    assignee: sam,
    owner: sam,
    collaborators: [sam],
    commentCount: 2,
    latestVersion: 2,
    tags: [],
    updatedMinutesAgo: 60 * 24 * 4,
  }),
  listDesignRow({
    id: "list-design-iss-0113",
    slug: "ISS-0113",
    title: "Fixture: Triage incoming reports",
    type: DocumentType.Feature,
    status: IssueStatus.Backlog,
    priority: Priority.Low,
    assignee: null,
    owner: jordan,
    collaborators: [],
    commentCount: 1,
    latestVersion: 1,
    tags: [],
    updatedMinutesAgo: 60 * 24 * 9,
  }),
];
