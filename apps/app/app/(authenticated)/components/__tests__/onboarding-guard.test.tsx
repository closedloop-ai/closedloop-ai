import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import { serializeOnboardingState } from "@repo/api/src/types/onboarding-persistence";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { ONBOARDING_STATUS_UNAVAILABLE_COPY as COPY } from "@repo/app/onboarding/components/onboarding-status-unavailable";
import { ApiError } from "@repo/app/shared/api/api-error";
import {
  clearAuthRejection,
  publishAuthRejectionIfAuthError,
} from "@repo/app/shared/query/auth-rejection-store";
import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingGuard } from "../onboarding-guard";

const {
  refetchMock,
  replaceMock,
  useGuidedSnapshotMock,
  useOnboardingStatusMock,
  usePathMock,
  identityLoadedMock,
} = vi.hoisted(() => ({
  refetchMock: vi.fn(() => Promise.resolve()),
  replaceMock: vi.fn(),
  useGuidedSnapshotMock: vi.fn(),
  useOnboardingStatusMock: vi.fn(),
  usePathMock: vi.fn<() => string>(() => "/acme/documents"),
  identityLoadedMock: vi.fn<() => boolean>(() => true),
}));

vi.mock("@repo/app/onboarding/hooks/use-onboarding", () => ({
  useOnboardingStatus: () => useOnboardingStatusMock(),
}));

// The guided takeover's own read. Its real wiring (one query shared with the
// sidebar host) is driven in `onboarding-guard-guided-first-run.test.tsx`.
vi.mock("@repo/app/onboarding/hooks/use-guided-onboarding", () => ({
  useGuidedOnboardingSnapshot: () => useGuidedSnapshotMock(),
}));

vi.mock("@repo/app/shared/auth/use-auth-snapshot", () => ({
  useAuthSnapshot: () => ({ isLoaded: identityLoadedMock() }),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ replace: replaceMock }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => usePathMock(),
}));

/**
 * Every flag the real query exposes for this state, not just the one the guard
 * reads today: a fixture that omits `isPending` would let the `isPending`-based
 * cut this file exists to prevent pass as well.
 */
type StatusResult = {
  data: { wizardCompleted: boolean } | undefined;
  error: unknown;
  errorUpdateCount: number;
  isError: boolean;
  isFetching: boolean;
  isLoading: boolean;
  isPending: boolean;
  refetch: () => Promise<unknown>;
};

function statusResult(overrides: Partial<StatusResult> = {}): StatusResult {
  return {
    data: { wizardCompleted: true },
    error: null,
    errorUpdateCount: 0,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    refetch: refetchMock,
    ...overrides,
  };
}

/**
 * A terminal failure with nothing settled, as the real query reports it: no
 * data, errored with the failure on record, and neither pending nor loading.
 */
function terminalFailure(overrides: Partial<StatusResult> = {}): StatusResult {
  return statusResult({
    data: undefined,
    error: new ApiError("Service Unavailable", 503),
    errorUpdateCount: 1,
    isError: true,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  usePathMock.mockReturnValue("/acme/documents");
  useOnboardingStatusMock.mockReturnValue(statusResult());
  useGuidedSnapshotMock.mockReturnValue(GUIDED_READ_FAILED);
  identityLoadedMock.mockReturnValue(true);
});

// The session-rejection case publishes to the module-level latch the guard reads.
afterEach(() => {
  clearAuthRejection();
});

describe("OnboardingGuard", () => {
  // ISS-5991: the status query is gated on a hydrated identity, so this window
  // ends as soon as the shell reports one. Falling through to children here
  // would flash the app at a user the guard has not decided about yet.
  it("renders nothing until the shell's identity has hydrated", () => {
    identityLoadedMock.mockReturnValue(false);
    useOnboardingStatusMock.mockReturnValue(
      statusResult({ data: undefined, isPending: true })
    );

    const { container } = render(
      <OnboardingGuard>
        <div>protected</div>
      </OnboardingGuard>
    );

    expect(container).toBeEmptyDOMElement();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  /*
   * The condition this guard must NEVER blank on. A query that is pending with
   * nothing in flight — between retry attempts, or while its gate stays shut on
   * a shell that reports a hydrated identity but no user — has no guaranteed
   * end, and this guard wraps the entire authenticated content region. An
   * earlier cut of ISS-5991 branched on `isPending` and containerized e2e caught
   * it: every branches/sessions surface rendered its chrome around an empty main
   * region because `/onboarding` never settled.
   */
  it("renders children when the status query is pending with nothing in flight", () => {
    useOnboardingStatusMock.mockReturnValue(
      statusResult({ data: undefined, isPending: true })
    );

    render(
      <OnboardingGuard>
        <div>protected</div>
      </OnboardingGuard>
    );

    expect(screen.getByText("protected")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("renders children when the wizard is complete", () => {
    render(
      <OnboardingGuard>
        <div>protected</div>
      </OnboardingGuard>
    );

    expect(screen.getByText("protected")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  // ISS-11072: with no guided answer to defer to, the legacy wizard stays the
  // destination.
  it("redirects to /onboarding when the wizard is incomplete and the guided read failed", () => {
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

  // ISS-11072 review: only a blocking phase holds the takeover up, so a run
  // settled past it yields to the legacy redirect like a failed read does.
  it("redirects to /onboarding when the wizard is incomplete and the guided run is past its takeover", () => {
    useOnboardingStatusMock.mockReturnValue(
      statusResult({ data: { wizardCompleted: false } })
    );
    useGuidedSnapshotMock.mockReturnValue(GUIDED_READ_PAST_TAKEOVER);

    const { container } = render(
      <OnboardingGuard>
        <div>protected</div>
      </OnboardingGuard>
    );

    expect(container).toBeEmptyDOMElement();
    expect(replaceMock).toHaveBeenCalledWith("/onboarding");
  });

  // ISS-11072: redirecting before the guided run answers would send a reader
  // it is about to onboard through the legacy wizard, and rendering would flash
  // the app at a reader who may yet be redirected.
  it("holds the content region without redirecting while the guided answer is on its way", () => {
    useOnboardingStatusMock.mockReturnValue(
      statusResult({ data: { wizardCompleted: false } })
    );
    useGuidedSnapshotMock.mockReturnValue(GUIDED_READ_PENDING);

    const { container } = render(
      <OnboardingGuard>
        <div>protected</div>
      </OnboardingGuard>
    );

    expect(container).toBeEmptyDOMElement();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  // ISS-11072 review: pins the guard's answer to an unanswered guided read
  // with nothing in flight. TanStack reports that for a PAUSED read (offline,
  // or a retry held while the tab is hidden); retry backoff stays in flight
  // and is driven in `onboarding-guard-guided-first-run.test.tsx`. A paused
  // read has no guaranteed end, so it must not blank the region (the rule the
  // status read follows above), and it has given no answer to redirect on.
  it("renders children without redirecting while the guided read is paused with no answer", () => {
    useOnboardingStatusMock.mockReturnValue(
      statusResult({ data: { wizardCompleted: false } })
    );
    useGuidedSnapshotMock.mockReturnValue(GUIDED_READ_PAUSED);

    render(
      <OnboardingGuard>
        <div>protected</div>
      </OnboardingGuard>
    );

    expect(screen.getByText("protected")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  // ISS-7089 F3: both observers share one query and the checklist refetches it
  // on every window focus (`refetchOnWindowFocus: "always"`), so `isFetching`
  // turns true with a settled answer in hand. Blanking there unmounted the
  // whole content region on every tab refocus.
  it("keeps children mounted through a background refetch of a settled answer", () => {
    useOnboardingStatusMock.mockReturnValue(statusResult({ isFetching: true }));

    render(
      <OnboardingGuard>
        <div>protected</div>
      </OnboardingGuard>
    );

    expect(screen.getByText("protected")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  // The sibling above renders one fixed state, which a guard that remounts its
  // subtree on every refetch would also pass. The defect was the unmount itself:
  // gates below the guard reset (the project page waits up to 3s on a PostHog
  // flag) and a spinner covers cached data. So pin the mount count across the
  // whole transition, not the presence of the text at one point in it.
  it("does not remount children across a background refetch", () => {
    let mounts = 0;
    function MountCounter() {
      useEffect(() => {
        mounts += 1;
      }, []);
      return <div>protected</div>;
    }

    const { rerender } = render(
      <OnboardingGuard>
        <MountCounter />
      </OnboardingGuard>
    );
    expect(mounts).toBe(1);

    useOnboardingStatusMock.mockReturnValue(statusResult({ isFetching: true }));
    rerender(
      <OnboardingGuard>
        <MountCounter />
      </OnboardingGuard>
    );

    useOnboardingStatusMock.mockReturnValue(statusResult());
    rerender(
      <OnboardingGuard>
        <MountCounter />
      </OnboardingGuard>
    );

    expect(screen.getByText("protected")).toBeInTheDocument();
    expect(mounts).toBe(1);
  });

  it("renders nothing while onboarding status is loading", () => {
    useOnboardingStatusMock.mockReturnValue(
      statusResult({
        data: undefined,
        isFetching: true,
        isLoading: true,
        isPending: true,
      })
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
  ])(
    "renders the exempt desktop authorize path (%s) without redirecting even when the wizard is incomplete",
    (pathname) => {
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
    }
  );

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

  // ISS-7828: after a terminal failure there is no answer, so neither older
  // branch held — no blank, no redirect — and protected content rendered for a
  // user whose setup was never confirmed.
  it("replaces the content region with the unavailable card on a terminal failure", () => {
    useOnboardingStatusMock.mockReturnValue(terminalFailure());

    render(
      <OnboardingGuard>
        <div>protected</div>
      </OnboardingGuard>
    );

    expect(screen.getByRole("alert", { name: COPY.title })).toBeInTheDocument();
    expect(screen.queryByText("protected")).not.toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  // As the real query reports Retry's read: a refetch with no data resets it to
  // pending and clears the error, leaving the failure count as the only record.
  it("shows the retry as in flight while the refetch runs", () => {
    useOnboardingStatusMock.mockReturnValue(
      terminalFailure({
        error: null,
        isError: false,
        isFetching: true,
        isLoading: true,
        isPending: true,
      })
    );

    render(
      <OnboardingGuard>
        <div>protected</div>
      </OnboardingGuard>
    );

    expect(
      screen.getByRole("button", { name: COPY.retryingLabel })
    ).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText("protected")).not.toBeInTheDocument();
  });

  // ISS-7089 F3 on the failure path: a settled answer outranks a background
  // refetch that failed, so the subtree neither swaps for the card nor remounts.
  it("keeps a settled answer's children mounted when a background refetch fails", () => {
    let mounts = 0;
    function MountCounter() {
      useEffect(() => {
        mounts += 1;
      }, []);
      return <div>protected</div>;
    }

    const { rerender } = render(
      <OnboardingGuard>
        <MountCounter />
      </OnboardingGuard>
    );

    useOnboardingStatusMock.mockReturnValue(
      statusResult({
        error: new ApiError("Service Unavailable", 503),
        isError: true,
      })
    );
    rerender(
      <OnboardingGuard>
        <MountCounter />
      </OnboardingGuard>
    );

    expect(screen.getByText("protected")).toBeInTheDocument();
    expect(
      screen.queryByRole("alert", { name: COPY.title })
    ).not.toBeInTheDocument();
    expect(mounts).toBe(1);
  });

  it("renders the exempt desktop authorize path through a terminal failure", () => {
    usePathMock.mockReturnValue(
      "/acme/settings/integrations/desktop/authorize"
    );
    useOnboardingStatusMock.mockReturnValue(terminalFailure());

    render(
      <OnboardingGuard>
        <div>protected</div>
      </OnboardingGuard>
    );

    expect(screen.getByText("protected")).toBeInTheDocument();
    expect(
      screen.queryByRole("alert", { name: COPY.title })
    ).not.toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  // `WorkspaceAuthGuard` sits inside this guard and owns session recovery for
  // as long as the query boundary holds the rejection. The onboarding card here
  // would unmount it and hide the only recovery that can fix an expired session.
  it("leaves a session rejection to the shell's session recovery", () => {
    publishAuthRejectionIfAuthError(new ApiError("Unauthorized", 401));
    useOnboardingStatusMock.mockReturnValue(
      terminalFailure({ error: new ApiError("Unauthorized", 401) })
    );

    render(
      <OnboardingGuard>
        <div>protected</div>
      </OnboardingGuard>
    );

    expect(screen.getByText("protected")).toBeInTheDocument();
    expect(
      screen.queryByRole("alert", { name: COPY.title })
    ).not.toBeInTheDocument();
  });
});

const GUIDED_READ_FAILED = { data: undefined, isError: true, isLoading: false };
const GUIDED_READ_PENDING = {
  data: undefined,
  isError: false,
  isLoading: true,
};
const GUIDED_READ_PAUSED = {
  data: undefined,
  isError: false,
  isLoading: false,
};
/**
 * A run that reached the Dashboard without establishing an organization: past
 * its takeover, and not counted as a finished wizard by `/onboarding/status`
 * (`guided-completion-status.test.ts`). The guard reads only `state`.
 */
const GUIDED_READ_PAST_TAKEOVER: {
  data: Pick<GuidedOnboardingSnapshot, "state">;
  isError: boolean;
  isLoading: boolean;
} = {
  data: {
    state: serializeOnboardingState({
      accountProvider: null,
      history: [OnboardingPhase.Welcome, OnboardingPhase.Account],
      organizationEstablished: false,
      phase: OnboardingPhase.DashboardAvailable,
      resuming: false,
    }),
  },
  isError: false,
  isLoading: false,
};
