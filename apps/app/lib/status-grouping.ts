import { DocumentStatus } from "@repo/api/src/types/document";
import type { DocumentRowItem } from "@/components/document-table/document-row";
import { DOCUMENT_STATUS_LABELS } from "@/lib/project-constants";

/** Fixed display order matching the DocumentStatus enum. */
export const STATUS_DISPLAY_ORDER: DocumentStatus[] = [
  DocumentStatus.Draft,
  DocumentStatus.InProgress,
  DocumentStatus.InReview,
  DocumentStatus.Approved,
  DocumentStatus.Executed,
  DocumentStatus.Done,
  DocumentStatus.Obsolete,
];

export type StatusSection = {
  status: DocumentStatus;
  label: string;
  items: DocumentRowItem[];
};

export function groupItemsByStatus(items: DocumentRowItem[]): StatusSection[] {
  const buckets = new Map<DocumentStatus, DocumentRowItem[]>();

  for (const item of items) {
    const status = item.data.status as DocumentStatus;
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
        label: DOCUMENT_STATUS_LABELS[status],
        items: sectionItems,
      });
    }
  }

  return sections;
}
