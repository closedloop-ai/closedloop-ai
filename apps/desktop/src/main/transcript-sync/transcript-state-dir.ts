import path from "node:path";
import { app } from "electron";

const TRANSCRIPT_STATE_DIR_NAME = "agent-dashboard-ingest";

export function resolveDesktopTranscriptStateDir(): string {
  return path.join(app.getPath("userData"), TRANSCRIPT_STATE_DIR_NAME);
}
