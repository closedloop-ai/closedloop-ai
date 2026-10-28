// @vitest-environment jsdom

import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_ORGANIZATION_MEMBERS } from "../../lib/guided-onboarding-fixtures";
import { GuidedOnboardingDialog } from "../guided-onboarding-dialog";
import { INVITE_SENT_WORD } from "../guided-onboarding-invite-step";
import type { GuidedOnboardingDialogProps } from "../guided-onboarding-types";

const DOWNLOAD_HREFS = {
  linux: "https://downloads.test/Closedloop.AppImage",
  mac: "https://downloads.test/Closedloop-universal.dmg",
  windows: "https://downloads.test/Closedloop-Setup.exe",
} as const;

const ALREADY_IN_ORG = /3 already in your organization/;
const PARTIAL_WITH_FAILURES =
  /1 already in your organization, 2 could not be sent\. You can try those again later\./;
const RETRY_GUIDANCE = /You can try those again later/;

/**
 * ISS-8348. `inviteOutcome`, when supplied, is AUTHORITATIVE: the step's local
 * optimistic latch is bypassed rather than merged, so the two can never both
 * drive the confirmation. Every count stated comes from the server's tally, not
 * from the number of addresses submitted.
 */
describe("guided onboarding invite outcome", () => {
  it("claims nothing sent while the send is still in flight", () => {
    renderDialog({ inviteOutcome: { status: "pending" } });

    // Positive control: the step rendered and is showing the in-flight send.
    expect(screen.getByRole("button", { name: "Sending…" })).not.toBeNull();
    expect(screen.queryByText(INVITE_SENT_WORD, { exact: false })).toBeNull();
  });

  it("states the number the server invited, not the number submitted", () => {
    renderDialog({
      inviteOutcome: {
        alreadyMember: 3,
        failed: 0,
        invited: 2,
        status: "partial",
      },
    });

    // The user typed five addresses; two were invited. "5 emails sent" was the
    // shipped behaviour, because the copy read the submitted list.
    expect(screen.getByText("2 invitations sent")).not.toBeNull();
    expect(screen.getByText(ALREADY_IN_ORG)).not.toBeNull();
  });

  it("names the sends that failed and offers a retry for them", () => {
    // ISS-11149 row 4: `describePartial`'s `failed > 0` half — the sentence and
    // the retry guidance — had no render test. Every other partial row in this
    // file passes `failed: 0`, so the branch was reachable only in production.
    renderDialog({
      inviteOutcome: {
        alreadyMember: 1,
        failed: 2,
        invited: 3,
        status: "partial",
      },
    });

    expect(screen.getByText(PARTIAL_WITH_FAILURES)).not.toBeNull();
  });

  it("offers no retry when nothing failed", () => {
    // Paired control: the guidance above is conditional, and telling someone to
    // re-invite a teammate who is already a member is advice that cannot work.
    renderDialog({
      inviteOutcome: {
        alreadyMember: 3,
        failed: 0,
        invited: 2,
        status: "partial",
      },
    });

    expect(screen.getByText(ALREADY_IN_ORG)).not.toBeNull();
    expect(screen.queryByText(RETRY_GUIDANCE)).toBeNull();
  });

  it("makes no send claim when everyone was already a member", () => {
    renderDialog({
      inviteOutcome: { alreadyMember: 2, status: "already-member" },
    });

    expect(screen.getByText("No new invitations needed")).not.toBeNull();
    expect(screen.queryByText(INVITE_SENT_WORD, { exact: false })).toBeNull();
  });

  it("surfaces a failed send and keeps the composer available", () => {
    renderDialog({
      inviteOutcome: {
        failed: 1,
        message: "Invite service down",
        status: "failed",
      },
    });

    expect(screen.getByText("Invite service down")).not.toBeNull();
    expect(screen.queryByText(INVITE_SENT_WORD, { exact: false })).toBeNull();
    // The user must be able to retry, so the composer stays mounted.
    expect(screen.getByRole("button", { name: "Send invite" })).not.toBeNull();
  });

  it.each([
    ["sent", { invited: 2, status: "sent" as const }],
    [
      "partial",
      { alreadyMember: 3, failed: 0, invited: 2, status: "partial" as const },
    ],
    ["already-member", { alreadyMember: 2, status: "already-member" as const }],
  ])(
    "leaves a way forward after a settled %s send",
    (_label, inviteOutcome) => {
      // The confirmation hides the composer, and "Skip for now" lives INSIDE the
      // composer. Without an explicit Continue the wizard dead-ends on any batch
      // whose addresses the host does not also list.
      renderDialog({ inviteOutcome });

      expect(screen.getByRole("button", { name: "Continue" })).not.toBeNull();
    }
  );

  it("keeps the previous optimistic behaviour when no outcome is supplied", () => {
    const onInviteTeam = vi.fn();
    renderDialog({ onInviteTeam });

    fireEvent.change(screen.getByRole("textbox", { name: "Work emails" }), {
      target: { value: "builder@company.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    expect(onInviteTeam).toHaveBeenCalledWith(["builder@company.com"]);
    expect(screen.getByText("1 email sent")).not.toBeNull();
  });
});

function renderDialog(props: Partial<GuidedOnboardingDialogProps>) {
  return render(
    <GuidedOnboardingDialog
      brand={<span>Closedloop.ai</span>}
      downloadHrefs={DOWNLOAD_HREFS}
      members={FIXTURE_ORGANIZATION_MEMBERS}
      onComplete={vi.fn()}
      open
      phase={OnboardingPhase.InviteTeam}
      {...props}
    />
  );
}
