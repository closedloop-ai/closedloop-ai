import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// EXIT_ANIMATION_MS matches the constant in the component
const EXIT_ANIMATION_MS = 250;

const mockQueryFn = vi.fn();

vi.mock("@/lib/engineer/queries/health-check", () => ({
  healthCheckOptions: () => ({
    queryKey: ["health-check"],
    queryFn: mockQueryFn,
  }),
}));

vi.mock("@/components/system-check/system-check-results", () => ({
  SystemCheckResults: () => <div data-testid="system-check-results" />,
}));

vi.mock("@/components/engineer/PathAutocomplete", () => ({
  PathAutocomplete: (props: {
    value: string;
    onChange: (v: string) => void;
    [key: string]: unknown;
  }) => (
    <input
      data-testid="path-autocomplete"
      onChange={(e) => props.onChange(e.target.value)}
      value={props.value}
    />
  ),
}));

vi.mock("@/lib/engineer/queries/keys", () => ({
  queryKeys: {
    healthCheck: () => ["health-check"],
    repos: () => ["repos"],
  },
}));

vi.mock("@/lib/engineer/queries/repos", () => ({
  updateRepoSettings: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// Import after mocks are registered
import {
  HealthCheckDialog,
  resetHealthCheckDialogVisibilityForTests,
} from "../HealthCheckDialog";

const failingData = {
  checks: [{ id: "cli", label: "CLI", required: true, passed: false }],
  allRequiredPassed: false,
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe("Dismissal behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetHealthCheckDialogVisibilityForTests();
    mockQueryFn.mockResolvedValue(failingData);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Escape key dismisses the dialog even with required failures", async () => {
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog />
      </Wrapper>
    );

    // Flush mount effects (setMounted + useEffect for failure detection)
    await act(async () => {});
    // Fire the deferred setTimeout(0) that commits shownTargetKeys
    act(() => {
      vi.advanceTimersByTime(1);
    });
    // Give Radix time to register its keyboard listener
    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(screen.queryByText("System Check")).not.toBeNull();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        })
      );
    });

    act(() => {
      vi.advanceTimersByTime(EXIT_ANIMATION_MS + 50);
    });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Click outside dismisses the dialog even with required failures", async () => {
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog />
      </Wrapper>
    );

    await act(async () => {});
    act(() => {
      vi.advanceTimersByTime(1);
    });
    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(screen.queryByText("System Check")).not.toBeNull();

    act(() => {
      document.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true })
      );
    });

    act(() => {
      vi.advanceTimersByTime(EXIT_ANIMATION_MS + 50);
    });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Continue button is always enabled and dismisses the dialog", async () => {
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog />
      </Wrapper>
    );

    await act(async () => {});
    act(() => {
      vi.advanceTimersByTime(1);
    });
    act(() => {
      vi.advanceTimersByTime(1);
    });

    const continueButton = screen.getByRole("button", { name: /continue/i });
    expect(continueButton).not.toBeDisabled();

    act(() => {
      continueButton.click();
    });

    act(() => {
      vi.advanceTimersByTime(EXIT_ANIMATION_MS + 50);
    });

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Show-once behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetHealthCheckDialogVisibilityForTests();
    mockQueryFn.mockResolvedValue(failingData);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Does not open the dialog on a second mount after the first mount opened it", async () => {
    const Wrapper = createWrapper();
    const { unmount } = render(
      <Wrapper>
        <HealthCheckDialog />
      </Wrapper>
    );

    // Flush mount effects
    await act(async () => {});
    // First advance processes query result and triggers the failure-detection
    // effect which schedules setTimeout(0) for the deferred flag write
    act(() => {
      vi.advanceTimersByTime(1);
    });
    // Second advance fires the deferred setTimeout(0), committing
    // shownTargetKeys = true BEFORE unmount's cleanup can cancel it
    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(screen.queryByText("System Check")).not.toBeNull();

    unmount();

    // Second mount — shownTargetKeys is now true
    const Wrapper2 = createWrapper();
    render(
      <Wrapper2>
        <HealthCheckDialog />
      </Wrapper2>
    );

    await act(async () => {});

    expect(screen.queryByText("System Check")).toBeNull();
  });

  it("After first failing mount sets shownTargetKeys, second mount does not issue another health-check query", async () => {
    const Wrapper = createWrapper();
    const { unmount } = render(
      <Wrapper>
        <HealthCheckDialog />
      </Wrapper>
    );

    await act(async () => {});
    // First advance: processes query result, triggers failure-detection effect
    act(() => {
      vi.advanceTimersByTime(1);
    });
    // Second advance: fires deferred setTimeout(0) → shownTargetKeys = true
    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(screen.queryByText("System Check")).not.toBeNull();

    unmount();
    mockQueryFn.mockClear();

    // Second mount — query should be disabled (canOpenThisMount.current is false)
    const Wrapper2 = createWrapper();
    render(
      <Wrapper2>
        <HealthCheckDialog />
      </Wrapper2>
    );

    await act(async () => {});
    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(mockQueryFn).not.toHaveBeenCalled();
  });

  it("StrictMode throwaway mount does not consume the one-shot flag, and stable mount does commit it", async () => {
    // Step 1: Render in StrictMode — throwaway mount must NOT burn the flag
    const Wrapper = createWrapper();
    const { unmount } = render(
      <React.StrictMode>
        <Wrapper>
          <HealthCheckDialog />
        </Wrapper>
      </React.StrictMode>
    );

    // Flush mount effects from both throwaway and stable mounts
    await act(async () => {});
    // First advance: processes query result, triggers failure-detection effect
    act(() => {
      vi.advanceTimersByTime(1);
    });
    // Second advance: fires the stable mount's deferred setTimeout(0) write
    act(() => {
      vi.advanceTimersByTime(1);
    });

    // Stable mount should have opened the dialog
    expect(screen.queryByText("System Check")).not.toBeNull();

    unmount();

    // Step 2: Do NOT call resetHealthCheckDialogVisibilityForTests —
    // the stable mount must have committed shownTargetKeys = true.
    const Wrapper2 = createWrapper();
    render(
      <Wrapper2>
        <HealthCheckDialog />
      </Wrapper2>
    );

    await act(async () => {});

    // Second mount sees shownTargetKeys = true and returns null
    expect(screen.queryByText("System Check")).toBeNull();
  });
});
