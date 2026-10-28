// Shared IPC-payload contract for the Activity panel (FEA-3258 / FEA-3259).
//
// The renderer's ActivityPanel renders the `desktop:get-activity-events`
// payload (`ActivityEvent[]`, from activity-log-store). The shape lives here, a
// dependency-free contract module under `src/shared`, so the renderer TS
// program imports the canonical type without following a type-only edge into
// main-process implementation files.

/** A gateway-request / security activity-log row. SSOT for `ActivityEvent`. */
export type ActivityEvent = {
  id: string;
  type?: "request" | "security";
  timestamp: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  detail?: string;
  requestSizeBytes?: number;
  responseSizeBytes?: number;
};
