/**
 * Which `priority` a session load projects. `Stored` is every local read.
 * `PendingUpload` is the outbox sync lane, the one path whose accepted ack
 * resets the marker.
 */
export const PriorityUploadProjection = {
  Stored: "stored",
  PendingUpload: "pending_upload",
} as const;
export type PriorityUploadProjection =
  (typeof PriorityUploadProjection)[keyof typeof PriorityUploadProjection];
