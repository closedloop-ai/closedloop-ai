import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import type { TranscriptSyncStore } from "../database/transcript-sync-store.js";

/** Database-host ports exposed by the composed dashboard runtime. */
export type AgentDashboardDatabaseRuntime = {
  connection: null;
  syncSource: AgentSessionSyncSource | null;
  /** Whether initial session payload derivations have settled. */
  isInitialSessionProjectionReady(): boolean;
  transcriptSync: TranscriptSyncStore | null;
  /** Execute a clone-safe operation in the database-host process. */
  invokeStoreOp: (name: string, args?: unknown[]) => Promise<unknown>;
};
