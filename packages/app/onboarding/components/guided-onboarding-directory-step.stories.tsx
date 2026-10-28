import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  ADD_DIRECTORY_CONTROL_COPY,
  FIXTURE_AUTO_EXCLUDED,
} from "../../shared/components/directory-scope-list-with-add-fixtures";
import { DirectoryStepSelection } from "./guided-onboarding-directory-step";
import { GuidedOnboardingDirectoryStepDemo } from "./guided-onboarding-directory-step-demo";
import {
  FIXTURE_ADDED_PICK,
  FIXTURE_BRAND_NAME,
  FIXTURE_DISCOVERED_ENTRIES,
  FIXTURE_DISCOVERED_EXPANDED_IDS,
  FIXTURE_DISCOVERED_INCLUDED_IDS,
  PLACEHOLDER_DIRECTORY_STEP_COPY,
  PLACEHOLDER_SCOPE_LIST_COPY,
} from "./guided-onboarding-directory-step-fixtures";

/**
 * ISS-12524: the onboarding step that confirms which directories are in scope,
 * shown in the guided-onboarding card. Design-only: it is not a phase of
 * `GuidedOnboardingDialog` yet.
 *
 * Placeholder strings fill every slot without approved wording, one per slot
 * and named after it (operator ruling, Nerys, 2026-10-15,
 * th_Dc0RuSiAdyCvLQpC_X2G4). The add control shows ISS-12521's approved copy,
 * and Continue reuses the sync step's shipped label.
 */
const meta = {
  title: "Composites/Onboarding/Guided Onboarding Directory Step",
  tags: ["experimental"],
  component: GuidedOnboardingDirectoryStepDemo,
  parameters: { layout: "fullscreen", controls: { disable: true } },
  args: {
    addCopy: ADD_DIRECTORY_CONTROL_COPY,
    autoExcluded: FIXTURE_AUTO_EXCLUDED,
    brandName: FIXTURE_BRAND_NAME,
    copy: PLACEHOLDER_DIRECTORY_STEP_COPY,
    defaultExpandedIds: FIXTURE_DISCOVERED_EXPANDED_IDS,
    initialEntries: FIXTURE_DISCOVERED_ENTRIES,
    initialIncludedIds: FIXTURE_DISCOVERED_INCLUDED_IDS,
    listCopy: PLACEHOLDER_SCOPE_LIST_COPY,
    onBack: fn(),
    onContinue: fn(),
    pick: FIXTURE_ADDED_PICK,
  },
} satisfies Meta<typeof GuidedOnboardingDirectoryStepDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

const DARK = { globals: { theme: "dark" } } as const;

function body(canvasElement: HTMLElement) {
  return within(canvasElement.ownerDocument.body);
}

function continueButton(canvasElement: HTMLElement) {
  return body(canvasElement).getByRole("button", {
    name: PLACEHOLDER_DIRECTORY_STEP_COPY.continueLabel,
  });
}

/** Desktop: what discovery found, with part of it in scope. */
export const Default: Story = {};

/** AC-002: a directory added through the folder picker joins the list. */
export const NewlyAdded: Story = {
  play: async ({ canvasElement }) => {
    const canvas = body(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: ADD_DIRECTORY_CONTROL_COPY.trigger })
    );
    await expect(
      await canvas.findByText(FIXTURE_ADDED_PICK.label)
    ).toBeInTheDocument();
  },
};

/**
 * AC-003: nothing selected. Continue stays available and confirms an empty
 * scope, which the sync step treats as local-only.
 */
export const ZeroSelected: Story = {
  args: { initialIncludedIds: [] },
  play: async ({ args, canvasElement }) => {
    const button = continueButton(canvasElement);
    await expect(button).toBeEnabled();
    await expect(button.dataset.selection).toBe(DirectoryStepSelection.None);
    await userEvent.click(button);
    await expect(args.onContinue).toHaveBeenCalledWith([]);
  },
};

/** Desktop discovery found nothing; adding is the only way in. */
export const NothingDiscovered: Story = {
  args: { autoExcluded: [], initialEntries: [], initialIncludedIds: [] },
};

/**
 * AC-004: web has no picker and no local discovery, so the add control is
 * absent and the list shows its empty state.
 */
export const Web: Story = {
  args: {
    addCopy: undefined,
    autoExcluded: [],
    initialEntries: [],
    initialIncludedIds: [],
    pick: undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = body(canvasElement);
    await expect(
      canvas.queryByRole("button", { name: ADD_DIRECTORY_CONTROL_COPY.trigger })
    ).toBeNull();
    await expect(
      canvas.getByText(PLACEHOLDER_SCOPE_LIST_COPY.empty)
    ).toBeInTheDocument();
    await expect(continueButton(canvasElement)).toBeEnabled();
  },
};

export const DefaultDark: Story = { ...DARK };
