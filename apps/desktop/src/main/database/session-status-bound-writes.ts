export const APPROVED_DESKTOP_SESSION_STATUS_BOUND_WRITES = {
  LiveHookSetSessionStatusUpdate:
    "apps/desktop/src/main/database/live-hook.ts::setSessionStatus::update",
  ImportPhaseSessionAndMainAgentInsert:
    "apps/desktop/src/main/database/write-core-import-phases-session.ts::importPhaseSessionAndMainAgent::insert",
  ReconcileTerminalSessionUpdate:
    "apps/desktop/src/main/database/write-core-terminal-end.ts::reconcileTerminalSession::update",
  MinimalCodexSessionUpsertInsert:
    "apps/desktop/src/main/otel/codex-otel-writer.ts::minimalCodexSessionUpsert::insert",
} as const;

export type ApprovedDesktopSessionStatusBoundWrite =
  (typeof APPROVED_DESKTOP_SESSION_STATUS_BOUND_WRITES)[keyof typeof APPROVED_DESKTOP_SESSION_STATUS_BOUND_WRITES];
