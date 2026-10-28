/**
 * ISS-11254 (PLN-2112 divergence D3): the initial Web run's conditional GitHub
 * step.
 *
 * `transitionFromDownloadDesktop` landed on the Dashboard on BOTH of its exits,
 * and `requiresGitHubStep` was consulted only on the Desktop arm of
 * `resolvePostInvitePhase`, so every non-GitHub Web signup — four of PRD-689's
 * twelve cohort cells — finished the blocking run with PR attribution
 * unconfigured. The canonical prototype
 * (`packages/app/shell/v2/components/web-master-preview/components/use-web-master-onboarding-controller.ts`,
 * `getPostDownloadPhase`) takes the edge production did not.
 *
 * Its own file rather than more rows in `onboarding-transitions.test.ts`:
 * that suite is within a few lines of the 1,000-line ceiling, and this is one
 * cohort axis (the auth method) swept across one seam.
 *
 * EVERY case here walks the machine from `Welcome` and asserts it reached
 * `DownloadDesktop` through real transitions BEFORE asserting what follows.
 * Asserting only that `ConnectGitHub` is absent would otherwise be satisfied by
 * a fixture that never got out of the account step at all.
 */

import { resolvePendingOnboardingStep } from "@repo/api/src/types/onboarding-completion";
import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import {
  AccountProvider,
  AccountStatus,
  KnownFlag,
  type OnboardingContext,
  OnboardingHost,
  type OnboardingMachineState,
  OnboardingPhase,
  OrganizationMembership,
  PendingOnboardingStep,
} from "@repo/api/src/types/onboarding-phase";
import { describe, expect, it } from "vitest";
import { context, move, stateAt } from "./onboarding-transitions-test-helpers";

/** One row of the Web provider/data-status matrix. */
type AuthMethodCase = {
  method: string;
  accountProvider: AccountProvider | null;
  /** Whether this organization and caller have a usable data connection. */
  githubConnected: boolean;
  owesGitHubStep: boolean;
};

const AUTH_METHODS: readonly AuthMethodCase[] = [
  {
    method: "GitHub",
    accountProvider: AccountProvider.GitHub,
    githubConnected: true,
    owesGitHubStep: false,
  },
  {
    method: "GitHub without a usable data grant",
    accountProvider: AccountProvider.GitHub,
    githubConnected: false,
    owesGitHubStep: true,
  },
  {
    method: "Google",
    accountProvider: AccountProvider.Google,
    githubConnected: false,
    owesGitHubStep: true,
  },
  {
    method: "email",
    accountProvider: AccountProvider.Email,
    githubConnected: false,
    owesGitHubStep: true,
  },
  {
    method: "a provider this build does not know",
    accountProvider: null,
    githubConnected: false,
    owesGitHubStep: true,
  },
  /**
   * A Google signup joining an organization with a GitHub App installation
   * takes the connected branch. This fails if Web routes only by provider.
   */
  {
    method: "Google second-user",
    accountProvider: AccountProvider.Google,
    githubConnected: true,
    owesGitHubStep: false,
  },
];

/**
 * The context a Web run holds once the account step has landed, which is what
 * the server recomposes from the persisted provider plus the org's own GitHub
 * installation (`buildServerContext`, `apps/api/app/onboarding/guided/snapshot-service.ts`).
 */
function webContextAfterAccount(
  authCase: AuthMethodCase,
  overrides: Partial<OnboardingContext> = {}
): OnboardingContext {
  return context({
    host: OnboardingHost.Web,
    membership: OrganizationMembership.FirstUser,
    organizationActive: KnownFlag.Yes,
    accountStatus: AccountStatus.Established,
    accountProvider: authCase.accountProvider,
    githubConnected: authCase.githubConnected,
    githubDataConnectionStatusMeasured: true,
    ...overrides,
  });
}

/**
 * The phase a walk must have landed on, or a loud failure naming both.
 *
 * A thrown `Error` rather than an `expect`: an assertion outside a test body is
 * refused by `noMisplacedAssertion`, and a helper that silently returned the
 * wrong state would make every case below assert against a run that never got
 * where its name says it did.
 */
function requirePhase(
  state: OnboardingMachineState,
  phase: OnboardingPhase
): OnboardingMachineState {
  if (state.phase !== phase) {
    throw new Error(`expected the run at ${phase}, found ${state.phase}`);
  }
  return state;
}

/**
 * Walk a real Web first run from `Welcome` to the download gate, through the
 * account step that carries the provider. Every case asserts the gate was
 * reached before asserting what follows it.
 */
function driveWebRunToDownloadGate(authCase: AuthMethodCase): {
  ctx: OnboardingContext;
  state: OnboardingMachineState;
} {
  const beforeAccount = webContextAfterAccount(authCase, {
    accountStatus: AccountStatus.None,
    accountProvider: null,
    githubConnected: false,
  });
  const ctx = webContextAfterAccount(authCase);

  const atAccount = requirePhase(
    move(
      stateAt(OnboardingPhase.Welcome),
      { type: OnboardingEvent.Start },
      beforeAccount
    ),
    OnboardingPhase.Account
  );
  const provider = authCase.accountProvider ?? AccountProvider.Email;
  const atOrganization = requirePhase(
    move(
      atAccount,
      { type: OnboardingEvent.AccountEstablished, provider },
      ctx
    ),
    OnboardingPhase.ChooseOrganization
  );
  const atInvite = requirePhase(
    move(atOrganization, { type: OnboardingEvent.OrganizationReady }, ctx),
    OnboardingPhase.InviteTeam
  );
  const atDownload = move(
    atInvite,
    { type: OnboardingEvent.SkipInvitations },
    ctx
  );

  return { ctx, state: atDownload };
}

describe("the initial Web run's GitHub step, per auth method", () => {
  for (const authCase of AUTH_METHODS) {
    const destination = authCase.owesGitHubStep
      ? OnboardingPhase.ConnectGitHub
      : OnboardingPhase.DashboardAvailable;

    it(`routes a ${authCase.method} signup from the download gate to ${destination}`, () => {
      const { ctx, state } = driveWebRunToDownloadGate(authCase);
      expect(state.phase).toBe(OnboardingPhase.DownloadDesktop);

      const downloaded = move(
        state,
        { type: OnboardingEvent.DownloadDesktopApp },
        ctx
      );
      expect(downloaded.phase).toBe(destination);
      expect(downloaded.history).toContain(OnboardingPhase.DownloadDesktop);
    });

    it(`routes a ${authCase.method} signup that skips the download to ${destination}`, () => {
      const { ctx, state } = driveWebRunToDownloadGate(authCase);
      expect(state.phase).toBe(OnboardingPhase.DownloadDesktop);
      const skippable: OnboardingContext = {
        ...ctx,
        membership: OrganizationMembership.ExistingMember,
      };

      const skipped = move(
        state,
        { type: OnboardingEvent.SkipDownload },
        skippable
      );
      expect(skipped.phase).toBe(destination);
      expect(skipped.history).toContain(OnboardingPhase.DownloadDesktop);
    });
  }
});

describe("a Web GitHub signup with a usable connection is not asked again", () => {
  const githubCase = AUTH_METHODS[0];

  it("reaches the Dashboard with the step absent from the whole run", () => {
    if (githubCase === undefined) {
      throw new Error("the GitHub auth-method row is missing");
    }
    const { ctx, state } = driveWebRunToDownloadGate(githubCase);
    expect(state.phase).toBe(OnboardingPhase.DownloadDesktop);

    const settled = move(
      state,
      { type: OnboardingEvent.DownloadDesktopApp },
      ctx
    );

    // The negative and its positive sibling on ONE locator: the same
    // `[...history, phase]` chain that carries `ConnectGitHub` for a Google or
    // email signup two cases up.
    const chain = [...settled.history, settled.phase];
    expect(chain).not.toContain(OnboardingPhase.ConnectGitHub);
    expect(chain).toContain(OnboardingPhase.DownloadDesktop);
    expect(settled.phase).toBe(OnboardingPhase.DashboardAvailable);
  });
});

describe("a Web client reading an older snapshot", () => {
  it("keeps the provider branch when the data-status measurement signal is absent", () => {
    const githubWithoutRegistry = AUTH_METHODS[1];
    if (githubWithoutRegistry === undefined) {
      throw new Error("the GitHub missing-grant row is missing");
    }
    const { ctx, state } = driveWebRunToDownloadGate(githubWithoutRegistry);

    const settled = move(
      state,
      { type: OnboardingEvent.DownloadDesktopApp },
      { ...ctx, githubDataConnectionStatusMeasured: undefined }
    );

    expect(settled.phase).toBe(OnboardingPhase.DashboardAvailable);
  });
});

describe("a resumed Web download step", () => {
  it("ends at the Dashboard rather than chaining the GitHub step", () => {
    const googleCase = AUTH_METHODS[2];
    if (googleCase === undefined) {
      throw new Error("the Google auth-method row is missing");
    }
    // What `ResumePendingStep` produces: history rewritten to the Dashboard.
    const resumed = stateAt(OnboardingPhase.DownloadDesktop, {
      history: [OnboardingPhase.DashboardAvailable],
      resuming: true,
      organizationEstablished: true,
    });

    const settled = move(
      resumed,
      { type: OnboardingEvent.DownloadDesktopApp },
      webContextAfterAccount(googleCase)
    );
    expect(settled.phase).toBe(OnboardingPhase.DashboardAvailable);
    expect(settled.resuming).toBe(false);
  });
});

describe("the deferred GitHub checklist item survives the new in-run step", () => {
  it("still offers the step to a Web reader who skipped it", () => {
    const googleCase = AUTH_METHODS[2];
    if (googleCase === undefined) {
      throw new Error("the Google auth-method row is missing");
    }
    const { ctx, state } = driveWebRunToDownloadGate(googleCase);
    expect(state.phase).toBe(OnboardingPhase.DownloadDesktop);
    const atGitHub = move(
      state,
      { type: OnboardingEvent.DownloadDesktopApp },
      ctx
    );
    expect(atGitHub.phase).toBe(OnboardingPhase.ConnectGitHub);

    const settled = move(atGitHub, { type: OnboardingEvent.SkipGitHub }, ctx);
    expect(settled.phase).toBe(OnboardingPhase.DashboardAvailable);

    // Skipping in the run leaves the connection unmade, so the completion card
    // is still the owner of the step: `githubConnected` is re-derived from the
    // org's installation and no marker can grant it.
    expect(
      resolvePendingOnboardingStep({ ...ctx, desktopAppDownloaded: true })
    ).toBe(PendingOnboardingStep.ConnectGitHub);
  });
});

describe("the Desktop arm is unchanged", () => {
  it("keeps the provider decision if Desktop ever reaches the download gate", () => {
    const settled = move(
      stateAt(OnboardingPhase.DownloadDesktop, {
        history: [OnboardingPhase.Welcome],
        organizationEstablished: true,
      }),
      { type: OnboardingEvent.DownloadDesktopApp },
      context({
        host: OnboardingHost.Desktop,
        accountStatus: AccountStatus.Established,
        accountProvider: AccountProvider.GitHub,
        githubConnected: false,
        githubDataConnectionStatusMeasured: true,
      })
    );

    expect(settled.phase).toBe(OnboardingPhase.DashboardAvailable);
  });

  it("still resolves its own GitHub step straight out of invitations", () => {
    const googleCase = AUTH_METHODS[2];
    if (googleCase === undefined) {
      throw new Error("the Google auth-method row is missing");
    }
    const desktop = context({
      host: OnboardingHost.Desktop,
      accountStatus: AccountStatus.Established,
      accountProvider: googleCase.accountProvider,
      githubConnected: false,
    });

    const settled = move(
      stateAt(OnboardingPhase.InviteTeam, {
        history: [OnboardingPhase.Welcome],
        organizationEstablished: true,
      }),
      { type: OnboardingEvent.SkipInvitations },
      desktop
    );
    // Desktop has no download gate, so its route to the step is the invite
    // exit and must not have moved onto the Web one.
    expect(settled.phase).toBe(OnboardingPhase.ConnectGitHub);
    expect(settled.history).not.toContain(OnboardingPhase.DownloadDesktop);
  });

  it("still treats GitHub account provenance as sufficient on its initial invitation exit", () => {
    const settled = move(
      stateAt(OnboardingPhase.InviteTeam, {
        history: [OnboardingPhase.Welcome],
        organizationEstablished: true,
      }),
      { type: OnboardingEvent.SkipInvitations },
      context({
        host: OnboardingHost.Desktop,
        accountStatus: AccountStatus.Established,
        accountProvider: AccountProvider.GitHub,
        githubConnected: false,
        githubDataConnectionStatusMeasured: true,
      })
    );

    expect(settled.phase).toBe(OnboardingPhase.DashboardAvailable);
  });
});
