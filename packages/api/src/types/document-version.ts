// DocumentVersion types for API contract

export type DocumentVersion = {
  id: string;
  documentId: string;
  version: number;
  content: string | null;
  createdById: string | null;
  createdAt: Date;
};
