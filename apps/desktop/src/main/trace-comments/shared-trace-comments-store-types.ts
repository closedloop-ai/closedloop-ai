import type { TraceCommentReply } from "@repo/api/src/types/comment";

/** Minimal raw-query surface shared by Desktop trace-comment store writes. */
export type RawWriteClient = {
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
};

/** SQLite projection for a durable trace-comment row. */
export type TraceCommentRow = {
  id: string;
  thread_id: string;
  target_type: string;
  target_id: string;
  artifact_id: string;
  surface: string;
  status: string;
  anchor: unknown;
  body: string;
  author_id: string;
  author_name: string | null;
  author_avatar_url: string | null;
  can_edit: boolean | number;
  can_delete: boolean | number;
  cloud_comment_id: string | null;
  cloud_thread_id: string | null;
  profile_id: string | null;
  sync_compute_target_id: string | null;
  sync_user_id: string | null;
  sync_organization_id: string | null;
  mentions: unknown;
  replies: unknown;
  comment_kind: string;
  sync_status: string;
  last_sync_attempt_at: string | null;
  sync_error: string | null;
  created_at: string;
  updated_at: string;
};

/** Small projection used to discover pending sync targets by surface. */
export type TraceCommentTargetRow = {
  target_type: string;
  target_id: string;
  surface: string;
};

/** Canonical nullable identity fields used in local-store predicates. */
export type NormalizedTraceCommentScope = {
  profileId: string | null;
  computeTargetId: string | null;
  userId: string | null;
  organizationId: string | null;
};

/** One local row eligible to reconcile with a cloud comment. */
export type CloudReconcileMatch = {
  id: string;
  syncStatus: string;
  repliesRaw: unknown;
  localKind: unknown;
};

/** Preloaded indexes for a single cloud-list reconciliation pass. */
export type CloudReconcileContext = {
  existingByCloudId: Map<string, CloudReconcileMatch>;
  existingById: Map<string, CloudReconcileMatch>;
  pendingByBodyAnchor: Map<string, CloudReconcileMatch[]>;
};

/** Local reply persistence fields layered onto the shared reply contract. */
export type StoredTraceCommentReply = TraceCommentReply & {
  cloudReplyId: string | null;
  syncStatus: string;
  lastSyncAttemptAt: string | null;
  syncError: string | null;
};
