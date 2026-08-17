import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";
import { AgentCoachingTips } from "../agent-coaching-tips";
import type {
  AgentCoachingApi,
  AgentCoachingGroundedMetrics,
  AgentCoachingTip,
  CoachingPackInfo,
} from "../agent-coaching-types";
import { makeGroundedMetrics } from "./grounded-metrics-factory";

const NEXT_BUTTON_PATTERN = /Next/;
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
    // FEA-3722: a successful install resets the draft installer, so the
    // reviewed-draft panel tears down (rather than lingering below the now
    // tip-cleared surface).
    await waitFor(() =>
      expect(screen.queryByText("Drafted artifact")).toBeNull()
    );
    expect(
      screen.queryByRole("button", { name: "Install (Apply skill)" })
    ).toBeNull();
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
    // FEA-3722: a successful install clears the draft panel post-install.
    await waitFor(() =>
      expect(screen.queryByText("Drafted artifact")).toBeNull()
    );
  });

  it("keeps the draft visible and surfaces the error when install fails", async () => {
    // FEA-3722: only a SUCCESSFUL install resets the draft installer. A failed
    // install must keep the reviewed draft on screen so the user can retry, and
    // report why it failed.
    const installArtifact = vi.fn(() =>
      Promise.reject(new Error("harness offline"))
    );
    const api: AgentCoachingApi = {
      installArtifact,
      loadTips: vi.fn(() => loaded([makeTip({ actions: [applyAction()] })])),
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText("Move repeated shell probes into a reusable skill");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply skill" }));
    await screen.findByText("Drafted artifact");

    fireEvent.click(
      await screen.findByRole("button", { name: "Install (Apply skill)" })
    );

    await screen.findByText("Install failed: harness offline");
    // The draft panel stays so the user can retry.
    expect(screen.getByText("Drafted artifact")).toBeTruthy();
  });

  // FEA-3687 #2: the drafted-artifact panel belongs to the tip it was drafted
  // from — navigating tips must clear it so a stale draft never hangs over the
  // next tip.
  it("clears the drafted artifact panel when navigating to the next tip", async () => {
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

    // Draft an artifact on the first tip.
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(await screen.findByRole("button", { name: "Draft skill" }));
    await screen.findByText("Drafted artifact");

    // Advance to the next tip — the stale draft panel must be gone.
    fireEvent.click(screen.getByRole("button", { name: NEXT_BUTTON_PATTERN }));
    await screen.findByText("Second coaching tip");
    expect(screen.queryByText("Drafted artifact")).toBeNull();
  });

  // FEA-3687 #2: dismissing a tip advances selection and must also clear an
  // open draft from the dismissed tip.
  it("clears the drafted artifact panel when the drafted tip is dismissed", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(await screen.findByRole("button", { name: "Draft skill" }));
    await screen.findByText("Drafted artifact");

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss coaching tip" })
    );
    await screen.findByText("Second coaching tip");
    expect(screen.queryByText("Drafted artifact")).toBeNull();
  });

  // FEA-3687 #4: Apply dispatches by the reviewed action's kind.
  it("passes the action kind to installArtifact on Apply", async () => {
    const installArtifact = vi.fn(() =>
      Promise.resolve("Installed skill at ~/.claude/skills/foo/SKILL.md")
    );
    const api: AgentCoachingApi = {
      installArtifact,
      loadTips: vi.fn(() =>
        loaded([
          makeTip({
            actions: [{ ...applyAction(), kind: "create-new-file" as const }],
          }),
        ])
      ),
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText("Move repeated shell probes into a reusable skill");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply skill" }));
    await screen.findByText("Drafted artifact");
    fireEvent.click(
      await screen.findByRole("button", { name: "Install (Apply skill)" })
    );

    await waitFor(() => expect(installArtifact).toHaveBeenCalledTimes(1));
    // draft, harness(undefined), kind
    expect(installArtifact).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      "create-new-file"
    );
  });

  it("defaults an absent action kind to create-new-file on Apply", async () => {
    const installArtifact = vi.fn(() => Promise.resolve("Installed."));
    const api: AgentCoachingApi = {
      installArtifact,
      loadTips: vi.fn(() => loaded([makeTip({ actions: [applyAction()] })])),
      recordFeedback: vi.fn(() => Promise.resolve()),
    };

    render(<AgentCoachingTips api={api} />);
    await screen.findByText("Move repeated shell probes into a reusable skill");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply skill" }));
    await screen.findByText("Drafted artifact");
    fireEvent.click(
      await screen.findByRole("button", { name: "Install (Apply skill)" })
    );

    await waitFor(() => expect(installArtifact).toHaveBeenCalledTimes(1));
    expect(installArtifact).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      "create-new-file"
    );
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

    fireEvent.click(screen.getByRole("button", { name: "Get more tips" }));

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

    fireEvent.click(screen.getByRole("button", { name: "Get more tips" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Get more tips" }));

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
    resolveSecond({
      activePack: null,
      groundedMetrics: null,
      tips: [makeTip()],
    });

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
    expect(screen.getByRole("button", { name: "Get more tips" })).toBeTruthy();
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

    fireEvent.click(screen.getByRole("button", { name: "Get more tips" }));

    await screen.findByText(NO_NEW_TIPS_PATTERN);
    expect(loadTips).toHaveBeenCalledTimes(2);
  });

  it("defers generation on an empty corpus and reloads once local activity lands", async () => {
    const unsubscribe = vi.fn();
    const subscribeToActivity = vi.fn((_cb: () => void) => unsubscribe);
    // Startup backfill race: the first read sees an empty corpus, the second
    // (after the DB-change push) sees the landed sessions and yields a tip.
    const loadTips = vi
      .fn()
      .mockResolvedValueOnce(await loaded([]))
      .mockResolvedValueOnce(await loaded([makeTip()]));
    const api: AgentCoachingApi = {
      loadTips,
      recordFeedback: vi.fn(() => Promise.resolve()),
      subscribeToActivity,
    };

    render(<AgentCoachingTips api={api} />);

    // First pass: nothing to show yet, and exactly ONE read — no wasted spawn.
    await screen.findByText(NO_TIPS_PATTERN);
    expect(loadTips).toHaveBeenCalledTimes(1);
    expect(subscribeToActivity).toHaveBeenCalledTimes(1);

    // The backfill lands → DB-change push → debounced re-load surfaces the tip.
    subscribeToActivity.mock.calls[0][0]();
    await screen.findByText("Move repeated shell probes into a reusable skill");
    expect(loadTips).toHaveBeenCalledTimes(2);
    // Grounded now — stop watching so later writes don't regenerate.
    await waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
  });

  it("stops waiting when the first load already reflects real activity", async () => {
    const unsubscribe = vi.fn();
    const subscribeToActivity = vi.fn((_cb: () => void) => unsubscribe);
    // Activity present but the harness returned no tips: we must still stop
    // waiting (the corpus is populated), driven by the grounded metrics.
    const loadTips = vi.fn(() =>
      loaded(
        [],
        null,
        makeGroundedMetrics({
          sessionsAnalyzed: 2,
          eventsAnalyzed: 40,
          totalInputTokens: 20_000,
          totalOutputTokens: 5000,
          totalTokens: 25_000,
        })
      )
    );
    const api: AgentCoachingApi = {
      loadTips,
      recordFeedback: vi.fn(() => Promise.resolve()),
      subscribeToActivity,
    };

    render(<AgentCoachingTips api={api} />);

    await screen.findByText(NO_TIPS_PATTERN);
    await waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));

    // A later DB change must not trigger another load — we already kicked off.
    subscribeToActivity.mock.calls[0][0]();
    expect(loadTips).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes from activity on unmount", async () => {
    const unsubscribe = vi.fn();
    const api: AgentCoachingApi = {
      loadTips: vi.fn(() => loaded([])),
      recordFeedback: vi.fn(() => Promise.resolve()),
      subscribeToActivity: vi.fn(() => unsubscribe),
    };

    const { unmount } = render(<AgentCoachingTips api={api} />);
    await screen.findByText(NO_TIPS_PATTERN);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  // FEA-3698: an activity push that lands WHILE the initial load is in flight
  // must not be dropped. The store records that the corpus went dirty and
  // schedules exactly ONE reconciliation after the in-flight load settles.
  it("reconciles activity that lands during the initial in-flight load", async () => {
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

    // The first load is in flight. A DB-activity push arrives now — it must be
    // remembered, not dropped (the old early-return lost it entirely).
    await waitFor(() => expect(loadTips).toHaveBeenCalledTimes(1));
    subscribeToActivity.mock.calls[0][0]();

    // The initial load settles empty; the recorded dirty flag then drives one
    // follow-up load, which surfaces the now-populated corpus.
    firstLoad.resolve([]);
    await screen.findByText("Move repeated shell probes into a reusable skill");
    expect(loadTips).toHaveBeenCalledTimes(2);
  });

  // FEA-3698: multiple pushes during a single in-flight load coalesce — the
  // burst collapses to ONE follow-up, not one reload per push.
  it("coalesces a burst of in-flight pushes into a single follow-up load", async () => {
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
    await waitFor(() => expect(loadTips).toHaveBeenCalledTimes(1));

    // Three pushes while the first load is in flight.
    const push = subscribeToActivity.mock.calls[0][0];
    push();
    push();
    push();

    firstLoad.resolve([]);
    await screen.findByText("Move repeated shell probes into a reusable skill");
    // Initial load + exactly one coalesced follow-up — not one per push.
    expect(loadTips).toHaveBeenCalledTimes(2);
  });

  // FEA-3698: a failed load must retain a retry path — the store stays
  // subscribed so a later push re-attempts, and the panel reveals (first-settle)
  // rather than hanging on the loading spinner.
  it("surfaces a failed initial load and retries on the next activity push", async () => {
    const subscribeToActivity = vi.fn((_cb: () => void) => vi.fn());
    const loadTips = vi
      .fn()
      .mockRejectedValueOnce(new Error("db offline"))
      .mockReturnValueOnce(loaded([makeTip()]));
    const api: AgentCoachingApi = {
      loadTips,
      recordFeedback: vi.fn(() => Promise.resolve()),
      subscribeToActivity,
    };

    render(<AgentCoachingTips api={api} />);

    // The first load rejected; the panel still reveals (empty), and the store is
    // still subscribed so a retry path remains.
    await screen.findByText(NO_TIPS_PATTERN);
    await waitFor(() => expect(loadTips).toHaveBeenCalledTimes(1));

    // A later push retries the load and surfaces the tip.
    subscribeToActivity.mock.calls[0][0]();
    await screen.findByText("Move repeated shell probes into a reusable skill");
    expect(loadTips).toHaveBeenCalledTimes(2);
  });

  // FEA-3698: disposal must clear pending follow-up work — a dirty flag set
  // during an in-flight load, plus its debounced reload, must not fire after the
  // component unmounts.
  it("clears the pending in-flight follow-up on unmount", async () => {
    const unsubscribe = vi.fn();
    const subscribeToActivity = vi.fn((_cb: () => void) => unsubscribe);
    const firstLoad = deferredLoad([]);
    const loadTips = vi
      .fn()
      .mockReturnValueOnce(firstLoad.promise)
      .mockReturnValue(loaded([makeTip()]));
    const api: AgentCoachingApi = {
      loadTips,
      recordFeedback: vi.fn(() => Promise.resolve()),
      subscribeToActivity,
    };

    const { unmount } = render(<AgentCoachingTips api={api} />);
    await waitFor(() => expect(loadTips).toHaveBeenCalledTimes(1));

    // Mark the corpus dirty mid-flight, then dispose before the load settles.
    subscribeToActivity.mock.calls[0][0]();
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    // Even after the in-flight load resolves, no follow-up load fires — disposal
    // dropped the pending dirty work.
    firstLoad.resolve([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(loadTips).toHaveBeenCalledTimes(1);
  });

  // FEA-3698: a remount starts a fresh kickoff without leaking the prior one —
  // the old subscription is torn down and the new instance subscribes exactly
  // once.
  it("tears down and re-subscribes cleanly on remount", async () => {
    const firstUnsub = vi.fn();
    const secondUnsub = vi.fn();
    const subscribeToActivity = vi
      .fn()
      .mockReturnValueOnce(firstUnsub)
      .mockReturnValueOnce(secondUnsub);
    const api: AgentCoachingApi = {
      loadTips: vi.fn(() => loaded([])),
      recordFeedback: vi.fn(() => Promise.resolve()),
      subscribeToActivity,
    };

    const { unmount } = render(<AgentCoachingTips api={api} />);
    await screen.findByText(NO_TIPS_PATTERN);
    unmount();
    expect(firstUnsub).toHaveBeenCalledTimes(1);

    render(<AgentCoachingTips api={api} />);
    await screen.findByText(NO_TIPS_PATTERN);
    // A fresh, single subscription for the remounted instance.
    expect(subscribeToActivity).toHaveBeenCalledTimes(2);
    expect(secondUnsub).not.toHaveBeenCalled();
  });
});

/**
 * A `loadTips` resolution: the day's tips plus the pack that powered them.
 * `groundedMetrics` defaults to null so the Coding Wrapped deck renders nothing
 * in these tip-focused tests (the deck has its own coverage).
 */
function loaded(
  tips: AgentCoachingTip[],
  activePack: CoachingPackInfo | null = null,
  groundedMetrics: AgentCoachingGroundedMetrics | null = null
) {
  return Promise.resolve({ activePack, groundedMetrics, tips });
}

/**
 * A `loadTips` resolution the test controls by hand, so an activity push can be
 * injected while the load is provably still in flight (the FEA-3698 race).
 */
function deferredLoad(initialTips: AgentCoachingTip[]) {
  let resolveInner!: (value: Awaited<ReturnType<typeof loaded>>) => void;
  const promise = new Promise<Awaited<ReturnType<typeof loaded>>>((resolve) => {
    resolveInner = resolve;
  });
  return {
    promise,
    resolve: (tips: AgentCoachingTip[] = initialTips) =>
      resolveInner({ activePack: null, groundedMetrics: null, tips }),
  };
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
