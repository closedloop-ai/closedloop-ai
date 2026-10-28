import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * ISS-12529 (PR #8877 review): the upload queue view reads its row tones from
 * the one upload-state tone map the session upload badge uses, never a copy of
 * it. The map is swapped for sentinel tones here, so a view that wrote the
 * tones out again would keep its own and fail.
 */
vi.mock("@repo/app/shared/lib/upload-state", () => {
  const SessionUploadState = {
    LocalOnly: "local-only",
    Uploading: "uploading",
    Shared: "shared",
    Failed: "failed",
  } as const;
  return {
    SessionUploadState,
    SESSION_UPLOAD_STATE_TONE: {
      [SessionUploadState.LocalOnly]: "neutral",
      [SessionUploadState.Uploading]: "warning",
      [SessionUploadState.Shared]: "success",
      [SessionUploadState.Failed]: "accent",
    },
  };
});

vi.mock("@repo/design-system/components/ui/primitives/status-badge", () => ({
  ToneBadge: ({ label, tone }: { label: string; tone: string }) => (
    <span data-tone={tone}>{label}</span>
  ),
}));

const COPY = {
  heading: "fixture-heading",
  queuedLabel: "fixture-queued",
  inFlightLabel: "fixture-in-flight",
  failedLabel: "fixture-failed",
  emptyText: "fixture-empty",
  unmeasuredText: "fixture-unmeasured",
} as const;

describe("UploadQueueView tones", () => {
  it("takes each row's tone from the shared upload-state tone map", async () => {
    const { UploadQueueView } = await import("../upload-queue-view");
    render(
      <UploadQueueView
        copy={COPY}
        counts={{ queued: 4, inFlight: 3, failed: 1 }}
      />
    );
    expect(screen.getByText(COPY.queuedLabel)).toHaveAttribute(
      "data-tone",
      "neutral"
    );
    expect(screen.getByText(COPY.inFlightLabel)).toHaveAttribute(
      "data-tone",
      "warning"
    );
    expect(screen.getByText(COPY.failedLabel)).toHaveAttribute(
      "data-tone",
      "accent"
    );
  });
});
