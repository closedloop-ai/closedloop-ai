import {
  OnboardingEvent,
  type OnboardingEventInput,
} from "@repo/api/src/types/onboarding-events";
import {
  AccountProvider,
  AccountStatus,
  createInitialOnboardingState,
  KnownFlag,
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { describe, expect, it } from "vitest";
import { buildOnboardingContext } from "../guided-onboarding-fixtures";
import {
  chooseActiveOrganization,
  transitionOnboarding,
} from "../onboarding-transitions";

/**
 * ISS-11090: Clerk's signup task creates the organization before the guided run
 * reaches its organization branch, so a first user usually arrives already
 * acting in one. Creating another stranded the run on the organization it was
 * keyed to. Both entries into the branch: Web's Welcome for an established
 * account, and the Account step on either host.
 */
describe("the organization branch for a first user", () => {
  const entries = [
    {
      entry: "Web Welcome",
      from: OnboardingPhase.Welcome,
      event: { type: OnboardingEvent.Start },
      host: OnboardingHost.Web,
    },
    ...Object.values(OnboardingHost).map((host) => ({
      entry: `${host} Account`,
      from: OnboardingPhase.Account,
      event: {
        type: OnboardingEvent.AccountEstablished,
        provider: AccountProvider.Google,
      },
      host,
    })),
  ] satisfies readonly {
    entry: string;
    from: OnboardingPhase;
    event: OnboardingEventInput;
    host: OnboardingHost;
  }[];

  // Unknown is a session still loading, signed out, or with no auth provider.
  // It is not "no organization", so it must not reach the create step.
  it.each(
    entries.flatMap((entry) =>
      [KnownFlag.Yes, KnownFlag.Unknown].map((organizationActive) => ({
        ...entry,
        organizationActive,
      }))
    )
  )(
    "chooses from $entry when organizationActive is $organizationActive",
    ({ event, from, host, organizationActive }) => {
      const ctx = buildOnboardingContext({
        accountStatus: AccountStatus.Established,
        host,
        membership: OrganizationMembership.FirstUser,
        organizationActive,
      });
      expect(
        transitionOnboarding(
          { ...createInitialOnboardingState(), phase: from },
          event,
          ctx
        )
      ).toMatchObject({
        state: { phase: OnboardingPhase.ChooseOrganization },
        status: "moved",
      });
    }
  );

  it.each(entries)(
    "creates one only with no active organization from $entry",
    ({ event, from, host }) => {
      const ctx = buildOnboardingContext({
        accountStatus: AccountStatus.Established,
        host,
        membership: OrganizationMembership.FirstUser,
        organizationActive: KnownFlag.No,
      });
      expect(
        transitionOnboarding(
          { ...createInitialOnboardingState(), phase: from },
          event,
          ctx
        )
      ).toMatchObject({
        state: { phase: OnboardingPhase.CreateOrganization },
        status: "moved",
      });
    }
  );
});

/**
 * A run that went through or parked on CreateOrganization is read as the
 * choose step unless the session is known to have no organization, in its
 * history too, so Back from InviteTeam lands on the step the user saw.
 */
describe("chooseActiveOrganization", () => {
  const passedCreate = {
    ...createInitialOnboardingState(),
    history: [
      OnboardingPhase.Welcome,
      OnboardingPhase.Account,
      OnboardingPhase.CreateOrganization,
    ],
    phase: OnboardingPhase.InviteTeam,
  };

  it.each([KnownFlag.Yes, KnownFlag.Unknown])(
    "reads create as choose when organizationActive is %s",
    (organizationActive) => {
      expect(
        chooseActiveOrganization(
          { ...passedCreate, phase: OnboardingPhase.CreateOrganization },
          organizationActive
        ).phase
      ).toBe(OnboardingPhase.ChooseOrganization);
      expect(
        chooseActiveOrganization(passedCreate, organizationActive).history
      ).toEqual([
        OnboardingPhase.Welcome,
        OnboardingPhase.Account,
        OnboardingPhase.ChooseOrganization,
      ]);
    }
  );

  it("leaves create alone for a session with no organization", () => {
    expect(chooseActiveOrganization(passedCreate, KnownFlag.No)).toEqual(
      passedCreate
    );
  });
});
