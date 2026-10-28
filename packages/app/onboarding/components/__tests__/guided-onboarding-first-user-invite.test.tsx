// @vitest-environment jsdom

import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  FIXTURE_FIRST_MEMBER,
  FIXTURE_ORGANIZATION_MEMBERS,
} from "../../lib/guided-onboarding-fixtures";
import { UNKNOWN_ORGANIZATION_MEMBERS } from "../guided-onboarding-data";
import { GuidedOnboardingDialog } from "../guided-onboarding-dialog";
import type { GuidedOnboardingDialogProps } from "../guided-onboarding-types";

/**
 * Deliberate copies of the step's own words rather than imports of the
 * constants under test: importing them would make either wording pass.
 */
const FIRST_USER_EYEBROW = "Invite your team";
const FIRST_USER_PITCH =
  "You're the first in your company to use Closedloop. Invite your team so you can all build and learn from the same playbook.";
const JOINING_USER_EYEBROW = "Your team is already here";
const JOINING_USER_PITCH =
  "50 people at your company already use Closedloop. Invite anyone missing so your team can learn from the same playbook.";
const CLAIM_FREE_EYEBROW = "Build together";
const POST_SEND_PITCH =
  "Your teammates have been invited. You can invite more people later.";
const INVITED_EMAIL = "teammate@example.com";
const SKIP_LABEL = "Skip for now";
const CONTINUE_LABEL = "Continue";

/**
 * The roster locators, named once so the first-user absences below are the SAME
 * queries the joining-user case proves can match. A locator that matched
 * nothing would fail that case rather than silently satisfy this one.
 */
const ROSTER_PILL_NAMES = [
  "Sample User",
  "Example Teammate",
  "Placeholder Colleague",
] as const;
const ROSTER_REMAINDER = "+47 more from your company";

describe("guided onboarding invite step, first user versus joining user", () => {
  it("tells a first user they are first and shows no roster", () => {
    renderInviteStep(FIXTURE_FIRST_MEMBER);

    expect(screen.getByText(FIRST_USER_EYEBROW)).not.toBeNull();
    expect(screen.getByText(FIRST_USER_PITCH)).not.toBeNull();
    expect(screen.queryByText(JOINING_USER_EYEBROW)).toBeNull();
    expect(screen.queryByText(JOINING_USER_PITCH)).toBeNull();

    for (const name of ROSTER_PILL_NAMES) {
      expect(screen.queryByText(name)).toBeNull();
    }
    expect(screen.queryByText(ROSTER_REMAINDER)).toBeNull();
  });

  /**
   * "You're the first" is as much a claim as "50 people are here", so a lookup
   * that has not reported may make neither. Without this case, dropping the
   * `status === "known"` guard from the eyebrow rule leaves every test green.
   */
  it("makes neither claim while the membership lookup is unknown", () => {
    renderInviteStep(UNKNOWN_ORGANIZATION_MEMBERS);

    expect(screen.getByText(CLAIM_FREE_EYEBROW)).not.toBeNull();
    expect(screen.queryByText(FIRST_USER_EYEBROW)).toBeNull();
    expect(screen.queryByText(FIRST_USER_PITCH)).toBeNull();
    expect(screen.queryByText(JOINING_USER_EYEBROW)).toBeNull();
    expect(screen.queryByText(JOINING_USER_PITCH)).toBeNull();

    for (const name of ROSTER_PILL_NAMES) {
      expect(screen.queryByText(name)).toBeNull();
    }
    expect(screen.queryByText(ROSTER_REMAINDER)).toBeNull();
  });

  /**
   * The first-user eyebrow is a claim about the org made while the step is
   * still asking for invitations. Once the send has happened the step reports
   * the send, so the claim is retired. Without this case, dropping the
   * sent guard from the eyebrow rule would render "Invite your team"
   * above a confirmed send and leave every other case green.
   */
  it("retires the first-user eyebrow once the invitations are sent", () => {
    renderInviteStep(FIXTURE_FIRST_MEMBER, {
      invitedEmails: [INVITED_EMAIL],
    });

    expect(screen.getByText(INVITED_EMAIL)).not.toBeNull();
    expect(screen.getByText(POST_SEND_PITCH)).not.toBeNull();
    expect(screen.getByText(CLAIM_FREE_EYEBROW)).not.toBeNull();
    expect(screen.queryByText(FIRST_USER_EYEBROW)).toBeNull();
    expect(screen.queryByText(FIRST_USER_PITCH)).toBeNull();
  });

  /**
   * ISS-11670: the sent state lists the addresses it claims. A send with no
   * address behind it used to render "Your invitations were sent." in place of
   * the composer; it now makes no claim and keeps the composer.
   */
  it("makes no sent claim and keeps the composer when no address was sent", () => {
    renderInviteStep(FIXTURE_FIRST_MEMBER, {
      invitedEmails: [],
    });

    expect(screen.queryByText(POST_SEND_PITCH)).toBeNull();
    expect(screen.getByText(FIRST_USER_PITCH)).not.toBeNull();
    expect(screen.getByRole("button", { name: SKIP_LABEL })).not.toBeNull();
    expect(screen.queryByRole("button", { name: CONTINUE_LABEL })).toBeNull();
  });

  it("keeps the roster and the count claim for a joining user", () => {
    renderInviteStep(FIXTURE_ORGANIZATION_MEMBERS);

    expect(screen.getByText(JOINING_USER_EYEBROW)).not.toBeNull();
    expect(screen.getByText(JOINING_USER_PITCH)).not.toBeNull();
    expect(screen.queryByText(FIRST_USER_EYEBROW)).toBeNull();
    expect(screen.queryByText(FIRST_USER_PITCH)).toBeNull();

    for (const name of ROSTER_PILL_NAMES) {
      expect(screen.getByText(name)).not.toBeNull();
    }
    expect(screen.getByText(ROSTER_REMAINDER)).not.toBeNull();
  });
});

const DOWNLOAD_HREFS = {
  linux: "https://downloads.test/Closedloop.AppImage",
  mac: "https://downloads.test/Closedloop-universal.dmg",
  windows: "https://downloads.test/Closedloop-Setup.exe",
} as const;

function renderInviteStep(
  members: GuidedOnboardingDialogProps["members"],
  send?: {
    invitedEmails: GuidedOnboardingDialogProps["invitedEmails"];
  }
): void {
  render(
    <GuidedOnboardingDialog
      brand={<span>Closedloop.ai</span>}
      downloadHrefs={DOWNLOAD_HREFS}
      invitedEmails={send?.invitedEmails ?? []}
      members={members}
      onComplete={vi.fn()}
      open
      phase={OnboardingPhase.InviteTeam}
    />
  );
}
