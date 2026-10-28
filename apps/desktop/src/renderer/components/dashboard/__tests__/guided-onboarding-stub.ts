/**
 * The guided-onboarding CLIENT, stubbed for every suite that mounts
 * `FirstLaunchDashboard` (PLN-1875 Step 9).
 *
 * The seam is deliberately the client and not `useGuidedDashboardTour`: the
 * reconciliation under test IS that hook, so mocking it would leave the thing
 * this step built untested in the one place it is wired. Stubbing the two query
 * hooks instead keeps the real hook, the real definition of done, and the real
 * arming gate in the render path, and only removes the API client, the auth
 * adapter and the `QueryClient` these suites do not stand up.
 *
 * The `mutate` reference is module-level so it is stable across renders: the
 * real `useMutation` returns a stable one, and a fresh function per render would
 * make this stub UNSTABLER than production — the failure mode a sibling fixture
 * in this directory already cost the suite once.
 */

import type { OnboardingEventInput } from "@repo/api/src/types/onboarding-events";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";

type RecordedTransition = {
  event: OnboardingEventInput;
  snapshot: GuidedOnboardingSnapshot;
};

export const guidedOnboardingStub = {
  /**
   * What the snapshot read answers. `undefined` is a run with no record to
   * return — an org with no attempt row, or a read that failed.
   */
  snapshot: undefined as GuidedOnboardingSnapshot | undefined,
  /**
   * Whether that read has SETTLED. `false` is a request still in flight, which
   * is a different state from a settled read with no record and is exactly what
   * the desktop arm must not confuse with either answer — so the stub carries
   * it rather than letting `snapshot: undefined` stand for both.
   */
  read: true,
  /**
   * Whether the read is REACHABLE at all — the identity half of the query's own
   * `enabled`, which lives inside `useGuidedOnboardingSnapshot` and not in the
   * `enabled` the tour hook passes down. `false` is a signed-out or
   * provider-less tree: the request is never issued, so nothing can resolve it
   * and nothing can fail it, and {@link guidedOnboardingStub.read} cannot
   * describe that — a settled read and an unreachable one are different
   * answers. Carried separately so no single fixture value stands for both.
   */
  identityReady: true,
  /** Every transition the page posted, in order. */
  transitions: [] as RecordedTransition[],
};

export function resetGuidedOnboardingStub(): void {
  guidedOnboardingStub.snapshot = undefined;
  guidedOnboardingStub.read = true;
  guidedOnboardingStub.identityReady = true;
  guidedOnboardingStub.transitions = [];
}

function mutate(input: RecordedTransition): void {
  guidedOnboardingStub.transitions.push(input);
}

const transition = { mutate };

/** The module shape `vi.mock` returns for the guided-onboarding client. */
export function guidedOnboardingStubModule() {
  return {
    // BOTH halves of the real gate, kept apart. `enabled` is honoured rather
    // than ignored: the real read is gated on the resolved experience, so a stub
    // that answered on every tree would let a legacy render see a run it could
    // never have. But that is only the caller's half — the real hook ANDs an
    // identity gate on top that no caller can see, and folding the two together
    // is what let this stub report one value for two situations.
    //
    // `isPending` is deliberately true for BOTH a gated-off query and a request
    // in flight, because that is what TanStack reports — it is the confusion a
    // consumer must not read. `isLoading` (`isPending && isFetching`) is the bit
    // that separates them, and it is what the tour hook reads.
    useGuidedOnboardingSnapshot: (
      _host: unknown,
      options?: { enabled?: boolean }
    ) => {
      const enabled =
        options?.enabled !== false && guidedOnboardingStub.identityReady;
      const settled = enabled && guidedOnboardingStub.read;
      return {
        data: settled ? guidedOnboardingStub.snapshot : undefined,
        isLoading: enabled && !guidedOnboardingStub.read,
        isPending: !settled,
      };
    },
    useGuidedOnboardingTransition: () => transition,
  };
}
