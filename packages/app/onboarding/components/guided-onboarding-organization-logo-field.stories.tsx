import type { Meta, StoryObj } from "@storybook/react";
import {
  GuidedOnboardingOrganizationLogoField,
  ORGANIZATION_LOGO_TOO_LARGE_MESSAGE,
} from "./guided-onboarding-organization-logo-field";

// A pick that passed validation. The name is what the staged sentence renders,
// so it is long enough to show the sentence wrapping at the clamped width.
const STAGED_LOGO_FILE = new File(
  [
    Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAJklEQVR4nGN4hgTkkAAucYZBqIEYRcjig1ED7UOJ9hpoH0o01wAAVguGEIh6FC8AAAAASUVORK5CYII="
      ),
      (character) => character.charCodeAt(0)
    ),
  ],
  "example-organization-mark.png",
  {
    type: "image/png",
  }
);

/**
 * The create-organization step's logo picker, in every state its props can put
 * it in. These are worth seeing together because the difference between them is
 * carried almost entirely by one helper sentence and one button word: staged,
 * uploading, uploaded, and not-available-yet are four different promises about
 * whether the file has left the machine, and nothing but that copy separates
 * them on screen.
 *
 * Rejected is the one state that changes more than words — the helper line turns
 * destructive and takes `role="alert"` — so it is here to be looked at against
 * the error token rather than inferred from a DOM assertion. The branch logic
 * itself is pinned by `__tests__/guided-onboarding-dialog.test.tsx`.
 */
const meta: Meta<typeof GuidedOnboardingOrganizationLogoField> = {
  args: {
    logoError: null,
    logoUploadAvailable: true,
    logoUploadConfirmed: false,
    logoUploading: false,
    onFileSelected: () => {
      // Storybook has no upload transport. Resolving a pick here would pretend
      // a round trip happened and land the story in a state it did not earn.
      return Promise.resolve();
    },
    stagedLogoFile: null,
  },
  component: GuidedOnboardingOrganizationLogoField,
  // Matches the create-organization step, which clamps its form to max-w-2xl.
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-2xl py-8">
        <Story />
      </div>
    ),
  ],
  tags: ["deprecated", "autodocs"],
  title: "Composites v1.0/Onboarding/Guided Onboarding Organization Logo Field",
};

export default meta;

type Story = StoryObj<typeof GuidedOnboardingOrganizationLogoField>;

/** Upload is wired and nothing has been picked — the step's opening state. */
export const Empty: Story = {};

/** A pick is in flight: every control disables and the tile takes the spinner. */
export const Uploading: Story = {
  args: { logoUploading: true },
};

/**
 * The create-first host, which has no organization to upload against yet. The
 * file is validated and held, and the sentence has to say so — a reader who
 * takes this for "uploaded" would close the wizard believing the logo shipped.
 */
export const Staged: Story = {
  args: { stagedLogoFile: STAGED_LOGO_FILE },
};

/** The provider confirmed the upload, so the action becomes Replace. */
export const UploadConfirmed: Story = {
  args: { logoUploadConfirmed: true },
};

/** Rejected by `validateOrganizationLogoFile` before any transport ran. */
export const Rejected: Story = {
  args: { logoError: ORGANIZATION_LOGO_TOO_LARGE_MESSAGE },
};

/** A host that wired no upload handler. The controls stay visibly inert. */
export const UploadUnavailable: Story = {
  args: { logoUploadAvailable: false },
};

/**
 * An organization that already carries a provider logo on a host with no upload
 * wired — the tile shows what exists while the copy still refuses to promise a
 * replacement can be made.
 */
export const ExistingLogoWithoutUpload: Story = {
  args: {
    logoUploadAvailable: false,
    newOrganizationLogo: <span className="font-semibold text-lg">EO</span>,
  },
};
