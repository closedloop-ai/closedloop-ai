import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingGuard } from "../onboarding-guard";

const { replaceMock, useOnboardingStatusMock, usePathMock } = vi.hoisted(
  () => ({
    replaceMock: vi.fn(),
    useOnboardingStatusMock: vi.fn(),
    usePathMock: vi.fn<() => string>(() => "/acme/documents"),
  })
);

vi.mock("@repo/app/onboarding/hooks/use-onboarding", () => ({
  useOnboardingStatus: () => useOnboardingStatusMock(),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ replace: replaceMock }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => usePathMock(),
}));

type StatusResult = {
  data: { wizardCompleted: boolean } | undefined;
  isLoading: boolean;
  isFetching: boolean;
};

function statusResult(overrides: Partial<StatusResult> = {}): StatusResult {
  return {
    data: { wizardCompleted: true },
    isLoading: false,
    isFetching: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePathMock.mockReturnValue("/acme/documents");
  useOnboardingStatusMock.mockReturnValue(statusResult());
});

describe("OnboardingGuard", () => {
  it("renders children when the wizard is complete", () => {
    render(
      <OnboardingGuard>
        <div>protected</div>
      </OnboardingGuard>
    );

    expect(screen.getByText("protected")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("redirects to /onboarding when the wizard is incomplete", () => {
    useOnboardingStatusMock.mockReturnValue(
      statusResult({ data: { wizardCompleted: false } })
    );

    render(
      <OnboardingGuard>
        <div>protected</div>
      </OnboardingGuard>
    );

    expect(screen.queryByText("protected")).not.toBeInTheDocument();
    expect(replaceMock).toHaveBeenCalledWith("/onboarding");
  });

  it("renders nothing while onboarding status is loading", () => {
    useOnboardingStatusMock.mockReturnValue(
      statusResult({ data: undefined, isLoading: true })
    );

    render(
      <OnboardingGuard>
        <div>protected</div>
      </OnboardingGuard>
    );

    expect(screen.queryByText("protected")).not.toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it.each([
    "/acme/settings/integrations/desktop/authorize",
    "/settings/integrations/desktop/authorize",
  ])("renders the exempt desktop authorize path (%s) without redirecting even when the wizard is incomplete", (pathname) => {
    usePathMock.mockReturnValue(pathname);
    useOnboardingStatusMock.mockReturnValue(
      statusResult({ data: { wizardCompleted: false } })
    );

    render(
      <OnboardingGuard>
        <div>protected</div>
      </OnboardingGuard>
    );

    expect(screen.getByText("protected")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("renders the exempt path immediately even during a status refetch", () => {
    usePathMock.mockReturnValue(
      "/acme/settings/integrations/desktop/authorize"
    );
    useOnboardingStatusMock.mockReturnValue(
      statusResult({ data: { wizardCompleted: false }, isFetching: true })
    );

    render(
      <OnboardingGuard>
        <div>protected</div>
      </OnboardingGuard>
    );

    expect(screen.getByText("protected")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
