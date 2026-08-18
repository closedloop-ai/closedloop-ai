/**
 * Main-process half of the user-initiated force-archive override (FEA-3489 /
 * PRD-536).
 *
 * When the desktop shows a transcript as terminally "not archived — exceeds size
 * limit", the panel offers "Sync this transcript anyway". Invoking it IPCs here;
 * this handler re-queues the dead `(externalSessionId, fileKey)` row and runs a
 * single upload attempt that bypasses the per-file size cap for THAT file only
 * (one-shot, per-file), reusing the existing resumable multipart lane and every
 * gate it enforces (privacy tier, online compute target). Desktop-only because it
 * needs the LOCAL transcript file — the web app reading via the cloud API cannot
 * command a remote machine (gateway/local-filesystem boundary).
 *
 * Security: untrusted senders reject (mirrors the rest of the desktop IPC
 * surface). The request carries only identifiers the renderer already holds; the
 * local file it acts on is resolved from trusted server-side sync state, never
 * from the renderer.
 */

import type { IpcMainInvokeEvent, WebContents } from "electron";
import { z } from "zod";
import {
  TRANSCRIPT_FORCE_ARCHIVE_CHANNEL,
  type TranscriptForceArchiveRequest,
  type TranscriptForceArchiveResult,
} from "../../shared/transcript-read-contract.js";

/**
 * Field validators for the renderer-supplied request, kept as a standalone
 * literal so the keys-covered guard can see them.
 *
 * `satisfies Record<keyof TranscriptForceArchiveRequest, z.ZodTypeAny>` is the
 * compile-time guard the `z.ZodType<TranscriptForceArchiveRequest>` annotation
 * alone does NOT provide: zod's `ZodType` is covariant in its output, so a
 * schema that omits an optional key still satisfies that annotation. Because the
 * schema is `.strict()`, a field added to
 * {@link TranscriptForceArchiveRequest} and sent by the renderer without being
 * taught here would make main reject the ENTIRE request as malformed — every
 * "Sync this transcript anyway" failing at once (the FEA-3701 lesson in the root
 * AGENTS.md, and the same guard the sibling `cloud-api-fetch-ipc` bridge
 * carries).
 *
 * Scope: this proves KEY COVERAGE only. `z.ZodTypeAny` is the top type, so it
 * does NOT pin a key's bounds or its optionality — relaxing a `.min(1)` or
 * dropping an `.optional()` on an already-covered key still satisfies it. Treat
 * a passing guard as "no key was forgotten", never as sign-off on a validator
 * change.
 */
const transcriptForceArchiveRequestShape = {
  externalSessionId: z.string().min(1),
  fileKey: z.string().min(1),
} satisfies Record<keyof TranscriptForceArchiveRequest, z.ZodTypeAny>;

const transcriptForceArchiveRequestSchema: z.ZodType<TranscriptForceArchiveRequest> =
  z.object(transcriptForceArchiveRequestShape).strict();

export type TranscriptForceArchiveDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: WebContents) => boolean;
  /**
   * Force-enqueue and run one bypass upload for a dead oversized transcript. Null
   * when the transcript-sync lane is not constructed (flag off) — treated as an
   * `unavailable` result rather than a hard failure so the renderer stays honest.
   */
  forceSyncOversized:
    | ((
        externalSessionId: string,
        fileKey: string
      ) => Promise<TranscriptForceArchiveResult>)
    | null;
};

type IpcMainLike = {
  handle: (
    channel: typeof TRANSCRIPT_FORCE_ARCHIVE_CHANNEL,
    listener: (
      event: IpcMainInvokeEvent,
      request: unknown
    ) => Promise<TranscriptForceArchiveResult>
  ) => void;
};

async function forceArchive(
  deps: TranscriptForceArchiveDeps,
  rawRequest: unknown
): Promise<TranscriptForceArchiveResult> {
  const parsed = transcriptForceArchiveRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    return { kind: "failed", reason: "Malformed force-archive request." };
  }
  if (!deps.forceSyncOversized) {
    return { kind: "unavailable" };
  }
  return await deps.forceSyncOversized(
    parsed.data.externalSessionId,
    parsed.data.fileKey
  );
}

/**
 * Registers the force-archive handler. Untrusted senders throw (rejecting the
 * IPC); every other outcome returns a typed {@link TranscriptForceArchiveResult}
 * the renderer surfaces as a terminal, retryable, or in-progress state.
 */
export function registerTranscriptForceArchiveIpcHandler(
  ipcMain: IpcMainLike,
  deps: TranscriptForceArchiveDeps
): void {
  ipcMain.handle(
    TRANSCRIPT_FORCE_ARCHIVE_CHANNEL,
    (event, request): Promise<TranscriptForceArchiveResult> => {
      if (!deps.isTrustedSender(event.sender)) {
        throw new Error("untrusted sender");
      }
      return forceArchive(deps, request);
    }
  );
}
