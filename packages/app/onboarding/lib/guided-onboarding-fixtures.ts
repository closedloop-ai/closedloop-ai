/**
 * @file The guided onboarding wizard's placeholder view model, plus the
 * REGISTER of what still has to be wired to real data.
 *
 * Nothing in a shipped render path imports this module — the same contract
 * `shared/lib/domain-mock-data.ts` holds for its Storybook fixtures. Stories and
 * tests import it; the wizard's components never do.
 *
 * It exists because the wizard was promoted out of `apps/prototypes` with the
 * prototype's mock numbers typed directly into its copy (ISS-8678): "270
 * sessions found", "2.4GB of logs", "Acme Co.", three invented teammates, and a
 * real person's email address, all on `main`. Placeholder values are legitimate
 * — the phases that produce the real ones are still being built — but they
 * belong HERE, named and attributed, not inlined into a sentence where the only
 * way to find them is to notice a number looks suspicious.
 *
 * {@link UNWIRED_GUIDED_ONBOARDING_DATA} is that list. It is a `Record` keyed by
 * {@link UnwiredOnboardingField} on purpose: adding a field to the union without
 * registering its owner fails `tsc`, so the enumeration cannot silently fall
 * behind the view model.
 */

import {
  AccountStatus,
  KnownFlag,
  type OnboardingContext,
  OnboardingHost,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { GitHubConnectAction } from "../../github/lib/github-connect-action";
import {
  type OnboardingAccount,
  OnboardingAnalysisEstimateStatus,
  type OnboardingAnalysisProgress,
  OnboardingAnalysisProgressStatus,
  type OnboardingGitHubConnection,
  OnboardingGitHubConnectionSource,
  OnboardingJoinAuthority,
  type OnboardingJoinableOrganization,
  type OnboardingOrganizationMembers,
  type OnboardingSessionDiscovery,
  type OnboardingSessionSource,
} from "../components/guided-onboarding-data";
import type { DesktopOs } from "./desktop-platform-availability";

/** Every value in the wizard that presents as measured data and is still fake. */
export type UnwiredOnboardingField =
  | "joinableOrganization.name"
  | "organizationName";

export type UnwiredOnboardingDatum = {
  /** Which step a reader will see this on. */
  surface: string;
  /** What the value claims to the user, so a wrong wiring is recognisable. */
  presentsAs: string;
  /** The ClosedLoop ticket that produces the real value. */
  ownedBy: string;
};

/**
 * The wiring worklist. Read this instead of grepping the components for numbers
 * that look invented — that is exactly the search ISS-8678 proved does not
 * happen. An entry disappears when its field is fed by a real producer and the
 * fixture stops being the only on-screen source.
 *
 * BOTH conditions, and ISS-8353 satisfied the second for every field: the wizard
 * mounts on both shells now, through `Sidebar.tsx` on each
 * (`apps/desktop/src/renderer/components/layout/Sidebar.tsx` and
 * `apps/app/app/(authenticated)/components/sidebar.tsx`), so no field's fixture
 * is anybody's on-screen source any more. Seven entries outlived that and
 * ISS-11147 retired them: the four `discovery.*`, fed on desktop by
 * `./onboarding-session-discovery.ts` over the byte inventory; the two
 * `members.*`, fed by `../hooks/use-onboarding-organization-members.ts` over
 * `GET /users`; and `account.email`, fed from Clerk on web and the desktop
 * identity bridge on desktop. A register that over-reports tells a reader
 * asking "is this number real yet?" that shipped data is fake, which is the one
 * answer worse than no register at all.
 *
 * The two survivors are each a HALF still missing, not a whole field:
 * `joinableOrganization.name` is fed the visitor's ACTIVE organization, so a
 * visitor holding only an invitation is offered nothing, and `organizationName`
 * is fed that same active name rather than a company inferred from the email
 * domain, so the first user reaching the create step gets an empty pre-fill.
 * `ownedBy` names ISS-8383, which owns PRD-689's remaining contract gaps — the
 * register points at whoever still has work to do, not at a ticket that already
 * did its half.
 *
 * {@link UNWIRED_GUIDED_ONBOARDING_DATA} can no longer over-report in silence,
 * and two files hold the two halves of that.
 * `./__tests__/guided-onboarding-unwired-register.test.ts` executes each retired
 * field's producer and fails if the register names it again;
 * `../components/__tests__/guided-onboarding-wired-field-arrival.test.tsx`
 * renders the real shared host and fails if the folded value stops reaching the
 * screen. The first alone would stay green on a value no reader ever sees.
 */
export const UNWIRED_GUIDED_ONBOARDING_DATA: Record<
  UnwiredOnboardingField,
  UnwiredOnboardingDatum
> = {
  "joinableOrganization.name": {
    ownedBy: "ISS-8383",
    presentsAs:
      "an organization the visitor holds a Clerk INVITATION to but is not yet a member of; the membership half is fed by the active organization",
    surface: "choose-organization step",
  },
  organizationName: {
    ownedBy: "ISS-8383",
    presentsAs:
      "the company inferred from the visitor's email domain, pre-filling the new-organization form",
    surface: "create-organization step",
  },
};

/**
 * Placeholder discovery measurements. The counts are the prototype's, kept so
 * stories still demonstrate a populated scan; they describe no real machine.
 */
export const FIXTURE_SESSION_DISCOVERY: OnboardingSessionDiscovery = {
  estimate: {
    remainingMinutes: 37,
    status: OnboardingAnalysisEstimateStatus.Measured,
  },
  logBytes: 2_576_980_378,
  sessionsAnalyzed: 261,
  sessionsFound: 270,
  sources: [
    {
      detection: { analyzed: 252, found: 252, status: "detected" },
      harness: "claude",
      label: "Claude Code",
    },
    {
      detection: { analyzed: 9, found: 18, status: "detected" },
      harness: "codex",
      label: "Codex",
    },
    {
      detection: { status: "not-detected" },
      harness: "cursor",
      label: "Cursor",
    },
  ],
  status: "measured",
};

/**
 * A stated percentage, for the stories and suites that drive the wizard at a
 * known one.
 *
 * Shared rather than re-declared per suite: two of them were building the same
 * union member by hand, and a constructor is the one place that stays right if
 * the measured arm ever gains a field.
 */
export function measuredAnalysisProgress(
  percent: number
): OnboardingAnalysisProgress {
  return { percent, status: OnboardingAnalysisProgressStatus.Measured };
}

/** A partially-complete import, matching {@link FIXTURE_SESSION_DISCOVERY}. */
export const FIXTURE_ANALYSIS_PROGRESS: OnboardingAnalysisProgress =
  measuredAnalysisProgress(97);

/** A scan that has reported nothing yet — the wizard's honest default. */
export const FIXTURE_UNKNOWN_DISCOVERY: OnboardingSessionDiscovery = {
  status: "unknown",
};

/**
 * Placeholder teammates. Invented names, deliberately unmistakable as such so
 * nobody reads them as a real roster — the shipped set ("Maya Chen", "Jon
 * Reyes", "Priya Shah") read exactly like real colleagues.
 */
export const FIXTURE_ORGANIZATION_MEMBERS: OnboardingOrganizationMembers = {
  count: 50,
  preview: [
    { id: "fixture-member-1", initials: "SU", name: "Sample User" },
    { id: "fixture-member-2", initials: "ET", name: "Example Teammate" },
    { id: "fixture-member-3", initials: "PC", name: "Placeholder Colleague" },
  ],
  status: "known",
};

/** An organization whose membership has been looked up and is empty. */
export const FIXTURE_FIRST_MEMBER: OnboardingOrganizationMembers = {
  count: 0,
  preview: [],
  status: "known",
};

/**
 * A placeholder signed-in identity. `example.com` is the RFC 2606 reserved
 * documentation domain, so this address cannot belong to a real person — which
 * is the whole point: the shipped literal was a live `@closedloop.ai` address
 * carrying a signup date.
 */
export const FIXTURE_ACCOUNT: OnboardingAccount = {
  email: "signed-in-user@example.com",
  status: "signed-in",
};

/**
 * A placeholder joinable organization backed by membership authority, carrying
 * the `join` target a host needs to honor the Join button. Without a target the
 * step offers no Join affordance at all, because a control must not report an
 * action nothing performs (ISS-11145).
 */
export const FIXTURE_JOINABLE_ORGANIZATION: OnboardingJoinableOrganization = {
  join: { authority: OnboardingJoinAuthority.Membership, id: "org_example" },
  name: "Example Organization",
  status: "available",
};

/** The placeholder company name that pre-fills the new-organization form. */
export const FIXTURE_ORGANIZATION_NAME = "Example Organization";

export const FIXTURE_ORGANIZATION_SLUG = "example-organization";

/**
 * A visitor whose GitHub account is not connected — the state the canonical
 * GitHub step was designed against, and what a fixture host renders.
 */
export const FIXTURE_GITHUB_DISCONNECTED: OnboardingGitHubConnection = {
  action: GitHubConnectAction.Connect,
  status: "disconnected",
};

/** A visitor whose grant lapsed, so the step offers the repair wording. */
export const FIXTURE_GITHUB_RECONNECT: OnboardingGitHubConnection = {
  action: GitHubConnectAction.Reconnect,
  status: "disconnected",
};

/** A visitor who signed in with GitHub, so the step is already satisfied. */
export const FIXTURE_GITHUB_CONNECTED: OnboardingGitHubConnection = {
  source: OnboardingGitHubConnectionSource.AccountProvider,
  status: "connected",
};

/**
 * A complete {@link OnboardingContext} with every field set, for suites that
 * need to drive the transition engine.
 *
 * Shared because it was written twice — `onboarding-transitions.test.ts` and
 * `onboarding-cohorts.test.ts` each carried their own context literal, so a
 * field added to the context had to be remembered in two places. Both now
 * delegate here and keep only the default that makes their own suite readable
 * (ISS-8350).
 *
 * Defaults describe a Desktop first-user who has started analysis and measured
 * nothing yet; every field is overridable.
 */
export function buildOnboardingContext(
  overrides: Partial<OnboardingContext> = {}
): OnboardingContext {
  return {
    host: OnboardingHost.Desktop,
    membership: OrganizationMembership.FirstUser,
    accountStatus: AccountStatus.None,
    accountProvider: null,
    githubConnected: false,
    desktopAppDownloaded: false,
    organizationHasSyncedSessionData: KnownFlag.Unknown,
    syncConsentRecorded: KnownFlag.Unknown,
    teamInvited: false,
    analysisStarted: true,
    tourCompleted: false,
    organizationActive: KnownFlag.No,
    ...overrides,
  };
}

/**
 * Illustrative desktop download targets, on the RFC 2606 reserved domain so no
 * story can hand a reader a live installer. The production per-platform assets
 * are owned by `packages/api/src/types/desktop-release.ts`
 * (`getPublicDesktopReleaseDownloadUrl`).
 */
export const FIXTURE_DOWNLOAD_HREFS: Readonly<Record<DesktopOs, string>> = {
  linux: "https://example.com/Closedloop.AppImage",
  mac: "https://example.com/Closedloop-universal.dmg",
  windows: "https://example.com/Closedloop-Setup.exe",
};

/**
 * The overshot row itself, exported on its own so a consumer that needs only
 * this source does not have to narrow {@link FIXTURE_WITHHELD_RATIO_DISCOVERY}'s
 * union to reach `sources` — the discovery type's `unknown` arm has no such
 * property, so indexing into it off the union does not typecheck.
 *
 * The store has outlived the transcripts it was built from, so its rows have no
 * counterpart in the denominator (ISS-10582).
 */
export const FIXTURE_OVERSHOT_SOURCE: OnboardingSessionSource = {
  detection: {
    analyzed: 72,
    analyzedWithheld: true,
    found: 68,
    status: "detected",
  },
  harness: "claude",
  label: "Claude Code",
};

/**
 * The reporter's machine in ISS-10961: one source whose analyzed count
 * OVERSHOOTS its found count, beside two whose counts reconcile.
 *
 * Three rows, deliberately, because the defect is a CONTRAST — on desktop
 * 0.17.133 the overshot row and a row still being scanned were the same bar. A
 * single-row fixture cannot show that, so the story and the suite share this
 * one rather than each building half of it.
 */
export const FIXTURE_WITHHELD_RATIO_DISCOVERY: OnboardingSessionDiscovery = {
  estimate: { status: OnboardingAnalysisEstimateStatus.Calculating },
  logBytes: 2_576_980_378,
  sessionsAnalyzed: 8756,
  sessionsFound: 8789,
  sources: [
    FIXTURE_OVERSHOT_SOURCE,
    {
      detection: { analyzed: 7744, found: 7781, status: "detected" },
      harness: "codex",
      label: "Codex",
    },
    {
      detection: { analyzed: 940, found: 940, status: "detected" },
      harness: "cursor",
      label: "Cursor",
    },
  ],
  status: "measured",
};
