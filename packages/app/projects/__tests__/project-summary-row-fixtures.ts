import type {
  ProjectSummaryOwner,
  ProjectSummaryRow,
} from "../lib/project-summary-row";

export const ADA = {
  id: "u-ada",
  initials: "AL",
  name: "Ada Lovelace",
} satisfies ProjectSummaryOwner;

export const GRACE = {
  id: "u-grace",
  initials: "GH",
  name: "Grace Hopper",
} satisfies ProjectSummaryOwner;

export function makeProjectSummaryRow(
  overrides: Partial<ProjectSummaryRow> & Pick<ProjectSummaryRow, "id" | "name">
): ProjectSummaryRow {
  return {
    childTaskCount: null,
    code: null,
    completionPercentage: null,
    dueDateLabel: null,
    dueDateMs: null,
    owner: null,
    priority: null,
    updatedAtMs: 0,
    updatedLabel: "just now",
    ...overrides,
  };
}
