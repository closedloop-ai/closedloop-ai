import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import {
  SESSION_UPLOAD_STATE_TONE,
  SessionUploadState,
} from "@repo/app/shared/lib/upload-state";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  SessionSyncStatusBadge,
  type SessionSyncStatusBadgeProps,
} from "../session-sync-status-badge";

// ISS-12532: the upload-state form of SessionSyncStatusBadge. The strings are
// test-local placeholders; the badge authors no copy of its own.
const LABEL = "upload-state label";
const RETRY_LABEL = "retry label";

// Hoisted (biome performance/useTopLevelRegex).
const PULSE_CLASS = /animate-status-pulse/;

function badge(): HTMLElement {
  return screen.getByTestId("session-upload-state-badge");
}

describe("SessionSyncStatusBadge upload-state form (ISS-12532)", () => {
  // The pill's fill is the visible tone; one class per tone's Badge variant.
  it.each([
    [SessionUploadState.LocalOnly, "bg-muted/70"],
    [SessionUploadState.Uploading, "bg-info/12"],
    [SessionUploadState.Shared, "bg-success/12"],
  ] as const)(
    "renders %s with its label, a %s pill and no retry control",
    (uploadState, fill) => {
      render(
        <SessionSyncStatusBadge label={LABEL} uploadState={uploadState} />
      );

      expect(badge()).toHaveAttribute("data-state", uploadState);
      expect(screen.getByText(LABEL)).toHaveClass(fill);
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    }
  );

  it("gives every state a distinct tone, so no two states read the same", () => {
    const tones = Object.values(SessionUploadState).map(
      (state) => SESSION_UPLOAD_STATE_TONE[state]
    );
    expect(new Set(tones).size).toBe(tones.length);
  });

  it("pulses the dot only while uploading", () => {
    const { rerender } = render(
      <SessionSyncStatusBadge
        label={LABEL}
        uploadState={SessionUploadState.Uploading}
      />
    );
    expect(badge().innerHTML).toMatch(PULSE_CLASS);

    rerender(
      <SessionSyncStatusBadge
        label={LABEL}
        uploadState={SessionUploadState.Shared}
      />
    );
    expect(badge().innerHTML).not.toMatch(PULSE_CLASS);
  });

  it("renders failed in the danger tone with a retry control that calls onRetry", () => {
    const onRetry = vi.fn();
    render(
      <SessionSyncStatusBadge
        label={LABEL}
        onRetry={onRetry}
        retryLabel={RETRY_LABEL}
        uploadState={SessionUploadState.Failed}
      />
    );

    expect(badge()).toHaveAttribute("data-state", SessionUploadState.Failed);
    expect(screen.getByText(LABEL)).toHaveClass("bg-destructive/12");

    fireEvent.click(screen.getByRole("button", { name: RETRY_LABEL }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("disables retry while one is in flight", () => {
    const onRetry = vi.fn();
    render(
      <SessionSyncStatusBadge
        isRetrying
        label={LABEL}
        onRetry={onRetry}
        retryLabel={RETRY_LABEL}
        uploadState={SessionUploadState.Failed}
      />
    );

    const retry = screen.getByRole("button", { name: RETRY_LABEL });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(onRetry).not.toHaveBeenCalled();
  });

  // PR #8843 review: isRetrying comes from the host, so two clicks that land
  // before it flips must still call onRetry once.
  it("calls onRetry once for two fast clicks, and again only after the retry settles", () => {
    const onRetry = vi.fn();
    const props = {
      label: LABEL,
      onRetry,
      retryLabel: RETRY_LABEL,
      uploadState: SessionUploadState.Failed,
    } as const;
    const { rerender } = render(<SessionSyncStatusBadge {...props} />);

    const retry = screen.getByRole("button", { name: RETRY_LABEL });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);

    // The host reports the retry in flight, then settled and still failed.
    rerender(<SessionSyncStatusBadge {...props} isRetrying />);
    rerender(<SessionSyncStatusBadge {...props} isRetrying={false} />);
    fireEvent.click(screen.getByRole("button", { name: RETRY_LABEL }));
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  // PR #8843 review: the two forms are discriminated, so mixing them is a
  // type error. Widen either `never` back out and the matching expect-error
  // directive below goes unused, which fails the typecheck.
  it("rejects a caller that mixes the session and upload-state forms", () => {
    const transcriptWithUpload = {
      session: { transcriptDisposition: TranscriptDisposition.Stale },
      uploadState: SessionUploadState.Shared,
    } as const;
    const uploadWithSession = {
      label: LABEL,
      session: { transcriptDisposition: TranscriptDisposition.Stale },
      uploadState: SessionUploadState.Shared,
    } as const;
    // @ts-expect-error: a transcript-form caller cannot also pass uploadState.
    const mixedTranscript: SessionSyncStatusBadgeProps = transcriptWithUpload;
    // @ts-expect-error: an upload-form caller cannot also pass session.
    const mixedUpload: SessionSyncStatusBadgeProps = uploadWithSession;

    expect(mixedTranscript).toBe(transcriptWithUpload);
    expect(mixedUpload).toBe(uploadWithSession);
  });

  it("leaves the existing transcript-verdict form unchanged for a session-only caller", () => {
    render(
      <SessionSyncStatusBadge
        session={{ transcriptDisposition: TranscriptDisposition.Stale }}
      />
    );

    expect(screen.getByTestId("session-sync-status-badge")).toHaveTextContent(
      "Stale"
    );
    expect(
      screen.queryByTestId("session-upload-state-badge")
    ).not.toBeInTheDocument();
  });
});
