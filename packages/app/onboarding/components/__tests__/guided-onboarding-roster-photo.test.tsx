// @vitest-environment jsdom

import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import type { User } from "@repo/api/src/types/user";
import { ApproverRole } from "@repo/api/src/types/user";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { foldOnboardingOrganizationMembers } from "../../lib/onboarding-organization-members";
import { GuidedOnboardingDialog } from "../guided-onboarding-dialog";

// Loaded INSIDE the factory: `vi.mock` hoists above every import, so a static
// binding to the helper is still uninitialised when the factory runs.
vi.mock("@repo/design-system/components/ui/avatar", async (importOriginal) => {
  const { avatarImageMockModule } = await import(
    "@repo/app/test/mocks/avatar-image"
  );
  return avatarImageMockModule(importOriginal);
});

/**
 * ISS-12341: the invite step's "your team is already here" strip shows each
 * teammate's PICTURE.
 *
 * Driven through the real fold, because the defect was in the fold, not the
 * strip: `toPreview()` destructured `{ id, name, initials }` off
 * `transformApiUserToSelectUser` and dropped the `avatarUrl` beside them, so a
 * strip converted to `PersonAvatar` alone would still draw initials.
 *
 * Radix gates `AvatarImage` on a real load and jsdom loads none, so the shared
 * `avatarImageMockModule` stands in; it forwards only `alt` and `src`, so these
 * cases claim nothing beyond the `src` that reached the DOM.
 */
const SIGNER_ID = "user-signer";
const TEAMMATE_PHOTO = "https://img.example.test/rosa.png";
/**
 * Asserted in every case as the positive control: without it the no-photo case
 * passes just as well when the roster never rendered at all, which is what
 * makes an absence assertion worthless.
 */
const ROSA_NAME = "Rosa";
const DOWNLOAD_HREFS = {
  linux: "https://downloads.test/Closedloop.AppImage",
  mac: "https://downloads.test/Closedloop-universal.dmg",
  windows: "https://downloads.test/Closedloop-Setup.exe",
} as const;

describe("Invite step roster renders teammate photos (ISS-12341)", () => {
  it("renders the photo the roster read carried", () => {
    renderRoster([rosa(TEAMMATE_PHOTO)]);

    expect(screen.getByText(ROSA_NAME)).not.toBeNull();
    expect(photoSources()).toEqual([TEAMMATE_PHOTO]);
  });

  it("renders no photo for a teammate the roster read has none for", () => {
    // The counterfactual: without it the case above passes against a strip
    // that hardcoded any `src`.
    renderRoster([rosa(null)]);

    expect(screen.getByText(ROSA_NAME)).not.toBeNull();
    expect(photoSources()).toEqual([]);
  });

  // Two teammates, one photo: a single-member fixture cannot tell a per-person
  // read from a strip that draws whatever the first member had.
  it("renders the photo only for the teammate who has one", () => {
    renderRoster([
      rosa(TEAMMATE_PHOTO),
      makeUser({ avatarUrl: null, firstName: "Wes", id: "user-wes" }),
    ]);

    expect(screen.getByText(ROSA_NAME)).not.toBeNull();
    expect(screen.getByText("Wes")).not.toBeNull();
    expect(photoSources()).toEqual([TEAMMATE_PHOTO]);
  });
});

function rosa(avatarUrl: string | null): User {
  return makeUser({ avatarUrl, firstName: ROSA_NAME, id: "user-rosa" });
}

/** The production mount: the real fold, inside the dialog that hosts the step. */
function renderRoster(users: readonly User[]) {
  const members = foldOnboardingOrganizationMembers(
    { status: "resolved", users: [...users, makeUser({ id: SIGNER_ID })] },
    SIGNER_ID
  );
  return render(
    <GuidedOnboardingDialog
      brand={<span>Closedloop.ai</span>}
      downloadHrefs={DOWNLOAD_HREFS}
      members={members}
      onComplete={vi.fn()}
      open
      phase={OnboardingPhase.InviteTeam}
    />
  );
}

/** Every `src` the strip drew, read from the document because it portals. */
function photoSources(): string[] {
  return Array.from(document.querySelectorAll("img")).map(
    (image) => image.getAttribute("src") ?? ""
  );
}

function makeUser({
  createdAt = "2025-06-01",
  ...overrides
}: Partial<Omit<User, "createdAt">> & {
  createdAt?: string;
  id: string;
}): User {
  return {
    active: true,
    avatarUrl: null,
    clerkId: `clerk-${overrides.id}`,
    createdAt: new Date(createdAt),
    email: `${overrides.id}@example.com`,
    firstName: "Given",
    githubUsername: null,
    lastName: null,
    linearId: null,
    organizationId: "org-1",
    phoneNumber: null,
    role: ApproverRole.Engineer,
    slackId: null,
    updatedAt: new Date(createdAt),
    ...overrides,
  };
}
