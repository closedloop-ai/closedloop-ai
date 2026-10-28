import { type ZodType, z } from "zod";
import { ChannelKind } from "./channels";

/** The signal types on a `comments:{orgId}:{artifactId}` channel (ISS-11212). */
export const CommentSignalType = {
  ThreadCreated: "thread.created",
  ThreadUpdated: "thread.updated",
} as const;
export type CommentSignalType =
  (typeof CommentSignalType)[keyof typeof CommentSignalType];

/** Which thread changed, and the revision it reached; clients order by the revision. */
export const commentThreadSignalDataSchema = z.object({
  threadId: z.uuid(),
  threadRevision: z.number().int().nonnegative(),
});
export type CommentThreadSignalData = z.infer<
  typeof commentThreadSignalDataSchema
>;

export const BranchSignalType = { Updated: "branch.updated" } as const;
export type BranchSignalType =
  (typeof BranchSignalType)[keyof typeof BranchSignalType];
export const branchSignalDataSchema = z.object({ branchId: z.uuid() });

/** The signal types on a `document-versions:{orgId}:{documentId}` channel (PLN-2190). */
export const DocumentVersionSignalType = {
  Published: "version.published",
} as const;
export type DocumentVersionSignalType =
  (typeof DocumentVersionSignalType)[keyof typeof DocumentVersionSignalType];

/** The version number only: content is read through the document API. */
export const documentVersionSignalDataSchema = z.object({
  version: z.number().int().positive(),
});
export type DocumentVersionSignalData = z.infer<
  typeof documentVersionSignalDataSchema
>;

/**
 * Per-kind signal-type schemas for producers (`emitSignal`) and client
 * helpers. Never imported by the realtime service (PLN-2103 decision 6).
 * The `comments` types are owned by ISS-11212.
 */
export const SignalTypes = {
  [ChannelKind.Branches]: {
    [BranchSignalType.Updated]: branchSignalDataSchema,
  } satisfies Record<BranchSignalType, ZodType>,
  [ChannelKind.Comments]: {
    [CommentSignalType.ThreadCreated]: commentThreadSignalDataSchema,
    [CommentSignalType.ThreadUpdated]: commentThreadSignalDataSchema,
  } satisfies Record<CommentSignalType, ZodType>,
  [ChannelKind.Document]: {},
  [ChannelKind.DocumentVersions]: {
    [DocumentVersionSignalType.Published]: documentVersionSignalDataSchema,
  } satisfies Record<DocumentVersionSignalType, ZodType>,
} as const satisfies Readonly<
  Record<ChannelKind, Readonly<Record<string, ZodType>>>
>;
