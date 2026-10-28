import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  DELETION_REQUEST_STATUS,
  type DeletionRequest,
  DeletionRequestTracker,
  type DeletionRequestTrackerCopy,
  resolveDeletionRequestStatus,
} from "../deletion-request-tracker";

/**
 * ISS-12538. Every string here is a test fixture, not product copy: the
 * tracker takes all its text from the host.
 */
const COPY: DeletionRequestTrackerCopy = {
  pendingLabel: "fixture-pending",
  completedLabel: "fixture-completed",
  failedLabel: "fixture-failed",
  unavailableLabel: "fixture-unavailable",
  unavailableExplanation: "fixture-nothing-removed",
  retryLabel: "fixture-retry",
};

function renderTracker(
  request: DeletionRequest,
  { onRetry = vi.fn(), isRetrying = false } = {}
) {
  render(
    <DeletionRequestTracker
      copy={COPY}
      isRetrying={isRetrying}
      onRetry={onRetry}
      request={request}
    />
  );
  return { onRetry, tracker: screen.getByTestId("deletion-request-tracker") };
}

describe("DeletionRequestTracker (ISS-12538)", () => {
  it("renders pending with its label and evidence, and no retry (AC-001)", () => {
    const { tracker } = renderTracker({
      status: DELETION_REQUEST_STATUS.PENDING,
      detail: "fixture-submitted",
    });
    expect(tracker).toHaveAttribute(
      "data-state",
      DELETION_REQUEST_STATUS.PENDING
    );
    const badge = screen.getByRole("status", { name: "fixture-pending" });
    expect(badge).toHaveAccessibleDescription("fixture-submitted");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders a verified completion with the backend's evidence (AC-001, AC-003)", () => {
    const { tracker } = renderTracker({
      status: DELETION_REQUEST_STATUS.COMPLETED,
      verified: true,
      evidence: "fixture-verified-evidence",
    });
    expect(tracker).toHaveAttribute(
      "data-state",
      DELETION_REQUEST_STATUS.COMPLETED
    );
    const badge = screen.getByRole("status", { name: "fixture-completed" });
    expect(badge).toHaveAccessibleDescription("fixture-verified-evidence");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders failed with a retry control that calls onRetry (AC-001, AC-002)", () => {
    const { tracker, onRetry } = renderTracker({
      status: DELETION_REQUEST_STATUS.FAILED,
      detail: "fixture-reason",
    });
    expect(tracker).toHaveAttribute(
      "data-state",
      DELETION_REQUEST_STATUS.FAILED
    );
    expect(
      screen.getByRole("status", { name: "fixture-failed" })
    ).toHaveAccessibleDescription("fixture-reason");
    fireEvent.click(screen.getByRole("button", { name: "fixture-retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("disables retry while a retry is in flight", () => {
    const { onRetry } = renderTracker(
      { status: DELETION_REQUEST_STATUS.FAILED },
      { isRetrying: true }
    );
    const retry = screen.getByRole("button", { name: "fixture-retry" });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("renders unavailable with the explanation that nothing was removed, and no retry (AC-001, AC-002)", () => {
    const { tracker } = renderTracker({
      status: DELETION_REQUEST_STATUS.UNAVAILABLE,
    });
    expect(tracker).toHaveAttribute(
      "data-state",
      DELETION_REQUEST_STATUS.UNAVAILABLE
    );
    expect(
      screen.getByRole("status", { name: "fixture-unavailable" })
    ).toHaveAccessibleDescription("fixture-nothing-removed");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("announces a status change as one statement: the new label and its reason (PR #8844 review)", () => {
    const props = { copy: COPY, onRetry: vi.fn() };
    const { rerender } = render(
      <DeletionRequestTracker
        {...props}
        request={{
          status: DELETION_REQUEST_STATUS.PENDING,
          detail: "fixture-submitted",
        }}
      />
    );
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-atomic", "true");

    rerender(
      <DeletionRequestTracker
        {...props}
        request={{
          status: DELETION_REQUEST_STATUS.FAILED,
          detail: "fixture-reason",
        }}
      />
    );

    // The same live region, still mounted, so the change is announced.
    const regions = screen.getAllByRole("status");
    expect(regions).toHaveLength(1);
    expect(regions[0]).toBe(region);
    // Its content, which is what a screen reader reads, carries the label
    // and the reason; the retry control is outside it.
    expect(region).toHaveTextContent("fixture-failed");
    expect(region).toHaveTextContent("fixture-reason");
    expect(region).not.toContainElement(
      screen.getByRole("button", { name: "fixture-retry" })
    );
    expect(region).toHaveAccessibleName("fixture-failed");
    expect(region).toHaveAccessibleDescription("fixture-reason");
  });

  describe("completed is shown only on a verified backend signal (AC-003)", () => {
    // A payload that crossed an untyped boundary: it claims completion but
    // carries no verification.
    const unverified = [
      {
        status: DELETION_REQUEST_STATUS.COMPLETED,
        evidence: "fixture-unverified-evidence",
      },
      {
        status: DELETION_REQUEST_STATUS.COMPLETED,
        verified: false,
        evidence: "fixture-unverified-evidence",
      },
      {
        status: DELETION_REQUEST_STATUS.COMPLETED,
        verified: "true",
        evidence: "fixture-unverified-evidence",
      },
    ] as unknown as DeletionRequest[];

    it.each(unverified)(
      "an unverified completion stays pending: %o",
      (request) => {
        expect(resolveDeletionRequestStatus(request)).toBe(
          DELETION_REQUEST_STATUS.PENDING
        );
        const { tracker } = renderTracker(request);
        expect(tracker).toHaveAttribute(
          "data-state",
          DELETION_REQUEST_STATUS.PENDING
        );
        expect(screen.queryByText(COPY.completedLabel)).toBeNull();
        expect(screen.queryByText("fixture-unverified-evidence")).toBeNull();
        expect(
          screen.getByRole("status", { name: "fixture-pending" })
        ).toBeInTheDocument();
      }
    );

    it("a verified completion resolves to completed", () => {
      expect(
        resolveDeletionRequestStatus({
          status: DELETION_REQUEST_STATUS.COMPLETED,
          verified: true,
          evidence: "fixture-verified-evidence",
        })
      ).toBe(DELETION_REQUEST_STATUS.COMPLETED);
    });
  });
});
