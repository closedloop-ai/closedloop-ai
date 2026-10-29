"use client";

import { OnboardingCtaId } from "@repo/api/src/types/onboarding-analytics";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { DialogDescription } from "@repo/design-system/components/ui/dialog";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  AlertCircle,
  Building2Icon,
  Loader2Icon,
  PlusIcon,
} from "lucide-react";
import { type ComponentProps, type ReactNode, useId, useState } from "react";
import { useOnboardingCtaAnalytics } from "../hooks/use-onboarding-analytics";
import { createOrganizationReadyEvent } from "../lib/guided-onboarding-events";
import type {
  OnboardingAccount,
  OnboardingJoinableOrganization,
  OnboardingOrganizationJoin,
} from "./guided-onboarding-data";
import {
  createOrganizationSlug,
  GuidedOnboardingOrganizationFields,
} from "./guided-onboarding-organization-fields";
import {
  GUIDED_ONBOARDING_STEP_BODY_CLASS,
  GUIDED_ONBOARDING_STEP_FOOTER_CLASS,
  GUIDED_ONBOARDING_STEP_SCROLL_CLASS,
  GuidedOnboardingBackButton,
  GuidedOnboardingPhaseHeading,
  GuidedOnboardingPrimaryPlaceholder,
} from "./guided-onboarding-step-layout";
import type { GuidedOnboardingPhaseSource } from "./guided-onboarding-types";
import { ONBOARDING_STATUS_UNAVAILABLE_COPY } from "./onboarding-status-unavailable";

export function GuidedOnboardingChooseOrganizationStep({
  account,
  brand,
  existingOrganizationLogo,
  joinableOrganization,
  joinError,
  joining,
  onBack,
  onContinue,
  onCreateNew,
  onJoin,
  onRename,
  onRetryLookup,
  onSignOut,
  organizationChosen,
  organizationSlug = "",
  privacyHref,
  renameError = null,
  renaming = false,
  termsHref,
}: {
  account: OnboardingAccount;
  brand: ReactNode;
  existingOrganizationLogo?: ReactNode;
  joinableOrganization: OnboardingJoinableOrganization;
  joinError?: string | null;
  joining?: boolean;
  onBack?: () => void;
  onContinue: () => void;
  onCreateNew?: () => void;
  onJoin?: (join: OnboardingOrganizationJoin) => void;
  /**
   * Renames the organization the session is ALREADY acting in, then advances.
   * Supplying it is what renders the editable name and slug; a host with no
   * rename capability — desktop — supplies nothing and the step stays a
   * confirmation (ISS-11253 AC3). It is never a create: the duplicate
   * organization ISS-11090 fixed came from routing this step to
   * CreateOrganization, and nothing here calls that path.
   */
  onRename?: (organization: { name: string; slug: string }) => void;
  /**
   * Re-runs the membership/invitation lookup after it FAILED. Supplying it is
   * what gives the `unavailable` arm its Retry — a host with no way to re-read
   * supplies nothing and the arm still states the failure rather than borrowing
   * the pending skeleton's sentence (ISS-11158). While that re-read is in
   * flight the arm carries `lookupRetrying` and the control stays mounted and
   * busy, so pressing it does not unmount it under the keyboard.
   */
  onRetryLookup?: () => void;
  onSignOut?: () => void;
  organizationChosen: boolean;
  /** The active organization's current slug, for the editable field. */
  organizationSlug?: string;
  privacyHref: string;
  /** Why the last rename failed, or `null`. Host-owned and host-worded. */
  renameError?: string | null;
  /** Whether a rename is in flight. Host-owned. */
  renaming?: boolean;
  termsHref: string;
}) {
  const { captureCtaClick } = useOnboardingCtaAnalytics();
  const activeOrganizationName =
    joinableOrganization.status === "available"
      ? joinableOrganization.name
      : "";
  // Only the EDITS are state; an untouched field tracks the resolved
  // organization. The lookup can complete after this step mounts — it starts at
  // `unknown` — and `useState(activeOrganizationName)` would have frozen the
  // empty initial read, handing that user a blank name to save.
  const [editedName, setEditedName] = useState<string | null>(null);
  const [editedSlug, setEditedSlug] = useState<string | null>(null);
  const [slugEdited, setSlugEdited] = useState(false);
  const name = editedName ?? activeOrganizationName;
  // Same fallback the create step uses: an unresolved slug proposes one from the
  // name rather than leaving the field — and therefore `Continue` — empty.
  const slug =
    editedSlug ??
    (organizationSlug || createOrganizationSlug(activeOrganizationName));
  // The first user's organization is the one Clerk's task already made, so the
  // editable pair is offered only where there IS one to rename and the host can
  // actually persist the rename.
  const naming =
    Boolean(onRename) &&
    organizationChosen &&
    joinableOrganization.status === "available";
  const savedName = name.trim();
  // The slug SAVES fully normalized. The field keeps a trailing hyphen while it
  // is typed — stripping it per keystroke makes "ada-labs" unreachable by
  // typing — so the strip happens here, once, at the boundary that persists it.
  const savedSlug = createOrganizationSlug(slug);
  const canSaveName = savedName.length > 0 && savedSlug.length > 0;
  // Nothing edited is not a write. Every first user who simply accepts the name
  // Clerk invented used to take an `organization.update` round trip that could
  // fail and strand them on a step whose Continue only ever posted a transition
  // (tamsinb, ISS-11253 review).
  const nameUnchanged =
    savedName === activeOrganizationName && savedSlug === organizationSlug;
  const submitNaming = () => {
    if (renaming) {
      return;
    }
    if (nameUnchanged) {
      onContinue();
      return;
    }
    if (canSaveName) {
      onRename?.({ name: savedName, slug: savedSlug });
    }
  };
  return (
    <div className={GUIDED_ONBOARDING_STEP_BODY_CLASS}>
      <div className={GUIDED_ONBOARDING_STEP_SCROLL_CLASS}>
        <div className="h-7 w-fit">{brand}</div>
        <div className="mx-auto mt-14 w-full max-w-md">
          {naming && renameError !== null ? (
            <Alert className="mb-4" variant="error">
              <AlertCircle />
              <AlertDescription>{renameError}</AlertDescription>
            </Alert>
          ) : null}
          <section className="overflow-hidden rounded-xl border bg-background shadow-sm">
            <GuidedOnboardingPhaseHeading className="border-b px-6 py-7 text-center font-semibold text-2xl tracking-tight">
              Choose an organization
            </GuidedOnboardingPhaseHeading>
            <DialogDescription className="sr-only">
              {organizationChosen
                ? "Review your selected organization or create a new one."
                : "Choose an organization available to this account or create a new one."}
            </DialogDescription>
            {naming ? (
              <EditableOrganizationRow
                logo={existingOrganizationLogo}
                name={name}
                onNameChange={(nextName) => {
                  setEditedName(nextName);
                  // The organization already HAS a slug, and a slug is a URL the
                  // reader may have deliberately set — so unlike the create
                  // step, where the name PROPOSES a slug for a value that does
                  // not exist yet, typing a name here only touches the slug
                  // while there is no real one to destroy.
                  if (!(slugEdited || organizationSlug)) {
                    setEditedSlug(createOrganizationSlug(nextName));
                  }
                }}
                onSlugChange={(nextSlug) => {
                  setSlugEdited(true);
                  setEditedSlug(nextSlug);
                }}
                onSubmit={submitNaming}
                slug={slug}
              />
            ) : (
              <JoinableOrganizationRow
                joining={joining === true}
                logo={existingOrganizationLogo}
                onJoin={onJoin}
                onRetryLookup={onRetryLookup}
                organization={joinableOrganization}
                organizationChosen={organizationChosen}
              />
            )}
            {/* Flush inside the card's row stack so it takes the ROW's
                horizontal padding rather than `Alert`'s own tighter `px-3`, with
                a neutral rule — the `error` variant's tinted border would make
                this the one hairline in the card that is not `--border`. The
                naming arm has no join to fail, and states its own failure in the
                alert above the card, so a stale join error never renders there. */}
            {!naming && joinError ? (
              <Alert
                className="rounded-none border-0 border-border border-b px-5 py-3"
                variant="error"
              >
                <AlertCircle />
                <AlertDescription>{joinError}</AlertDescription>
              </Alert>
            ) : null}
            <CreateOrganizationRow onCreateNew={onCreateNew} />
          </section>
          <div className="mt-4 flex items-center gap-3 px-5 text-muted-foreground text-sm">
            <span className="min-w-0 flex-1 truncate">
              {account.status === "signed-in"
                ? `Signed in as ${account.email}`
                : "Signed in"}
            </span>
            {onSignOut ? (
              <button
                className="shrink-0 font-medium text-foreground hover:underline"
                onClick={() => {
                  captureCtaClick({
                    ctaId: OnboardingCtaId.SignOut,
                    step: OnboardingPhase.ChooseOrganization,
                  });
                  onSignOut();
                }}
                type="button"
              >
                Sign out
              </button>
            ) : null}
          </div>
          <div className="mt-5 flex justify-center gap-4 border-t pt-5 text-muted-foreground text-xs">
            <a
              className="hover:text-foreground"
              href={privacyHref}
              onClick={() =>
                captureCtaClick({
                  ctaId: OnboardingCtaId.PrivacyPolicy,
                  step: OnboardingPhase.ChooseOrganization,
                })
              }
              rel="noreferrer"
              target="_blank"
            >
              Privacy
            </a>
            <a
              className="hover:text-foreground"
              href={termsHref}
              onClick={() =>
                captureCtaClick({
                  ctaId: OnboardingCtaId.Terms,
                  step: OnboardingPhase.ChooseOrganization,
                })
              }
              rel="noreferrer"
              target="_blank"
            >
              Terms
            </a>
          </div>
        </div>
      </div>
      <div className={GUIDED_ONBOARDING_STEP_FOOTER_CLASS}>
        <GuidedOnboardingBackButton
          disabled={naming && renaming}
          onBack={onBack}
        />
        <ChooseOrganizationPrimaryAction
          canSaveName={canSaveName}
          naming={naming}
          onContinue={onContinue}
          onSaveName={submitNaming}
          organizationChosen={organizationChosen}
          renaming={renaming}
        />
      </div>
    </div>
  );
}

/**
 * The row offering an organization to join. Only a completed authorized lookup
 * renders a Join affordance — an unknown lookup gets the pending treatment, a
 * failed one says it could not be completed (and keeps saying so through its own
 * retry), and an empty lookup says so, rather than any of them borrowing
 * another's copy. The shipped version hard-coded
 * "Closedloop" here regardless of who was signing up.
 */
function JoinableOrganizationRow({
  joining,
  logo,
  onJoin,
  onRetryLookup,
  organization,
  organizationChosen,
}: {
  joining: boolean;
  logo?: ReactNode;
  onJoin?: (join: OnboardingOrganizationJoin) => void;
  onRetryLookup?: () => void;
  organization: OnboardingJoinableOrganization;
  organizationChosen: boolean;
}) {
  if (organization.status === "unknown") {
    return (
      <div className="flex items-center gap-4 border-b px-5 py-4" role="status">
        <Skeleton className="size-10 shrink-0 rounded-lg" />
        <Skeleton className="h-4 w-40" />
        <span className="sr-only">
          {CHOOSE_ORGANIZATION_LOOKUP_PENDING_COPY.announcement}
        </span>
      </div>
    );
  }

  if (organization.status === "unavailable") {
    return (
      <JoinableLookupUnavailableRow
        onRetry={onRetryLookup}
        retrying={organization.lookupRetrying === true}
      />
    );
  }

  if (organization.status === "none") {
    return (
      <div className="border-b">
        <EmptyState
          description={CHOOSE_ORGANIZATION_LOOKUP_NONE_COPY.description}
          icon={Building2Icon}
          size="compact"
          title={CHOOSE_ORGANIZATION_LOOKUP_NONE_COPY.title}
        />
      </div>
    );
  }

  // The organization the account has ALREADY activated needs no join, so the row
  // reports the selection and the footer advances. One the account has not
  // activated carries a `join` target, and pressing Join performs it through the
  // host — the button never reports a join the host did not make, which is why
  // it is not offered at all when there is no way to honor it.
  const joinTarget = organization.join;
  const canJoin = Boolean(joinTarget && onJoin);
  return (
    <>
      <div className="flex items-center gap-4 border-b px-5 py-4">
        {logo}
        <span className="font-medium text-sm">{organization.name}</span>
        <JoinableOrganizationAction
          canJoin={canJoin}
          joining={joining}
          onJoin={() => {
            if (joinTarget && onJoin) {
              onJoin(joinTarget);
            }
          }}
          organizationChosen={organizationChosen}
        />
      </div>
      {organization.partialLookupFailure === true ? (
        <JoinableLookupPartialFailureRow
          onRetry={onRetryLookup}
          retrying={organization.lookupRetrying === true}
        />
      ) : null}
    </>
  );
}

function JoinableOrganizationAction({
  canJoin,
  joining,
  onJoin,
  organizationChosen,
}: {
  canJoin: boolean;
  joining: boolean;
  onJoin: () => void;
  organizationChosen: boolean;
}) {
  if (organizationChosen) {
    return (
      <Button
        className="ml-auto"
        disabled
        size="sm"
        type="button"
        variant="outline"
      >
        Selected
      </Button>
    );
  }
  if (!canJoin) {
    return null;
  }
  // `aria-disabled` rather than `disabled`: a real `disabled` drops focus to
  // `<body>` the instant Join is pressed, so a screen-reader user hears nothing
  // at all until the error fires. This keeps focus on the control and lets
  // `aria-busy` announce the pending state, matching
  // `onboarding-status-unavailable.tsx`'s retry button.
  return (
    <Button
      aria-busy={joining}
      aria-disabled={joining}
      className="ml-auto aria-disabled:opacity-50"
      onClick={joining ? undefined : onJoin}
      size="sm"
      type="button"
      variant="outline"
    >
      {joining ? <Loader2Icon className="animate-spin" /> : null}
      {joining ? "Joining…" : "Join"}
    </Button>
  );
}

export function selectChooseOrganizationStepProps(
  source: GuidedOnboardingPhaseSource
): ComponentProps<typeof GuidedOnboardingChooseOrganizationStep> {
  return {
    account: source.account,
    brand: source.brand,
    existingOrganizationLogo: source.existingOrganizationLogo,
    joinableOrganization: source.joinableOrganization,
    joinError: source.organizationJoinError,
    joining: source.organizationJoining,
    onBack: source.onBack,
    onContinue: () => {
      if (source.onContinueFromOrganization) {
        source.onContinueFromOrganization(createOrganizationReadyEvent());
        return;
      }
      source.onComplete();
    },
    onCreateNew: source.onStartCreateOrganization,
    onJoin: source.onJoinOrganization,
    onRename: source.onRenameOrganization
      ? (organization) =>
          source.onRenameOrganization?.(
            organization,
            createOrganizationReadyEvent()
          )
      : undefined,
    onRetryLookup: source.onRetryJoinableOrganizationLookup,
    onSignOut: source.onSignOut,
    organizationChosen: source.organizationChosen,
    organizationSlug: source.organizationSlug,
    privacyHref: source.privacyHref,
    renameError: source.organizationRenameError,
    renaming: source.organizationRenaming,
    termsHref: source.termsHref,
  };
}

/**
 * The active organization as an editable name and slug, in the row that
 * otherwise shows its name beside a disabled `Selected` (ISS-11253).
 *
 * The name is stated ONCE: the field replaces the static label rather than
 * sitting beneath it, so the row does not say the same name twice, and the dead
 * disabled button is gone with it. Saving is the footer's `Continue`, which is
 * why this carries no action of its own — the inner `form` exists so Enter in
 * either field reaches the same submit the button does.
 */
function EditableOrganizationRow({
  logo,
  name,
  onNameChange,
  onSlugChange,
  onSubmit,
  slug,
}: {
  logo?: ReactNode;
  name: string;
  onNameChange: (name: string) => void;
  onSlugChange: (slug: string) => void;
  onSubmit: () => void;
  slug: string;
}) {
  return (
    <div className="border-b px-6 py-6">
      <div className="flex items-start gap-4">
        {logo}
        <form
          className="grid min-w-0 flex-1 gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <GuidedOnboardingOrganizationFields
            name={name}
            nameInputId="chosen-organization-name"
            onNameChange={onNameChange}
            onSlugChange={onSlugChange}
            slug={slug}
            slugInputId="chosen-organization-slug"
          />
        </form>
      </div>
    </div>
  );
}

/**
 * The step's single primary action. `Continue` either confirms the chosen
 * organization or saves an edited name first — the naming host's save IS this
 * button, so the step grows no second action row, and a step with nothing chosen
 * still renders the placeholder that reserves its height.
 */
function ChooseOrganizationPrimaryAction({
  canSaveName,
  naming,
  onContinue,
  onSaveName,
  organizationChosen,
  renaming,
}: {
  canSaveName: boolean;
  naming: boolean;
  onContinue: () => void;
  onSaveName: () => void;
  organizationChosen: boolean;
  renaming: boolean;
}) {
  if (!organizationChosen) {
    return <GuidedOnboardingPrimaryPlaceholder />;
  }
  return (
    <Button
      aria-busy={naming ? renaming : undefined}
      className="w-full sm:w-56"
      disabled={naming && !(canSaveName && !renaming)}
      onClick={naming ? onSaveName : onContinue}
      size="lg"
      type="button"
    >
      {naming && renaming ? <Loader2Icon className="animate-spin" /> : null}
      Continue
    </Button>
  );
}

/**
 * The "Create new organization" row. No production host supplies `onCreateNew`,
 * so it renders on neither shell: the CreateOrganization phase has no edge out
 * of this step in `PHASE_EDGES`, deliberately, because routing there created a
 * SECOND organization for a first user whose organization Clerk's task had
 * already made (ISS-11090). Naming lives on this step instead (ISS-11253).
 */
function CreateOrganizationRow({ onCreateNew }: { onCreateNew?: () => void }) {
  if (!onCreateNew) {
    return null;
  }
  return (
    <button
      className="flex w-full items-center gap-4 px-5 py-4 text-left text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      onClick={onCreateNew}
      type="button"
    >
      <span className="flex size-7 items-center justify-center rounded-full border border-muted-foreground border-dashed">
        <PlusIcon className="size-4" />
      </span>
      <span className="font-medium text-sm">Create new organization</span>
    </button>
  );
}

/**
 * The sentence BOTH failure rows state, whole and partial.
 *
 * Operator ruling, Marisol Ashgrove, 2026-09-28, verbatim: *"Use \"We couldn't check
 * for organizations to join.\" in both places & apply the warning-acknowledged
 * label"*. That is the provenance for these words; root `AGENTS.md` forbids an
 * agent originating any of them, so do not reword, re-case, or drop the period
 * without a further ruling.
 *
 * It is ONE constant because it is now ONE string. The two rows had two
 * different sentences before the ruling, and two copies of an identical literal
 * is the SSOT drift the repo names by hand; the two copy objects below differ in
 * the SLOT the sentence fills (a card title against a row description) and read
 * it from here.
 *
 * It states what could not be done and never why: one row covers a network
 * error, a provider error, and a response this bundle could not read, and any
 * cause it named would be false for two of the three.
 */
export const CHOOSE_ORGANIZATION_LOOKUP_FAILURE_SENTENCE =
  "We couldn't check for organizations to join.";

/**
 * Copy for the `unavailable` arm — the membership/invitation lookup REPORTED a
 * failure (ISS-11158).
 *
 * The title must not say "no authorized organization is ready to join", which is
 * a claim about data the shell never received, and must not say a check is in
 * progress, which is what the pending skeleton says and what a settled failure
 * makes false.
 *
 * Both retry WORDS come from {@link ONBOARDING_STATUS_UNAVAILABLE_COPY}: onboarding
 * already owns that label and its in-flight spelling, and a second spelling of
 * either would be the same control under two names.
 */
export const CHOOSE_ORGANIZATION_LOOKUP_UNAVAILABLE_COPY = {
  title: CHOOSE_ORGANIZATION_LOOKUP_FAILURE_SENTENCE,
  description: "Retry, or reload if this keeps happening.",
  retryLabel: ONBOARDING_STATUS_UNAVAILABLE_COPY.retryLabel,
  retryingLabel: ONBOARDING_STATUS_UNAVAILABLE_COPY.retryingLabel,
} as const;

/**
 * The failed-lookup row. Flush inside the card's row stack for the same reason
 * the join-error alert is, and named by its own heading so the row the reader
 * lands on is the one a screen reader announces.
 *
 * Retry is offered only where a host can actually re-read. Without one the arm
 * still renders: stating the failure with no escape is honest, and falling back
 * to either neighbouring arm's copy is not.
 *
 * The card SURVIVES its own retry. `aria-disabled` rather than `disabled`, and
 * the row kept mounted rather than swapped for the pending skeleton, because
 * either would unmount the control the reader just pressed and drop keyboard
 * focus to the dialog container. The title is past tense, so it stays true
 * while the new read runs, and the busy label says a check is happening —
 * the pair `onboarding-status-unavailable.tsx` already ships for the same
 * reason (ISS-11158 review, tamsinb).
 */
function JoinableLookupUnavailableRow({
  onRetry,
  retrying = false,
}: {
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const titleId = useId();
  const copy = CHOOSE_ORGANIZATION_LOOKUP_UNAVAILABLE_COPY;
  return (
    <Alert
      aria-labelledby={titleId}
      className="rounded-none border-0 border-border border-b px-5 py-4"
      variant="error"
    >
      <AlertCircle />
      <AlertTitle id={titleId}>{copy.title}</AlertTitle>
      <AlertDescription>
        <p>{copy.description}</p>
        {onRetry ? (
          <Button
            aria-busy={retrying}
            aria-disabled={retrying}
            className="mt-3 aria-disabled:opacity-50"
            onClick={retrying ? undefined : onRetry}
            size="sm"
            type="button"
            variant="outline"
          >
            {retrying ? <Loader2Icon className="animate-spin" /> : null}
            {retrying ? copy.retryingLabel : copy.retryLabel}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Copy for a lookup that PARTLY answered — one authority reported a candidate,
 * another reported a failure (ISS-11158, review-soul).
 *
 * This used to carry a deliberately weaker second sentence, on the reasoning that
 * the whole-lookup one would be false beside a Join the shell can honor. The
 * 2026-09-28 operator ruling quoted on
 * {@link CHOOSE_ORGANIZATION_LOOKUP_FAILURE_SENTENCE} replaced both with that one
 * string, so the distinction is retired rather than merely unimplemented.
 *
 * What still distinguishes the two rows is STRUCTURE, not wording, and the suite
 * pins it there: this row is an unnamed `Alert` BENEATH a live Join, while the
 * `unavailable` card is an `Alert` named by its own heading and standing in place
 * of one.
 */
export const CHOOSE_ORGANIZATION_LOOKUP_PARTIAL_COPY = {
  description: CHOOSE_ORGANIZATION_LOOKUP_FAILURE_SENTENCE,
  retryLabel: ONBOARDING_STATUS_UNAVAILABLE_COPY.retryLabel,
  retryingLabel: ONBOARDING_STATUS_UNAVAILABLE_COPY.retryingLabel,
} as const;

/**
 * The partial-failure line, beneath the Join row rather than in place of it.
 *
 * It must not block: the Join above is a real affordance the shell can honor, and
 * this row only says the list behind it may be short. Same flush in-card
 * treatment as the join-error row for the same reason — it takes the card's
 * horizontal padding and keeps the one neutral hairline.
 *
 * Deliberately UNNAMED — no `AlertTitle`, no `aria-labelledby`. It is a line
 * beside a live Join, not the landing point the `unavailable` card is, and since
 * the 2026-09-28 ruling gave both rows one sentence that difference is the only
 * thing telling them apart. Naming this alert would collapse them, which is what
 * the partial-failure case in the step's suite asserts against.
 */
function JoinableLookupPartialFailureRow({
  onRetry,
  retrying = false,
}: {
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const copy = CHOOSE_ORGANIZATION_LOOKUP_PARTIAL_COPY;
  return (
    <Alert
      className="rounded-none border-0 border-border border-b px-5 py-3"
      variant="error"
    >
      <AlertCircle />
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>{copy.description}</span>
        {onRetry ? (
          <Button
            aria-busy={retrying}
            aria-disabled={retrying}
            className="aria-disabled:opacity-50"
            onClick={retrying ? undefined : onRetry}
            size="sm"
            type="button"
            variant="outline"
          >
            {retrying ? <Loader2Icon className="animate-spin" /> : null}
            {retrying ? copy.retryingLabel : copy.retryLabel}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Copy for the `unknown` arm — the membership/invitation lookup has NOT
 * reported yet.
 *
 * Exported for the same reason the two failure copies are: the step's suite
 * asserts this sentence ABSENT on every other arm, and an absence assertion
 * that carries its own spelling of the text goes on passing after the component
 * stops rendering it. There is one string, and the tests locate it through this
 * constant.
 */
export const CHOOSE_ORGANIZATION_LOOKUP_PENDING_COPY = {
  announcement: "Checking for organizations you can join",
} as const;

/**
 * Copy for the `none` arm — the lookup reported, produced nothing, and did not
 * fail.
 *
 * Exported for the absence-assertion reason given on
 * {@link CHOOSE_ORGANIZATION_LOOKUP_PENDING_COPY}: the `unknown` and
 * `unavailable` arms each assert this title absent, and neither may hold its own
 * copy of it.
 */
export const CHOOSE_ORGANIZATION_LOOKUP_NONE_COPY = {
  title: "No authorized organization is ready to join",
  description:
    "Create a new organization below, or sign in with the account that received an invitation.",
} as const;
