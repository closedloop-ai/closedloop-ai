/**
 * Guided-onboarding step copy the `e2e` suite asserts on, and the ONE
 * declaration of each string.
 *
 * Four specs had their own literals for these — the required-phase sequence, the
 * resume flow, the skip-arm matrix, and the first-user organization flow. That is
 * how a rewording comes to be chased in one spec and not the others, and how two
 * specs come to disagree about which sentence the Unknown arm states. Most of
 * the guided steps write their copy inline, so this module is the canonical
 * mirror of it; where a step DOES export the string, this module re-exports that
 * constant instead, because a mirror the suite only ever negates cannot fail
 * when it drifts (tamsinb, PR #8814).
 *
 * Named for the WORDS rather than for one step, because two steps share them:
 * the invite deferral and the download deferral are both `Skip for now`.
 */

import { DOWNLOAD_SKIP_UNAVAILABLE_LINE } from "@repo/app/onboarding/components/guided-onboarding-download-step";

/** `GuidedOnboardingDownloadStep`'s dialog title. */
export const DOWNLOAD_DIALOG_NAME = "Bring Closedloop to your desktop";

/** The deferral control — the invite step's, and the download step's Eligible arm. */
export const SKIP_FOR_NOW_NAME = "Skip for now";

/**
 * The download step's Unknown skip arm. Deliberately not a spinner and not an
 * alert — the copy IS the contract there, so the words are the locator. Read
 * from the step rather than restated, so a rewording cannot leave every
 * assertion on it passing against a sentence nothing renders.
 */
export const DOWNLOAD_SKIP_UNAVAILABLE_TEXT = DOWNLOAD_SKIP_UNAVAILABLE_LINE;

/** `GuidedOnboardingInviteStep`'s dialog title before a send. */
export const INVITE_DIALOG_NAME = "Invite people you build with";

/** `GuidedOnboardingInviteStep`'s dialog title once this run's send invited someone. */
export const INVITE_SENT_DIALOG_NAME = "Invitations sent";

/** `MultiEmailInviteField`'s label. */
export const INVITE_EMAILS_FIELD_LABEL = "Work emails";

/** `MultiEmailInviteField`'s submit label with two addresses committed. */
export const SEND_TWO_INVITES_NAME = "Send 2 invites";

/** The invite step's clean-send confirmation title for a server tally of two. */
export const TWO_INVITATIONS_SENT_TITLE = "2 invitations sent";

/** `GuidedOnboardingBackButton`'s label. */
export const GUIDED_ONBOARDING_BACK_NAME = "Back";
