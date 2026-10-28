"use client";

import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { FIXTURE_ACCOUNT } from "@repo/app/onboarding/lib/guided-onboarding-fixtures"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  SidebarInset,
  SidebarProvider,
} from "@repo/design-system/components/ui/sidebar";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { WEB_MASTER_BASE_PATH } from "../mock";
import { AnalysisStatusBanner } from "./analysis-status-banner";
import { AppSidebar, type PendingOnboardingStep } from "./app-sidebar";
import { DashboardSpotlightTour } from "./dashboard-spotlight-tour";
import { desktopAvailabilityNotifyPreview } from "./desktop-availability-notify-preview";
import { FtueProgressProvider } from "./ftue-progress-context";
import { GuidedFtueModal } from "./guided-ftue-modal";
import {
  PrototypeDeveloperMenu,
  PrototypeMode,
  PrototypeOrganizationDataProbe,
  PrototypePlatform,
} from "./prototype-developer-menu";
import { useWebMasterOnboardingController } from "./use-web-master-onboarding-controller";
import { WebMasterPrototypeProvider } from "./web-master-prototype-context";

export const WebMasterShell = ({ children }: { children: ReactNode }) => {
  const pathname = usePath();
  const navigation = useNavigation();
  const [prototypeMode, setPrototypeMode] = useState<PrototypeMode>(
    PrototypeMode.Desktop
  );
  const [organizationMemberCount, setOrganizationMemberCount] = useState(0);
  const [organizationDataProbe, setOrganizationDataProbe] =
    useState<PrototypeOrganizationDataProbe>(
      PrototypeOrganizationDataProbe.Measured
    );
  const [prototypePlatform, setPrototypePlatform] = useState<PrototypePlatform>(
    PrototypePlatform.Detected
  );
  // ISS-12364: the address the mock "notify me" request recorded. Held here,
  // not in the form, so Back then forward on the download step shows the
  // confirmation rather than an empty form (marisolashgrove, review of #8983).
  const [notifySubmittedEmail, setNotifySubmittedEmail] = useState<
    string | undefined
  >(undefined);
  const controller = useWebMasterOnboardingController({
    mode: prototypeMode,
    organizationDataProbe,
    organizationMemberCount,
  });
  const [analysisHeight, setAnalysisHeight] = useState(0);
  const [visibleOnboardingStep, setVisibleOnboardingStep] =
    useState<PendingOnboardingStep | null>(null);
  const [completionCardExiting, setCompletionCardExiting] = useState(false);
  const [dashboardTourActive, setDashboardTourActive] = useState(false);
  const completionCardExitTimerRef = useRef<number | null>(null);

  const resetTransientState = useCallback(() => {
    setAnalysisHeight(0);
    setVisibleOnboardingStep(null);
    setCompletionCardExiting(false);
    setDashboardTourActive(false);
    setNotifySubmittedEmail(undefined);
    if (completionCardExitTimerRef.current !== null) {
      globalThis.window.clearTimeout(completionCardExitTimerRef.current);
      completionCardExitTimerRef.current = null;
    }
  }, []);

  const resetOnboarding = useCallback(() => {
    controller.reset();
    resetTransientState();
  }, [controller.reset, resetTransientState]);

  const handleModeChange = useCallback(
    (mode: PrototypeMode) => {
      resetTransientState();
      setPrototypeMode(mode);
    },
    [resetTransientState]
  );

  const handleOrganizationMemberCountChange = useCallback(
    (count: number) => {
      resetTransientState();
      setOrganizationMemberCount(count);
    },
    [resetTransientState]
  );

  const handleOrganizationDataProbeChange = useCallback(
    (probe: PrototypeOrganizationDataProbe) => {
      resetTransientState();
      setOrganizationDataProbe(probe);
    },
    [resetTransientState]
  );

  const handlePlatformChange = useCallback((platform: PrototypePlatform) => {
    // Each Platform option starts the capture from its initial state.
    setNotifySubmittedEmail(undefined);
    setPrototypePlatform(platform);
  }, []);

  const handleSignOut = useCallback(() => {
    resetOnboarding();
    navigation.replace(`${WEB_MASTER_BASE_PATH}/dashboard`);
  }, [navigation, resetOnboarding]);

  // The FTUE is a blocking gate, so while it is open the app behind it is inert:
  // not tabbable and not exposed to assistive tech. The prototype developer menu
  // sits outside this subtree and stays reachable on purpose.
  const ftueGateOpen =
    controller.state.phase !== OnboardingPhase.DashboardAvailable;

  useEffect(() => {
    if (
      controller.state.phase !== OnboardingPhase.DashboardAvailable ||
      !controller.state.dashboardTourCompleted
    ) {
      setVisibleOnboardingStep(null);
      setCompletionCardExiting(false);
      return;
    }
    if (!controller.pendingOnboardingStep) {
      setVisibleOnboardingStep(null);
      setCompletionCardExiting(false);
      return;
    }
    const timer = globalThis.window.setTimeout(() => {
      setVisibleOnboardingStep(controller.pendingOnboardingStep);
      setCompletionCardExiting(false);
    }, MODAL_EXIT_DURATION_MS);
    return () => globalThis.window.clearTimeout(timer);
  }, [
    controller.pendingOnboardingStep,
    controller.state.dashboardTourCompleted,
    controller.state.phase,
  ]);

  useEffect(() => {
    if (
      controller.state.phase !== OnboardingPhase.DashboardAvailable ||
      dashboardTourActive ||
      controller.state.dashboardTourCompleted
    ) {
      return;
    }
    const timer = globalThis.window.setTimeout(
      () => setDashboardTourActive(true),
      MODAL_EXIT_DURATION_MS
    );
    return () => globalThis.window.clearTimeout(timer);
  }, [
    controller.state.dashboardTourCompleted,
    controller.state.phase,
    dashboardTourActive,
  ]);

  useEffect(
    () => () => {
      if (completionCardExitTimerRef.current !== null) {
        globalThis.window.clearTimeout(completionCardExitTimerRef.current);
      }
    },
    []
  );

  useEffect(() => {
    // `phase` is the transient `welcome` default until `useGuidedFtueState`
    // reads storage back, so redirecting before `ready` bounces a completed
    // user off a deep-linked route on every reload.
    if (!controller.ready) {
      return;
    }
    if (
      controller.state.phase !== OnboardingPhase.DashboardAvailable &&
      pathname !== `${WEB_MASTER_BASE_PATH}/dashboard`
    ) {
      navigation.replace(`${WEB_MASTER_BASE_PATH}/dashboard`);
    }
  }, [controller.ready, controller.state.phase, navigation, pathname]);

  return (
    <FeatureFlagAdapterProvider adapter={WEB_MASTER_FEATURE_FLAGS}>
      <WebMasterPrototypeProvider value={controller.prototypeContextValue}>
        <FtueProgressProvider
          phase={
            controller.isDesktop
              ? controller.state.phase
              : OnboardingPhase.Welcome
          }
          progress={controller.state.progress}
        >
          <SidebarProvider className="h-svh">
            <AppSidebar
              backgroundInert={ftueGateOpen}
              completionCardExiting={completionCardExiting}
              completionProgress={controller.completionProgress}
              onContinueOnboarding={() => {
                const nextStep = visibleOnboardingStep;
                if (!nextStep) {
                  return;
                }
                setCompletionCardExiting(true);
                completionCardExitTimerRef.current =
                  globalThis.window.setTimeout(() => {
                    completionCardExitTimerRef.current = null;
                    setVisibleOnboardingStep(null);
                    setCompletionCardExiting(false);
                    controller.resumePendingStep(nextStep);
                  }, COMPLETION_CARD_EXIT_DURATION_MS);
              }}
              onDownloadDesktopApp={
                controller.prototypeContextValue.downloadDesktopApp
              }
              onSignOut={handleSignOut}
              pendingOnboardingStep={visibleOnboardingStep}
              setupGate={
                controller.isDesktop ? undefined : controller.setupGate
              }
            />
            <SidebarInset
              className="min-w-0 overflow-hidden transition-[margin-top] duration-300 ease-out"
              style={
                controller.showAnalysisStatus
                  ? { marginTop: `${analysisHeight}px` }
                  : undefined
              }
            >
              <AnalysisStatusBanner onHeightChange={setAnalysisHeight} />
              <div className="contents" inert={ftueGateOpen}>
                {children}
              </div>
            </SidebarInset>
          </SidebarProvider>
        </FtueProgressProvider>
      </WebMasterPrototypeProvider>
      <GuidedFtueModal
        {...controller.modalProps}
        {...desktopAvailabilityNotifyPreview({
          email:
            FIXTURE_ACCOUNT.status === "signed-in"
              ? FIXTURE_ACCOUNT.email
              : undefined,
          onSubmitted: setNotifySubmittedEmail,
          platform: prototypePlatform,
          submittedEmail: notifySubmittedEmail,
        })}
        onSignOut={handleSignOut}
      />
      <DashboardSpotlightTour
        active={dashboardTourActive}
        onClose={() => {
          setDashboardTourActive(false);
          controller.markDashboardTourCompleted();
        }}
      />
      <PrototypeDeveloperMenu
        onModeChange={handleModeChange}
        onOrganizationDataProbeChange={handleOrganizationDataProbeChange}
        onOrganizationMemberCountChange={handleOrganizationMemberCountChange}
        onPlatformChange={handlePlatformChange}
        onResetOnboarding={resetOnboarding}
        onSimulateDesktopSyncChoice={
          controller.isDesktop
            ? undefined
            : controller.prototypeContextValue.simulateDesktopSyncChoice
        }
      />
    </FeatureFlagAdapterProvider>
  );
};

const MODAL_EXIT_DURATION_MS = 240;
const COMPLETION_CARD_EXIT_DURATION_MS = 200;

// ISS-12641 AC-4: the preserved prototype renders the mastered champion, which
// the shared list surfaces select only while gridview-adoption resolves open.
const WEB_MASTER_FEATURE_FLAGS = createStaticFeatureFlagAdapter({
  enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
});
