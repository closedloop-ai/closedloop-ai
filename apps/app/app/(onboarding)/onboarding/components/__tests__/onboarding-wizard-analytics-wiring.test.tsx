// @vitest-environment jsdom

/**
 * PRD-736 (ISS-10500) — the WIZARD's production wiring: creating the team
 * captures its checklist-item completion. Without a mounted provider the
 * capture hook no-ops, so only this suite reddens if that call site is
 * deleted. (The CREATE_PROJECT capture rides the same hook one handler down;
 * its wiring is exercised structurally, not pinned here.)
 */

import { ChecklistItemId } from "@repo/api/src/types/onboarding";
import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import {
  Surface,
  type SurfaceAnalyticsCapture,
} from "@repo/api/src/types/surface-analytics";
import { SurfaceAnalyticsProvider } from "@repo/app/shared/observability/surface-analytics-context";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  completeWizard: vi.fn(),
  createTeam: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: mocks.navigate, replace: vi.fn() }),
}));
vi.mock("@repo/app/onboarding/hooks/use-onboarding", () => ({
  useCompleteWizard: () => ({
    isPending: false,
    mutate: mocks.completeWizard,
  }),
}));
vi.mock("@repo/app/teams/hooks/use-teams", () => ({
  useCreateTeam: () => ({ isPending: false, mutate: mocks.createTeam }),
}));
vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useCreateProject: () => ({ isPending: false, mutate: vi.fn() }),
}));

import { OnboardingWizard } from "../onboarding-wizard";

const capture = vi.fn<SurfaceAnalyticsCapture>();

const TEAM_NAME_LABEL = /team name/i;
const CREATE_TEAM_BUTTON = /create team/i;

function resolveMutation(mutate: ReturnType<typeof vi.fn>, result: unknown) {
  const [, options] = mutate.mock.calls.at(-1) ?? [];
  act(() => {
    (options as { onSuccess: (value: unknown) => void }).onSuccess(result);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe("OnboardingWizard analytics wiring", () => {
  it("captures the CREATE_TEAM checklist completion when the team is created", () => {
    render(
      <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
        <OnboardingWizard />
      </SurfaceAnalyticsProvider>
    );

    fireEvent.change(screen.getByLabelText(TEAM_NAME_LABEL), {
      target: { value: "Engineering" },
    });
    fireEvent.click(screen.getByRole("button", { name: CREATE_TEAM_BUTTON }));
    resolveMutation(mocks.createTeam, { id: "team-1", name: "Engineering" });

    expect(capture).toHaveBeenCalledWith(
      OnboardingAnalyticsEvent.ChecklistItemCompleted,
      expect.objectContaining({
        [OnboardingAnalyticsProperty.ItemId]: ChecklistItemId.CreateTeam,
      })
    );
  });
});
