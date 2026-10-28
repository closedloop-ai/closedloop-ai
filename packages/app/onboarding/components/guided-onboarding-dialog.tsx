"use client";

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  Dialog,
  DialogContent,
} from "@repo/design-system/components/ui/dialog";
import { type RefObject, useEffect, useRef, useState } from "react";
import { privacyPolicyHref, termsOfServiceHref } from "../lib/legal-links";
import {
  OnboardingDesktopSkipEligibility,
  onboardingAnalysisHasStarted,
  UNKNOWN_ACCOUNT,
  UNKNOWN_ANALYSIS_PROGRESS,
  UNKNOWN_GITHUB_CONNECTION,
  UNKNOWN_JOINABLE_ORGANIZATION,
  UNKNOWN_ORGANIZATION_MEMBERS,
  UNKNOWN_SESSION_DISCOVERY,
} from "./guided-onboarding-data";
import { GUIDED_ONBOARDING_PHASES } from "./guided-onboarding-phase-registry";
import { GuidedOnboardingRestoringStep } from "./guided-onboarding-restoring-step";
import type {
  GuidedOnboardingDialogProps,
  GuidedOnboardingPhaseSource,
  WizardPhase,
} from "./guided-onboarding-types";

/**
 * The blocking onboarding modal. It owns the chrome — the non-dismissible
 * dialog, the restoring override — and nothing else: which component a phase
 * renders, and which props it gets, are stated once in
 * `guided-onboarding-phase-registry.tsx`, so a new phase never edits this file.
 *
 * No `phase` renders NO wizard screen, deliberately. Defaulting it would put
 * back at runtime exactly the fallthrough the registry's compile-time
 * exhaustiveness exists to remove: a host that has left the wizard's rendered
 * set — resting at `dashboard_available` — would be handed a plausible screen
 * instead of none. That default was visible, not theoretical, because the
 * dialog stays mounted through its ~200ms exit animation: the wizard faded out
 * on the WELCOME screen after the user finished it (ISS-8345).
 *
 * What "no wizard screen" leaves behind depends on `open`, which is an
 * INDEPENDENT prop rather than one this component can derive. Closing, the body
 * is empty, so the fade carries nothing the reader never saw. OPEN, it is the
 * restoring step: an empty body there is a card with every dismissal path
 * prevented below and no `DialogTitle` — inescapable, and nameless to a screen
 * reader. Neither branch guesses a wizard screen, which is the property that
 * matters.
 */
export function GuidedOnboardingDialog({
  account = UNKNOWN_ACCOUNT,
  accountCreated = false,
  accountMethod = null,
  accountPendingMethod = null,
  accountSignInError = null,
  analysisStarted,
  allowStagedOrganizationLogo = false,
  allowSkipAccount,
  desktopSkipEligibility = OnboardingDesktopSkipEligibility.Unknown,
  annotations = {},
  brand,
  desktopAppDownloaded = false,
  desktopAppRunning = false,
  desktopMode = true,
  discovery = UNKNOWN_SESSION_DISCOVERY,
  downloadHrefs,
  installerGapFollowUp,
  inviteOutcome,
  platformOverride,
  existingOrganizationLogo,
  githubConnectError = null,
  githubConnecting = false,
  githubConnection = UNKNOWN_GITHUB_CONNECTION,
  invitedEmails = [],
  joinableOrganization = UNKNOWN_JOINABLE_ORGANIZATION,
  members = UNKNOWN_ORGANIZATION_MEMBERS,
  newOrganizationLogo,
  onBack,
  onComplete,
  onConnectGitHub,
  onCreateOrganization,
  onContinue,
  onContinueFromDownload,
  onContinueWithoutInstalling,
  onContinueFromGitHub,
  onContinueFromInvites,
  onContinueFromOrganization,
  onJoinOrganization,
  onContinueFromSync,
  onContinueWithEmail,
  onContinueWithGitHub,
  onContinueWithGoogle,
  onDownloadApp,
  onInviteTeam,
  onRenameOrganization,
  onRetryJoinableOrganizationLookup,
  onUploadOrganizationLogo,
  onSignIn,
  onSignOut,
  onSkipAccount,
  onSkipDownload,
  onSkipGitHub,
  onSkipInvites,
  onStart,
  onStartCreateOrganization,
  onSyncLevelChange,
  open,
  organizationChosen = false,
  organizationCreationError = null,
  organizationCreating = false,
  organizationJoinError = null,
  organizationJoining = false,
  organizationName = "",
  organizationRenameError = null,
  organizationRenaming = false,
  organizationSlug = "",
  phase,
  privacyHref = privacyPolicyHref(),
  progress = UNKNOWN_ANALYSIS_PROGRESS,
  restoring = false,
  stepNotices,
  syncError = null,
  syncLevel = DataSyncLevel.Full,
  syncSaving = false,
  termsHref = termsOfServiceHref(),
}: GuidedOnboardingDialogProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [uncontrolledSyncLevel, setUncontrolledSyncLevel] = useState(syncLevel);
  const selectedSyncLevel = onSyncLevelChange
    ? syncLevel
    : uncontrolledSyncLevel;
  const handleSyncLevelChange = onSyncLevelChange ?? setUncontrolledSyncLevel;
  const accountSkipAllowed = desktopMode && (allowSkipAccount ?? true);
  // Resolved here rather than in the step's selector, so a host that gates the
  // machine edge on its own answer hands that exact boolean to the button. A
  // caller with no machine behind it (the prototype shell, the phase catalog)
  // gets the shared derivation instead of a second, drifting rule.
  const analysisHasStarted =
    analysisStarted ?? onboardingAnalysisHasStarted(discovery, progress);

  const source: GuidedOnboardingPhaseSource = {
    account,
    accountCreated,
    accountMethod,
    accountPendingMethod,
    accountSignInError,
    allowSkipAccount: accountSkipAllowed,
    analysisStarted: analysisHasStarted,
    allowStagedOrganizationLogo,
    annotations,
    brand,
    desktopAppDownloaded,
    desktopAppRunning,
    desktopMode,
    desktopSkipEligibility,
    discovery,
    downloadHrefs,
    existingOrganizationLogo,
    installerGapFollowUp,
    githubConnectError,
    githubConnecting,
    githubConnection,
    inviteOutcome,
    invitedEmails,
    joinableOrganization,
    members,
    newOrganizationLogo,
    onBack,
    onComplete,
    onConnectGitHub,
    onContinue,
    onContinueFromDownload,
    onContinueWithoutInstalling,
    onContinueFromGitHub,
    onContinueFromInvites,
    onContinueFromOrganization,
    onJoinOrganization,
    onContinueFromSync,
    onContinueWithEmail,
    onContinueWithGitHub,
    onContinueWithGoogle,
    onCreateOrganization,
    onDownloadApp,
    onInviteTeam,
    onRenameOrganization,
    onRetryJoinableOrganizationLookup,
    onSignIn,
    onSignOut,
    onSkipAccount,
    onSkipDownload,
    onSkipGitHub,
    onSkipInvites,
    onStart,
    onStartCreateOrganization,
    onSyncLevelChange: handleSyncLevelChange,
    onUploadOrganizationLogo,
    organizationChosen,
    organizationCreationError,
    organizationCreating,
    organizationJoinError,
    organizationJoining,
    organizationName,
    organizationRenameError,
    organizationRenaming,
    organizationSlug,
    platformOverride,
    privacyHref,
    progress,
    stepNotices,
    syncError,
    syncLevel: selectedSyncLevel,
    syncSaving,
    termsHref,
  };

  // Bounded to `open` on purpose: the CLOSED beat must stay empty so the exit
  // fade carries no screen, while an open dialog can never be an empty blocking
  // card. `restoring` stays authoritative when the host sets it.
  const showRestoringBody = restoring || (open && !phase);

  const phaseAnnouncement = useAnnounceBodyChange(
    contentRef,
    open,
    showRestoringBody ? RESTORING_BODY : phase
  );

  return (
    <Dialog open={open}>
      <DialogContent
        // ISS-11315: `focus:outline-hidden` because this card is the programmatic
        // landing point for a step change and is `tabIndex={-1}` — never in the
        // tab order, never reached by Tab — so it is not a control WCAG 2.4.7
        // owes a visible indicator. Every control INSIDE it keeps its own ring
        // untouched; this suppresses the browser's ring on the container alone,
        // which is the ring a reader would otherwise meet on arriving at a step.
        className="grid-cols-1 gap-0 overflow-hidden p-0 transition-none focus:outline-hidden"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        ref={contentRef}
        showCloseButton={false}
        size="large"
      >
        {/* The step change, spoken. Polite so it never interrupts, `sr-only` so
            it is invisible, and outside the body so a phase swap cannot unmount
            the region before it is read.
            `aria-live` WITHOUT `role="status"`, deliberately: the ambient
            analysis banner is a `role="status"` sibling that several suites
            locate by that role alone, and a second one inside the dialog makes
            those queries ambiguous. `role="status"` is shorthand for a polite
            region PLUS `aria-atomic`, so the atomic half is restated here
            rather than lost — without it a reader is told to announce the
            changed descendants instead of re-reading the whole sentence, which
            is not the same instruction across readers. */}
        <span
          aria-atomic="true"
          aria-live="polite"
          className="sr-only"
          data-slot="guided-onboarding-announcement"
        >
          {phaseAnnouncement}
        </span>
        {showRestoringBody ? (
          <GuidedOnboardingRestoringStep brand={brand} />
        ) : (
          renderPhaseBody(phase, source)
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The phase's screen, or nothing at all. A host legitimately holds no wizard
 * phase while the dialog is closing — it is resting past the last one — and the
 * shell owes that beat an empty body rather than a guess. An OPEN dialog never
 * reaches the empty branch: the caller routes it to the restoring step instead.
 */
function renderPhaseBody(
  phase: WizardPhase | undefined,
  source: GuidedOnboardingPhaseSource
) {
  if (!phase) {
    return null;
  }
  return GUIDED_ONBOARDING_PHASES[phase].render(source);
}

/**
 * Which body the dialog is showing, for focus purposes only. The restoring
 * screen is not a phase — it is chrome that overrides the body — so it needs an
 * identity of its own here, or a phase change that happened underneath it would
 * be spent while the reader could not see it and the real arrival would move
 * nothing.
 */
const RESTORING_BODY = "restoring";

/**
 * Keep the reader inside the dialog after a step change, and say which step
 * they are now on.
 *
 * WCAG 2.4.3 Focus Order (Level A). A phase change unmounts whatever control
 * the user was on; focus falls back to `document.body`, so a keyboard or screen
 * reader user loses their position inside a dialog they are not allowed to
 * dismiss, and nothing announces the screen they were moved to.
 *
 * ISS-11315 SPLIT THOSE TWO JOBS, because one element was doing both badly.
 * This used to call `.focus()` on the heading, which fixed the position and
 * announced the step — and painted a focus ring on a title a mouse user had
 * arrived at without touching anything. The operator reported it against a
 * fresh install and ruled the heading must not take focus or show a border at
 * all, so neither a `:focus-visible` variant nor a suppressed outline is the
 * answer here.
 *
 * POSITION is now kept by landing on the dialog CONTENT element, which is
 * where Radix parks focus on open anyway and which is `tabIndex={-1}` and out
 * of the tab order — so the reader stays inside the card they cannot dismiss
 * and Tab continues from the top of it.
 *
 * The ANNOUNCEMENT is now a polite live region carrying the rendered heading's
 * own text (`[data-slot="dialog-title"]`, the design system's marker on
 * `DialogTitle`, which every phase already owes). It is read from the DOM
 * rather than threaded down, so it originates no copy and tracks the heading a
 * step actually renders — including a heading a step REWRITES IN PLACE, which
 * an arrival-keyed announcement would have held at its first sentence. A live
 * region is also the mechanism that survives the case a re-focus does not:
 * focus already sitting on the content element does not re-announce when only
 * the body beneath it changed.
 *
 * An ARRIVAL is what moves focus, so the dependency list is half the guard:
 * re-running this on every render would drag focus off whatever control the
 * user is currently in.
 *
 * A CLOSING dialog is not an arrival either, which is why `open` is a guard
 * rather than only an input to the body. Radix holds `DialogContent` mounted
 * through the exit animation, and this effect runs on the closing commit while
 * that content is still there — so a host whose teardown turns `restoring` back
 * on gets the restoring body, a heading to find, and the reader's LAST
 * announcement is "Restoring your setup" from a card that is already fading
 * out. `open` false means the reader is leaving; nothing here may speak.
 *
 * The other half is that an arrival RESCUES focus and never takes it. A body
 * whose own control claims focus as it mounts — create-organization
 * autofocuses Name — has already put the reader somewhere better than the
 * heading, and pulling them off it is the same interruption this effect exists
 * to prevent. Do NOT read the portal's mount timing as that protection: the
 * mechanism is real but it is spent on the wrong body. It is also not what it
 * sounds like — being portalled does not defer a ref, because React attaches
 * refs during commit and portal children commit with everything else. What
 * defers is Radix's `Portal` itself: it renders `null` until its own layout
 * effect flips an internal `mounted` flag, so the opening commit has no content
 * ELEMENT at all and `contentRef` has nothing to attach to. (Not the presence
 * layer either, which starts `mounted` when `present` is true.) Either way the
 * skip is spent early: a host derives `restoring` from a passive effect, so the
 * dialog's FIRST commit is the restoring screen, and every arrival at a phase —
 * create-organization included — is a body CHANGE that reaches this effect.
 */
function useAnnounceBodyChange(
  contentRef: RefObject<HTMLDivElement | null>,
  open: boolean,
  body: WizardPhase | typeof RESTORING_BODY | undefined
): string {
  const [announcement, setAnnouncement] = useState("");

  // THE ANNOUNCEMENT IS NOT KEYED ON AN ARRIVAL, and the focus move below is.
  // Splitting them is the point: a live region speaks when its TEXT changes, so
  // the text is the trigger it wants, while a focus move must fire only on an
  // arrival or it drags the reader off whatever control they are in.
  //
  // Keying both on `body` is what a design pass caught: the analysis step's
  // heading is DERIVED, not fixed — `getAnalysisTitle` walks it from "Session
  // analysis started." to "Session analysis complete." with `phase` pinned at
  // `analysis` throughout — so an arrival-keyed region held the first sentence
  // for the whole step and a reader never heard it finish while the card in
  // front of them said otherwise. No dependency array, so this re-reads on
  // every commit; the state setter bails on an unchanged string, so a render
  // that moved nothing costs one comparison and re-announces nothing.
  useEffect(() => {
    if (!open) {
      return;
    }
    const heading = contentRef.current?.querySelector<HTMLElement>(
      '[data-slot="dialog-title"]'
    );
    // An empty heading would replace a true announcement with silence, so the
    // previous one stands rather than being cleared by a body that has not
    // rendered its title yet.
    const headingText = heading?.textContent?.trim();
    if (headingText) {
      setAnnouncement((previous) =>
        previous === headingText ? previous : headingText
      );
    }
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `body` is the trigger, not an input — the effect reads the DOM, and the identity of the body the reader arrived at is the only thing that says an arrival happened. Dropping it from the list is exactly the change that turns this into a re-focus on every render.
  useEffect(() => {
    if (!open) {
      return;
    }

    const content = contentRef.current;
    if (!content) {
      return;
    }

    // The content element itself is where Radix parks focus when the body it
    // opened on has nothing focusable in it — that is the stranded state, not a
    // claim, so it does not count as one.
    const focused = content.ownerDocument.activeElement;
    if (focused && focused !== content && content.contains(focused)) {
      return;
    }

    content.focus();
  }, [body, contentRef, open]);

  return announcement;
}
