import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ONBOARDING_STATUS_UNAVAILABLE_COPY as COPY,
  OnboardingStatusUnavailable,
} from "../onboarding-status-unavailable";

describe("OnboardingStatusUnavailable", () => {
  it("names the alert by its heading and retries on click", () => {
    const onRetry = vi.fn();

    render(<OnboardingStatusUnavailable onRetry={onRetry} retrying={false} />);

    expect(screen.getByRole("alert", { name: COPY.title })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: COPY.title })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: COPY.retryLabel }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // `aria-disabled`, not `disabled`: Retry is the only control on the screen,
  // so it must keep keyboard focus while it is busy.
  it("marks Retry busy but focusable, and ignores clicks, while a retry is in flight", () => {
    const onRetry = vi.fn();

    render(<OnboardingStatusUnavailable onRetry={onRetry} retrying />);

    const button = screen.getByRole("button", { name: COPY.retryingLabel });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: COPY.retryLabel })
    ).not.toBeInTheDocument();
  });
});
