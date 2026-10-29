import { CommentTargetType } from "@repo/api/src/types/comment";

/**
 * One stored session trace comment, as the service's mocked reads return it
 * after ISS-11212: the anchor in its own column as the v1 envelope, metadata
 * without it, and no sync-state row. Literals rather than the contract
 * constants, so a fixture cannot agree with a mistake in the code it feeds.
 */
export const sessionTraceAnchor = {
  traceId: "trace:session-1:0",
  turnId: "turn:session-1:0",
  row: 0,
  selectedText: "quote target",
  sourceText: "A trace quote target row",
  startOffset: 8,
  endOffset: 20,
  sessionId: "session-1",
  actor: { name: "codex", human: null },
};

export const sessionTraceMetadata = {
  kind: "trace_comment",
  schemaVersion: 1,
  targetType: CommentTargetType.Session,
  surface: "session_detail",
};

export const storedSessionTraceAnchor = {
  v: 1,
  kind: "trace",
  ...sessionTraceAnchor,
};

export const storedSessionTraceThreadColumns = {
  metadata: sessionTraceMetadata,
  anchor: storedSessionTraceAnchor,
  syncStates: [],
};
