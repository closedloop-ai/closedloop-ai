import {
  ChecklistItemId,
  type OnboardingChecklistItem,
} from "@repo/api/src/types/onboarding";
import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import {
  Surface,
  type SurfaceAnalyticsCapture,
} from "@repo/api/src/types/surface-analytics";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SurfaceAnalyticsProvider } from "../../../shared/observability/surface-analytics-context";
import { useOnboardingChecklistCompletionEvents } from "../use-onboarding-checklist-analytics";

const capture = vi.fn<SurfaceAnalyticsCapture>();

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
      {children}
    </SurfaceAnalyticsProvider>
  );
}

function item(
  id: ChecklistItemId,
  completed: boolean
): OnboardingChecklistItem {
  return { completed, description: "", id, label: id };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useOnboardingChecklistCompletionEvents", () => {
  it("emits for an item that flips to complete while mounted, and checklist_completed on the last flip", () => {
    const { rerender } = renderHook(
      ({ items }: { items: OnboardingChecklistItem[] }) =>
        useOnboardingChecklistCompletionEvents(items),
      {
        initialProps: {
          items: [
            item(ChecklistItemId.CreateTeam, true),
            item(ChecklistItemId.ConnectGitHub, false),
          ],
        },
        wrapper,
      }
    );
    expect(capture).not.toHaveBeenCalled();

    rerender({
      items: [
        item(ChecklistItemId.CreateTeam, true),
        item(ChecklistItemId.ConnectGitHub, true),
      ],
    });

    expect(capture.mock.calls).toEqual([
      [
        OnboardingAnalyticsEvent.ChecklistItemCompleted,
        {
          [OnboardingAnalyticsProperty.ItemId]: ChecklistItemId.ConnectGitHub,
          surface: Surface.Web,
        },
      ],
      [
        OnboardingAnalyticsEvent.ChecklistCompleted,
        {
          [OnboardingAnalyticsProperty.ItemsCompletedCount]: 2,
          surface: Surface.Web,
        },
      ],
    ]);
  });

  it("emits nothing for a checklist that mounts already complete", () => {
    const items = [
      item(ChecklistItemId.CreateTeam, true),
      item(ChecklistItemId.CreateProject, true),
    ];
    const { rerender } = renderHook(
      ({ items: current }: { items: OnboardingChecklistItem[] }) =>
        useOnboardingChecklistCompletionEvents(current),
      { initialProps: { items }, wrapper }
    );
    rerender({ items });

    expect(capture).not.toHaveBeenCalled();
  });

  // `items` MEMBERSHIP changes at runtime (the checklist filters ConnectGoogle
  // on an async feature-flag read). The incomplete member simply leaving the
  // list is not a completion anybody performed, so the collapse to a smaller
  // all-complete set must emit nothing.
  it("emits nothing when the only incomplete item leaves the list without flipping", () => {
    const { rerender } = renderHook(
      ({ items: current }: { items: OnboardingChecklistItem[] }) =>
        useOnboardingChecklistCompletionEvents(current),
      {
        initialProps: {
          items: [
            item(ChecklistItemId.CreateTeam, true),
            item(ChecklistItemId.CreateProject, true),
            item(ChecklistItemId.ConnectGitHub, false),
          ],
        },
        wrapper,
      }
    );

    rerender({
      items: [
        item(ChecklistItemId.CreateTeam, true),
        item(ChecklistItemId.CreateProject, true),
      ],
    });

    expect(capture).not.toHaveBeenCalled();
  });
});
