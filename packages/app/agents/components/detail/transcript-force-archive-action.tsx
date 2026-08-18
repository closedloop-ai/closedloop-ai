"use client";

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { useMutation } from "@tanstack/react-query";
import { CloudUploadIcon, Loader2Icon } from "lucide-react";
import type { ForceArchiveOversizedResult } from "../../data-source/transcript-bytes-transport";
import { useTranscriptBytesTransport } from "../../data-source/transcript-bytes-transport";

/**
 * FEA-3489 (PRD-536): the user-invocable "Sync this transcript anyway" override
 * shown on the terminal "not archived — exceeds size limit" state.
 *
 * Desktop-only: the override needs the LOCAL transcript file, so only the desktop
 * transport supplies `forceArchiveOversized`. On the web (no local file) the
 * capability is undefined and this component renders NOTHING — the panel's own
 * description already tells the user the transcript can only be synced from the
 * machine where the session ran (PRD-536: "the web surface does not offer the
 * action"), so a permanently-disabled button plus a duplicate explanation would
 * just be dead chrome.
 *
 * On success (`uploaded` caught up, or `noop`) the cloud copy is readable, so
 * `onArchived` refetches the transcript descriptors (the panel passes the read
 * hook's `retry`) to flip the panel from the terminal state to the rendered
 * transcript. A large upload that is not yet caught up (`uploaded`,
 * `caughtUp:false`) reports that it started and will appear once it finishes. A
 * `failed` result is RETRYABLE and surfaced inline via a design-system `Alert`
 * (so it is announced); a `permanent` result is a terminal dead end with no
 * retry invitation. A thrown rejection is toasted by the global mutation error
 * handler (no local `.catch` toast).
 */
export function TranscriptForceArchiveAction({
  externalSessionId,
  fileKey,
  onArchived,
}: {
  /** Harness session id (the local sync store's dead-row identity). */
  externalSessionId: string | undefined;
  fileKey: string;
  /** Refetch descriptors + re-parse once the forced upload has archived the file. */
  onArchived: () => void;
}) {
  const transport = useTranscriptBytesTransport();
  const force = transport.forceArchiveOversized;

  const mutation = useMutation({
    mutationFn: async () => {
      if (!(force && externalSessionId)) {
        // Guarded by the desktop-only render below; defensive so a race can't
        // send a bad call.
        return { kind: "unavailable" as const };
      }
      return await force({ externalSessionId, fileKey });
    },
    onSuccess: (result) => {
      // Only a CAUGHT-UP upload (or a server-side noop) means the transcript is
      // readable now — refetch so the panel re-derives availability and renders
      // it. A not-yet-caught-up upload leaves the terminal state in place; the
      // hint tells the user it will appear once the upload finishes.
      const readableNow =
        (result.kind === "uploaded" && result.caughtUp) ||
        result.kind === "noop";
      if (readableNow) {
        onArchived();
      }
    },
  });

  // Desktop-only: the override needs a local file AND the local row identity. On
  // the web `force` is undefined — render nothing and let the panel description
  // carry the "sync from the machine where it ran" explanation.
  if (!(force && externalSessionId)) {
    return null;
  }

  const result = mutation.data;
  const forcing = mutation.isPending;

  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-3">
      <Button
        disabled={forcing}
        onClick={() => mutation.mutate()}
        size="sm"
        variant="outline"
      >
        {forcing ? (
          <Loader2Icon className="animate-spin" />
        ) : (
          <CloudUploadIcon />
        )}
        Sync this transcript anyway
      </Button>
      {forcing ? null : <ForceArchiveResultNotice result={result} />}
    </div>
  );
}

/**
 * Announce a settled force-archive result via a design-system `Alert` (so it
 * carries `role="alert"` and screen readers read it when it appears). Retryable
 * (`failed`) and terminal (`permanent`) outcomes read as warnings; informational
 * outcomes (`notFound`, an in-progress upload, an unavailable lane) read as the
 * default tone — a settled result that is not an error must not be styled
 * destructive.
 */
function ForceArchiveResultNotice({
  result,
}: {
  result: ForceArchiveOversizedResult | undefined;
}) {
  const hint = forceArchiveResultHint(result);
  if (!hint) {
    return null;
  }
  return (
    <Alert variant={hint.tone === "warn" ? "warning" : "default"}>
      <AlertDescription>{hint.message}</AlertDescription>
    </Alert>
  );
}

type ForceArchiveHint = { message: string; tone: "warn" | "muted" };

/** Human copy + tone for a settled force-archive result, or null when nothing to say. */
function forceArchiveResultHint(
  result: ForceArchiveOversizedResult | undefined
): ForceArchiveHint | null {
  if (!result) {
    return null;
  }
  switch (result.kind) {
    case "uploaded":
      // Caught-up uploads refetch and render (no notice needed); an in-progress
      // upload reassures the user it started and will appear when finished.
      return result.caughtUp
        ? null
        : {
            message:
              "Sync started. This transcript will appear here once the upload finishes.",
            tone: "muted",
          };
    case "failed":
      return {
        message: "Syncing this transcript failed. You can try again.",
        tone: "warn",
      };
    case "permanent":
      return {
        message:
          "This transcript can’t be synced. It will stay on the machine where the session ran.",
        tone: "warn",
      };
    case "unavailable":
      return {
        message:
          "History sync is currently unavailable. Try again once you’re online and syncing.",
        tone: "warn",
      };
    case "notFound":
      return {
        message: "This transcript is no longer queued for syncing.",
        tone: "muted",
      };
    default:
      // `noop` refetches and renders — nothing to say.
      return null;
  }
}
