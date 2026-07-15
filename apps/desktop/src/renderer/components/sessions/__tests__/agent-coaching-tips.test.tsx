import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";
import { AgentCoachingTips } from "../agent-coaching-tips";
import type {
  AgentCoachingApi,
  AgentCoachingTip,
  CoachingPackInfo,
} from "../agent-coaching-types";

const NO_TIPS_PATTERN = /No coaching tips right now/;
const POWERED_BY_PATTERN = /Powered by/;
const NO_NEW_TIPS_PATTERN = /No new tips right now/;
const DRAFT_BODY_PATTERN = /Move repeated shell probes into a reusable skill/;
const ARTIFACT_PATTERN = /nightly-review-preflight/;

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

describe("AgentCoachingTips", () => {
  it("previews the artifact on draft without clearing the tip", async () => {
    const api: AgentCoachingApi = {
      loadTips: vi.fn(() => loaded([makeTip()])),
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    render(<AgentCoachingTips api={api} />);

    await screen.findByText("Move repeated shell probes into a reusable skill");

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    await waitFor(() =>
      expect(api.recordFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "details_opened",
          tipId: "shell-probe-reusable-skill",
        })
      )
    );

    fireEvent.click(screen.getByRole("button", { name: "Draft skill" }));
    await waitFor(() =>
      expect(api.recordFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "action_clicked",
          actionId: "draft-command-wrapper",
          tipId: "shell-probe-reusable-skill",
        })
      )
    );

    // Draft is a preview: the artifact appears, and the tip + its actions stay
    // so the user can still install it.
    await screen.findByText("Drafted artifact");
    expect(
      screen.getByText("Move repeated shell probes into a reusable skill")
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Draft skill" })).toBeTruthy();
  });

  it("drafts and surfaces a concrete artifact when a draft action is used", async () => {
    const api: AgentCoachingApi = {
      loadTips: vi.fn(() => loaded([makeTip()])),
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText("Move repeated shell probes into a reusable skill");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));

    fireEvent.click(await screen.findByRole("button", { name: "Draft skill" }));

    // The draft artifact is produced and surfaced. With no proposedArtifact the
    // synthesized draft embeds the tip title, so it appears both in the still-
    // present tip card and in the draft panel.
    await screen.findByText("Drafted artifact");
    expect(screen.getAllByText(DRAFT_BODY_PATTERN).length).toBeGreaterThan(1);
  });

  it("shows the generator's proposedArtifact verbatim as the draft", async () => {
    const artifact =
      "name: nightly-review-preflight\nsteps:\n  - git fetch origin\n  - gh pr checks";
    const api: AgentCoachingApi = {
      loadTips: vi.fn(() => loaded([makeTip({ proposedArtifact: artifact })])),
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText("Move repeated shell probes into a reusable skill");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(await screen.findByRole("button", { name: "Draft skill" }));

    // The real artifact is shown, not a synthesized plan/description.
    const draft = await screen.findByText(ARTIFACT_PATTERN);
    expect(draft.textContent).toContain("name: nightly-review-preflight");
  });

  it("reviews then installs an artifact via the harness on confirm_then_apply", async () => {
    const installArtifact = vi.fn(() =>
      Promise.resolve("Created skill at .claude/skills/foo")
    );
    const api: AgentCoachingApi = {
      installArtifact,
      loadTips: vi.fn(() => loaded([makeTip({ actions: [applyAction()] })])),
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText("Move repeated shell probes into a reusable skill");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));

    // First click surfaces the draft for review (no install yet).
    fireEvent.click(await screen.findByRole("button", { name: "Apply skill" }));
    await screen.findByText("Drafted artifact");
    expect(installArtifact).not.toHaveBeenCalled();

    // The explicit Install click hands the reviewed draft to the harness.
    fireEvent.click(
      await screen.findByRole("button", { name: "Install (Apply skill)" })
    );
    await waitFor(() => expect(installArtifact).toHaveBeenCalledTimes(1));
    await screen.findByText("Created skill at .claude/skills/foo");
  });

  it("installs the artifact even when recording feedback fails", async () => {
    const installArtifact = vi.fn(() =>
      Promise.resolve("Created skill at .claude/skills/foo")
    );
    const api: AgentCoachingApi = {
      installArtifact,
      loadTips: vi.fn(() => loaded([makeTip({ actions: [applyAction()] })])),
      // Only the install's own feedback event fails, isolating the installDraft
      // path under test.
      recordFeedback: vi.fn((event) =>
        event.action === "action_clicked"
          ? Promise.reject(new Error("feedback offline"))
          : Promise.resolve()
      ),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText("Move repeated shell probes into a reusable skill");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));

    fireEvent.click(await screen.findByRole("button", { name: "Apply skill" }));
    await screen.findByText("Drafted artifact");

    fireEvent.click(
      await screen.findByRole("button", { name: "Install (Apply skill)" })
    );

    // A rejected recordFeedback (telemetry) must not block the install.
    await waitFor(() => expect(installArtifact).toHaveBeenCalledTimes(1));
    await screen.findByText("Created skill at .claude/skills/foo");
  });

  it("clears a tip on dismiss and shows the next", async () => {
    const api: AgentCoachingApi = {
      loadTips: vi.fn(() =>
        loaded([
          makeTip(),
          makeTip({ id: "second-tip", title: "Second coaching tip" }),
        ])
      ),
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText("Move repeated shell probes into a reusable skill");

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss coaching tip" })
    );

    await screen.findByText("Second coaching tip");
    expect(
      screen.queryByText("Move repeated shell probes into a reusable skill")
    ).toBeNull();
  });

  it("clears the tip on dismiss even when recording feedback fails", async () => {
    const api: AgentCoachingApi = {
      loadTips: vi.fn(() =>
        loaded([
          makeTip(),
          makeTip({ id: "second-tip", title: "Second coaching tip" }),
        ])
      ),
      recordFeedback: vi.fn(() =>
        Promise.reject(new Error("feedback offline"))
      ),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText("Move repeated shell probes into a reusable skill");

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss coaching tip" })
    );

    // A rejected recordFeedback must not strand the tip in the UI — it still
    // clears and the next tip shows.
    await screen.findByText("Second coaching tip");
    expect(
      screen.queryByText("Move repeated shell probes into a reusable skill")
    ).toBeNull();
  });

  it("appends fresh tips on Get More Tips without resurrecting earlier ones", async () => {
    const loadTips = vi
      .fn()
      .mockResolvedValueOnce(await loaded([makeTip()]))
      .mockResolvedValueOnce(
        await loaded([
          makeTip({ id: "extra-tip", title: "Extra coaching tip" }),
        ])
      );
    const api: AgentCoachingApi = {
      loadTips,
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText("Move repeated shell probes into a reusable skill");
    expect(screen.getByText("Tip 1 of 1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Get More Tips" }));

    await screen.findByText("Tip 1 of 2");
    expect(loadTips).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect a dismissed tip on Get More Tips when its feedback failed", async () => {
    // The dismiss's telemetry rejects, so the model never learns the tip was
    // cleared and re-serves it on the next load. The component must still
    // suppress it locally so a best-effort failure can't resurrect it.
    const loadTips = vi
      .fn()
      .mockResolvedValueOnce(await loaded([makeTip()]))
      .mockResolvedValueOnce(await loaded([makeTip()]));
    const api: AgentCoachingApi = {
      loadTips,
      recordFeedback: vi.fn(() =>
        Promise.reject(new Error("feedback offline"))
      ),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText("Move repeated shell probes into a reusable skill");

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss coaching tip" })
    );
    await waitFor(() =>
      expect(
        screen.queryByText("Move repeated shell probes into a reusable skill")
      ).toBeNull()
    );

    fireEvent.click(screen.getByRole("button", { name: "Get More Tips" }));

    // The re-served tip is suppressed; the "no new tips" notice shows instead.
    await screen.findByText(NO_NEW_TIPS_PATTERN);
    expect(
      screen.queryByText("Move repeated shell probes into a reusable skill")
    ).toBeNull();
    expect(loadTips).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect a tip cleared while Get More Tips is in flight", async () => {
    // Race: the user dismisses the current tip after clicking Get More Tips but
    // before its load resolves. The in-flight load then re-serves that same tip.
    // The append updater must read clearedIds at resolution time (not click
    // time) so the just-cleared tip stays gone.
    let resolveSecond!: (value: Awaited<ReturnType<typeof loaded>>) => void;
    const secondLoad = new Promise<Awaited<ReturnType<typeof loaded>>>(
      (resolve) => {
        resolveSecond = resolve;
      }
    );
    const loadTips = vi
      .fn()
      .mockReturnValueOnce(loaded([makeTip()]))
      .mockReturnValueOnce(secondLoad);
    const api: AgentCoachingApi = {
      loadTips,
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText("Move repeated shell probes into a reusable skill");

    // Kick off Get More Tips; its load stays in flight.
    fireEvent.click(screen.getByRole("button", { name: "Get More Tips" }));

    // The user clears the current tip before the fetch resolves. Wait for the
    // tip to leave the list so the in-flight load resolves against state where
    // the tip is already gone — the only thing that can still suppress it on
    // reload is the recorded cleared id.
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss coaching tip" })
    );
    await waitFor(() =>
      expect(
        screen.queryByText("Move repeated shell probes into a reusable skill")
      ).toBeNull()
    );

    // The in-flight load re-serves the just-cleared tip.
    resolveSecond({ activePack: null, tips: [makeTip()] });

    // It must stay cleared — a set read at button-click time instead of
    // resolution time would have resurrected it.
    await screen.findByText(NO_NEW_TIPS_PATTERN);
    expect(
      screen.queryByText("Move repeated shell probes into a reusable skill")
    ).toBeNull();
    expect(loadTips).toHaveBeenCalledTimes(2);
  });

  it("keeps the bar and an empty hint once the only tip is cleared, without auto-refetch", async () => {
    const loadTips = vi.fn(() => loaded([makeTip()]));
    const api: AgentCoachingApi = {
      loadTips,
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText("Move repeated shell probes into a reusable skill");

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss coaching tip" })
    );

    // The tip is gone but the bar persists so the user can still pull more.
    await waitFor(() =>
      expect(
        screen.queryByText("Move repeated shell probes into a reusable skill")
      ).toBeNull()
    );
    expect(screen.getByRole("button", { name: "Get More Tips" })).toBeTruthy();
    expect(screen.getByText(NO_TIPS_PATTERN)).toBeTruthy();
    // No automatic refetch — the only load was the initial mount.
    expect(loadTips).toHaveBeenCalledTimes(1);
  });

  it("shows a 'Powered by <pack>' badge when a coaching pack is active", async () => {
    // The badge is driven by the pack `loadTips` returns alongside its tips —
    // the same value used to generate them — not a separate fetch.
    const api: AgentCoachingApi = {
      loadTips: vi.fn(() =>
        loaded([makeTip()], {
          name: "token-coach",
          displayName: "Token Coach",
          version: "1.0.0",
          description: null,
          signals: ["a signal"],
        })
      ),
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    render(<AgentCoachingTips api={api} />);

    await screen.findByText("Powered by Token Coach");
  });

  it("renders no pack badge when the built-in signals are in effect", async () => {
    const api: AgentCoachingApi = {
      loadTips: vi.fn(() => loaded([makeTip()])),
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText("Move repeated shell probes into a reusable skill");
    expect(screen.queryByText(POWERED_BY_PATTERN)).toBeNull();
  });

  it("shows a 'no new tips' notice when Get More Tips finds nothing new", async () => {
    const loadTips = vi.fn(() => loaded([makeTip()]));
    const api: AgentCoachingApi = {
      loadTips,
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText("Move repeated shell probes into a reusable skill");

    fireEvent.click(screen.getByRole("button", { name: "Get More Tips" }));

    await screen.findByText(NO_NEW_TIPS_PATTERN);
    expect(loadTips).toHaveBeenCalledTimes(2);
  });
});

/** A `loadTips` resolution: the day's tips plus the pack that powered them. */
function loaded(
  tips: AgentCoachingTip[],
  activePack: CoachingPackInfo | null = null
) {
  return Promise.resolve({ activePack, tips });
}

function applyAction() {
  return {
    id: "apply-command-wrapper",
    label: "Apply skill",
    mode: "confirm_then_apply" as const,
    result: "Writes the approved skill after confirmation.",
    safety: "moderate" as const,
  };
}

function makeTip(overrides: Partial<AgentCoachingTip> = {}): AgentCoachingTip {
  return {
    actions: [
      {
        id: "inspect-command-cluster",
        label: "Inspect cluster",
        mode: "read_only",
        result: "Shows repeated commands.",
        safety: "safe",
      },
      {
        id: "draft-command-wrapper",
        label: "Draft skill",
        mode: "draft",
        result: "Drafts a reusable skill.",
        safety: "safe",
      },
    ],
    body: "These shell calls were often repeated.",
    category: "token_efficiency",
    detail: {
      autoApply: "Draft only until confirmed.",
      candidateFromThisDryRun: {
        estimatedTokenSavingsPercent: 70,
        moveThis:
          "Move repeated nightly-review-worktree-preflight probes into a skill.",
        observedCalls: 12,
        outputContract: ["branch", "checks"],
        pattern: "nightly-review-worktree-preflight",
        representativeCommands: [],
        suggestedWrapper: "Create nightly-review-worktree-preflight-skill.",
      },
      howToAct: ["Inspect the cluster", "Draft a skill"],
      whatThisMeans: "Promote repeated shell probes.",
      whyThisRecommendation:
        "nightly-review-worktree-preflight appeared 12 times.",
    },
    evidence: ["12 repeated shell probes"],
    experiment: "Draft the skill.",
    id: "shell-probe-reusable-skill",
    title: "Move repeated shell probes into a reusable skill",
    whyItMatters: "It saves tokens.",
    ...overrides,
  };
}
