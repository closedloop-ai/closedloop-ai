import { DocumentStatus } from "@repo/api/src/types/document";

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
