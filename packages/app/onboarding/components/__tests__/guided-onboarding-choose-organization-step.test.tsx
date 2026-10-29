// @vitest-environment jsdom

import {
  Dialog,
  DialogContent,
} from "@repo/design-system/components/ui/dialog";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  FIXTURE_ACCOUNT,
  FIXTURE_JOINABLE_ORGANIZATION,
} from "../../lib/guided-onboarding-fixtures";
import {
  GuidedOnboardingChooseOrganizationStep,
  CHOOSE_ORGANIZATION_LOOKUP_NONE_COPY as NONE_COPY,
  CHOOSE_ORGANIZATION_LOOKUP_PARTIAL_COPY as PARTIAL_COPY,
  CHOOSE_ORGANIZATION_LOOKUP_PENDING_COPY as PENDING_COPY,
  CHOOSE_ORGANIZATION_LOOKUP_UNAVAILABLE_COPY as UNAVAILABLE_COPY,
} from "../guided-onboarding-choose-organization-step";
import { OnboardingJoinAuthority } from "../guided-onboarding-data";

type StepProps = ComponentProps<typeof GuidedOnboardingChooseOrganizationStep>;

/**
 * Mounts the phase on its own, with only the Radix context its `DialogTitle`
 * needs. The wizard shell is deliberately absent: what this file covers is the
 * step's own choice-versus-no-choice policy, and the cross-phase dialog suite
 * covers the rest.
 */
function renderStep(overrides: Partial<StepProps> = {}) {
  render(
    <Dialog open>
      <DialogContent showCloseButton={false}>
        <GuidedOnboardingChooseOrganizationStep
          account={FIXTURE_ACCOUNT}
          brand={<span>Closedloop.ai</span>}
          joinableOrganization={FIXTURE_JOINABLE_ORGANIZATION}
          onContinue={vi.fn()}
          onCreateNew={vi.fn()}
          onJoin={vi.fn()}
          organizationChosen={false}
          privacyHref="/legal/privacy"
          termsHref="/legal/terms"
          {...overrides}
        />
      </DialogContent>
    </Dialog>
  );
}

describe("GuidedOnboardingChooseOrganizationStep", () => {
  it("withholds the primary action until an organization is actually chosen", () => {
    renderStep();

    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.getByRole("button", { name: "Join" })).toBeEnabled();
  });

  it("announces a check only while the joinable lookup has not reported", () => {
    renderStep({ joinableOrganization: { status: "unknown" } });

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText(PENDING_COPY.announcement)).toBeInTheDocument();
    expect(screen.queryByText(NONE_COPY.title)).toBeNull();
    expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
  });

  it("offers the joinable organization and stops announcing a check", () => {
    renderStep({
      joinableOrganization: {
        join: { authority: OnboardingJoinAuthority.Membership, id: "org_acme" },
        name: "Acme Research",
        status: "available",
      },
    });

    expect(screen.getByRole("button", { name: "Join" })).toBeEnabled();
    expect(screen.getByText("Acme Research")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(PENDING_COPY.announcement)).toBeNull();
  });

  // ISS-11145: the regression. A settled, EMPTY lookup is a different claim from
  // an unreported one, and the shipped step could only ever be handed the
  // latter — so an existing member with no active organization read a
  // `role="status"` skeleton announcing a check that had already finished.
  it("states the empty result instead of a skeleton once the lookup reports nothing", () => {
    renderStep({ joinableOrganization: { status: "none" } });

    expect(screen.getByText(NONE_COPY.title)).toBeInTheDocument();
    expect(screen.getByText(NONE_COPY.description)).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(PENDING_COPY.announcement)).toBeNull();
    expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Create new organization" })
    ).toBeInTheDocument();
  });

  // ISS-11158, the regression this file exists to pin. A FAILED
  // membership/invitation lookup used to resolve `unknown`, whose row is a
  // `role="status"` skeleton whose sr-only sentence announces a check IN
  // PROGRESS — for a read that had already exhausted its retries and would not
  // run again. Both halves of the transition are asserted on purpose: the
  // failure card present, and the two sentences it must not borrow absent. A
  // negative-only assertion would pass on an empty row, and the positive one is
  // on the alert's accessible NAME rather than on `toBeVisible`, which an
  // `sr-only` 1x1 element also satisfies.
  it("states a failed lookup instead of announcing a check that already resolved", () => {
    renderStep({
      joinableOrganization: { status: "unavailable" },
      onRetryLookup: vi.fn(),
    });

    expect(
      screen.getByRole("alert", { name: UNAVAILABLE_COPY.title })
    ).toHaveTextContent(UNAVAILABLE_COPY.description);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(PENDING_COPY.announcement)).toBeNull();
    expect(screen.queryByText(NONE_COPY.title)).toBeNull();
    expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
  });

  // The escape. Without this the reader's only live control is one that creates a
  // SECOND organization for someone whose invitation the lookup merely failed to
  // fetch.
  it("re-runs the lookup when the reader presses Retry", () => {
    const onRetryLookup = vi.fn();
    renderStep({
      joinableOrganization: { status: "unavailable" },
      onRetryLookup,
    });

    fireEvent.click(
      screen.getByRole("button", { name: UNAVAILABLE_COPY.retryLabel })
    );

    expect(onRetryLookup).toHaveBeenCalledTimes(1);
  });

  // ISS-11158 review (tamsinb). The reader presses Retry from INSIDE this card,
  // so the card has to survive its own press: swapping to the pending skeleton
  // or using a real `disabled` unmounts or blurs the control and Radix hands
  // focus back to the dialog container. Both halves are pinned on the SAME
  // locator — the busy button is present and named, and it is aria-disabled —
  // because a `queryBy(...).toBeNull()` on a name that never resolves passes on
  // an empty render.
  it("keeps the Retry mounted and busy while the re-read is in flight", () => {
    const onRetryLookup = vi.fn();
    renderStep({
      joinableOrganization: { lookupRetrying: true, status: "unavailable" },
      onRetryLookup,
    });

    const retry = screen.getByRole("button", {
      name: UNAVAILABLE_COPY.retryingLabel,
    });
    expect(retry).toBeInTheDocument();
    expect(retry).toHaveAttribute("aria-disabled", "true");
    expect(retry).not.toBeDisabled();
    expect(
      screen.getByRole("alert", { name: UNAVAILABLE_COPY.title })
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(PENDING_COPY.announcement)).toBeNull();

    fireEvent.click(retry);
    expect(onRetryLookup).not.toHaveBeenCalled();
  });

  // A host with no way to re-read still gets the honest statement. Falling back
  // to either neighbour's copy is what this ticket removes, so the arm may not
  // depend on the retry existing.
  it("still states the failure where no host can re-run the lookup", () => {
    renderStep({ joinableOrganization: { status: "unavailable" } });

    expect(
      screen.getByRole("alert", { name: UNAVAILABLE_COPY.title })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: UNAVAILABLE_COPY.retryLabel })
    ).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(NONE_COPY.title)).toBeNull();
  });

  // review-soul, ISS-11158. One authority answered and the other REPORTED A
  // FAILURE. Offering the Join is right — the shell can honor it — but rendering
  // it as a complete answer is the same collapse in the other direction, so the
  // row says a list went unread. Both halves asserted: the Join is still there,
  // and the failure is stated beside it.
  //
  // The two rows used to be told apart by their WORDING. The 2026-09-28 operator
  // ruling made both state one sentence, so they are told apart by STRUCTURE
  // instead, which is what the last assertion pins: this row is an unnamed
  // `Alert` under a live Join, so no `alert` carries the sentence as its
  // accessible NAME — only the `unavailable` card, which is `aria-labelledby` its
  // own heading, does. Paired with the `getByText` above on the same sentence, so
  // the negative cannot be passing on an empty render.
  it("offers the Join and still says a list went unread on a partial failure", () => {
    renderStep({
      joinableOrganization: {
        join: { authority: OnboardingJoinAuthority.Membership, id: "org_acme" },
        name: "Acme Research",
        partialLookupFailure: true,
        status: "available",
      },
      onRetryLookup: vi.fn(),
    });

    expect(screen.getByRole("button", { name: "Join" })).toBeEnabled();
    expect(screen.getByText("Acme Research")).toBeInTheDocument();
    expect(screen.getByText(PARTIAL_COPY.description)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: PARTIAL_COPY.retryLabel })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("alert", { name: UNAVAILABLE_COPY.title })
    ).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(PENDING_COPY.announcement)).toBeNull();
  });

  // Same survival contract on the partial row, whose Retry re-reads the same
  // pair. The Join beside it must stay live — a busy retry is not a reason to
  // take away an affordance the shell can honor.
  it("keeps the partial-failure Retry mounted and busy while re-reading", () => {
    renderStep({
      joinableOrganization: {
        join: {
          authority: OnboardingJoinAuthority.Invitation,
          id: "inv_1",
        },
        lookupRetrying: true,
        name: "Acme Research",
        partialLookupFailure: true,
        status: "available",
      },
      onRetryLookup: vi.fn(),
    });

    const retry = screen.getByRole("button", {
      name: PARTIAL_COPY.retryingLabel,
    });
    expect(retry).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Join" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: PARTIAL_COPY.retryLabel })
    ).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(PENDING_COPY.announcement)).toBeNull();
  });

  // The sibling that keeps the line above from becoming decoration on every
  // successful lookup: a clean read states nothing.
  it("says nothing about the lookup when both authorities answered", () => {
    renderStep({
      joinableOrganization: {
        join: { authority: OnboardingJoinAuthority.Membership, id: "org_acme" },
        name: "Acme Research",
        status: "available",
      },
      onRetryLookup: vi.fn(),
    });

    expect(screen.getByRole("button", { name: "Join" })).toBeEnabled();
    expect(screen.queryByText(PARTIAL_COPY.description)).toBeNull();
    expect(
      screen.queryByRole("button", { name: PARTIAL_COPY.retryLabel })
    ).toBeNull();
  });

  // ISS-11145. Join must perform the join, not merely advance: the host is handed
  // the target its authority names, and the step never advances by itself.
  it("hands the host the join target the row was offered on", () => {
    const onJoin = vi.fn();
    const onContinue = vi.fn();
    renderStep({ onContinue, onJoin });

    fireEvent.click(screen.getByRole("button", { name: "Join" }));

    expect(onJoin).toHaveBeenCalledWith({
      authority: OnboardingJoinAuthority.Membership,
      id: "org_example",
    });
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("offers no Join where the host gave no way to honor it", () => {
    renderStep({
      joinableOrganization: { name: "Acme Research", status: "available" },
      onJoin: undefined,
    });

    expect(screen.getByText("Acme Research")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
  });

  it("reports the join in progress and withholds a second press", () => {
    const onJoin = vi.fn();
    renderStep({ joining: true, onJoin });
    const joining = screen.getByRole("button", { name: "Joining…" });

    // `aria-disabled`, not `disabled`: a native `disabled` drops focus to
    // `<body>` the instant Join is pressed, so a screen-reader user hears
    // nothing until the error fires. The three assertions are the contract the
    // old single `toBeDisabled()` stood in for — announced, inert, still
    // focusable — and the middle one pins the press the name promises.
    expect(joining).toHaveAttribute("aria-disabled", "true");
    expect(joining).toHaveAttribute("aria-busy", "true");

    fireEvent.click(joining);
    expect(onJoin).not.toHaveBeenCalled();

    joining.focus();
    expect(joining).toHaveFocus();
  });

  it("states a failed join without advancing or claiming the lookup was empty", () => {
    renderStep({
      joinError: "We couldn't accept that invitation.",
    });

    expect(
      screen.getByText("We couldn't accept that invitation.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join" })).toBeEnabled();
    expect(screen.queryByText(NONE_COPY.title)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("reports the chosen organization and advances from the footer", () => {
    const onContinue = vi.fn();
    renderStep({ onContinue, organizationChosen: true });

    expect(screen.getByRole("button", { name: "Selected" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  /**
   * tamsinb, ISS-11253 review. The slug field is controlled, so whatever
   * normalization returns is what the NEXT keystroke appends to. Stripping the
   * trailing hyphen per keystroke means "ada-labs" typed one character at a time
   * lands as "adalabs" — a hyphenated organization URL becomes unreachable by
   * typing, only by pasting.
   *
   * Driven ONE CHARACTER AT A TIME on purpose: the single `fireEvent.change`
   * that a paste looks like is exactly the shape that cannot see this bug.
   */
  it("keeps a hyphen typed one character at a time in the slug", () => {
    renderStep({
      onRename: vi.fn(),
      organizationChosen: true,
      organizationSlug: "acme",
    });

    const slugField = screen.getByLabelText("Slug");
    let typed = "";
    for (const character of "ada-labs") {
      typed += character;
      fireEvent.change(slugField, { target: { value: typed } });
      typed = (slugField as HTMLInputElement).value;
    }

    expect(slugField).toHaveValue("ada-labs");
  });

  /**
   * The counterfactual's other half: a trailing hyphen is still stripped at
   * SAVE, so the field's typing-time tolerance never reaches the URL.
   */
  it("saves a trailing hyphen off the slug", () => {
    const onRename = vi.fn();
    renderStep({
      onRename,
      organizationChosen: true,
      organizationSlug: "acme",
    });

    fireEvent.change(screen.getByLabelText("Slug"), {
      target: { value: "ada-labs-" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(onRename).toHaveBeenCalledWith({
      name: "Example Organization",
      slug: "ada-labs",
    });
  });

  /**
   * tamsinb, ISS-11253 review. A first user who simply accepts the name Clerk
   * invented used to take an `organization.update` round trip that could fail
   * and strand them on a step whose Continue only ever posted a transition.
   */
  it("advances without a write when nothing was edited", () => {
    const onContinue = vi.fn();
    const onRename = vi.fn();
    renderStep({
      onContinue,
      onRename,
      organizationChosen: true,
      organizationSlug: "example-organization",
    });

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(onRename).not.toHaveBeenCalled();
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  /**
   * whitlockk, ISS-11253 review. Leaving Back clickable while the rename is in
   * flight lets the reader post a Back that the completion then beats: the
   * completion advances the run and the Back is rejected as stale, so trying to
   * LEAVE this step lands them on the next one.
   *
   * The enabled case is asserted on the SAME locator, so a Back button that
   * failed to render at all cannot satisfy the disabled half.
   */
  it("locks Back while a rename is in flight", () => {
    const shared = {
      onBack: vi.fn(),
      onRename: vi.fn(),
      organizationChosen: true,
      organizationSlug: "acme",
    };
    renderStep({ ...shared, renaming: false });
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(shared.onBack).toHaveBeenCalledTimes(1);

    cleanup();
    shared.onBack.mockClear();

    renderStep({ ...shared, renaming: true });
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(shared.onBack).not.toHaveBeenCalled();
  });
});
