import { CheckSeverity } from "@repo/api/src/types/compute-target";
import { act, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWrapper,
  failingData,
  RE_RECHECK_BUTTON,
} from "./fixtures/health-check-dialog-fixtures";

// EXIT_ANIMATION_MS matches the constant in the component
const EXIT_ANIMATION_MS = 250;

const RE_CONTINUE_BUTTON = /continue/i;
const RE_CANCEL_BUTTON = /^cancel$/i;
const RE_INSTALLER_URL =
  /raw\.githubusercontent\.com\/closedloop-ai\/claude-plugins\/main\/install\.sh/;
const RE_TARGET_LOCAL_GATEWAY = /Target: Local Gateway/i;
const RE_TARGET_LOCALHOST = /Target: localhost/i;
const RE_SESSION_CHECKBOX = /don't show this again until i close this tab/i;

const mockQueryFn = vi.fn();
const mockSystemCheckResults = vi.fn();

const mockUseFeatureFlagEnabled = vi.hoisted(() =>
  vi.fn((_key: string) => false)
);

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => mockUseFeatureFlagEnabled(key),
}));

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
      staleTime: 30_000,
    }),
  };
});

vi.mock("@/components/system-check/system-check-results", () => ({
  SystemCheckResults: (props: Record<string, unknown>) => {
    mockSystemCheckResults(props);
    return (
      <div data-testid="system-check-results">
        {props.afterRequired as React.ReactNode}
      </div>
    );
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
import { HealthCheckDialog } from "../HealthCheckDialog";

const pluginFailureData = {
  checks: [
    {
      id: "claude-plugins",
      label: "Claude Code plugins",
      required: true,
      passed: false,
    },
  ],
  allRequiredPassed: false,
};
const passingData = {
  checks: [{ id: "cli", label: "CLI", required: true, passed: true }],
  allRequiredPassed: true,
};

describe("target kind classification", () => {
  it("classifies owned relay targets by ownership even when plugin auto-update is disabled", async () => {
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={failingData}
          isOwnedTarget
          latestVersionOverride={null}
          onCancel={vi.fn()}
          pluginAutoUpdateEnabled={false}
          relayTargetId="target-1"
        />
      </Wrapper>
    );

    await act(async () => {});

    expect(mockSystemCheckResults.mock.calls.at(-1)?.[0]).toMatchObject({
      pluginAutoUpdateEnabled: false,
      targetKind: "owned_relay",
    });
  });

  it("classifies shared relay targets separately from disabled owned relays", async () => {
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={failingData}
          isOwnedTarget={false}
          latestVersionOverride={null}
          onCancel={vi.fn()}
          pluginAutoUpdateEnabled={false}
          relayTargetId="target-1"
        />
      </Wrapper>
    );

    await act(async () => {});

    expect(mockSystemCheckResults.mock.calls.at(-1)?.[0]).toMatchObject({
      pluginAutoUpdateEnabled: false,
      targetKind: "shared_relay",
    });
  });
});

describe("plugin install guidance", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the user-scope repair installer command", async () => {
    vi.useFakeTimers();
    const Wrapper = createWrapper();

    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={{
            allRequiredPassed: false,
            checks: [
              {
                id: "claude-plugins",
                label: "Claude Plugins",
                required: true,
                passed: false,
              },
            ],
          }}
          latestVersionOverride={null}
          onCancel={vi.fn()}
        />
      </Wrapper>
    );

    await act(async () => {});
    act(() => {
      vi.advanceTimersByTime(150);
    });

    const installerCommand = screen.getByText(RE_INSTALLER_URL);

    expect(installerCommand).toBeInTheDocument();
    expect(installerCommand).toHaveTextContent(/mktemp/);
    expect(installerCommand).toHaveTextContent(/-o "\$install_script"/);
    expect(installerCommand).not.toHaveTextContent(/\| bash/);
    expect(
      screen.queryByText(
        /claude plugin install code@closedloop-ai self-learning@closedloop-ai/
      )
    ).not.toBeInTheDocument();
  });

  it("shows installer remediation for missing or disabled plugins", async () => {
    vi.useFakeTimers();
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={pluginFailureData}
          latestVersionOverride={null}
          onCancel={vi.fn()}
        />
      </Wrapper>
    );

    await act(async () => {});
    act(() => {
      vi.advanceTimersByTime(120);
    });

    const command = screen.getByText((_, element) => {
      const text = (element?.textContent ?? "").replace(/\s+/g, " ");
      return (
        element?.tagName.toLowerCase() === "p" &&
        !text.includes("bootstrap@closedloop-ai") &&
        text.includes("/bin/bash -c") &&
        text.includes(
          "raw.githubusercontent.com/closedloop-ai/claude-plugins/main/install.sh"
        )
      );
    });

    expect(command).toBeInTheDocument();
  });

  it("shows installer remediation when any plugin check fails", async () => {
    vi.useFakeTimers();
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={{
            checks: [
              {
                id: "claude-plugins",
                label: "Claude Code plugins",
                required: true,
                passed: true,
              },
              {
                id: "plugin-code",
                label: "Symphony Plugin",
                required: true,
                passed: false,
              },
            ],
            allRequiredPassed: false,
          }}
          latestVersionOverride={null}
          onCancel={vi.fn()}
        />
      </Wrapper>
    );

    await act(async () => {});
    act(() => {
      vi.advanceTimersByTime(240);
    });

    expect(
      screen.getByText((_, element) => {
        const text = (element?.textContent ?? "").replace(/\s+/g, " ");
        return (
          element?.tagName.toLowerCase() === "p" &&
          text.includes("/bin/bash -c") &&
          text.includes(
            "raw.githubusercontent.com/closedloop-ai/claude-plugins/main/install.sh"
          )
        );
      })
    ).toBeInTheDocument();
  });

  it("does not prescribe the installer when the plugin rows are merely blocked", async () => {
    // ISS-5369: a stale Claude binary path leaves every plugin row `blocked`
    // and still `passed: false` for older builds. The rows stopped asserting a
    // fault; the panel must stop prescribing a command that cannot succeed.
    vi.useFakeTimers();
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={{
            checks: [
              {
                id: "claude-cli",
                label: "Claude Code",
                required: true,
                passed: false,
                severity: CheckSeverity.Error,
                error: "Override path does not exist or is not executable",
              },
              {
                id: "plugin-code",
                label: "Symphony Plugin",
                required: true,
                passed: false,
                severity: CheckSeverity.Blocked,
                blockedBy: "claude-cli",
                error: "Not checked, Claude CLI unavailable",
              },
            ],
            allRequiredPassed: false,
          }}
          latestVersionOverride={null}
          onCancel={vi.fn()}
        />
      </Wrapper>
    );

    await act(async () => {});
    act(() => {
      vi.advanceTimersByTime(240);
    });

    expect(screen.queryByText(RE_INSTALLER_URL)).toBeNull();
  });
});

describe("MCP rendering", () => {
  it("passes Claude and Codex MCP rows into the rendered checks", async () => {
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={{
            checks: [
              { id: "cli", label: "CLI", required: true, passed: false },
            ],
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
          }}
          latestVersionOverride={null}
          onCancel={vi.fn()}
        />
      </Wrapper>
    );

    await act(async () => {});

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

describe("Blocking dialog behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockQueryFn.mockResolvedValue(failingData);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders initial data without issuing a health-check fetch", async () => {
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={failingData}
          latestVersionOverride={null}
          onCancel={vi.fn()}
        />
      </Wrapper>
    );

    await act(async () => {});

    expect(screen.queryByText("System Check")).not.toBeNull();
    expect(mockQueryFn).not.toHaveBeenCalled();
  });

  it("does not render a session dismissal checkbox", async () => {
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={failingData}
          latestVersionOverride={null}
          onCancel={vi.fn()}
        />
      </Wrapper>
    );

    await act(async () => {});

    expect(
      screen.queryByRole("checkbox", { name: RE_SESSION_CHECKBOX })
    ).not.toBeInTheDocument();
  });

  it("renders initial data supplied after the query is mounted", async () => {
    const Wrapper = createWrapper();
    const { rerender } = render(
      <Wrapper>
        <HealthCheckDialog latestVersionOverride={null} onCancel={vi.fn()} />
      </Wrapper>
    );

    await act(async () => {});
    expect(mockSystemCheckResults.mock.calls.at(-1)?.[0]).toMatchObject({
      isLoading: true,
      checks: undefined,
    });

    rerender(
      <Wrapper>
        <HealthCheckDialog
          initialData={failingData}
          latestVersionOverride={null}
          onCancel={vi.fn()}
        />
      </Wrapper>
    );

    await act(async () => {});
    act(() => {
      vi.advanceTimersByTime(0);
    });
    await act(async () => {});

    expect(mockSystemCheckResults.mock.calls.at(-1)?.[0]).toMatchObject({
      isLoading: false,
      checks: expect.arrayContaining([
        expect.objectContaining({ id: "cli", passed: false }),
      ]),
    });
  });

  it("routes Escape through cancel", async () => {
    const onCancel = vi.fn();
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={failingData}
          latestVersionOverride={null}
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

  it("routes the Cancel button through cancel and closes the dialog", async () => {
    const onCancel = vi.fn();
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={failingData}
          latestVersionOverride={null}
          onCancel={onCancel}
        />
      </Wrapper>
    );

    await act(async () => {});

    act(() => {
      screen.getByRole("button", { name: RE_CANCEL_BUTTON }).click();
    });

    expect(onCancel).toHaveBeenCalledOnce();

    act(() => {
      vi.advanceTimersByTime(EXIT_ANIMATION_MS + 50);
    });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers only Cancel and Re-check actions, no Continue affordance", async () => {
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={failingData}
          latestVersionOverride={null}
          onCancel={vi.fn()}
        />
      </Wrapper>
    );

    await act(async () => {});

    expect(
      screen.getByRole("button", { name: RE_CANCEL_BUTTON })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: RE_RECHECK_BUTTON })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RE_CONTINUE_BUTTON })
    ).not.toBeInTheDocument();
  });

  it("labels localhost targets as Local Gateway", async () => {
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={failingData}
          latestVersionOverride={null}
          onCancel={vi.fn()}
          targetLabel="localhost"
        />
      </Wrapper>
    );

    await act(async () => {});

    expect(screen.getByText(RE_TARGET_LOCAL_GATEWAY)).toBeInTheDocument();
    expect(screen.queryByText(RE_TARGET_LOCALHOST)).not.toBeInTheDocument();
  });

  it("runs one health-check request per Re-check click", async () => {
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={failingData}
          latestVersionOverride={null}
          onCancel={vi.fn()}
        />
      </Wrapper>
    );

    await act(async () => {});

    expect(screen.queryByText("System Check")).not.toBeNull();

    mockQueryFn.mockClear();
    mockQueryFn.mockResolvedValueOnce(failingData);

    act(() => {
      screen.getByRole("button", { name: RE_RECHECK_BUTTON }).click();
    });
    await act(async () => {});

    expect(mockQueryFn).toHaveBeenCalledTimes(1);
  });

  it("calls the resolved callback after a passing Re-check success delay", async () => {
    const onResolvedAfterRecheck = vi.fn();
    mockQueryFn.mockResolvedValueOnce(passingData);
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={failingData}
          latestVersionOverride={null}
          onCancel={vi.fn()}
          onResolvedAfterRecheck={onResolvedAfterRecheck}
        />
      </Wrapper>
    );

    await act(async () => {});

    act(() => {
      screen.getByRole("button", { name: RE_RECHECK_BUTTON }).click();
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

  /**
   * ISS-5811. The Re-check clears the real failure and leaves only a REQUIRED
   * row the gateway could not determine. The pre-loop gate records zero
   * blockers on that response, so the dialog must let go too — while it read its
   * own `required && !passed`, it saw a failure the gate did not, the success
   * screen never ran, and the pending command stayed stuck behind a dialog with
   * nothing left to fix. `allRequiredPassed` stays FALSE in the fixture on
   * purpose: this resolves off the row severities, not off that flag.
   */
  it("calls the resolved callback when Re-check leaves only undeterminable required rows", async () => {
    const onResolvedAfterRecheck = vi.fn();
    mockQueryFn.mockResolvedValueOnce({
      checks: [
        { id: "git", label: "Git", required: true, passed: true },
        {
          id: "plugin-code",
          label: "Symphony Plugin",
          required: true,
          passed: false,
          severity: CheckSeverity.Unknown,
          error: "Could not verify enabled state",
        },
      ],
      allRequiredPassed: false,
    });
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={failingData}
          latestVersionOverride={null}
          onCancel={vi.fn()}
          onResolvedAfterRecheck={onResolvedAfterRecheck}
        />
      </Wrapper>
    );

    await act(async () => {});

    act(() => {
      screen.getByRole("button", { name: RE_RECHECK_BUTTON }).click();
    });
    await act(async () => {});
    act(() => {
      vi.advanceTimersByTime(240);
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
          latestVersionOverride={null}
          onCancel={vi.fn()}
          onRecheckResult={onRecheckResult}
        />
      </Wrapper>
    );

    await act(async () => {});

    act(() => {
      screen.getByRole("button", { name: RE_RECHECK_BUTTON }).click();
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
          latestVersionOverride={null}
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
      screen.getByRole("button", { name: RE_RECHECK_BUTTON }).click();
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

describe("Query error rendering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the timeout error instead of stale passing data when Re-check fails", async () => {
    const onResolvedAfterRecheck = vi.fn();
    mockQueryFn.mockRejectedValueOnce(
      new DOMException("The operation timed out.", "TimeoutError")
    );
    const Wrapper = createWrapper();

    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={passingData}
          latestVersionOverride={null}
          onCancel={vi.fn()}
          onResolvedAfterRecheck={onResolvedAfterRecheck}
        />
      </Wrapper>
    );

    await act(async () => {});
    act(() => {
      screen.getByRole("button", { name: RE_RECHECK_BUTTON }).click();
    });
    await act(async () => {});
    act(() => {
      vi.advanceTimersByTime(120);
    });
    await act(async () => {});

    expect(onResolvedAfterRecheck).not.toHaveBeenCalled();
    expect(mockSystemCheckResults.mock.calls.at(-1)?.[0]).toMatchObject({
      checks: [
        expect.objectContaining({
          id: "health-check-request",
          error: "System check timed out",
          passed: false,
        }),
      ],
      revealedCount: 1,
    });
  });
});

describe("Checking indicator behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Render the blocking dialog and click Re-check with a pending query. */
  async function renderAndClickRecheckWithPendingQuery() {
    let resolveRecheck!: (value: typeof failingData) => void;
    mockQueryFn.mockReturnValue(
      new Promise((resolve) => {
        resolveRecheck = resolve;
      })
    );

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={failingData}
          latestVersionOverride={null}
          onCancel={vi.fn()}
        />
      </Wrapper>
    );

    await act(async () => {});

    act(() => {
      screen.getByRole("button", { name: RE_RECHECK_BUTTON }).click();
    });
    await act(async () => {});

    return resolveRecheck;
  }

  it("spins the RefreshCw icon while a re-check is in flight with cached failures", async () => {
    const resolveRecheck = await renderAndClickRecheckWithPendingQuery();

    const recheckButton = screen.getByRole("button", {
      name: RE_RECHECK_BUTTON,
    });
    const icon = recheckButton.querySelector("svg");
    expect(icon?.getAttribute("class")).toContain("animate-spin");

    await act(() => {
      resolveRecheck(failingData);
    });
  });

  it("does not spin the RefreshCw icon when no fetch is in flight", async () => {
    mockQueryFn.mockResolvedValue(failingData);

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={failingData}
          latestVersionOverride={null}
          onCancel={vi.fn()}
        />
      </Wrapper>
    );

    await act(async () => {});

    const recheckButton = screen.getByRole("button", {
      name: RE_RECHECK_BUTTON,
    });
    const icon = recheckButton.querySelector("svg");
    expect(icon?.getAttribute("class")).not.toContain("animate-spin");
  });

  it("disables the Re-check button while a fetch is in flight", async () => {
    const resolveRecheck = await renderAndClickRecheckWithPendingQuery();

    expect(
      screen.getByRole("button", { name: RE_RECHECK_BUTTON })
    ).toBeDisabled();

    await act(() => {
      resolveRecheck(failingData);
    });
  });
});
