// @vitest-environment jsdom

/**
 * ISS-12524: the onboarding directory step. It is design-only, so AC-001's
 * place in the flow is the step's contract (Back, and a Continue that hands the
 * confirmed scope to the sync step) rather than a phase-registry entry.
 *
 * The copy values are slot markers so a test can tell which slot rendered; the
 * step owns no strings.
 */

import {
  Dialog,
  DialogContent,
} from "@repo/design-system/components/ui/dialog";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DirectoryScopeListCopy } from "../../../shared/components/directory-scope-list";
import type {
  AddDirectoryAdapter,
  AddDirectoryControlCopy,
} from "../../../shared/components/directory-scope-list-with-add";
import {
  DirectoryStepSelection,
  GuidedOnboardingDirectoryStep,
  type GuidedOnboardingDirectoryStepCopy,
  type GuidedOnboardingDirectoryStepProps,
} from "../guided-onboarding-directory-step";
import {
  FIXTURE_ADDED_PICK,
  FIXTURE_DISCOVERED_ENTRIES,
  FIXTURE_DISCOVERED_INCLUDED_IDS,
} from "../guided-onboarding-directory-step-fixtures";

const STEP_COPY: GuidedOnboardingDirectoryStepCopy = {
  continueLabel: "slot:continue",
  description: "slot:description",
  eyebrow: "slot:eyebrow",
  title: "slot:title",
};

const LIST_COPY: DirectoryScopeListCopy = {
  autoExcludedHeading: "slot:auto-excluded-heading",
  autoExcludedReason: "slot:auto-excluded-reason",
  empty: "slot:empty",
  newlyDiscovered: "slot:newly-discovered",
  noSelection: "slot:no-selection",
  treeLabel: "slot:tree-label",
  unavailable: "slot:unavailable",
  unavailableReason: "slot:unavailable-reason",
};

const ADD_COPY: AddDirectoryControlCopy = {
  added: "slot:added",
  duplicate: "slot:duplicate",
  protectedFolder: "slot:protected",
  trigger: "slot:trigger",
  unreadable: "slot:unreadable",
};

function desktopAdd(overrides: Partial<AddDirectoryAdapter> = {}) {
  return {
    copy: ADD_COPY,
    onAdd: vi.fn(),
    onPickError: vi.fn(),
    pickDirectory: () => Promise.resolve(FIXTURE_ADDED_PICK),
    ...overrides,
  } satisfies AddDirectoryAdapter;
}

function renderStep(props: Partial<GuidedOnboardingDirectoryStepProps> = {}) {
  const handlers = {
    onBack: vi.fn(),
    onContinue: vi.fn(),
    onIncludedIdsChange: vi.fn(),
  };
  render(
    <Dialog open>
      <DialogContent showCloseButton={false}>
        <GuidedOnboardingDirectoryStep
          add={desktopAdd()}
          brand={<span>slot:brand</span>}
          copy={STEP_COPY}
          entries={FIXTURE_DISCOVERED_ENTRIES}
          includedIds={FIXTURE_DISCOVERED_INCLUDED_IDS}
          listCopy={LIST_COPY}
          {...handlers}
          {...props}
        />
      </DialogContent>
    </Dialog>
  );
  return handlers;
}

/** The shipped label `GuidedOnboardingBackButton` draws. */
const BACK_LABEL = /back/i;

function continueButton() {
  return screen.getByRole("button", { name: STEP_COPY.continueLabel });
}

describe("GuidedOnboardingDirectoryStep (ISS-12524)", () => {
  it("renders every step slot from props (AC-001)", () => {
    renderStep();
    for (const slot of [STEP_COPY.eyebrow, STEP_COPY.title]) {
      expect(screen.getByText(slot)).toBeInTheDocument();
    }
    expect(screen.getByText(STEP_COPY.description)).toBeInTheDocument();
    expect(screen.getByText("slot:brand")).toBeInTheDocument();
  });

  it("hands the confirmed scope to the next step on Continue (AC-001)", () => {
    const { onContinue } = renderStep();
    fireEvent.click(continueButton());
    expect(onContinue).toHaveBeenCalledWith([
      ...FIXTURE_DISCOVERED_INCLUDED_IDS,
    ]);
    expect(continueButton().dataset.selection).toBe(
      DirectoryStepSelection.Some
    );
  });

  it("goes Back when the host offers it", () => {
    const { onBack } = renderStep();
    fireEvent.click(screen.getByRole("button", { name: BACK_LABEL }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("renders the discovered directories as the scope list (AC-002)", () => {
    renderStep();
    expect(
      screen.getByRole("tree", { name: LIST_COPY.treeLabel })
    ).toBeInTheDocument();
    expect(screen.getByText("~/scratch")).toBeInTheDocument();
  });

  it("passes inclusion changes to the host (AC-002)", () => {
    const { onIncludedIdsChange } = renderStep();
    fireEvent.click(screen.getByRole("treeitem", { name: "~/scratch" }));
    expect(onIncludedIdsChange).toHaveBeenCalledTimes(1);
    expect(onIncludedIdsChange.mock.calls[0]?.[0]).toContain("~/scratch");
  });

  it("adds a picked directory through the add control (AC-002)", async () => {
    const add = desktopAdd();
    renderStep({ add });
    await act(() => {
      fireEvent.click(screen.getByRole("button", { name: ADD_COPY.trigger }));
      return Promise.resolve();
    });
    expect(add.onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ id: FIXTURE_ADDED_PICK.id })
    );
  });

  it("shows the list's empty state when nothing was discovered (AC-002)", () => {
    renderStep({ entries: [], includedIds: [] });
    expect(screen.getByText(LIST_COPY.empty)).toBeInTheDocument();
  });

  it("shows the no-selection state and still continues with an empty scope (AC-002, AC-003)", () => {
    const { onContinue } = renderStep({ includedIds: [] });
    expect(screen.getByText(LIST_COPY.noSelection)).toBeInTheDocument();
    const button = continueButton();
    expect(button).toBeEnabled();
    expect(button.dataset.selection).toBe(DirectoryStepSelection.None);
    fireEvent.click(button);
    expect(onContinue).toHaveBeenCalledWith([]);
  });

  it("on web, has no add control and shows the empty state (AC-004)", () => {
    const { onContinue } = renderStep({
      add: undefined,
      entries: [],
      includedIds: [],
    });
    expect(screen.queryByRole("button", { name: ADD_COPY.trigger })).toBeNull();
    expect(screen.getByText(LIST_COPY.empty)).toBeInTheDocument();
    fireEvent.click(continueButton());
    expect(onContinue).toHaveBeenCalledWith([]);
  });

  it("on desktop, offers the add control (AC-004)", () => {
    renderStep();
    expect(
      screen.getByRole("button", { name: ADD_COPY.trigger })
    ).toBeInTheDocument();
  });
});
