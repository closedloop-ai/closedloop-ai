/**
 * @file agent-dashboard-trace-comment-ipc.ts
 * @description ISS-4771: the trace-comment IPC channels (list / create / reply /
 * update / delete). Each write lands locally FIRST and then kicks the cloud sync
 * lane fire-and-forget, so an offline comment is never lost. Extracted verbatim
 * out of the shrink-only grandfathered
 * `agent-dashboard-design-system-runtime.ts`; the local-first ordering, the
 * awaited-vs-fire-and-forget split, and the payload validation are unchanged.
 */
import { ipcMain } from "electron";
import { SHARED_TRACE_COMMENTS_IPC_CHANNELS } from "../../shared/shared-trace-comments-contract.js";
import type { WithDb } from "./agent-dashboard-ipc-handler-wrappers.js";
import type {
  AgentDashboardDesignSystemRuntimeOptions,
  InvokeStoreOp,
} from "./agent-dashboard-runtime-options.js";
import {
  coerceTraceCommentDraft,
  coerceTraceCommentId,
  coerceTraceCommentReplyDraft,
  coerceTraceCommentStoreTarget,
  coerceTraceCommentUpdate,
  createLocalTraceComment,
  createLocalTraceCommentReply,
  deleteLocalTraceComment,
  getTraceCommentStoreScope,
  listLocalTraceComments,
  logTraceCommentCloudSyncError,
  runTraceCommentCloudSync,
  updateLocalTraceComment,
} from "./agent-dashboard-trace-comment-sync.js";

/** Register the trace-comment channels. */
export function registerTraceCommentIpcHandlers(deps: {
  withDb: WithDb;
  options: AgentDashboardDesignSystemRuntimeOptions;
  invokeStoreOp: InvokeStoreOp;
}): void {
  const { withDb, options, invokeStoreOp } = deps;
  ipcMain.handle(
    SHARED_TRACE_COMMENTS_IPC_CHANNELS.list,
    withDb(async (agentDatabase, target: unknown, query: unknown) => {
      const parsedTarget = coerceTraceCommentStoreTarget(target, query);
      if (!parsedTarget) {
        return [];
      }
      await runTraceCommentCloudSync(
        invokeStoreOp,
        agentDatabase.syncSource,
        parsedTarget,
        options
      ).catch((error) =>
        logTraceCommentCloudSyncError(options, "sync", parsedTarget, error)
      );
      return listLocalTraceComments(
        invokeStoreOp,
        parsedTarget,
        getTraceCommentStoreScope(options)
      );
    })
  );
  ipcMain.handle(
    SHARED_TRACE_COMMENTS_IPC_CHANNELS.create,
    withDb(
      async (
        agentDatabase,
        target: unknown,
        draft: unknown,
        query: unknown
      ) => {
        const parsedTarget = coerceTraceCommentStoreTarget(target, query);
        const parsedDraft = coerceTraceCommentDraft(draft);
        if (!(parsedTarget && parsedDraft)) {
          throw new Error("Invalid trace comment IPC payload.");
        }
        const created = await createLocalTraceComment(
          invokeStoreOp,
          parsedTarget,
          parsedDraft,
          getTraceCommentStoreScope(options)
        );
        runTraceCommentCloudSync(
          invokeStoreOp,
          agentDatabase.syncSource,
          parsedTarget,
          options
        ).catch((error) =>
          logTraceCommentCloudSyncError(options, "sync", parsedTarget, error)
        );
        return created;
      }
    )
  );
  ipcMain.handle(
    SHARED_TRACE_COMMENTS_IPC_CHANNELS.reply,
    withDb(
      async (
        agentDatabase,
        target: unknown,
        commentId: unknown,
        draft: unknown,
        query: unknown
      ) => {
        const parsedTarget = coerceTraceCommentStoreTarget(target, query);
        const parsedCommentId = coerceTraceCommentId(commentId);
        const parsedDraft = coerceTraceCommentReplyDraft(draft);
        if (!(parsedTarget && parsedCommentId && parsedDraft)) {
          throw new Error("Invalid trace comment reply IPC payload.");
        }
        const updated = await createLocalTraceCommentReply(
          invokeStoreOp,
          parsedTarget,
          parsedCommentId,
          parsedDraft,
          getTraceCommentStoreScope(options)
        );
        runTraceCommentCloudSync(
          invokeStoreOp,
          agentDatabase.syncSource,
          parsedTarget,
          options
        ).catch((error) =>
          logTraceCommentCloudSyncError(options, "sync", parsedTarget, error)
        );
        return updated;
      }
    )
  );
  ipcMain.handle(
    SHARED_TRACE_COMMENTS_IPC_CHANNELS.update,
    withDb(
      async (
        agentDatabase,
        target: unknown,
        commentId: unknown,
        update: unknown,
        query: unknown
      ) => {
        const parsedTarget = coerceTraceCommentStoreTarget(target, query);
        const parsedCommentId = coerceTraceCommentId(commentId);
        const parsedUpdate = coerceTraceCommentUpdate(update);
        if (!(parsedTarget && parsedCommentId && parsedUpdate)) {
          throw new Error("Invalid trace comment IPC payload.");
        }
        const updated = await updateLocalTraceComment(
          invokeStoreOp,
          parsedTarget,
          parsedCommentId,
          parsedUpdate,
          getTraceCommentStoreScope(options)
        );
        runTraceCommentCloudSync(
          invokeStoreOp,
          agentDatabase.syncSource,
          parsedTarget,
          options
        ).catch((error) =>
          logTraceCommentCloudSyncError(options, "sync", parsedTarget, error)
        );
        return updated;
      }
    )
  );
  ipcMain.handle(
    SHARED_TRACE_COMMENTS_IPC_CHANNELS.delete,
    withDb(
      async (
        agentDatabase,
        target: unknown,
        commentId: unknown,
        query: unknown
      ) => {
        const parsedTarget = coerceTraceCommentStoreTarget(target, query);
        const parsedCommentId = coerceTraceCommentId(commentId);
        if (!(parsedTarget && parsedCommentId)) {
          throw new Error("Invalid trace comment IPC payload.");
        }
        const deleted = await deleteLocalTraceComment(
          invokeStoreOp,
          parsedTarget,
          parsedCommentId,
          getTraceCommentStoreScope(options)
        );
        runTraceCommentCloudSync(
          invokeStoreOp,
          agentDatabase.syncSource,
          parsedTarget,
          options
        ).catch((error) =>
          logTraceCommentCloudSyncError(options, "sync", parsedTarget, error)
        );
        return deleted;
      }
    )
  );
}
