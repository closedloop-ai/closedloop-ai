import {
  OnboardingAnalyticsEvent as AnalyticsEvent,
  OnboardingAnalyticsPageName,
  OnboardingAnalyticsProperty as Property,
} from "@repo/api/src/types/onboarding-analytics";
import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import {
  type GuidedOnboardingSnapshot,
  guidedOnboardingTransitionRequestSchema,
} from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  KnownFlag,
  OnboardingHost,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import { Surface } from "@repo/api/src/types/surface-analytics";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagAdapterProvider } from "../../../shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../../shared/feature-flags/static-feature-flag-adapter";
import { SurfaceAnalyticsProvider } from "../../../shared/observability/surface-analytics-context";
import { stateAt } from "../../lib/__tests__/onboarding-transitions-test-helpers";
import { DesktopOs } from "../../lib/desktop-platform-availability";
import { buildOnboardingContext } from "../../lib/guided-onboarding-fixtures";
import { transitionOnboarding } from "../../lib/onboarding-transitions";
import {
  IDLE_INVITE_OUTCOME,
  UNKNOWN_ORGANIZATION_MEMBERS,
} from "../guided-onboarding-data";
import { GuidedOnboardingDialogHost } from "../guided-onboarding-dialog-host";

const deps = vi.hoisted(() => ({
  detectedOs: "windows" as string | null,
  mutate: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock("../../hooks/use-detected-desktop-os", () => ({
  useDetectedDesktopOs: () => deps.detectedOs,
}));
vi.mock("../../../compute/hooks/use-compute-targets", () => ({
  useComputeTargets: () => ({ data: undefined }),
}));
vi.mock("../../hooks/use-guided-onboarding", () => ({
  useGuidedOnboardingSnapshot: deps.snapshot,
  useGuidedOnboardingTransition: () => ({
    isPending: false,
    mutate: deps.mutate,
  }),
}));
vi.mock("../../hooks/use-onboarding-invite-team", () => ({
  useOnboardingInviteTeam: () => ({
    invite: vi.fn(),
    invitedEmails: [],
    outcome: IDLE_INVITE_OUTCOME,
  }),
}));
vi.mock("../../hooks/use-onboarding-organization-members", () => ({
  useOnboardingOrganizationMembers: () => UNKNOWN_ORGANIZATION_MEMBERS,
}));

beforeEach(() => vi.clearAllMocks());

const CONTINUE_LABEL = "Continue without installing";
const DOWNLOAD_LABEL = /Download .* Desktop App/;

function renderDownload(detectedOs: string | null) {
  deps.detectedOs = detectedOs;
  const context = buildOnboardingContext({
    accountProvider: AccountProvider.Google,
    desktopAppDownloaded: false,
    githubConnected: false,
    host: OnboardingHost.Web,
    organizationHasSyncedSessionData: KnownFlag.No,
  });
  const state = stateAt(OnboardingPhase.DownloadDesktop, {
    accountProvider: AccountProvider.Google,
    organizationEstablished: true,
    history: [
      OnboardingPhase.Welcome,
      OnboardingPhase.Account,
      OnboardingPhase.CreateOrganization,
      OnboardingPhase.InviteTeam,
    ],
  });
  const snapshot: GuidedOnboardingSnapshot = {
    attemptId: "attempt-1",
    context,
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 5,
    state: serializeOnboardingState(state),
  };
  deps.snapshot.mockReturnValue({ data: snapshot, isLoading: false });
  const capture = vi.fn();
  const onDownloadDesktop = vi.fn();
  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
    >
      <SurfaceAnalyticsProvider
        capture={capture}
        getClickPage={() => ({
          entry: "onboarding",
          pageName: OnboardingAnalyticsPageName.Onboarding,
        })}
        surface={Surface.Web}
      >
        <GuidedOnboardingDialogHost
          analysisStarted={false}
          brand={<span>Closedloop.ai</span>}
          dashboardActive={false}
          desktopMode={false}
          host={OnboardingHost.Web}
          onBackFallback={vi.fn()}
          onDashboardAvailable={vi.fn()}
          onDownloadDesktop={onDownloadDesktop}
          organizationChosen
          organizationName="Example"
          organizationSlug="example"
        />
      </SurfaceAnalyticsProvider>
    </FeatureFlagAdapterProvider>
  );
  return { capture, context, onDownloadDesktop, snapshot, state };
}

describe("download analytics production wiring (ISS-12230)", () => {
  it.each([DesktopOs.Windows, null])(
    "continues without claiming a download on %s",
    (detectedOs) => {
      const { capture, context, onDownloadDesktop, snapshot, state } =
        renderDownload(detectedOs);
      fireEvent.click(screen.getByRole("button", { name: CONTINUE_LABEL }));
      expect(capture).toHaveBeenCalledExactlyOnceWith(
        AnalyticsEvent.ButtonClicked,
        {
          [Property.ButtonName]: "continue_without_installing",
          [Property.DownloadClicked]: false,
          [Property.PageName]: OnboardingAnalyticsPageName.Onboarding,
          [Property.Surface]: Surface.Web,
        }
      );
      expect(onDownloadDesktop).toHaveBeenCalledOnce();
      expect(deps.mutate).toHaveBeenCalledExactlyOnceWith(
        {
          analytics: { downloadClicked: false },
          event: { type: OnboardingEvent.DownloadDesktopApp },
          snapshot,
        },
        expect.any(Object)
      );
      const event = {
        type: OnboardingEvent.DownloadDesktopApp,
      } as const;
      const result = transitionOnboarding(state, event, context);
      expect(result).toMatchObject({
        status: "moved",
        state: { phase: OnboardingPhase.ConnectGitHub },
      });
      if (result.status !== "moved") {
        throw new Error("Expected the no-installer action to advance");
      }
      const parsed = guidedOnboardingTransitionRequestSchema.parse({
        commandId: "11111111-1111-4111-8111-111111111111",
        event,
        experienceVariant: WorkspaceExperience.V2,
        host: OnboardingHost.Web,
        revision: snapshot.revision,
        state: serializeOnboardingState(result.state),
      });
      expect(parsed.event).toEqual(event);
    }
  );

  // ISS-12614: Linux has a published installer, so it takes this path too.
  it.each([DesktopOs.Mac, DesktopOs.Linux])(
    "keeps the real installer on the download path on %s",
    (detectedOs) => {
      const { capture, onDownloadDesktop, snapshot } =
        renderDownload(detectedOs);
      const link = screen.getByRole("link", { name: DOWNLOAD_LABEL });
      link.addEventListener("click", (event) => event.preventDefault());
      fireEvent.click(link);
      expect(capture).toHaveBeenCalledExactlyOnceWith(
        AnalyticsEvent.ButtonClicked,
        {
          [Property.ButtonName]: "Open link",
          [Property.PageName]: OnboardingAnalyticsPageName.Onboarding,
          [Property.Surface]: Surface.Web,
        }
      );
      expect(onDownloadDesktop).toHaveBeenCalledOnce();
      expect(deps.mutate).toHaveBeenCalledExactlyOnceWith(
        {
          analytics: undefined,
          event: { type: OnboardingEvent.DownloadDesktopApp },
          snapshot,
        },
        expect.any(Object)
      );
    }
  );
});
