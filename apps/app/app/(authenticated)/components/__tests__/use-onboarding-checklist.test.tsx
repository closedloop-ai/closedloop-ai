/**
 * ISS-7089 F4: the checklist card shows its completed state and is removed
 * only by the dismiss control — it must not delete itself the instant the last
 * row ticks, disappearing mid-session under the user.
 */
import {
  ChecklistItemId,
  type OnboardingChecklistItem,
} from "@repo/api/src/types/onboarding";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import { useOnboardingChecklist } from "../use-onboarding-checklist";

const mocks = vi.hoisted(() => ({
  status: undefined as unknown,
  googleDriveEnabled: false,
}));

vi.mock("@repo/app/onboarding/hooks/use-onboarding", () => ({
  useOnboardingStatus: () => ({ data: mocks.status }),
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: () => ({ enabled: mocks.googleDriveEnabled }),
}));

function checklistRow(
  id: ChecklistItemId,
  completed: boolean
): OnboardingChecklistItem {
  return { completed, description: "", id, label: String(id) };
}

function fullStatus(overrides: {
  checklistDismissed?: boolean;
  completed?: boolean;
  wizardCompleted?: boolean;
}) {
  const completed = overrides.completed ?? true;
  return {
    checklist: [
      checklistRow(ChecklistItemId.CreateTeam, completed),
      checklistRow(ChecklistItemId.InviteMembers, completed),
    ],
    checklistDismissed: overrides.checklistDismissed ?? false,
    wizardCompleted: overrides.wizardCompleted ?? true,
  };
}

describe("useOnboardingChecklist visibility", () => {
  beforeEach(() => {
    mocks.status = undefined;
    mocks.googleDriveEnabled = false;
  });

  it("stays visible at full completion, showing the completed state", () => {
    mocks.status = fullStatus({ completed: true });

    const { result } = renderHook(() => useOnboardingChecklist(), {
      wrapper: WebFeatureFlagProvider,
    });

    expect(result.current.visible).toBe(true);
    expect(result.current.completedCount).toBe(result.current.totalCount);
  });

  it("is removed only by dismissal", () => {
    mocks.status = fullStatus({ checklistDismissed: true, completed: true });

    const { result } = renderHook(() => useOnboardingChecklist(), {
      wrapper: WebFeatureFlagProvider,
    });

    expect(result.current.visible).toBe(false);
  });

  it("stays hidden before the wizard completes", () => {
    mocks.status = fullStatus({ wizardCompleted: false });

    const { result } = renderHook(() => useOnboardingChecklist(), {
      wrapper: WebFeatureFlagProvider,
    });

    expect(result.current.visible).toBe(false);
  });
});

/**
 * ISS-7089 F5 / ISS-5490 FR-6: five rows, and six wherever the `google-drive`
 * flag is on (PRD-795 removed the Anthropic key row). The server emits all six
 * (pinned in the API's
 * checklist-derivation test); this filter is what decides the count the reader
 * sees, so both counts are pinned here. Built from every declared
 * `ChecklistItemId` so adding a row fails these numbers instead of quietly
 * changing what FR-6 promises.
 */
describe("useOnboardingChecklist row count", () => {
  beforeEach(() => {
    mocks.googleDriveEnabled = false;
    mocks.status = {
      checklist: Object.values(ChecklistItemId).map((id) =>
        checklistRow(id, FRESH_WORKSPACE_COMPLETED.has(id))
      ),
      checklistDismissed: false,
      wizardCompleted: true,
    };
  });

  it("reads 2 of 5 for a fresh workspace with the flag off", () => {
    const { result } = renderHook(() => useOnboardingChecklist(), {
      wrapper: WebFeatureFlagProvider,
    });

    expect(result.current.totalCount).toBe(5);
    expect(result.current.completedCount).toBe(2);
    expect(
      result.current.items.some(
        (item) => item.id === ChecklistItemId.ConnectGoogle
      )
    ).toBe(false);
  });

  it("reads 2 of 6 for a fresh workspace with the flag on", () => {
    mocks.googleDriveEnabled = true;

    const { result } = renderHook(() => useOnboardingChecklist(), {
      wrapper: WebFeatureFlagProvider,
    });

    expect(result.current.totalCount).toBe(6);
    expect(result.current.completedCount).toBe(2);
    expect(
      result.current.items.some(
        (item) => item.id === ChecklistItemId.ConnectGoogle
      )
    ).toBe(true);
  });
});

const FRESH_WORKSPACE_COMPLETED = new Set<ChecklistItemId>([
  ChecklistItemId.CreateTeam,
  ChecklistItemId.CreateProject,
]);
