// @vitest-environment jsdom

/**
 * PRD-736 (ISS-10500) — the CARD's production wiring: a checklist item that
 * flips to complete while `OnboardingChecklist` is mounted reaches the
 * surface-analytics port. The hook's own suite cannot prove this — without a
 * provider the hook no-ops, so deleting the wiring line would leave every
 * other checklist test green.
 */

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
import { SurfaceAnalyticsProvider } from "@repo/app/shared/observability/surface-analytics-context";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: null as unknown,
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: () => ({ enabled: false }),
}));
vi.mock("@repo/app/onboarding/hooks/use-onboarding", () => ({
  useOnboardingStatus: () => ({ data: mocks.status }),
  useDismissChecklist: () => ({ mutate: vi.fn() }),
}));
vi.mock("@repo/app/onboarding/hooks/use-detected-desktop-os", () => ({
  useDetectedDesktopOs: () => null,
}));
vi.mock("@repo/navigation/link", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import { OnboardingChecklist } from "../onboarding-checklist";

const capture = vi.fn<SurfaceAnalyticsCapture>();

function item(
  id: ChecklistItemId,
  completed: boolean
): OnboardingChecklistItem {
  return { completed, description: "", id, label: id };
}

function statusWith(items: OnboardingChecklistItem[]) {
  return { checklist: items, checklistDismissed: false, wizardCompleted: true };
}

function mount() {
  return render(
    <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
      <OnboardingChecklist />
    </SurfaceAnalyticsProvider>,
    { wrapper: WebFeatureFlagProvider }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("OnboardingChecklist analytics wiring", () => {
  it("captures an item flip observed by the mounted card", () => {
    mocks.status = statusWith([
      item(ChecklistItemId.CreateTeam, true),
      item(ChecklistItemId.ConnectGitHub, false),
    ]);
    const view = mount();
    expect(capture).not.toHaveBeenCalled();

    mocks.status = statusWith([
      item(ChecklistItemId.CreateTeam, true),
      item(ChecklistItemId.ConnectGitHub, true),
    ]);
    view.rerender(
      <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
        <OnboardingChecklist />
      </SurfaceAnalyticsProvider>
    );

    expect(capture).toHaveBeenCalledWith(
      OnboardingAnalyticsEvent.ChecklistItemCompleted,
      expect.objectContaining({
        [OnboardingAnalyticsProperty.ItemId]: ChecklistItemId.ConnectGitHub,
      })
    );
  });
});
