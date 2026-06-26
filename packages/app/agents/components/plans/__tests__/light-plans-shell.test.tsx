import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import {
  createLightPlanFixture,
  populatedLightPlanFixtures,
  populatedLightPlanVersionFixtures,
} from "../light-plan-fixtures";
import {
  LightPlanConfirmationState,
  LightPlansShell,
  type LightPlansShellProps,
  resolveLightPlanConfirmationState,
} from "../light-plans-shell";

const noop = () => undefined;
const openButtonNamePattern = /Open/i;

describe("LightPlansShell", () => {
  it("renders loading and empty states", () => {
    const { rerender } = renderShell({ isLoading: true });

    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();

    rerender(withProviders(<LightPlansShell {...shellProps()} />));
    expect(screen.getByText("No plans captured yet")).toBeInTheDocument();
  });

  it("renders list-level and scoped version error states separately", () => {
    const { rerender } = renderShell({ isError: true });

    expect(
      screen.getByText("Plans are temporarily unavailable.")
    ).toBeInTheDocument();

    rerender(
      withProviders(
        <LightPlansShell
          {...shellProps({
            isVersionsError: true,
            plans: populatedLightPlanFixtures,
            selectedPlan: populatedLightPlanFixtures[0] ?? null,
            selectedPlanId: "plan-1",
            showVersions: true,
          })}
        />
      )
    );

    expect(screen.getAllByText("Shared telemetry plan").length).toBeGreaterThan(
      0
    );
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Version history is temporarily unavailable for this plan."
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Plans are temporarily unavailable.")
    ).not.toBeInTheDocument();
  });

  it("uses confirmation state for action visibility and stale status precedence", () => {
    expect(resolveLightPlanConfirmationState("confirmed", true)).toBe(
      LightPlanConfirmationState.Confirmed
    );
    expect(resolveLightPlanConfirmationState("rejected", true)).toBe(
      LightPlanConfirmationState.Rejected
    );
    expect(resolveLightPlanConfirmationState("pending", true)).toBe(
      LightPlanConfirmationState.NeedsConfirmation
    );

    const confirmedWithStaleFlag = createLightPlanFixture({
      confirmationState: LightPlanConfirmationState.Confirmed,
      sourceStatus: "confirmed",
      statusLabel: "confirmed",
    });

    renderShell({
      plans: [confirmedWithStaleFlag],
      selectedPlan: confirmedWithStaleFlag,
      selectedPlanId: confirmedWithStaleFlag.id,
    });

    expect(
      screen.queryByRole("button", { name: "Confirm" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reject" })
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("confirmed").length).toBeGreaterThan(0);
  });

  it("invokes injected callbacks and keeps unsupported controls hidden", () => {
    const onSelectPlan = vi.fn();
    const onConfirmPlan = vi.fn();
    const onRejectPlan = vi.fn();
    const onToggleVersions = vi.fn();
    renderShell({
      onConfirmPlan,
      onRejectPlan,
      onSelectPlan,
      onToggleVersions,
      plans: populatedLightPlanFixtures,
      projectControls: <button type="button">Project filter</button>,
      selectedPlan: populatedLightPlanFixtures[0] ?? null,
      selectedPlanId: "plan-1",
      surfaceCapabilities: { projectControls: false, teamControls: false },
      teamControls: <button type="button">Team filter</button>,
    });

    fireEvent.click(screen.getAllByText("Shared telemetry plan")[0]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.click(screen.getByRole("button", { name: "Show Versions (2)" }));

    expect(onSelectPlan).toHaveBeenCalledWith("plan-1");
    expect(onConfirmPlan).toHaveBeenCalledWith("plan-1");
    expect(onRejectPlan).toHaveBeenCalledWith("plan-1");
    expect(onToggleVersions).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Project filter")).not.toBeInTheDocument();
    expect(screen.queryByText("Team filter")).not.toBeInTheDocument();
  });

  it("renders actionable disabled and pending action states", () => {
    const onConfirmPlan = vi.fn();
    const onRejectPlan = vi.fn();
    const actionablePlan = createLightPlanFixture({
      id: "plan-disabled",
      confirmationState: LightPlanConfirmationState.NeedsConfirmation,
      sourceStatus: "pending",
      statusLabel: "Needs confirmation",
    });
    const baseProps = {
      onConfirmPlan,
      onRejectPlan,
      plans: [actionablePlan],
      selectedPlan: actionablePlan,
      selectedPlanId: actionablePlan.id,
    } satisfies Partial<LightPlansShellProps>;
    const { rerender } = renderShell({
      ...baseProps,
      disabledActionPlanIds: [actionablePlan.id],
    });

    const disabledConfirm = screen.getByRole("button", { name: "Confirm" });
    const disabledReject = screen.getByRole("button", { name: "Reject" });
    expect(disabledConfirm).toBeDisabled();
    expect(disabledReject).toBeDisabled();
    fireEvent.click(disabledConfirm);
    fireEvent.click(disabledReject);
    expect(onConfirmPlan).not.toHaveBeenCalled();
    expect(onRejectPlan).not.toHaveBeenCalled();

    rerender(
      withProviders(
        <LightPlansShell
          {...shellProps({
            ...baseProps,
            pendingAction: { planId: actionablePlan.id, action: "confirm" },
          })}
        />
      )
    );

    expect(screen.getByRole("button", { name: "Confirming" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });

  it("renders caller-owned action errors near the plan actions", () => {
    const actionablePlan = createLightPlanFixture({
      id: "plan-action-error",
      confirmationState: LightPlanConfirmationState.NeedsConfirmation,
      sourceStatus: "pending",
      statusLabel: "Needs confirmation",
    });

    renderShell({
      actionError: {
        planId: actionablePlan.id,
        action: "confirm",
        message: "Plan confirmation failed. Try again.",
      },
      plans: [actionablePlan],
      selectedPlan: actionablePlan,
      selectedPlanId: actionablePlan.id,
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Plan confirmation failed. Try again."
    );
  });

  it("keeps the content grid collapsible for narrow viewports", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    window.dispatchEvent(new Event("resize"));

    renderShell({
      plans: populatedLightPlanFixtures,
      selectedPlan: populatedLightPlanFixtures[0] ?? null,
      selectedPlanId: "plan-1",
    });

    expect(screen.getByTestId("light-plans-content-grid")).toHaveAttribute(
      "style",
      "grid-template-columns: repeat(auto-fit, minmax(min(100%, 28rem), 1fr));"
    );
    expect(screen.getByRole("button", { name: "Confirm" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Reject" })).toBeVisible();
  });

  it("renders versions, invalid dates, empty content, and captured paths as labels only", () => {
    const selectedPlan = createLightPlanFixture({
      createdAt: "not-a-date",
      latestContent: "<script>alert('x')</script>\n# not markdown",
      updatedAt: null,
    });

    renderShell({
      plans: [selectedPlan],
      selectedPlan,
      selectedPlanId: selectedPlan.id,
      showVersions: true,
      versions: populatedLightPlanVersionFixtures,
    });

    expect(
      screen.getByText("<script>alert('x')</script>", { exact: false })
    ).toBeInTheDocument();
    expect(
      screen.getByText("File: runs/session/plans/plan.md")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Source log: runs/session/transcript.jsonl")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: openButtonNamePattern })
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("No content captured for this version.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Invalid Date")).not.toBeInTheDocument();
  });
});

function renderShell(overrides: Partial<LightPlansShellProps>) {
  return render(withProviders(<LightPlansShell {...shellProps(overrides)} />));
}

function shellProps(
  overrides: Partial<LightPlansShellProps> = {}
): LightPlansShellProps {
  return {
    onConfirmPlan: noop,
    onRejectPlan: noop,
    onSelectPlan: noop,
    onToggleVersions: noop,
    plans: [],
    selectedPlan: null,
    selectedPlanId: null,
    ...overrides,
  };
}

function withProviders(ui: React.ReactElement) {
  return <AppCoreStoryProviders>{ui}</AppCoreStoryProviders>;
}
