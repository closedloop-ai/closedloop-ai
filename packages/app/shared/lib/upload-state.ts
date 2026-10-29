/**
 * ISS-12532 (PRD-807, data controls): where ONE session stands in the
 * selective-share flow — whether it has been uploaded at all, as opposed to
 * how fresh an uploaded transcript is (`TranscriptDisposition`) or how a
 * Status pill draws an in-flight upload (`SessionSyncPresentation`).
 *
 *  - `LocalOnly` — the session has not been shared; it lives on this machine.
 *  - `Uploading` — a share was confirmed and the upload is in flight.
 *  - `Shared` — the upload finished; the session is visible to its audience.
 *  - `Failed` — the upload did not finish. The badge exposes a retry.
 *
 * A dependency-free leaf so the share review sheet can name the states
 * without pulling the badge's render graph in. In shared/ rather than the
 * agents slice since ISS-12529 (PR #8877 review): the upload queue view
 * (`shared/components/upload-queue-view.tsx`) reads the same tones, and
 * shared/ may not import a slice.
 * Presentational vocabulary only: nothing derives it from a session row yet,
 * and the host decides which state a session is in.
 */
export const SessionUploadState = {
  LocalOnly: "local-only",
  Uploading: "uploading",
  Shared: "shared",
  Failed: "failed",
} as const;
export type SessionUploadState =
  (typeof SessionUploadState)[keyof typeof SessionUploadState];

/**
 * ISS-12532: the shared status-pill tone for each upload state. Literal tone
 * names (a subset of the design-system `Tone`) so this leaf stays import-free;
 * the badge's `Record<SessionUploadState, SessionSyncTone>` annotation and the
 * upload queue view's `Tone` rows check them against the real union. Tone never carries the state alone: every
 * state renders its label as text (WCAG 1.4.1).
 *
 * The tones follow what each tone already means on the shipped sync badges
 * (`TRANSCRIPT_DISPOSITION_TONES`, `session-sync-status.ts`): muted for a
 * resting state, info for in flight, success for done, danger for failed. Only
 * the tone is shared. The shipped LABELS for those badges describe different
 * facts, so the upload states do not reuse them (PR #8843 review).
 */
export const SESSION_UPLOAD_STATE_TONE = {
  [SessionUploadState.LocalOnly]: "muted",
  [SessionUploadState.Uploading]: "info",
  [SessionUploadState.Shared]: "success",
  [SessionUploadState.Failed]: "danger",
} as const;
