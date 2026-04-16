import { ArtifactStatus } from "@repo/api/src/types/artifact";
import type { ArtifactRowItem } from "@/components/artifact-table/artifact-row";
import { ARTIFACT_STATUS_LABELS } from "@/lib/project-constants";

/** Fixed display order matching the ArtifactStatus enum. */
export const STATUS_DISPLAY_ORDER: ArtifactStatus[] = [
  ArtifactStatus.Draft,
  ArtifactStatus.InProgress,
  ArtifactStatus.InReview,
  ArtifactStatus.Approved,
  ArtifactStatus.Executed,
  ArtifactStatus.Done,
  ArtifactStatus.Obsolete,
];

export type StatusSection = {
  status: ArtifactStatus;
  label: string;
  items: ArtifactRowItem[];
};

export function groupItemsByStatus(items: ArtifactRowItem[]): StatusSection[] {
  const buckets = new Map<ArtifactStatus, ArtifactRowItem[]>();

  for (const item of items) {
    const status = item.data.status as ArtifactStatus;
    if (!buckets.has(status)) {
      buckets.set(status, []);
    }
    buckets.get(status)?.push(item);
  }

  const sections: StatusSection[] = [];
  for (const status of STATUS_DISPLAY_ORDER) {
    const sectionItems = buckets.get(status);
    if (sectionItems && sectionItems.length > 0) {
      sections.push({
        status,
        label: ARTIFACT_STATUS_LABELS[status],
        items: sectionItems,
      });
    }
  }

  return sections;
}
