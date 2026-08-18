import {
  ComputePreference,
  type ComputePreferenceResponse,
} from "@repo/api/src/types/compute-target";
import { CLAUDE_API_KEY_INFO_PATH } from "@repo/app/api-keys/hooks/use-claude-api-keys";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_API_KEY_CARD_ANCHOR,
  SettingsTab,
} from "@/app/(authenticated)/[orgSlug]/settings/settings-tabs";
import {
  CLOUD_READINESS_UNKNOWN_REASON,
  CLOUD_TARGET_UNAVAILABLE_ACTION_LABEL,
  CLOUD_TARGET_UNAVAILABLE_TOAST_DURATION_MS,
  CLOUD_TARGET_VALIDATION_FEATURE_FLAG_KEY,
  CloudTargetUnavailableMessage,
  CloudTargetUnavailableReason,
} from "../cloud-target-readiness";
import {
  PreLoopAnalyticsEvent,
  PreLoopCommand,
} from "../pre-loop-health-check";
import {
  PreLoopSystemCheckProvider,
  usePreLoopSystemCheckGate,
} from "../pre-loop-system-check-provider";
import { createQueryClient } from "./fixtures/pre-loop-provider-harness";

const mockCapture = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());
const mockToastWarning = vi.hoisted(() => vi.fn());
const mockUseFeatureFlag = vi.hoisted(() => vi.fn());
const mockUseComputePreference = vi.hoisted(() => vi.fn());
const mockUseComputeTargets = vi.hoisted(() => vi.fn());
const mockUseLatestElectronRelease = vi.hoisted(() => vi.fn());
const mockApiGet = vi.hoisted(() => vi.fn());
const mockUseUser = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("@repo/analytics/client", () => ({
  useAnalytics: () => ({
    capture: mockCapture,
    identify: vi.fn(),
    reset: vi.fn(),
  }),
  useFeatureFlag: (key: string) => mockUseFeatureFlag(key),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) =>
    mockUseFeatureFlag(key)?.enabled === true,
}));

vi.mock("@repo/auth/client", () => ({
  useUser: () => mockUseUser(),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: mockToastError,
    warning: mockToastWarning,
  },
}));

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_MCP_SERVER_URL: "https://mcp.closedloop.ai/mcp",
    NEXT_PUBLIC_POSTHOG_KEY: "test-posthog-key",
  },
}));

vi.mock("@repo/app/compute/hooks/use-compute-preference", () => ({
  useComputePreference: (...args: unknown[]) =>
    mockUseComputePreference(...args),
}));

vi.mock("@/hooks/queries/use-compute-targets", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/queries/use-compute-targets")
    >();
  return {
    ...actual,
    useComputeTargets: (...args: unknown[]) => mockUseComputeTargets(...args),
  };
});

vi.mock("@repo/app/desktop/hooks/use-electron-release", () => ({
  useLatestElectronRelease: (...args: unknown[]) =>
    mockUseLatestElectronRelease(...args),
}));

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: () => ({ get: mockApiGet }),
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "org-test",
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

vi.mock("@/components/engineer/HealthCheckDialog", () => ({
  HealthCheckDialog: () => <div data-testid="blocking-dialog" />,
}));

const CLOUD_PREFERENCE: ComputePreferenceResponse = {
  preferredComputeMode: ComputePreference.Cloud,
  computeTargetId: undefined,
};

const KEY_SET = {
  org: { isSet: false, lastFour: null, setAt: null },
  user: { isSet: true, lastFour: "abcd", setAt: null },
};

const NO_KEY_SET = {
  org: { isSet: false, lastFour: null, setAt: null },
  user: { isSet: false, lastFour: null, setAt: null },
};

const MISSING_KEY_COPY =
  CloudTargetUnavailableMessage[CloudTargetUnavailableReason.MissingApiKey];

function GateHarness({
  execute,
  computeTargetId,
}: {
  execute: (context?: unknown) => void;
  computeTargetId?: string | null;
}) {
  const gate = usePreLoopSystemCheckGate();
  return (
    <button
      onClick={() => {
        gate
          .runWithPreLoopSystemCheck(
            {
              command: PreLoopCommand.ExecutePlan,
              documentId: "plan-1",
              documentType: "implementation_plan",
              ownerKey: "owner-1",
              computeTargetId,
            },
            execute
          )
          .catch(() => undefined);
      }}
      type="button"
    >
      Run
    </button>
  );
}

function renderGate(
  execute: (context?: unknown) => void,
  computeTargetId: string | null | undefined
) {
  const queryClient = createQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <PreLoopSystemCheckProvider>
        <GateHarness computeTargetId={computeTargetId} execute={execute} />
      </PreLoopSystemCheckProvider>
    </QueryClientProvider>
  );
}

function enableFlags(...keys: string[]) {
  const enabled = new Set(keys);
  mockUseFeatureFlag.mockImplementation((key: string) => ({
    enabled: enabled.has(key),
  }));
}

/**
 * `null` explicitly targets Cloud; `undefined` resolves the saved preference.
 * Deliberately NOT a defaulted parameter — a default would fire on an explicit
 * `undefined` and silently turn every preference-driven case into an explicit
 * Cloud one.
 */
function runGate(
  execute: (context?: unknown) => void,
  computeTargetId: string | null | undefined
) {
  renderGate(execute, computeTargetId);
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
}

describe("pre-loop Cloud compute target validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUser.mockReturnValue({ user: { id: "user-1" } });
    enableFlags(CLOUD_TARGET_VALIDATION_FEATURE_FLAG_KEY);
    mockUseComputePreference.mockImplementation(() => ({
      data: CLOUD_PREFERENCE,
      refetch: vi
        .fn()
        .mockResolvedValue({ data: CLOUD_PREFERENCE, error: null }),
    }));
    mockUseComputeTargets.mockImplementation(() => ({
      data: [],
      refetch: vi.fn().mockResolvedValue({ data: [], error: null }),
    }));
    mockUseLatestElectronRelease.mockReturnValue({
      data: { version: "1.0.0" },
      refetch: vi
        .fn()
        .mockResolvedValue({ data: { version: "1.0.0" }, error: null }),
    });
    mockApiGet.mockResolvedValue(KEY_SET);
    vi.stubGlobal("fetch", vi.fn());
  });

  it("blocks the command when no Anthropic API key is configured", async () => {
    mockApiGet.mockResolvedValue(NO_KEY_SET);
    const execute = vi.fn();

    runGate(execute, null);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        MISSING_KEY_COPY.title,
        expect.objectContaining({ description: MISSING_KEY_COPY.description })
      );
    });
    // `toast.error`, not `toast.warning`: in this gate a warning means "could
    // not verify" (the `Unknown` degrade, which still dispatches) and an error
    // means "verified, and it is wrong". A missing key is the second kind.
    expect(mockToastWarning).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(mockApiGet).toHaveBeenCalledWith(CLAUDE_API_KEY_INFO_PATH);
    expect(mockCapture).toHaveBeenCalledWith(
      PreLoopAnalyticsEvent.SystemCheckUnavailable,
      expect.objectContaining({
        reason: CloudTargetUnavailableReason.MissingApiKey,
      })
    );
  });

  it("dispatches to Cloud when a user-level key is configured", async () => {
    const execute = vi.fn();

    runGate(execute, null);

    await waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    // Every dispatching path below asserts BOTH variants: checking only
    // `error` would go quietly green if the block were re-routed back to
    // `toast.warning`, which in this gate means "could not verify".
    expect(mockToastError).not.toHaveBeenCalled();
    expect(mockToastWarning).not.toHaveBeenCalled();
  });

  it("dispatches to Cloud when only an org-level key is configured", async () => {
    mockApiGet.mockResolvedValue({
      org: { isSet: true, lastFour: "wxyz", setAt: null },
      user: { isSet: false, lastFour: null, setAt: null },
    });
    const execute = vi.fn();

    runGate(execute, null);

    await waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    expect(mockToastError).not.toHaveBeenCalled();
    expect(mockToastWarning).not.toHaveBeenCalled();
  });

  it("leaves a Local-preference user with an offline desktop alone", async () => {
    // The no-local-target branch is ALSO reached when the preference is Local
    // and nothing is online. Blaming an Anthropic key there would hide the
    // server's accurate "no online compute targets" answer.
    mockUseComputePreference.mockImplementation(() => {
      const localPreference: ComputePreferenceResponse = {
        preferredComputeMode: ComputePreference.Local,
        computeTargetId: undefined,
      };
      return {
        data: localPreference,
        refetch: vi
          .fn()
          .mockResolvedValue({ data: localPreference, error: null }),
      };
    });
    mockApiGet.mockResolvedValue(NO_KEY_SET);
    const execute = vi.fn();

    runGate(execute, undefined);

    await waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    expect(mockToastError).not.toHaveBeenCalled();
    expect(mockToastWarning).not.toHaveBeenCalled();
    expect(mockApiGet).not.toHaveBeenCalledWith(CLAUDE_API_KEY_INFO_PATH);
  });

  it("blocks a keyless Cloud-preference user who requested no explicit target", async () => {
    // Same entry shape as the Local case above (`computeTargetId: undefined`),
    // so the two tests together prove the preference — not the branch — decides.
    mockApiGet.mockResolvedValue(NO_KEY_SET);
    const execute = vi.fn();

    runGate(execute, undefined);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        MISSING_KEY_COPY.title,
        expect.objectContaining({ description: MISSING_KEY_COPY.description })
      );
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports the unknown-readiness degrade so it cannot fail silently", async () => {
    mockApiGet.mockRejectedValue(new Error("network down"));
    const execute = vi.fn();

    runGate(execute, null);

    await waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    expect(mockCapture).toHaveBeenCalledWith(
      PreLoopAnalyticsEvent.SystemCheckUnavailable,
      expect.objectContaining({ reason: CLOUD_READINESS_UNKNOWN_REASON })
    );
  });

  it("re-reads readiness on every attempt instead of trusting a cached verdict", async () => {
    // A key added in another tab must unblock this one without a page reload.
    mockApiGet.mockResolvedValueOnce(NO_KEY_SET).mockResolvedValue(KEY_SET);
    const execute = vi.fn();

    renderGate(execute, null);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    expect(mockApiGet).toHaveBeenCalledTimes(2);
  });

  it("dispatches when the readiness lookup itself fails", async () => {
    // Degrade, don't wedge: a failed lookup is not evidence the launch fails.
    mockApiGet.mockRejectedValue(new Error("network down"));
    const execute = vi.fn();

    runGate(execute, null);

    await waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    expect(mockToastError).not.toHaveBeenCalled();
    expect(mockToastWarning).not.toHaveBeenCalled();
  });

  it("dispatches when the API answers a shape this client cannot parse", async () => {
    mockApiGet.mockResolvedValue({ keys: ["user"] });
    const execute = vi.fn();

    runGate(execute, null);

    await waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    expect(mockToastError).not.toHaveBeenCalled();
    expect(mockToastWarning).not.toHaveBeenCalled();
  });

  it("does not check readiness at all when the flag is off", async () => {
    // Gate trap guard: this fixture would BLOCK with the flag on, so a green
    // assertion here proves the flag is the thing turning the check off.
    enableFlags();
    mockApiGet.mockResolvedValue(NO_KEY_SET);
    const execute = vi.fn();

    runGate(execute, null);

    await waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    expect(mockApiGet).not.toHaveBeenCalledWith(CLAUDE_API_KEY_INFO_PATH);
    expect(mockToastError).not.toHaveBeenCalled();
    expect(mockToastWarning).not.toHaveBeenCalled();
  });

  it("offers a one-click deep link to the Anthropic key card itself", async () => {
    // The `Anthropic API Key` card lives on Integrations, NOT on the `API Keys`
    // tab (that one is for Closedloop `sk_live_` keys). Sending a blocked user
    // to `api-keys` lands them on a screen with no Anthropic field on it.
    //
    // The fragment matters as much as the tab: Integrations stacks six cards,
    // so a tab-only link would drop the user at the top of a list and leave
    // them to find the card the button promised.
    mockApiGet.mockResolvedValue(NO_KEY_SET);

    runGate(vi.fn(), null);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledTimes(1);
    });
    const options = mockToastError.mock.calls[0][1];
    expect(options.action.label).toBe(CLOUD_TARGET_UNAVAILABLE_ACTION_LABEL);
    // This toast is the only place the user learns why nothing happened, and
    // it asks them to read two sentences and then decide. Riding sonner's 4s
    // default can expire mid-sentence, so the duration is set explicitly.
    expect(options.duration).toBe(CLOUD_TARGET_UNAVAILABLE_TOAST_DURATION_MS);

    expect(mockNavigate).not.toHaveBeenCalled();
    options.action.onClick();
    expect(mockNavigate).toHaveBeenCalledWith(
      `/org-test/settings?tab=${SettingsTab.Integrations}#${ANTHROPIC_API_KEY_CARD_ANCHOR}`
    );
  });
});
