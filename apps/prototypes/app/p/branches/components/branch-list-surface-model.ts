export const BranchesTableColumnId = {
  Owner: "owner",
  /** ISS-10332: the branch artifact's priority, shown by default beside Owner. */
  Priority: "priority",
  Collaborators: "collaborators",
  Sessions: "sessions",
  Changes: "changes",
  Status: "status",
  PullRequest: "pullRequest",
  LastActivity: "lastActivity",
  Repository: "repo",
  Tags: "tags",
  /** ISS-12453: the branch artifact's project, editable per the operator ruling. */
  Project: "project",
} as const;
export type BranchesTableColumnId =
  (typeof BranchesTableColumnId)[keyof typeof BranchesTableColumnId];

export type BranchesTableColumnSpec = {
  id: BranchesTableColumnId;
  label: string;
  width: string;
  sortable?: boolean;
};

export const BRANCHES_TABLE_COLUMN_SPECS: readonly BranchesTableColumnSpec[] = [
  {
    id: BranchesTableColumnId.Owner,
    label: "Owner",
    width: "180px",
    sortable: true,
  },
  {
    id: BranchesTableColumnId.Priority,
    label: "Priority",
    width: "120px",
    sortable: true,
  },
  {
    id: BranchesTableColumnId.Collaborators,
    label: "Collaborators",
    width: "140px",
  },
  {
    id: BranchesTableColumnId.Sessions,
    label: "Linked sessions",
    width: "140px",
    sortable: true,
  },
  {
    id: BranchesTableColumnId.Changes,
    label: "Changes",
    width: "130px",
    sortable: true,
  },
  {
    id: BranchesTableColumnId.Status,
    label: "Status",
    width: "150px",
    sortable: true,
  },
  {
    id: BranchesTableColumnId.PullRequest,
    label: "Pull request",
    width: "140px",
    sortable: true,
  },
  {
    id: BranchesTableColumnId.LastActivity,
    label: "Last active",
    width: "130px",
    sortable: true,
  },
  {
    id: BranchesTableColumnId.Repository,
    label: "Repository",
    width: "180px",
    sortable: true,
  },
  {
    id: BranchesTableColumnId.Tags,
    label: "Tags",
    width: "180px",
  },
  {
    id: BranchesTableColumnId.Project,
    label: "Project",
    width: "160px",
  },
];
