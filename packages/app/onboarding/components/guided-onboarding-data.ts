/**
 * @file The MEASURED-DATA seam of the guided onboarding wizard.
 *
 * Everything here is something the product measures about the person signing up
 * — how many sessions were found on their machine, how many bytes of logs, how
 * many teammates are already in their organization, which account they are
 * signed in as. None of it is copy, and a step may never invent it: a step
 * either receives the value or renders the `unknown` variant.
 *
 * The wizard was promoted out of `apps/prototypes` with the prototype's mock
 * numbers typed straight into its copy — "270 sessions found", a made-up
 * company, and a real person's email address, all shipped on `main` (ISS-8678).
 * This module is the contract that replaced them. Producing the real values is
 * owned per phase by the tickets enumerated in
 * `../lib/guided-onboarding-fixtures.ts`.
 *
 * Every type below keeps `unknown` DISTINCT from a real zero, per the
 * "Loading ≠ unavailable ≠ not-applicable ≠ real zero" rule in
 * `packages/app/AGENTS.md`. "We have not been told" and "we looked and the
 * answer is none" are different claims and render differently.
 */

import type { GitHubConnectPromptAction } from "../../github/lib/github-connect-action";

/**
 * Whether one agent-session source was found on the machine, and its progress.
 *
 * There is no `unknown` arm. A source the host cannot say anything about is
 * LEFT OUT of the list rather than listed with a status that names no
 * observation (ISS-11591): "Not reported" beside an empty track was three
 * claims a reader could not tell apart — not installed, installed but
 * unscanned, scanned but unparsable — and it buried the rows that carried real
 * counts under rows that never would.
 */
export type OnboardingSourceDetection =
  /**
   * The host LOOKED and this tool is not on the machine. Only evidence of
   * absence may produce this — a source the host simply cannot observe is left
   * out of the list, never this, because claiming a tool is missing when it is
   * merely uninspected is what put a fabricated "Not detected" beside a real
   * Cursor install (ISS-8678).
   */
  | { status: "not-detected" }
  | {
      status: "detected";
      /**
       * Sessions of this source already analyzed, or `null` when the store has
       * not been read yet. `null` is not zero: a settled read that returns no
       * row for this source really has analyzed none, and that is a different
       * screen from one where the read is still in flight.
       */
      analyzed: number | null;
      /**
       * Present, and `true`, ONLY when this row's analyzed→found RATIO was
       * WITHHELD — the host read the count and it settled as one that may not
       * be divided into {@link found} — rather than merely unread. An unread
       * count is a measurement in flight, so the row's bar sweeps; a withheld
       * ratio has settled and no quotient is coming, so a sweep there animates
       * work that is not happening.
       *
       * Says nothing about whether {@link analyzed} survived, because the two
       * shortfalls that set it differ on exactly that: a corrupt read is
       * withdrawn whole and leaves `null`, while a store that has outlived its
       * transcripts still states 2,443 beside its own 940 found and gives up
       * only the quotient (ISS-10582). So a consumer deciding whether the bar
       * may sweep reads THIS, never `analyzed === null`.
       *
       * OMITTED when the ratio is statable or the count is simply unread, so
       * its absence means "not withheld", never "divides fine".
       */
      analyzedWithheld?: boolean;
      found: number;
    };

export type OnboardingSessionSource = {
  detection: OnboardingSourceDetection;
  /**
   * The stable harness id the collector recorded (e.g. "claude", "codex") —
   * what analytics emits (`harnesses_detected`, ISS-10502): the display label
   * below is title-cased presentation text and must never reach the wire.
   */
  harness: string;
  /** Display name of the tool, e.g. "Claude Code". */
  label: string;
};

/**
 * Whether the time remaining on the local analysis can be stated, and why not
 * when it cannot.
 *
 * A scalar `estimatedAnalysisMinutes` cannot represent this: the producer has
 * four terminal answers and three of them carry no number, so a scalar forces a
 * fabricated duration for each. `Calculating` and `Unavailable` are deliberately
 * distinct — one is a measurement in flight and the other is one that cannot be
 * taken — and `Complete` is not "0 minutes remaining", it is a different claim.
 */
export const OnboardingAnalysisEstimateStatus = {
  /** Nobody has told this component anything. */
  Unknown: "unknown",
  /** A real estimate is being derived and is not ready. */
  Calculating: "calculating",
  /** The host looked and cannot produce one. */
  Unavailable: "unavailable",
  Measured: "measured",
  /** Analysis finished, so there is no time remaining to state. */
  Complete: "complete",
} as const;
export type OnboardingAnalysisEstimateStatus =
  (typeof OnboardingAnalysisEstimateStatus)[keyof typeof OnboardingAnalysisEstimateStatus];

export type OnboardingAnalysisEstimate =
  | { status: typeof OnboardingAnalysisEstimateStatus.Unknown }
  | { status: typeof OnboardingAnalysisEstimateStatus.Calculating }
  | { status: typeof OnboardingAnalysisEstimateStatus.Unavailable }
  | {
      status: typeof OnboardingAnalysisEstimateStatus.Measured;
      remainingMinutes: number;
    }
  | { status: typeof OnboardingAnalysisEstimateStatus.Complete };

/**
 * How far the local analysis has got, when that can be said at all.
 *
 * NOT a bare `number`. A percentage defaulted to `0` renders a measurement
 * nobody took — the bar sits at zero and the caption says "0%" on a machine
 * whose analysis is simply unreported — which is the same class of lie as the
 * hardcoded counts this seam replaced.
 */
export const OnboardingAnalysisProgressStatus = {
  /** Nobody has reported a population, so there is nothing to be short of. */
  Unknown: "unknown",
  /**
   * A population WAS reported and no lane could state a ratio over it.
   *
   * Distinct from {@link Unknown} for the same reason the estimate above keeps
   * `Calculating` and `Unavailable` apart: one is a measurement that has not
   * arrived and the other is one that cannot be taken. Collapsing them left an
   * endless indeterminate sweep on a screen whose analysis had already settled,
   * which is the bar claiming work is in flight forever (the operator's machine,
   * 2026-09-17: 1,092 sessions found, a store holding more sessions than the
   * sweep could still see on disk, and every bar hatching for good).
   */
  Unavailable: "unavailable",
  Measured: "measured",
} as const;
export type OnboardingAnalysisProgressStatus =
  (typeof OnboardingAnalysisProgressStatus)[keyof typeof OnboardingAnalysisProgressStatus];

/**
 * The operand a withheld completion figure is missing.
 *
 * ONE member, stated rather than implied. Root `AGENTS.md` ("Never Delete a
 * Capability You Cannot Compute") requires the uncovered operand to be NAMED
 * where the value would have rendered, and the renderer cannot name what the
 * fold does not carry. Only the numerator is reachable today — a denominator
 * nobody reported is `Unknown`, not this — so a second member would be
 * speculative; adding one when a second gap becomes reachable is the point of
 * the const.
 */
export const OnboardingProgressOperand = {
  /** How many of the found sessions have been analyzed. */
  AnalyzedSessions: "analyzed-sessions",
} as const;
export type OnboardingProgressOperand =
  (typeof OnboardingProgressOperand)[keyof typeof OnboardingProgressOperand];

export type OnboardingAnalysisProgress =
  | { status: typeof OnboardingAnalysisProgressStatus.Unknown }
  | {
      status: typeof OnboardingAnalysisProgressStatus.Unavailable;
      /** Which operand is absent, so the screen can say so beside the bar. */
      missing: OnboardingProgressOperand;
    }
  | {
      status: typeof OnboardingAnalysisProgressStatus.Measured;
      /** Clamped to 0..100 by whoever derived it. */
      percent: number;
    };

/**
 * What the local session scan measured. `unknown` covers both "the scan has not
 * reported yet" and "no host supplied this", because neither entitles the step
 * to state a count — and asserting a scan is in flight would be its own
 * fabrication.
 */
export type OnboardingSessionDiscovery =
  | { status: "unknown" }
  | {
      status: "measured";
      estimate: OnboardingAnalysisEstimate;
      /**
       * Total size on disk of the transcripts found locally, or `null` when the
       * host has not reported one. Every field on this arm is INDEPENDENTLY
       * unknown-able, because they come from separate reads that settle at
       * separate moments: a machine can have real session counts before its byte
       * sweep lands, and a desktop build older than the count contract reports
       * bytes with no counts at all. A single `unknown` for the whole arm would
       * force one of those honest states to invent the other's value.
       *
       * `null` here is an INTERNAL in-process unknown, which root `AGENTS.md`
       * sanctions, and `formatBytes` already renders it as its unknown label.
       */
      logBytes: number | null;
      /** Sessions that have landed in the local store, or `null` when unread. */
      sessionsAnalyzed: number | null;
      /** Sessions the scan discovered, or `null` when nothing reported a count. */
      sessionsFound: number | null;
      /**
       * One row per source the host holds POSITIVE EVIDENCE about: a counted
       * `detected` row, or a `not-detected` row backed by evidence of absence.
       * A source it merely scans and did not count gets no row at all
       * (ISS-11591, reversing the unreported rows ISS-11346 added). A source it
       * cannot observe is never a `not-detected` row: we can see presence, and
       * only a host holding real evidence of absence may claim it.
       *
       * Invariant the fold guarantees: the `found` counts of the detected rows
       * sum to {@link sessionsFound} when that is stated, so the summary can
       * never contradict its own population.
       */
      sources: readonly OnboardingSessionSource[];
    };

export type OnboardingMemberPreview = {
  /**
   * Stable identity for the render key. Two real teammates can share a display
   * name; the placeholder rosters never could, so keying off the name was safe
   * only while the data was invented (ISS-8348).
   */
  id: string;
  avatarUrl?: string;
  initials: string;
  name: string;
};

/**
 * The organization's existing membership. A `known` count of 0 means the signer
 * really is the first person in; `unknown` means nobody has told this component
 * either way, and it must not claim a team exists or that one does not.
 */
export type OnboardingOrganizationMembers =
  | { status: "unknown" }
  | {
      status: "known";
      count: number;
      preview: readonly OnboardingMemberPreview[];
    };

/**
 * What a submitted invitation batch actually did.
 *
 * `partial` exists because the batch route answers 200 with per-email outcomes:
 * a send can invite some addresses, find others already in the org, and fail a
 * third set, all at once. Collapsing that into "sent" and reporting the number
 * the user TYPED is the specific lie this union prevents — every non-idle
 * variant carries the counts the copy is allowed to state, so no caller can
 * reach for the submitted length instead.
 */
export const OnboardingInviteStatus = {
  Idle: "idle",
  Pending: "pending",
  Sent: "sent",
  Partial: "partial",
  AlreadyMember: "already-member",
  Failed: "failed",
} as const;
export type OnboardingInviteStatus =
  (typeof OnboardingInviteStatus)[keyof typeof OnboardingInviteStatus];

export type OnboardingInviteOutcome =
  | { status: typeof OnboardingInviteStatus.Idle }
  | { status: typeof OnboardingInviteStatus.Pending }
  | { status: typeof OnboardingInviteStatus.Sent; invited: number }
  | {
      status: typeof OnboardingInviteStatus.Partial;
      invited: number;
      alreadyMember: number;
      failed: number;
    }
  | {
      status: typeof OnboardingInviteStatus.AlreadyMember;
      alreadyMember: number;
    }
  | {
      status: typeof OnboardingInviteStatus.Failed;
      failed: number;
      message?: string;
    };

/** The signed-in identity shown above the legal links. */
export type OnboardingAccount =
  | { status: "unknown" }
  | { status: "signed-in"; email: string };

/**
 * The organization the signer is authorized to join through Clerk membership or
 * invitation authority. `none` is a completed lookup with nothing available;
 * `unknown` is a lookup that has not reported; `unavailable` is one that
 * reported a FAILURE, which is neither of the other two and must not borrow
 * either's copy (ISS-11158). Only `available` may render a Join affordance.
 *
 * `available` additionally carries `partialLookupFailure`, because the shell
 * reads TWO independent authorities and a candidate from one of them does not
 * make the other's failure disappear. Offering the Join is right — a failure in
 * the half that answered nothing may not take away a join the shell can honor —
 * but rendering it as a COMPLETE answer would be the same collapse in the other
 * direction: the reader choosing between Join and Create new organization would
 * not know a list went unread (review-soul, ISS-11158).
 *
 * Both failure-bearing arms carry `lookupRetrying`, because the reader presses
 * Retry from INSIDE one of them: the arm has to survive its own retry or the
 * control unmounts under the keyboard. Same reason
 * {@link OnboardingStatusUnavailable} keeps its retry mounted and `aria-disabled`
 * (ISS-11158 review, tamsinb).
 */
export type OnboardingJoinableOrganization =
  | { status: "unknown" }
  | {
      status: "unavailable";
      /** A re-read of the failed lookup is IN FLIGHT. */
      lookupRetrying?: boolean;
    }
  | { status: "none" }
  | {
      status: "available";
      name: string;
      join?: OnboardingOrganizationJoin;
      /** One authority answered; another REPORTED A FAILURE. */
      partialLookupFailure?: boolean;
      /** A re-read of the failed authority is IN FLIGHT. */
      lookupRetrying?: boolean;
    };

/**
 * WHICH authority makes an organization joinable, because the two are not
 * interchangeable at the moment the reader presses Join: a membership is
 * activated, an invitation must first be accepted. The host performs whichever
 * its identity provider requires; this package only carries the discriminant so
 * one button cannot silently do the wrong one of the two.
 */
export const OnboardingJoinAuthority = {
  Invitation: "invitation",
  Membership: "membership",
} as const;
export type OnboardingJoinAuthority =
  (typeof OnboardingJoinAuthority)[keyof typeof OnboardingJoinAuthority];

/**
 * What the host needs to actually perform the join, opaque to this package.
 *
 * Present only when the host can act: the ACTIVE organization needs no join, so
 * it carries no target, and a Join affordance is offered only where one of these
 * says how to honor it. That is the invariant that keeps the button from
 * claiming an action nothing performs.
 */
export type OnboardingOrganizationJoin = {
  authority: OnboardingJoinAuthority;
  /**
   * The identifier the host's own provider needs — an organization id for a
   * membership, an invitation id for an invitation. Never rendered.
   */
  id: string;
};

/**
 * The honest defaults. A composition root that is handed no data passes these
 * rather than a plausible number — the anti-pattern ISS-8678 removed was an
 * `organizationMemberCount = 50` default, which made "nobody passed this"
 * indistinguishable from "this org has 50 members".
 */
export const UNKNOWN_SESSION_DISCOVERY: OnboardingSessionDiscovery = {
  status: "unknown",
};

export const UNKNOWN_ANALYSIS_PROGRESS: OnboardingAnalysisProgress = {
  status: OnboardingAnalysisProgressStatus.Unknown,
};

export const UNKNOWN_ORGANIZATION_MEMBERS: OnboardingOrganizationMembers = {
  status: "unknown",
};

export const UNKNOWN_ACCOUNT: OnboardingAccount = { status: "unknown" };

/** No invitation has been submitted yet. */
export const IDLE_INVITE_OUTCOME: OnboardingInviteOutcome = {
  status: OnboardingInviteStatus.Idle,
};

export const UNKNOWN_JOINABLE_ORGANIZATION: OnboardingJoinableOrganization = {
  status: "unknown",
};

/**
 * The membership/invitation read reported a FAILURE. Distinct from
 * {@link UNKNOWN_JOINABLE_ORGANIZATION} because that one's sentence claims a
 * check is running, and a failed read's check has finished (ISS-11158).
 */
export const UNAVAILABLE_JOINABLE_ORGANIZATION: OnboardingJoinableOrganization =
  {
    status: "unavailable",
  };

/**
 * A source's completion percentage, DERIVED from the two measured counts rather
 * than stood in for. The shipped code multiplied the overall progress by 1.04
 * and 2.1 to fake per-source bars; those factors described nothing.
 *
 * `null` when there is no percentage to state — an undetected source, one whose
 * analyzed count has not been read, or a zero denominator. A `0` there would
 * render an empty bar as a measurement of no progress rather than as the
 * absence of one.
 *
 * An analyzed count that does not fit its found count is declined for the same
 * reason — see {@link analyzedCountFitsFound}. The row still STATES both counts,
 * each beside its own label; only the ratio between them is withheld.
 */
export function getSourceProgressPercent(
  detection: OnboardingSourceDetection
): number | null {
  if (
    detection.status !== "detected" ||
    detection.analyzed === null ||
    detection.found <= 0 ||
    !analyzedCountFitsFound(detection.analyzed, detection.found)
  ) {
    return null;
  }
  return progressPercentFromRatio(detection.analyzed / detection.found);
}

/**
 * Whether an analyzed count may be stated AS A FRACTION of its found count.
 *
 * The two count different populations — analyzed counts rows the local store has
 * accumulated, found counts transcripts still on disk — and a store outlives the
 * files it was built from, so a store that has outlived its transcripts holds
 * rows with no counterpart in the denominator (ISS-10582). Those rows do not
 * narrow the sample, they bias any quotient over them upward, and there is no
 * ceiling that rescues it: 100 is an affirmative completion claim here, rendered
 * as "Session analysis complete." and a green check.
 *
 * So each count is stated on its own, beside its own label, and nothing divides
 * or juxtaposes them when this returns false. It lives HERE, next to
 * {@link progressPercentFromRatio}, for the same reason that one does: the
 * headline, the per-source rows, and the ambient banner must agree on when the
 * pair may be related, and one exported rule is what makes that true rather
 * than three comments claiming it.
 */
export function analyzedCountFitsFound(
  analyzed: number,
  found: number
): boolean {
  return analyzed <= found;
}

/**
 * A ratio as the whole percentage the screen may state. Clamped at both ends,
 * and never rounded INTO either end: 100 is a completion claim, so it is stated
 * only when the ratio really is one (3,985 of 4,004 reads 99, not a green
 * check), and 0 is "not started", so any progress at all reads at least 1 — the
 * Continue gate keys on a measured zero, and 43 of 8,604 is not zero.
 */
export function progressPercentFromRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return 0;
  }
  if (ratio >= 1) {
    return 100;
  }
  return Math.min(99, Math.max(1, Math.round(ratio * 100)));
}

/**
 * How a connection was established, when one was. `account_provider` means the
 * visitor signed in with GitHub and that grant satisfies the step; `grant` means
 * the integration status itself reports a live user grant or App installation.
 * Kept distinct so a surface can tell an inferred connection from a measured
 * one without re-deriving either.
 */
export const OnboardingGitHubConnectionSource = {
  AccountProvider: "account_provider",
  Grant: "grant",
} as const;
export type OnboardingGitHubConnectionSource =
  (typeof OnboardingGitHubConnectionSource)[keyof typeof OnboardingGitHubConnectionSource];

/**
 * Whether the visitor's GitHub account is connected (ISS-8352).
 *
 * `unknown` is NOT `disconnected`. A status read that has not landed, or a
 * payload from a peer this build does not understand, is an absent answer — and
 * an absent answer may not render a Connect prompt, which would ask a
 * GitHub-auth user to do something they have already done. It also may not
 * render as connected: it folds to `githubConnected: false` so the completion
 * card still counts the step as outstanding.
 *
 * The predicate behind `connected`/`disconnected` is NOT owned here — see
 * `../lib/onboarding-github-connection.ts`, which delegates it to
 * `resolveGitHubGateConnected`, the repo's single owner of that question.
 */
export type OnboardingGitHubConnection =
  | { status: "unknown" }
  | { status: "connected"; source: OnboardingGitHubConnectionSource }
  | { status: "disconnected"; action: GitHubConnectPromptAction };

export const UNKNOWN_GITHUB_CONNECTION: OnboardingGitHubConnection = {
  status: "unknown",
};

/**
 * Whether the Web installer step may be skipped (ISS-8350).
 *
 * `Unknown` is NOT `Required`. They hide the same control, but they are
 * different claims: `Required` means the snapshot named this reader the
 * organization's first user, while `Unknown` means nobody has told this
 * component either way — a payload from a peer this build does not understand,
 * or a host that has not supplied `membership`. Only `Unknown` says so on
 * screen; rendering it as `Required` would tell the reader they are the first
 * user on a value nobody supplied.
 *
 * The predicate behind `Eligible`/`Required` is NOT owned here — see
 * `../lib/onboarding-desktop-skip.ts`, which delegates it to
 * `canSkipDesktopDownload`, the ISS-8349 owner of that question.
 */
export const OnboardingDesktopSkipEligibility = {
  Unknown: "unknown",
  Eligible: "eligible",
  Required: "required",
} as const;
export type OnboardingDesktopSkipEligibility =
  (typeof OnboardingDesktopSkipEligibility)[keyof typeof OnboardingDesktopSkipEligibility];

/**
 * Whether the analyzer has reported enough for the wizard to leave Session
 * Discovery.
 *
 * ONE rule, read by BOTH gates that ask the question: the Continue button's
 * `disabled`, and `canContinueFromDiscovery`, the machine edge that button
 * fires. They were two rules, and they disagreed — the button fail-opened on an
 * inventory the transition guard never read, so a guest could press an enabled
 * Continue and have the machine swallow it, staying on a blocking step with no
 * feedback (whitlockk, PR #7547).
 *
 * A MEASURED INVENTORY is analysis having started (ISS-10539): it is the
 * analyzer's first stage reporting, and it is what already licenses the
 * "Session analysis started." headline rendered off the same value. A
 * percentage is the weaker evidence and only counts above zero — the byte lane
 * credits bytes as files land, so its first poll reads zero while real work is
 * in flight, which is why this may never be the only thing consulted.
 *
 * `settled` is NOT part of this. It is host-owned and only ever LOOSENS the
 * answer, so a host that has it ORs it in; the invariant that matters is that
 * nothing here can enable a button the machine would refuse.
 */
export function onboardingAnalysisHasStarted(
  discovery: OnboardingSessionDiscovery,
  progress: OnboardingAnalysisProgress
): boolean {
  if (discovery.status === "measured") {
    return true;
  }
  if (progress.status === OnboardingAnalysisProgressStatus.Measured) {
    return progress.percent > 0;
  }
  return false;
}
