import type { ArtifactRepositorySnapshot } from "@repo/api/src/types/document";

export type PlanSource = {
  id: string;
  title: string;
  projectId?: string | null;
  /**
   * Immutable per-document repository snapshot inherited from PLN-602.
   * Optional so legacy DocumentWithProject rows (still typed before this
   * field surfaced) and bare external sources can satisfy the contract.
   */
  repositorySnapshot?: ArtifactRepositorySnapshot;
  approver?: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email?: string;
  } | null;
  fileName?: string | null;
};

export function generateFileNameFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s]/g, "")
    .replaceAll(/\s+/g, "-")
    .concat("-plan.md");
}

export function generatePlanFileName(source: PlanSource): string {
  if (source.fileName) {
    return source.fileName.replace(".md", "-plan.md");
  }
  return generateFileNameFromTitle(source.title);
}

export function getFinalFileName(
  fileName: string,
  title: string,
  source?: PlanSource
): string {
  if (fileName.trim()) {
    return fileName.trim();
  }
  if (source) {
    return generatePlanFileName(source);
  }
  return generateFileNameFromTitle(title);
}
