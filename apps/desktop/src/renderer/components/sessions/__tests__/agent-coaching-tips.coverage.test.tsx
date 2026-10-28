import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCoachingTips } from "../agent-coaching-tips";
import type {
  AgentCoachingAction,
  AgentCoachingApi,
  AgentCoachingLoadResult,
  AgentCoachingTip,
  CoachingPackInfo,
} from "../agent-coaching-types";
import { makeGroundedMetrics } from "./grounded-metrics-factory";

const NO_TIPS_PATTERN = /No coaching tips right now/;
const DRAFT_BODY_PATTERN = /Move repeated shell probes into a reusable skill/;
const APPEARED_FIVE_TIMES_PATTERN = /It appeared 5 times/;
const TIP_ONE_OF_ONE_PATTERN = /Tip 1 of 1/;
const POWERED_BY_TOKEN_COACH_PATTERN = /Powered by Token Coach/;
const GET_MORE_TIPS_PATTERN = /Get more tips/;
const INSTALL_BUTTON_PATTERN = /Install/;
const DRAFTED_COPIED_PATTERN = /drafted & copied to clipboard/;
const ESTIMATED_SAVINGS_PATTERN = /Estimated savings/;

vi.mock("@closedloop-ai/design-system/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

vi.mock("@closedloop-ai/design-system/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

function loaded(
  tips: AgentCoachingTip[],
  activePack: CoachingPackInfo | null = null,
  groundedMetrics = makeGroundedMetrics()
): Promise<AgentCoachingLoadResult> {
  return Promise.resolve({ activePack, groundedMetrics, tips });
}

function deferredLoad(tips: AgentCoachingTip[]) {
  let resolveFn: (value: AgentCoachingTip[]) => void = () => undefined;
  const promise = new Promise<AgentCoachingLoadResult>((resolve) => {
    resolveFn = (resolvedTips) =>
      resolve({
        activePack: null,
        groundedMetrics: makeGroundedMetrics(),
        tips: resolvedTips,
      });
  });
  return { promise, resolve: () => resolveFn(tips) };
}

function makeTip(overrides: Partial<AgentCoachingTip> = {}): AgentCoachingTip {
  return {
    actions: [
      {
        id: "draft-command-wrapper",
        kind: "create-new-file",
        label: "Draft the wrapper",
        mode: "confirm_then_apply",
        result: "Wraps the repeated probe into a skill.",
        safety: "safe",
      },
    ],
    body: "Move repeated shell probes into a reusable skill and save tokens.",
    category: "token_efficiency",
    detail: {
      candidateFromThisDryRun: {
        estimatedTokenSavingsPercent: 40,
        moveThis: "Move repeated nightly-review probes into a skill.",
        observedCalls: 5,
        outputContract: [],
        pattern: "nightly-review-worktree-preflight",
        representativeCommands: [],
        suggestedWrapper: "nightly-review-preflight-skill",
      },
      howToAct: ["Inspect the cluster"],
      whatThisMeans: "Promote it to a reusable skill.",
      whyThisRecommendation: "It appeared 5 times.",
      autoApply: "Draft only until confirmed.",
    },
    evidence: ["5 observed calls"],
    experiment: "Draft a skill and compare.",
    id: "shell-probe-reusable-skill",
    title: "Move repeated shell probes",
    whyItMatters: "Cuts token load.",
    ...overrides,
  };
}

describe("AgentCoachingTips — details expand/collapse toggle", () => {
  it("collapses details on a second click of the same toggle button", async () => {
    const api: AgentCoachingApi = {
      loadTips: vi.fn(() => loaded([makeTip()])),
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText(DRAFT_BODY_PATTERN);

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText(APPEARED_FIVE_TIMES_PATTERN)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
    expect(screen.queryByText(APPEARED_FIVE_TIMES_PATTERN)).toBeNull();
  });
});

describe("AgentCoachingTips — read_only actions", () => {
  it("opens details via a read_only action without clearing the tip", async () => {
    const recordFeedback = vi.fn(() => Promise.resolve());
    const readOnlyAction: AgentCoachingAction = {
      id: "inspect-cluster",
      kind: "create-new-file",
      label: "Inspect cluster",
      mode: "read_only",
      result: "Reveals the underlying command cluster.",
      safety: "safe",
    };
    const api: AgentCoachingApi = {
      loadTips: vi.fn(() => loaded([makeTip({ actions: [readOnlyAction] })])),
      recordFeedback,
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText(DRAFT_BODY_PATTERN);

    // First expand details normally so a SECOND read_only click below runs
    // openDetails() while `expanded` is already true (the `!expanded` skip
    // branch), instead of the initial-expand branch already covered elsewhere.
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    await waitFor(() =>
      expect(recordFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ action: "details_opened" })
      )
    );
    recordFeedback.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Inspect cluster" }));

    // read_only never clears the tip or records action_clicked feedback.
    await waitFor(() => expect(recordFeedback).not.toHaveBeenCalled());
    expect(screen.getByText(DRAFT_BODY_PATTERN)).toBeTruthy();
  });
});

describe("AgentCoachingTips — Get More Tips selects index 0 on an empty list", () => {
  it("resets selectedIndex to 0 when fresh tips arrive after every tip was cleared", async () => {
    const loadTips = vi
      .fn()
      .mockReturnValueOnce(loaded([makeTip({ id: "only-tip" })]))
      .mockReturnValueOnce(loaded([makeTip({ id: "fresh-tip" })]));
    const api: AgentCoachingApi = {
      loadTips,
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText(DRAFT_BODY_PATTERN);

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss coaching tip" })
    );
    await screen.findByText(NO_TIPS_PATTERN);

    fireEvent.click(
      screen.getByRole("button", { name: GET_MORE_TIPS_PATTERN })
    );
    await screen.findByText(DRAFT_BODY_PATTERN);
    expect(screen.getByText(TIP_ONE_OF_ONE_PATTERN)).toBeTruthy();
  });
});

describe("AgentCoachingTips — coaching pack badge without a version", () => {
  it("omits the version suffix in the badge title when the pack carries no version", async () => {
    const api: AgentCoachingApi = {
      loadTips: vi.fn(() =>
        loaded([makeTip()], {
          description: null,
          displayName: "Token Coach",
          name: "token-coach",
          signals: [],
          version: null,
        } as unknown as CoachingPackInfo)
      ),
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText(POWERED_BY_TOKEN_COACH_PATTERN);

    const description = screen.getByText(POWERED_BY_TOKEN_COACH_PATTERN);
    expect(description.getAttribute("title")).toBe(
      "Coaching signals supplied by the Token Coach pack"
    );
  });
});

describe("AgentCoachingTips — install-in-flight button label", () => {
  it("shows 'Installing…' while the install promise is pending", async () => {
    let resolveInstall: (value: string) => void = () => undefined;
    const installArtifact = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveInstall = resolve;
        })
    );
    const api: AgentCoachingApi = {
      installArtifact,
      loadTips: vi.fn(() => loaded([makeTip()])),
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText(DRAFT_BODY_PATTERN);

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(screen.getByRole("button", { name: "Draft the wrapper" }));
    await screen.findByRole("button", { name: INSTALL_BUTTON_PATTERN });
    fireEvent.click(
      screen.getByRole("button", { name: INSTALL_BUTTON_PATTERN })
    );

    await screen.findByRole("button", { name: "Installing…" });

    resolveInstall("Installed.");
    await waitFor(() => expect(installArtifact).toHaveBeenCalledTimes(1));
  });
});

describe("AgentCoachingTips — clipboard write with no navigator", () => {
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator"
  );

  afterEach(() => {
    if (originalNavigatorDescriptor) {
      Object.defineProperty(
        globalThis,
        "navigator",
        originalNavigatorDescriptor
      );
    }
  });

  it("drafts a non-confirm action without throwing when navigator is undefined", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: undefined,
    });
    const api: AgentCoachingApi = {
      loadTips: vi.fn(() =>
        loaded([
          makeTip({
            actions: [
              {
                id: "draft-only",
                kind: "create-new-file",
                label: "Draft only",
                mode: "draft",
                result: "Shows the draft without installing.",
                safety: "safe",
              },
            ],
          }),
        ])
      ),
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText(DRAFT_BODY_PATTERN);

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: "Draft only" }))
    ).not.toThrow();

    await screen.findByText(DRAFTED_COPIED_PATTERN);
  });
});

describe("AgentCoachingTips — details with no repeated-command candidate", () => {
  it("omits the estimated-savings block when the tip carries no candidateFromThisDryRun", async () => {
    const api: AgentCoachingApi = {
      loadTips: vi.fn(() =>
        loaded([
          makeTip({
            detail: {
              howToAct: ["Do the thing"],
              whatThisMeans: "It means this.",
              whyThisRecommendation: "Because evidence.",
              autoApply: "Draft only until confirmed.",
            },
          }),
        ])
      ),
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText(DRAFT_BODY_PATTERN);

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("Because evidence.")).toBeTruthy();
    expect(screen.queryByText(ESTIMATED_SAVINGS_PATTERN)).toBeNull();
  });
});

describe("AgentCoachingTips — activity push after unmount", () => {
  it("ignores an activity push delivered after the component unmounted", async () => {
    const unsubscribe = vi.fn();
    const subscribeToActivity = vi.fn((_cb: () => void) => unsubscribe);
    const loadTips = vi.fn(() => loaded([]));
    const api: AgentCoachingApi = {
      loadTips,
      recordFeedback: vi.fn(() => Promise.resolve()),
      subscribeToActivity,
    };

    const { unmount } = render(<AgentCoachingTips api={api} />);
    await screen.findByText(NO_TIPS_PATTERN);
    const push = subscribeToActivity.mock.calls[0][0];

    unmount();
    expect(loadTips).toHaveBeenCalledTimes(1);

    // A push firing post-unmount must be a no-op (the `cancelled` guard at the
    // top of the subscribeToActivity callback), not schedule another load.
    push();
    expect(loadTips).toHaveBeenCalledTimes(1);
  });
});

describe("AgentCoachingTips — reentrant load while still in flight", () => {
  it("records the corpus as dirty and reconciles once the in-flight load settles", async () => {
    vi.useFakeTimers();
    try {
      const subscribeToActivity = vi.fn((_cb: () => void) => vi.fn());
      const firstLoad = deferredLoad([]);
      const loadTips = vi
        .fn()
        .mockReturnValueOnce(firstLoad.promise)
        .mockReturnValueOnce(loaded([makeTip()]));
      const api: AgentCoachingApi = {
        loadTips,
        recordFeedback: vi.fn(() => Promise.resolve()),
        subscribeToActivity,
      };

      render(<AgentCoachingTips api={api} />);
      expect(loadTips).toHaveBeenCalledTimes(1);

      // A DB push arrives; its debounced reload only fires after 400ms.
      subscribeToActivity.mock.calls[0][0]();

      // Advance PAST the debounce window while the first load is STILL
      // pending — the debounced `load()` re-enters while `inFlight` is true,
      // hitting the reentrancy guard and marking the corpus dirty rather than
      // dropping the push.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(loadTips).toHaveBeenCalledTimes(1);

      // Settling the first load must now schedule exactly one follow-up
      // reload (the recorded dirty flag), which surfaces the new tip.
      await act(async () => {
        firstLoad.resolve();
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(loadTips).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AgentCoachingTips — rejected load settling after being superseded", () => {
  it("keeps the current tip when a superseded kickoff's load rejects late", async () => {
    let rejectFirst: (error: Error) => void = () => undefined;
    const firstLoad = new Promise<AgentCoachingLoadResult>(
      (_resolve, reject) => {
        rejectFirst = reject;
      }
    );
    const loadTips = vi
      .fn()
      .mockReturnValueOnce(firstLoad)
      .mockReturnValueOnce(loaded([makeTip()]));
    const api: AgentCoachingApi = {
      loadTips,
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    const { rerender } = render(
      <AgentCoachingTips api={api} lookbackDays={7} />
    );
    expect(loadTips).toHaveBeenCalledTimes(1);

    // Changing `lookbackDays` re-runs the kickoff effect: its cleanup marks
    // the FIRST kickoff's own `cancelled` flag, then a second kickoff starts
    // and loads the current tip.
    act(() => {
      rerender(<AgentCoachingTips api={api} lookbackDays={30} />);
    });
    await screen.findByText(DRAFT_BODY_PATTERN);
    expect(loadTips).toHaveBeenCalledTimes(2);

    // The stale first load rejects only now — the cancelled guard in its
    // `.catch()` must suppress `handlers.onError()` so it cannot clear the
    // tips the second, current kickoff already committed.
    await act(async () => {
      rejectFirst(new Error("db offline"));
      await Promise.resolve();
    });

    expect(screen.getByText(DRAFT_BODY_PATTERN)).toBeTruthy();
  });
});

describe("AgentCoachingTips — double-click on Get More Tips", () => {
  it("ignores a second Get More Tips click while the first is still in flight", async () => {
    let resolveFn: (tips: AgentCoachingTip[]) => void = () => undefined;
    const loadTips = vi
      .fn()
      .mockReturnValueOnce(loaded([makeTip()]))
      .mockReturnValueOnce(
        new Promise<AgentCoachingLoadResult>((resolve) => {
          resolveFn = (tips) =>
            resolve({
              activePack: null,
              groundedMetrics: makeGroundedMetrics(),
              tips,
            });
        })
      );
    const api: AgentCoachingApi = {
      loadTips,
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText(DRAFT_BODY_PATTERN);

    const button = screen.getByRole("button", { name: GET_MORE_TIPS_PATTERN });
    fireEvent.click(button);
    // The button disables itself while fetchingMore is true; a disabled
    // native button does not dispatch a click at all, so this second
    // fireEvent.click is a no-op through the DOM itself — documenting that
    // getMoreTips' own `if (fetchingMore) return;` guard is defense-in-depth
    // behind that disabled state, not reachable as a distinct path here.
    fireEvent.click(button);

    await act(async () => {
      resolveFn([makeTip({ id: "second-tip" })]);
      await Promise.resolve();
    });
    expect(loadTips).toHaveBeenCalledTimes(2);
  });
});

describe("AgentCoachingTips — default api construction from window.desktopApi", () => {
  const originalDesktopApi = window.desktopApi;

  afterEach(() => {
    window.desktopApi = originalDesktopApi;
  });

  it("builds its own coaching api from window.desktopApi when none is provided", async () => {
    const getAnalytics = vi.fn(() => Promise.resolve(null));
    const getWorkflowData = vi.fn(() => Promise.resolve(null));
    const getEventFeed = vi.fn(() => Promise.resolve([]));
    const getAllSkills = vi.fn(() => Promise.resolve([]));
    window.desktopApi = {
      agentSessionsApi: {
        analytics: vi.fn(),
        detail: vi.fn(),
        list: vi.fn(),
        usage: vi.fn(),
      },
      db: {
        getAllSkills,
        getAnalytics,
        getEventFeed,
        getWorkflowData,
      },
    } as unknown as typeof window.desktopApi;

    render(<AgentCoachingTips />);

    await screen.findByText(NO_TIPS_PATTERN);
    expect(getAnalytics).toHaveBeenCalled();
  });
});
