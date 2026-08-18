// @vitest-environment jsdom

import { OnboardingStep } from "@repo/api/src/types/onboarding";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTeam: vi.fn(),
  createProject: vi.fn(),
  completeWizard: vi.fn(),
  completeWizardPending: false,
  navigate: vi.fn(),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: mocks.navigate, replace: vi.fn() }),
}));
vi.mock("@repo/app/onboarding/hooks/use-onboarding", () => ({
  useCompleteWizard: () => ({
    mutate: mocks.completeWizard,
    isPending: mocks.completeWizardPending,
  }),
}));
vi.mock("@repo/app/teams/hooks/use-teams", () => ({
  useCreateTeam: () => ({ mutate: mocks.createTeam, isPending: false }),
}));
vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useCreateProject: () => ({ mutate: mocks.createProject, isPending: false }),
}));

import { OnboardingWizard } from "../onboarding-wizard";

const WIZARD_STATE_KEY = "onboarding_wizard_state";
const TEAM_HEADING = "Create your team";
const PROJECT_HEADING = "Create your first project";
const POST_WIZARD_ROUTE = "/my-tasks?from=onboarding";
const TEAM_NAME_LABEL = /team name/i;
const PROJECT_NAME_LABEL = /project name/i;
const CREATE_TEAM_BUTTON = /create team/i;
const CREATE_PROJECT_BUTTON = /create project/i;
const CONTINUE_BUTTON = /continue/i;

function seedWizardState(state: Record<string, unknown>) {
  sessionStorage.setItem(WIZARD_STATE_KEY, JSON.stringify(state));
}

/**
 * Resolve the mutation the surface just fired. The hooks are mocked, so the
 * success callback has to be invoked by hand — inside `act`, because it is what
 * advances the wizard's state and an un-acted update never flushes.
 */
function resolveMutation(mutate: ReturnType<typeof vi.fn>, result: unknown) {
  const [, options] = mutate.mock.calls.at(-1) ?? [];
  act(() => {
    (options as { onSuccess: (value: unknown) => void }).onSuccess(result);
  });
}

/** Drive the team step to completion, which is how the project step mounts. */
function completeTeamStep() {
  fireEvent.change(screen.getByLabelText(TEAM_NAME_LABEL), {
    target: { value: "Engineering" },
  });
  fireEvent.click(screen.getByRole("button", { name: CREATE_TEAM_BUTTON }));
  resolveMutation(mocks.createTeam, { id: "team-1", name: "Engineering" });
}

describe("OnboardingWizard — ISS-5490 trim", () => {
  beforeEach(() => {
    mocks.createTeam.mockReset();
    mocks.createProject.mockReset();
    mocks.completeWizard.mockReset();
    mocks.completeWizardPending = false;
    mocks.navigate.mockReset();
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it("opens on the team step and shows a two-step indicator", () => {
    render(<OnboardingWizard />);

    expect(screen.getByText(TEAM_HEADING)).toBeTruthy();
    expect(screen.getByText("Step 1 of 2")).toBeTruthy();
  });

  it("completes the wizard and leaves for My Tasks once the project lands", () => {
    render(<OnboardingWizard />);
    completeTeamStep();

    expect(screen.getByText(PROJECT_HEADING)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(PROJECT_NAME_LABEL), {
      target: { value: "Web app" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: CREATE_PROJECT_BUTTON })
    );
    resolveMutation(mocks.createProject, { id: "project-1", name: "Web app" });

    // Creating the project is the last thing the sequence asks for, so nothing
    // downstream is left to mark the wizard finished.
    expect(mocks.completeWizard).toHaveBeenCalledTimes(1);
    expect(mocks.completeWizard.mock.calls[0][0]).toEqual({
      createdTeamId: "team-1",
      createdProjectId: "project-1",
    });

    resolveMutation(mocks.completeWizard, undefined);
    expect(mocks.navigate).toHaveBeenCalledWith(POST_WIZARD_ROUTE);
    expect(sessionStorage.getItem(WIZARD_STATE_KEY)).toBeNull();
  });

  it("clamps a restored step that the sequence no longer contains", () => {
    // A tab open across the deploy restores a step the trim removed.
    seedWizardState({
      currentStep: OnboardingStep.ConnectOptionalIntegrations,
      createdTeamId: null,
      createdTeamName: null,
      createdProjectId: null,
      createdProjectName: null,
    });

    render(<OnboardingWizard />);

    // Not a blank card: the user lands on the sequence's first step instead.
    expect(screen.getByText(TEAM_HEADING)).toBeTruthy();
    expect(screen.getByText("Step 1 of 2")).toBeTruthy();
  });

  it("starts the project step over when no team came with it", () => {
    // Passes the step check and still dead-ends: the project step needs a team
    // to attach the project to, so the wizard's own guard renders neither step
    // and the card comes up blank.
    seedWizardState({
      currentStep: OnboardingStep.CreateProject,
      createdTeamId: null,
      createdTeamName: null,
      createdProjectId: null,
      createdProjectName: null,
    });

    render(<OnboardingWizard />);

    expect(screen.getByText(TEAM_HEADING)).toBeTruthy();
  });

  it("ignores a stored state that is not a wizard state", () => {
    // `sessionStorage` is a parse boundary: a half-written blob, an older
    // build's shape, or anyone with devtools. Casting it would hand the wizard
    // a state missing the fields it renders from.
    seedWizardState({ currentStep: OnboardingStep.CreateProject });

    render(<OnboardingWizard />);

    expect(screen.getByText(TEAM_HEADING)).toBeTruthy();
  });

  it("ignores stored text that is not JSON at all", () => {
    sessionStorage.setItem(WIZARD_STATE_KEY, "not json");

    render(<OnboardingWizard />);

    expect(screen.getByText(TEAM_HEADING)).toBeTruthy();
  });

  it("does not complete twice when Continue is clicked mid-flight", () => {
    const { rerender } = render(<OnboardingWizard />);
    completeTeamStep();

    fireEvent.change(screen.getByLabelText(PROJECT_NAME_LABEL), {
      target: { value: "Web app" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: CREATE_PROJECT_BUTTON })
    );
    resolveMutation(mocks.createProject, { id: "project-1", name: "Web app" });
    expect(mocks.completeWizard).toHaveBeenCalledTimes(1);

    // The step stays mounted while the completion is in flight and re-renders
    // in its success state with a live Continue wired straight back into the
    // same handler. A second PUT is another read-modify-write of the whole
    // Organization.settings blob, plus a second navigate.
    mocks.completeWizardPending = true;
    rerender(<OnboardingWizard />);

    // Disabled, not merely inert: a live button that swallows the click tells
    // the user nothing happened when something is happening.
    const continueButton = screen.getByRole("button", {
      name: CONTINUE_BUTTON,
    }) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);

    fireEvent.click(continueButton);
    expect(mocks.completeWizard).toHaveBeenCalledTimes(1);
  });
});
