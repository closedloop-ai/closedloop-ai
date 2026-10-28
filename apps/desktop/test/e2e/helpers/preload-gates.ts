import { agentsPageDataGateLaunchArgs } from "./agents-page-data-gate";
import { branchesPageDataGateLaunchArgs } from "./branches-page-data-gate";
import {
  desktopAuthStateGateEnv,
  desktopAuthStateGateLaunchArgs,
} from "./desktop-auth-state-gate";
import {
  docsHelpFailureGateEnv,
  docsHelpFailureGateLaunchArgs,
} from "./docs-help-failure-gate";
import {
  gatewayListenGateEnv,
  gatewayListenGateLaunchArgs,
} from "./gateway-listen-gate";
import {
  githubConnectLegGateEnv,
  githubConnectLegGateLaunchArgs,
} from "./github-connect-leg-gate";
import {
  insightsReadFailureGateEnv,
  insightsReadFailureGateLaunchArgs,
} from "./insights-read-failure-gate";
import {
  insightsSectionHoldGateEnv,
  insightsSectionHoldGateLaunchArgs,
} from "./insights-section-hold-gate";
import {
  localSessionSourceGateEnv,
  localSessionSourceGateLaunchArgs,
} from "./local-session-source-gate";
import { logsReadGateEnv, logsReadGateLaunchArgs } from "./logs-read-gate";
import {
  sessionsListFailureGateEnv,
  sessionsListFailureGateLaunchArgs,
} from "./sessions-list-failure-gate";
import {
  sessionsPageDataGateEnv,
  sessionsPageDataGateLaunchArgs,
} from "./sessions-page-data-gate";
import {
  signInAccountConfirmationGateEnv,
  signInAccountConfirmationGateLaunchArgs,
} from "./sign-in-account-confirmation-gate";

/** The main-process `-r` preload gates a `launchDesktopApp` call can install. */
export type PreloadGateOptions = {
  /**
   * ISS-4561: install the Sessions combined `pageData` IPC gate. It is INERT
   * until the spec arms it; armed, it forces the best-effort usage half into the
   * transient failure the recovery hook exists for and holds each response until
   * the spec releases it. See `sessions-page-data-gate-preload.cjs` for what that
   * substitutes, and what it deliberately leaves as the real thing.
   */
  sessionsPageDataGate?: boolean;
  /**
   * ISS-7661: install the Sessions list FAILURE gate. Inert until the spec arms
   * it; armed, every `pageData` read rejects with a plain (non-transient) error,
   * which is what puts the surface in a refetch-failed state OVER the result it
   * already holds. Distinct from {@link sessionsPageDataGate}, which fails only
   * the best-effort usage half and holds responses rather than rejecting them.
   * See `sessions-list-failure-gate-preload.cjs`.
   */
  sessionsListFailureGate?: boolean;
  /**
   * ISS-10366: install the docs-help getPage/search FAILURE gate. Inert until
   * the spec arms one of its two channels, and disarmable again — which is how a
   * retry proves it re-crossed IPC. `status` and `nav` are never wrapped, so the
   * Help surface still reaches its reader pane while `getPage` rejects. See
   * `docs-help-failure-gate-preload.cjs`.
   */
  docsHelpFailureGate?: boolean;
  /** Hold real Branches page-data IPC responses for transition assertions. */
  branchesPageDataGate?: boolean;
  /**
   * ISS-6141: install the Agents combined `pageData` IPC gate. Unlike the
   * Branches one it HOLDS FROM LAUNCH — the window it exists for is the very
   * first read the Agents surface issues, so there is no later moment at which
   * arming would still catch it. It records each request and parks each response
   * until `resumeAgentsPageDataReads`. See `agents-page-data-gate-preload.cjs`.
   */
  agentsPageDataGate?: boolean;
  /**
   * ISS-8288: hold the renderer's desktop auth bridge UNRESOLVED — both the
   * `desktop:get-desktop-auth-state` pull and the `desktop:auth-state-changed`
   * push — until the spec releases it. Held from launch.
   *
   * Both channels, because main pushes the startup SignedOut transition on its
   * own schedule with no queue and no republish on renderer-ready: a pull-only
   * hold would sometimes be settled early by that push and the spec would pass
   * for the wrong reason. See `desktop-auth-state-gate-preload.cjs`.
   */
  desktopAuthStateGate?: boolean;
  /**
   * ISS-10411: make the device-authorization leg of the connect-GitHub flow
   * REJECT while leaving the GitHub connect leg observable but un-opened, so a
   * spec can assert which leg a failure is attributed to. See
   * `github-connect-leg-gate-preload.cjs`.
   */
  githubConnectLegGate?: boolean;
  /**
   * ISS-11345: stand in for main's side of a confirmation-gated sign-in, so a
   * spec can drive the account-confirmation dialog without a browser. See
   * `sign-in-account-confirmation-gate-preload.cjs`.
   */
  signInAccountConfirmationGate?: boolean;
  /**
   * ISS-6002: hold the LOCAL SESSION SOURCE down (`starting`, with no observed
   * boot import) while the session read keeps answering — the cold-boot window
   * in which a successful `{ total: 0 }` says nothing about what the store
   * holds. Held from launch; `releaseLocalSessionSource` lets the real source
   * through. See `local-session-source-gate-preload.cjs`.
   */
  localSessionSourceGate?: boolean;
  /**
   * ISS-7593: install the gateway-log read gate. It is INERT until the spec
   * arms it; armed, it parks each `desktop:get-logs` answer until the spec
   * releases it, which is the only way to still be mid-read when Pause is
   * pressed. See `logs-read-gate-preload.cjs`.
   */
  logsReadGate?: boolean;
  /**
   * ISS-10409: fail the LOCAL insights read from launch, so the dashboard
   * resolves to its terminal error branch instead of ever drawing. It FAILS the
   * read rather than parking it, and it fails on arrival: the first read is the
   * one the error branch is reached from, so arming later would arm after it had
   * already succeeded. `releaseInsightsRead` hands the real read back. See
   * `insights-read-failure-gate-preload.cjs`.
   */
  insightsReadFailureGate?: boolean;
  /**
   * ISS-12110: PARK the local insights read for this one section from launch,
   * while every other section answers, until `releaseInsightsSectionHold`. A
   * failed section is not waited on by the dashboard tour, so this holds rather
   * than fails. See `insights-section-hold-gate-preload.cjs`.
   */
  insightsSectionHold?: string;
  /**
   * ISS-10291: park the gateway server's bind from launch, so boot is still
   * waiting on the server — and has not started the update checks — when the
   * spec acts. `releaseGatewayListen` lets boot continue. See
   * `gateway-listen-gate-preload.cjs`.
   */
  gatewayListenGate?: boolean;
};

export function preloadGateLaunchArgs(options: PreloadGateOptions): string[] {
  return [
    ...agentsPageDataGateLaunchArgs(options.agentsPageDataGate === true),
    ...branchesPageDataGateLaunchArgs(options.branchesPageDataGate === true),
    ...desktopAuthStateGateLaunchArgs(options.desktopAuthStateGate === true),
    ...githubConnectLegGateLaunchArgs(options.githubConnectLegGate === true),
    ...signInAccountConfirmationGateLaunchArgs(
      options.signInAccountConfirmationGate === true
    ),
    ...sessionsPageDataGateLaunchArgs(options.sessionsPageDataGate === true),
    ...sessionsListFailureGateLaunchArgs(
      options.sessionsListFailureGate === true
    ),
    ...docsHelpFailureGateLaunchArgs(options.docsHelpFailureGate === true),
    ...localSessionSourceGateLaunchArgs(
      options.localSessionSourceGate === true
    ),
    ...logsReadGateLaunchArgs(options.logsReadGate === true),
    ...insightsReadFailureGateLaunchArgs(
      options.insightsReadFailureGate === true
    ),
    ...gatewayListenGateLaunchArgs(),
    ...insightsSectionHoldGateLaunchArgs(options.insightsSectionHold),
  ];
}

export function preloadGateEnv(
  options: PreloadGateOptions,
  userDataDir: string
): Record<string, string> {
  return {
    ...sessionsPageDataGateEnv(options.sessionsPageDataGate === true),
    ...desktopAuthStateGateEnv(options.desktopAuthStateGate === true),
    ...githubConnectLegGateEnv(options.githubConnectLegGate === true),
    ...signInAccountConfirmationGateEnv(
      options.signInAccountConfirmationGate === true
    ),
    ...sessionsListFailureGateEnv(options.sessionsListFailureGate === true),
    ...docsHelpFailureGateEnv(options.docsHelpFailureGate === true),
    ...localSessionSourceGateEnv(options.localSessionSourceGate === true),
    ...logsReadGateEnv(options.logsReadGate === true),
    ...insightsReadFailureGateEnv(options.insightsReadFailureGate === true),
    ...gatewayListenGateEnv(options.gatewayListenGate === true, userDataDir),
    ...insightsSectionHoldGateEnv(options.insightsSectionHold),
  };
}
