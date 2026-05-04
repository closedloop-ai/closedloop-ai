import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// EXIT_ANIMATION_MS matches the constant in the component
const EXIT_ANIMATION_MS = 250;

const mockQueryFn = vi.fn();
const mockSystemCheckResults = vi.fn();
const mockLatestElectronReleaseOptions = vi.hoisted(() => vi.fn());
const mockLatestElectronReleaseResult = vi.hoisted(
  (): {
    value: {
      data:
        | {
            downloadUrl: string;
            releaseNotes: string;
            version: string;
          }
        | undefined;
      isLoading: boolean;
    };
  } => ({
    value: {
      data: {
        downloadUrl: "https://example.com/closedloop.dmg",
        releaseNotes: "",
        version: "1.0.0",
      },
      isLoading: false,
    },
  })
);

vi.mock("@/lib/engineer/queries/health-check", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/engineer/queries/health-check")
    >();
  return {
    ...actual,
    healthCheckOptions: () => ({
      queryKey: ["health-check"],
      queryFn: mockQueryFn,
    }),
  };
});

vi.mock("@/components/system-check/system-check-results", () => ({
  SystemCheckResults: (props: Record<string, unknown>) => {
    mockSystemCheckResults(props);
    return <div data-testid="system-check-results" />;
  },
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

vi.mock("@/hooks/queries/use-electron-release", () => ({
  useLatestElectronRelease: (options: unknown) => {
    mockLatestElectronReleaseOptions(options);
    return mockLatestElectronReleaseResult.value;
  },
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
const passingData = {
  checks: [{ id: "cli", label: "CLI", required: true, passed: true }],
  allRequiredPassed: true,
};

beforeEach(() => {
  mockLatestElectronReleaseResult.value = {
    data: {
      downloadUrl: "https://example.com/closedloop.dmg",
      releaseNotes: "",
      version: "1.0.0",
    },
    isLoading: false,
  };
});

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

describe("Release gating", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetHealthCheckDialogVisibilityForTests();
    mockQueryFn.mockResolvedValue(failingData);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for latest release data to settle before issuing the initial health check", async () => {
    mockLatestElectronReleaseResult.value = {
      data: undefined,
      isLoading: true,
    };

    const Wrapper = createWrapper();
    const { rerender } = render(
      <Wrapper>
        <HealthCheckDialog />
      </Wrapper>
    );

    expect(mockLatestElectronReleaseOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        staleTime: 300_000,
      })
    );

    await act(async () => {});
    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(mockQueryFn).not.toHaveBeenCalled();
    expect(mockLatestElectronReleaseOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: true,
        staleTime: 300_000,
      })
    );

    mockLatestElectronReleaseResult.value = {
      data: {
        downloadUrl: "https://example.com/closedloop.dmg",
        releaseNotes: "",
        version: "1.0.0",
      },
      isLoading: false,
    };

    rerender(
      <Wrapper>
        <HealthCheckDialog />
      </Wrapper>
    );
    await act(async () => {});

    expect(mockQueryFn).toHaveBeenCalledTimes(1);
  });
});

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

describe("MCP rendering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetHealthCheckDialogVisibilityForTests();
    mockQueryFn.mockResolvedValue({
      checks: [{ id: "cli", label: "CLI", required: true, passed: false }],
      allRequiredPassed: false,
      mcpServers: {
        claude: {
          available: true,
          serverName: "my-claude-mcp",
          matchedUrl: "https://example.com/mcp",
          checkedAt: "2026-04-13T18:41:00.000Z",
        },
        codex: {
          available: false,
          serverName: "my-codex-mcp",
          matchedUrl: "https://example.com/mcp",
          checkedAt: "2026-04-13T18:41:00.000Z",
        },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes Claude and Codex MCP rows into the rendered checks", async () => {
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

    const latestProps = mockSystemCheckResults.mock.calls.at(-1)?.[0] as
      | {
          checks?: Array<{ label: string; version?: string; error?: string }>;
        }
      | undefined;

    expect(latestProps?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Claude MCP",
          passed: true,
          version: "my-claude-mcp",
        }),
        expect.objectContaining({
          label: "Codex MCP",
          passed: false,
          error: "Disconnected",
        }),
      ])
    );
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

describe("Blocking pre-loop mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetHealthCheckDialogVisibilityForTests();
    mockQueryFn.mockResolvedValue(failingData);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bypasses ambient show-once suppression and renders initial data without fetching", async () => {
    const Wrapper = createWrapper();
    const { unmount } = render(
      <Wrapper>
        <HealthCheckDialog />
      </Wrapper>
    );

    await act(async () => {});
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(screen.queryByText("System Check")).not.toBeNull();
    unmount();
    mockQueryFn.mockClear();

    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={failingData}
          mode="blocking-pre-loop"
          onCancel={vi.fn()}
        />
      </Wrapper>
    );

    await act(async () => {});

    expect(screen.queryByText("System Check")).not.toBeNull();
    expect(mockQueryFn).not.toHaveBeenCalled();
  });

  it("routes Escape through cancel", async () => {
    const onCancel = vi.fn();
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={failingData}
          mode="blocking-pre-loop"
          onCancel={onCancel}
        />
      </Wrapper>
    );

    await act(async () => {});
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        })
      );
    });

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("disables Continue in blocking mode", async () => {
    const onCancel = vi.fn();
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={failingData}
          mode="blocking-pre-loop"
          onCancel={onCancel}
        />
      </Wrapper>
    );

    await act(async () => {});

    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("labels localhost targets as Local Gateway", async () => {
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={failingData}
          mode="blocking-pre-loop"
          onCancel={vi.fn()}
          targetLabel="localhost"
        />
      </Wrapper>
    );

    await act(async () => {});

    expect(screen.getByText(/Target: Local Gateway/i)).toBeInTheDocument();
    expect(screen.queryByText(/Target: localhost/i)).not.toBeInTheDocument();
  });

  it("calls the resolved callback after a passing Re-check success delay", async () => {
    const onResolvedAfterRecheck = vi.fn();
    mockQueryFn.mockResolvedValueOnce(passingData);
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={failingData}
          mode="blocking-pre-loop"
          onCancel={vi.fn()}
          onResolvedAfterRecheck={onResolvedAfterRecheck}
        />
      </Wrapper>
    );

    await act(async () => {});

    act(() => {
      screen.getByRole("button", { name: /re-check/i }).click();
    });
    await act(async () => {});
    act(() => {
      vi.advanceTimersByTime(120);
    });
    await act(async () => {});
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {});
    act(() => {
      vi.advanceTimersByTime(1200);
    });

    expect(onResolvedAfterRecheck).toHaveBeenCalledOnce();
  });

  it("keeps blocking and reports result data when Re-check still has failures", async () => {
    const onRecheckResult = vi.fn();
    const changedFailure = {
      checks: [{ id: "git", label: "Git", required: true, passed: false }],
      allRequiredPassed: false,
    };
    mockQueryFn.mockResolvedValueOnce(changedFailure);
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={failingData}
          mode="blocking-pre-loop"
          onCancel={vi.fn()}
          onRecheckResult={onRecheckResult}
        />
      </Wrapper>
    );

    await act(async () => {});

    act(() => {
      screen.getByRole("button", { name: /re-check/i }).click();
    });
    await act(async () => {});

    expect(onRecheckResult).toHaveBeenCalledWith(changedFailure);
    expect(screen.queryByText("System Check")).not.toBeNull();
  });

  it("restores the visible rows when Re-check is unavailable", async () => {
    const onRecheckUnavailable = vi.fn();
    mockQueryFn.mockRejectedValueOnce(new Error("offline"));
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={failingData}
          mode="blocking-pre-loop"
          onCancel={vi.fn()}
          onRecheckUnavailable={onRecheckUnavailable}
        />
      </Wrapper>
    );

    await act(async () => {});
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(mockSystemCheckResults.mock.calls.at(-1)?.[0]).toMatchObject({
      revealedCount: 1,
    });

    act(() => {
      screen.getByRole("button", { name: /re-check/i }).click();
    });
    await act(async () => {});
    act(() => {
      vi.advanceTimersByTime(120);
    });

    expect(onRecheckUnavailable).toHaveBeenCalledWith("offline");
    expect(mockSystemCheckResults.mock.calls.at(-1)?.[0]).toMatchObject({
      revealedCount: 1,
    });
  });
});
