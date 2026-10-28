import { buttonVariants } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UPLOADS_STATE, UploadsPauseControl } from "../uploads-pause-control";
import { UploadsPauseControlFixtureHost } from "../uploads-pause-control-fixtures";

/**
 * ISS-12528. Every string here is a test fixture, not product copy: the
 * component takes all its text from its host.
 */
const FIXTURE = {
  heading: "fixture-heading",
  uploadingSummary: "fixture-uploading-summary",
  pausedSummary: "fixture-paused-summary",
  pauseLabel: "fixture-pause",
  resumeLabel: "fixture-resume",
  pausedLabel: "fixture-paused",
  finishingDetail: "fixture-finishing-detail",
} as const;

function renderUploading(onPause = vi.fn()) {
  return render(
    <UploadsPauseControl
      heading={FIXTURE.heading}
      onPause={onPause}
      pauseLabel={FIXTURE.pauseLabel}
      state={UPLOADS_STATE.UPLOADING}
      summary={FIXTURE.uploadingSummary}
    />
  );
}

function renderPaused(
  onResume = vi.fn(),
  finishingUploadDetail: string | undefined = undefined
) {
  return render(
    <UploadsPauseControl
      finishingUploadDetail={finishingUploadDetail}
      heading={FIXTURE.heading}
      onResume={onResume}
      pausedLabel={FIXTURE.pausedLabel}
      resumeLabel={FIXTURE.resumeLabel}
      state={UPLOADS_STATE.PAUSED}
      summary={FIXTURE.pausedSummary}
    />
  );
}

describe("UploadsPauseControl", () => {
  it("AC-001: offers pause while uploading and fires onPause", () => {
    const onPause = vi.fn();
    renderUploading(onPause);
    expect(screen.getByText(FIXTURE.heading)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: FIXTURE.pauseLabel }));
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it("AC-001: offers resume while paused and fires onResume", () => {
    const onResume = vi.fn();
    renderPaused(onResume);
    fireEvent.click(screen.getByRole("button", { name: FIXTURE.resumeLabel }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("AC-002: paused shows in the summary and in its own paused badge", () => {
    renderPaused();
    expect(screen.getByTestId("uploads-pause-summary")).toHaveTextContent(
      FIXTURE.pausedSummary
    );
    expect(
      screen.getByRole("status", { name: FIXTURE.pausedLabel })
    ).toHaveTextContent(FIXTURE.pausedLabel);
    // Paused is its own axis, not a policy status (PR #8870 review).
    expect(screen.queryByTestId("policy-status-indicator")).toBeNull();
  });

  it("AC-002: no paused badge while uploading", () => {
    renderUploading();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("uploads-pause-summary")).toHaveTextContent(
      FIXTURE.uploadingSummary
    );
  });

  it("keeps focus on the same button when its label flips from pause to resume", () => {
    // Showing paused on the click itself (Marisol's Q2 ruling) is the host's job,
    // and belongs to the real host's test; the fixture host only drives it.
    render(
      <UploadsPauseControlFixtureHost
        heading={FIXTURE.heading}
        onPause={vi.fn()}
        onResume={vi.fn()}
        pausedLabel={FIXTURE.pausedLabel}
        pausedSummary={FIXTURE.pausedSummary}
        pauseLabel={FIXTURE.pauseLabel}
        resumeLabel={FIXTURE.resumeLabel}
        state={UPLOADS_STATE.UPLOADING}
        uploadingSummary={FIXTURE.uploadingSummary}
      />
    );
    const button = screen.getByRole("button", { name: FIXTURE.pauseLabel });
    button.focus();
    fireEvent.click(button);
    const resume = screen.getByRole("button", { name: FIXTURE.resumeLabel });
    expect(resume).toBe(button);
    expect(resume).toHaveFocus();
  });

  it("Marisol Q1 (a): a finishing in-flight upload is shown only when the host reports it", () => {
    const { unmount } = renderPaused(vi.fn(), FIXTURE.finishingDetail);
    expect(
      screen.getByRole("status", { name: FIXTURE.pausedLabel })
    ).toHaveAccessibleDescription(FIXTURE.finishingDetail);
    unmount();
    renderPaused();
    expect(screen.queryByText(FIXTURE.finishingDetail)).toBeNull();
    expect(
      screen.getByRole("status", { name: FIXTURE.pausedLabel })
    ).not.toHaveAccessibleDescription();
  });

  it("AC-003: pause and resume never use the destructive button", () => {
    // The oracle is the class list Button itself renders for outline/sm.
    const outline = cn(buttonVariants({ variant: "outline", size: "sm" }));
    for (const renderState of [renderUploading, renderPaused]) {
      const { unmount } = renderState();
      const button = screen.getByRole("button");
      expect(button.className).toBe(outline);
      unmount();
    }
  });
});
