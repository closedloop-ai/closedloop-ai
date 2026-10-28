/**
 * The Desktop guided-onboarding takeover as the suites that drive it through
 * the organization, sync-policy and invite steps mount it: the REAL Desktop
 * host inside the REAL `DesktopAuthProvider` and settings-host adapter, over an
 * in-memory guided-onboarding API. Each suite keeps its own `vi.mock` leaf
 * stubs and supplies the analytics provider it observes through.
 */

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import { guidedOnboardingTransitionRequestSchema } from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  AccountStatus,
  createInitialOnboardingState,
  KnownFlag,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { SettingsHostAdapterProvider } from "@repo/app/shared/settings-host/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { vi } from "vitest";
import { createDesktopSettingsHostAdapter } from "../../../settings-host/desktop-settings-host-adapter";
import {
  DesktopAuthProvider,
  useDesktopAuth,
} from "../../../shared-agent-sessions/desktop-auth-provider";
import type { DesktopApi, DesktopAuthState } from "../../../types/desktop-api";
import { DesktopGuidedOnboardingDialogHost } from "../desktop-guided-onboarding-dialog-host";
import { writeGuestGuidedOnboardingRecord } from "../guest-guided-onboarding-record";

export const ORGANIZATION = {
  id: "org_from_clerk_task",
  name: "Acme Engineering",
} as const;
export const USER_ID = "user_1";

const SNAPSHOT_PATH_PREFIX = "/onboarding/guided/snapshot";
export const TRANSITION_PATH = "/onboarding/guided/transition";
export const CONTINUE = /^continue$/i;
export const SYNC_HEADING = /choose what to sync/i;
export const CREATE_HEADING = /you're the first one here/i;
export const INVITE_HEADING = /invite people you build with/i;
export const NAME_LABEL = "Name";

/** A Desktop first user's run that reached CreateOrganization before the fix. */
export function parkedOnCreateOrganization(): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-1",
    context: {
      accountProvider: AccountProvider.GitHub,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: true,
      githubConnected: true,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.No,
      teamInvited: false,
      tourCompleted: false,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 4,
    state: serializeOnboardingState({
      ...createInitialOnboardingState(),
      accountProvider: AccountProvider.GitHub,
      history: [
        OnboardingPhase.Welcome,
        OnboardingPhase.SyncPolicy,
        OnboardingPhase.SessionDiscovery,
        OnboardingPhase.Account,
      ],
      phase: OnboardingPhase.CreateOrganization,
    }),
  };
}

export function seedLocalRunOnCreateOrganization(): void {
  const snapshot = parkedOnCreateOrganization();
  writeGuestGuidedOnboardingRecord({
    revision: snapshot.revision,
    state: snapshot.state,
  });
}

/**
 * The guided-onboarding API over one in-memory run: the snapshot read, and a
 * transition write that advances the revision and stores the posted state.
 */
export function createGuidedOnboardingServer(
  initial: GuidedOnboardingSnapshot
) {
  let server = initial;
  return {
    replace: (next: GuidedOnboardingSnapshot) => {
      server = next;
    },
    get: (path: string) =>
      path.startsWith(SNAPSHOT_PATH_PREFIX)
        ? Promise.resolve(server)
        : Promise.reject(new Error(`unexpected GET ${path}`)),
    post: (path: string, body: unknown) => {
      if (path !== TRANSITION_PATH) {
        return Promise.reject(new Error(`unexpected POST ${path}`));
      }
      const command = guidedOnboardingTransitionRequestSchema.parse(body);
      server = {
        ...server,
        revision: server.revision + 1,
        state: command.state,
      };
      return Promise.resolve(server);
    },
  };
}

/**
 * The preload bridge the takeover reads, as main answers it for `state`. The
 * suite supplies the main-process calls it observes; `pushAuthState` sends the
 * renderer the push main sends on every auth transition, to the latest
 * subscriber.
 */
export function stubDesktopTakeoverBridge(
  state: DesktopAuthState,
  calls: Pick<DesktopApi, "createBootstrapOrganization" | "recordSyncConsent"> &
    Partial<Pick<DesktopApi, "captureSurfaceAnalytics" | "getDataSyncLevel">>
) {
  let subscriber: (next: DesktopAuthState) => void = () => undefined;
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      beginDesktopSignIn: vi.fn(() => Promise.resolve({ ok: true })),
      cancelDesktopSignIn: vi.fn(() => Promise.resolve()),
      getDataSyncLevel: vi.fn(() =>
        Promise.resolve({ level: DataSyncLevel.Full })
      ),
      getDesktopAuthState: vi.fn(() => Promise.resolve(state)),
      getSyncConsentRecord: vi.fn(() =>
        Promise.resolve({
          bound: true,
          organizationId: state.organizationId,
          tier: null,
        })
      ),
      onDesktopAuthStateChanged: vi.fn(
        (callback: (next: DesktopAuthState) => void) => {
          subscriber = callback;
          return () => undefined;
        }
      ),
      signOutDesktop: vi.fn(() => Promise.resolve()),
      ...calls,
    },
  });
  return {
    pushAuthState: (next: DesktopAuthState) => subscriber(next),
  };
}

/** Mount the takeover under the analytics provider the suite observes through. */
export function renderDesktopTakeover(
  AnalyticsProvider: ComponentType<{ children: ReactNode }>
): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
      >
        <DesktopAuthProvider>
          <AnalyticsProvider>
            <DesktopSettingsHost>
              <DesktopGuidedOnboardingDialogHost />
            </DesktopSettingsHost>
          </AnalyticsProvider>
        </DesktopAuthProvider>
      </FeatureFlagAdapterProvider>
    </QueryClientProvider>
  );
}

/**
 * The settings host exactly as `DesktopAppCoreProvider` composes it: the real
 * desktop adapter, bound to the organization of the SAME desktop session main
 * binds a recorded consent to (`sync-consent-apply.ts`).
 */
function DesktopSettingsHost({ children }: { children: ReactNode }) {
  const { state } = useDesktopAuth();
  return (
    <SettingsHostAdapterProvider
      adapter={createDesktopSettingsHostAdapter(
        window.desktopApi,
        state.organizationId
      )}
    >
      {children}
    </SettingsHostAdapterProvider>
  );
}
