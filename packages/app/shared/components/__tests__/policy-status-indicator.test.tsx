import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import type { Tone } from "@repo/design-system/components/ui/types";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  POLICY_STATUS,
  type PolicyStatus,
  PolicyStatusIndicator,
} from "../policy-status-indicator";

/**
 * ISS-12526. Labels here are test fixtures, not product copy: the component
 * takes every string from its host.
 */
const FIXTURE_LABELS: Record<PolicyStatus, string> = {
  [POLICY_STATUS.ACTIVE]: "fixture-active",
  [POLICY_STATUS.PENDING]: "fixture-pending",
  [POLICY_STATUS.FAILED]: "fixture-failed",
  [POLICY_STATUS.UNAVAILABLE]: "fixture-unavailable",
};

const EXPECTED_TONE: Record<PolicyStatus, Tone> = {
  [POLICY_STATUS.ACTIVE]: "success",
  [POLICY_STATUS.PENDING]: "info",
  [POLICY_STATUS.FAILED]: "danger",
  [POLICY_STATUS.UNAVAILABLE]: "muted",
};

function renderState(status: PolicyStatus, onRetry = vi.fn()) {
  const label = FIXTURE_LABELS[status];
  return status === POLICY_STATUS.FAILED
    ? render(
        <PolicyStatusIndicator
          label={label}
          onRetry={onRetry}
          retryLabel="fixture-retry"
          status={status}
        />
      )
    : render(<PolicyStatusIndicator label={label} status={status} />);
}

/** The class list the shared ToneBadge renders for a tone, as the oracle. */
function toneBadgeClassName(tone: Tone): string {
  const { container, unmount } = render(
    <ToneBadge label="oracle" tone={tone} />
  );
  const className = (container.firstElementChild as HTMLElement).className;
  unmount();
  return className;
}

const ALL_STATES = Object.values(POLICY_STATUS);

describe("PolicyStatusIndicator", () => {
  it("AC-001: renders all four states through the shared status badge", () => {
    expect(ALL_STATES).toHaveLength(4);
    for (const status of ALL_STATES) {
      const expectedClassName = toneBadgeClassName(EXPECTED_TONE[status]);
      const { unmount } = renderState(status);
      const indicator = screen.getByTestId("policy-status-indicator");
      expect(indicator).toHaveAttribute("data-state", status);
      const badge = screen.getByRole("status");
      // The pill IS the shared ToneBadge: the design-system Badge slot, with
      // exactly the classes ToneBadge renders for this state's tone.
      expect(badge).toHaveAttribute("data-slot", "badge");
      expect(badge.className).toBe(expectedClassName);
      unmount();
    }
  });

  it("pulses the badge's state dot on pending only", () => {
    for (const status of ALL_STATES) {
      const { unmount } = renderState(status);
      // The pulse lives on the dot, not the pill, so the class oracle above
      // cannot see it: assert the dot itself.
      const dot = screen
        .getByRole("status")
        .querySelector('[aria-hidden="true"]');
      expect(dot).not.toBeNull();
      expect(dot?.classList.contains("animate-status-pulse")).toBe(
        status === POLICY_STATUS.PENDING
      );
      unmount();
    }
  });

  it("AC-002: every state is named in text, never by color alone", () => {
    for (const status of ALL_STATES) {
      const label = FIXTURE_LABELS[status];
      const { unmount } = renderState(status);
      // Accessible name and visible text both carry the state.
      const badge = screen.getByRole("status", { name: label });
      expect(badge).toHaveTextContent(label);
      unmount();
    }
  });

  it("AC-002: the supporting detail describes the status, it does not replace it", () => {
    render(
      <PolicyStatusIndicator
        detail="fixture-detail"
        label="fixture-unavailable"
        status={POLICY_STATUS.UNAVAILABLE}
      />
    );
    const badge = screen.getByRole("status", { name: "fixture-unavailable" });
    expect(badge).toHaveAccessibleDescription("fixture-detail");
  });

  it("AC-003: the failed state exposes a retry path that fires its callback", () => {
    const onRetry = vi.fn();
    renderState(POLICY_STATUS.FAILED, onRetry);
    fireEvent.click(screen.getByRole("button", { name: "fixture-retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("offers retry only on the failed state", () => {
    for (const status of ALL_STATES) {
      const { unmount } = renderState(status);
      expect(screen.queryAllByRole("button")).toHaveLength(
        status === POLICY_STATUS.FAILED ? 1 : 0
      );
      unmount();
    }
  });
});
