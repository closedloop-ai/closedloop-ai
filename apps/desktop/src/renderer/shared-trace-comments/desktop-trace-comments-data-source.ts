import type { TraceCommentsDataSource } from "@repo/app/agents/data-source/trace-comments-data-source";
import type { DesktopApi } from "../types/desktop-api";

type DesktopTraceCommentsApi = Pick<DesktopApi, "traceCommentsApi">;

/**
 * Desktop trace comments are local-first. The main-process IPC implementation
 * persists comments in the local SQLite store and syncs with cloud when the
 * desktop API key and cloud target are available.
 */
export function createDesktopTraceCommentsDataSource(
  desktopApi: DesktopTraceCommentsApi
): TraceCommentsDataSource {
  return {
    scope: "desktop-local",
    list: (target) => desktopApi.traceCommentsApi.list(target),
    create: (target, draft) =>
      desktopApi.traceCommentsApi.create(target, draft),
    reply: (target, commentId, draft) =>
      desktopApi.traceCommentsApi.reply(target, commentId, draft),
    update: (target, commentId, update) =>
      desktopApi.traceCommentsApi.update(target, commentId, update),
    delete: (target, commentId) =>
      desktopApi.traceCommentsApi.delete(target, commentId),
  };
}
