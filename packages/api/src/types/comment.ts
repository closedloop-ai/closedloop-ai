import type { JsonObject } from "./common.js";
import type { BasicUser } from "./user.js";

export const ThreadSource = {
  Native: "NATIVE",
  Liveblocks: "LIVEBLOCKS",
  /** Persisted/shared source for GitHub comment projection rows. */
  Github: "GITHUB",
} as const;
export type ThreadSource = (typeof ThreadSource)[keyof typeof ThreadSource];

export const ThreadStatus = {
  Open: "OPEN",
  Resolved: "RESOLVED",
} as const;
export type ThreadStatus = (typeof ThreadStatus)[keyof typeof ThreadStatus];

export type CommentThread = {
  id: string;
  organizationId: string;
  source: ThreadSource;
  externalId: string | null;
  roomId: string | null;
  artifactId: string | null;
  status: ThreadStatus;
  metadata: JsonObject | null;
  createdAtVersion: number | null;
  resolvedAt: Date | null;
  resolvedById: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CommentThreadWithComments = CommentThread & {
  comments: Comment[];
  resolvedBy: BasicUser | null;
  createdBy: BasicUser | null;
};

export type Comment = {
  id: string;
  threadId: string;
  authorId: string;
  body: JsonObject;
  plainText: string | null;
  externalId: string | null;
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  author?: BasicUser | null;
  reactions?: CommentReaction[];
  attachments?: CommentAttachment[];
};

export type CommentReaction = {
  id: string;
  commentId: string;
  userId: string;
  emoji: string;
  createdAt: Date;
};

export type CommentAttachment = {
  id: string;
  commentId: string;
  externalId: string | null;
  name: string;
  size: number | null;
  mimeType: string | null;
  url: string | null;
  createdAt: Date;
};
