import type { EntityType } from "@repo/api/src/types/entity-link";

export type PlanSource = {
  id: string;
  title: string;
  sourceType: EntityType;
  projectId?: string | null;
  workstreamId?: string | null;
  /** Only present for document sources */
  latestVersion?: number;
  targetRepo?: string | null;
  targetBranch?: string | null;
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
