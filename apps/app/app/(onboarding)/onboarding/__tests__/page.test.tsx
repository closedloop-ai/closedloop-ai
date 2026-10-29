/**
 * ISS-5991: the onboarding status query is gated on a hydrated identity, and a
 * gated-off query reports `isLoading: false` with no data. This page branched on
 * that flag, so in that window it rendered the wizard for a user whose status
 * was still unknown, including one who finished setup months ago. It now renders
 * only on a positive answer.
 *
 * ISS-7828: a terminal failure with no answer used to leave that same "render
 * nothing" branch in place forever — a blank page. It now renders the
 * recoverable unavailable card with Retry.
 */
import { ONBOARDING_STATUS_UNAVAILABLE_COPY as COPY } from "@repo/app/onboarding/components/onboarding-status-unavailable";
import { WEB_CANONICAL_LANDING_HREF } from "@repo/app/shared/lib/primary-nav-destinations";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OnboardingPage from "../page";

const { refetchMock, replaceMock, useOnboardingStatusMock } = vi.hoisted(
  () => ({
    refetchMock: vi.fn(() => Promise.resolve()),
    replaceMock: vi.fn(),
    useOnboardingStatusMock: vi.fn(),
  })
);

vi.mock("@repo/app/onboarding/hooks/use-onboarding", () => ({
  useOnboardingStatus: () => useOnboardingStatusMock(),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ replace: replaceMock }),
}));

vi.mock("../components/onboarding-wizard", () => ({
  OnboardingWizard: () => <div>onboarding wizard</div>,
}));

const WIZARD = "onboarding wizard";

type StatusResult = {
  data: { wizardCompleted: boolean } | undefined;
  errorUpdateCount: number;
  isError: boolean;
  isFetching: boolean;
  isLoading: boolean;
  refetch: () => Promise<unknown>;
};

function statusResult(overrides: Partial<StatusResult> = {}): StatusResult {
  return {
    data: undefined,
    errorUpdateCount: 0,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: refetchMock,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("OnboardingPage", () => {
  it("renders nothing while the status is unknown, however that came about", () => {
    useOnboardingStatusMock.mockReturnValue(statusResult());

    render(<OnboardingPage />);

    expect(screen.queryByText(WIZARD)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("sends an already-completed user on without rendering the wizard", () => {
    useOnboardingStatusMock.mockReturnValue(
      statusResult({ data: { wizardCompleted: true } })
    );

    render(<OnboardingPage />);

    expect(screen.queryByText(WIZARD)).not.toBeInTheDocument();
    expect(replaceMock).toHaveBeenCalledWith(WEB_CANONICAL_LANDING_HREF);
    expect(WEB_CANONICAL_LANDING_HREF).toBe("/dashboard");
  });

  it("renders the wizard once the status says setup is unfinished", () => {
    useOnboardingStatusMock.mockReturnValue(
      statusResult({ data: { wizardCompleted: false } })
    );

    render(<OnboardingPage />);

    expect(screen.getByText(WIZARD)).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("renders the unavailable card with Retry when a terminal failure leaves no answer", () => {
    useOnboardingStatusMock.mockReturnValue(statusResult({ isError: true }));

    render(<OnboardingPage />);

    expect(screen.getByRole("alert", { name: COPY.title })).toBeInTheDocument();
    expect(screen.queryByText(WIZARD)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: COPY.retryLabel }));
    expect(refetchMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  // As the real query reports Retry's read: a refetch with no data resets it to
  // pending and clears the error, leaving the failure count as the only record.
  it("keeps the card up and busy while Retry's read is in flight", () => {
    useOnboardingStatusMock.mockReturnValue(
      statusResult({ errorUpdateCount: 1, isFetching: true, isLoading: true })
    );

    render(<OnboardingPage />);

    expect(
      screen.getByRole("button", { name: COPY.retryingLabel })
    ).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText(WIZARD)).not.toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
