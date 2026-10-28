import type { SessionLinkedArtifact } from "@repo/api/src/types/agent-session";
import { OnboardingAnalyticsPageName } from "@repo/api/src/types/onboarding-analytics";
import { classifySessionDetailError } from "@repo/app/agents/components/detail/agent-session-detail-states";
import { AgentSessionDetailView as SharedAgentSessionDetailView } from "@repo/app/agents/components/detail/agent-session-detail-view";
import { AgentSessionShellView } from "@repo/app/agents/components/detail/agent-session-shell-view";
import { useAgentSessionDetail } from "@repo/app/agents/hooks/use-agent-sessions";
import {
  readTranscriptFileKey,
  readTranscriptInvocationAnchor,
  withTranscriptFileParam,
} from "@repo/app/agents/lib/session-transcript-href";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { readArtifactCommentThreadId } from "@repo/app/shared/lib/artifact-comment-href";
import { ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { NavReferrerSurface } from "@repo/app/shared/lib/nav-referrer";
import { usePageViewedEvent } from "@repo/app/shared/observability/use-page-viewed-event";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { Profiler, useCallback } from "react";
import { DesktopAuthStatus } from "../../../shared/contracts";
import { RendererRenderView } from "../../../shared/render-commit-event";
import { useMarkThreadViewed } from "../../hooks/use-mark-thread-viewed";
import { useTranscriptNeverExpected } from "../../hooks/use-transcript-never-expected";
import {
  detailTitleKey,
  usePublishDetailTitle,
} from "../../navigation/detail-title-context";
import { branchDetailHref } from "../../navigation/route-table";
import { buildArtifactWebHref } from "../../shared-agent-sessions/artifact-web-href";
import { DesktopAppCoreMode } from "../../shared-agent-sessions/desktop-app-core-mode";
import { useDesktopAppCoreMode } from "../../shared-agent-sessions/desktop-app-core-provider";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import { desktopSessionDetailHref } from "../../shared-agent-sessions/session-hrefs";
import { useDesktopIdentity } from "../../shared-agent-sessions/use-desktop-identity";
import { useWebAppOrigin } from "../../shared-agent-sessions/use-web-app-origin";
import { useDesktopBranchesConsumption } from "../../shared-branches/desktop-branches-consumption";
import {
  resolveSessionsDetailCause,
  useRenderCommitInstrumentation,
} from "./use-render-commit-instrumentation";
import { useSessionDetailDeadEndTelemetry } from "./use-sessions-dead-end-telemetry";

/**
 * Desktop wrapper for the shared agent-session detail body.
 *
 * ISS-4793 / ISS-4898: `buildArtifactHref` is passed only when this renderer can
 * produce a destination that actually resolves.
 *
 * It still hosts no document detail routes — `route-table.ts` maps sessions,
 * branches, agents and the nav ids, and nothing else, so an IN-APP
 * `/issues/ISS-4544` has no entry and the nav guard would silently drop a click
 * on it (`handleUnmappedHref` in `desktop-adapter.tsx`). So the destination is
 * not an in-app route at all: it is the ABSOLUTE web-app URL for the artifact,
 * which the shared row renders as an external `<a target="_blank">` and the
 * Electron window-open handler hands to the OS browser — exactly what the PR
 * pills in this same pane already do for GitHub.
 *
 * Two preconditions, and missing either one falls back to inert labels rather
 * than to a link that lies:
 *
 *  - the ORG SLUG. The web artifact route is org-slug-scoped, and this renderer
 *    used to hold only an `organizationId`. ISS-4898 added `organizationSlug` to
 *    the `GET /desktop/identity` payload, additively — an older server omits it,
 *    and then there is no URL to build.
 *  - the configured WEB-APP ORIGIN ({@link useWebAppOrigin}), which is null
 *    until the settings read settles and stays null if it fails.
 *
 * The URL is built by {@link buildArtifactWebHref} against the origin this
 * desktop is CONFIGURED against ({@link useWebAppOrigin}) — a stage-pointed
 * desktop gets a stage URL for its stage org, not a production link to a
 * stranger. That builder also owns the non-navigable-type null.
 *
 * ISS-5366: both preconditions arrive ASYNCHRONOUSLY, so "missing" and "not yet
 * known" are different states and only the first justifies the inert label.
 * Two changes keep the row honest about which one it is in:
 *
 *  - {@link useDesktopIdentity} and {@link useWebAppOrigin} now cache their
 *    settled result process-wide and share one in-flight request, so a mount
 *    that follows any earlier resolution — the shell's own AccountMenu already
 *    resolves identity — seeds both values SYNCHRONOUSLY and never renders a
 *    transient null at all. That also collapses one `GET /desktop/identity` per
 *    hook instance down to one per signed-in user.
 *  - for the genuinely cold first mount, `artifactHrefPending` tells the shared
 *    row to withhold BOTH reachability claims until the reads settle, rather
 *    than showing the muted "not reachable" treatment over a question nobody
 *    has answered yet.
 *
 * Branch Details uses the same absolute-web-route strategy for its "What was
 * delivered" rows under that surface's default-on PRD contract. That wiring is
 * owned by the Branch surface rather than this Session component.
 */
export function SessionDetailView({
  backHref,
  sessionId,
}: {
  backHref: string;
  sessionId: string;
}) {
  const sessionQuery = useAgentSessionDetail(sessionId);
  // PRD-736 (ISS-10502): the aha-moment anchor — first page_viewed[session_detail],
  // gated on the read succeeding exactly as the web page is: a not-found or
  // failed read rendered an error state, not a session, and must not count as
  // the activation moment. Per-mount is correct here (unlike the keep-alive nav
  // views): this view mounts per detail visit, keyed on the session id.
  usePageViewedEvent(OnboardingAnalyticsPageName.SessionDetail, {
    ready: sessionQuery.isSuccess,
  });
  // ISS-7830: this mount IS the user having navigated into the thread, so the
  // capture is unconditional on the read settling — a session that never loads
  // was still opened, and gating on `sessionQuery.data` would silently lose the
  // view for exactly the not-found and offline cases.
  //
  // What it must state is the LOCAL `sessions.id` — the harness
  // `externalSessionId`, which is the key `session_viewership` is written
  // against. The two app-core modes disagree about what the ROUTE id is:
  // the local projection sets `id: session.externalSessionId`
  // (`shared-agent-sessions-api.ts`), so the route id already is that value;
  // the cloud projection sets `id: record.artifactId`
  // (`agent-sessions/service/projections.ts`), a different id space that
  // matches no `sessions` row, so stating it would record nothing and leave
  // the feature dead across the whole authenticated surface (tamsinb, cid
  // 3845388737). The settled detail carries `externalSessionId` in BOTH modes,
  // so prefer it and fall back to the route id until the read lands. The hook
  // re-fires only when the value actually changes — a no-op in local mode,
  // where the two are equal — and the store is monotonic, so the cloud pair of
  // attempts still records exactly one first view.
  useMarkThreadViewed(sessionQuery.data?.externalSessionId ?? sessionId);
  const searchParams = useSearchParamsValue();
  // ISS-4898: the org slug the web artifact route is scoped by. Null until the
  // identity fetch settles, on an older server that omits the field, and while
  // signed out — every one of which leaves the pills inert rather than linking
  // to a URL with a missing segment.
  const { state: authState } = useDesktopAuth();
  // `useDesktopIdentity` short-circuits to null without a fetch while signed
  // out, so a signed-out detail mount still issues no IPC.
  const { identity, isResolved: identityResolved } = useDesktopIdentity(
    authState.status,
    authState.userId
  );
  const organizationSlug = identity?.organizationSlug ?? null;
  const { origin: webAppOrigin, isResolved: originResolved } =
    useWebAppOrigin();
  const canBuildArtifactHref = Boolean(organizationSlug && webAppOrigin);
  // ISS-5366: both inputs arrive over IPC, so there is a window in which we do
  // not yet know whether these pills are reachable. `canBuildArtifactHref` is
  // false in that window for the same reason it is false when they genuinely
  // are not reachable — and the row used to render its settled "not reachable"
  // label for both, asserting something it had not checked. Report the window
  // explicitly so the row can withhold the claim instead of guessing at it.
  //
  // Only unresolved-and-not-yet-buildable counts: once either input has settled
  // into a usable value the href builds, and once BOTH have settled the answer
  // is final either way.
  const artifactHrefPending = !(
    canBuildArtifactHref ||
    (identityResolved && originResolved)
  );
  // A non-navigable type (or a slug-less artifact) resolves to null and the
  // shared row keeps that pill an honest label.
  const buildArtifactHref = useCallback(
    (artifact: SessionLinkedArtifact) =>
      // `webAppOrigin` is null until the settings read settles, and stays null
      // if it fails (whitlockk + codex review): a pending or failed read must leave
      // the pill inert, never fall back to production and pair a prod origin
      // with a stage/local org slug.
      organizationSlug && webAppOrigin
        ? buildArtifactWebHref(webAppOrigin, organizationSlug, artifact)
        : null,
    [organizationSlug, webAppOrigin]
  );
  // ISS-7249: count the not-found / unavailable / stalled treatments below as
  // the tracked errors they are. Emits once per render-with-cause, so a poll
  // tick on a session that stays missing does not re-count it.
  useSessionDetailDeadEndTelemetry({
    error: sessionQuery.error,
    errorKind: classifySessionDetailError(sessionQuery.error),
    hasSession: Boolean(sessionQuery.data),
    isError: sessionQuery.isError,
    isLoading: sessionQuery.isLoading,
  });
  const transcriptFileKey = readTranscriptFileKey(searchParams);
  const invocationAnchor = readTranscriptInvocationAnchor(searchParams);
  // ISS-11004: the Activity tab's comment rows link here with `?comment=`; the
  // shell that owns the URL reads it, as it does the transcript deep links.
  const selectedThreadId = readArtifactCommentThreadId(searchParams);
  const buildTranscriptFileHref = useCallback(
    (fileKey: string) =>
      withTranscriptFileParam(
        desktopSessionDetailHref({ id: sessionId }),
        fileKey
      ),
    [sessionId]
  );
  // FEA-4262: tag the session's Branch link with `?from=session` so the branch
  // detail page's Back returns to the sessions list the user came from.
  const getBranchHref = useCallback(
    (branchArtifactId: string) =>
      branchDetailHref(branchArtifactId, NavReferrerSurface.Session),
    []
  );
  // ISS-5567: a branch id only resolves against the source that MINTED it — the
  // cloud detail reads a Branch artifact UUID, the local detail decodes an
  // `encodeBranchId` composite. The two surfaces pick their source by DIFFERENT
  // rules: Sessions weighs connectivity and the sync backlog
  // (`useDesktopAppCoreMode`), Branches only whether a canonical cloud identity
  // exists. So an authenticated user who is offline — or online but pre-drain —
  // reads this session locally while `/branches/:id` would be served by the
  // cloud, and the local id names nothing there. Withhold the builder whenever
  // the two disagree: the shared pane then renders the Branch row as plain text,
  // which is what it did before this feature, rather than offering a link that
  // lands on "not found".
  //
  // The auth read that decides the Branches half arrives over IPC, so there is a
  // window in which the answer is not yet known — and the two sources AGREE
  // vacuously in it (both read `false` from an unsettled auth state). Asserting
  // the link there and retracting it a tick later is the worst shape available:
  // the app-core mode does not change across that transition, so nothing else on
  // the pane moves, the row just quietly stops being a link — and because the
  // shared row swaps element types, a focused anchor is unmounted out from under
  // the keyboard. So require the read to have SETTLED, the same "pending is not
  // an answer" rule `artifactHrefPending` above applies to the artifact pills.
  //
  // This closes the PENDING-window retraction, and only that. It is NOT a
  // once-linked-always-linked guarantee: `useDesktopAuth` is a live store, so a
  // later transition can still withdraw the link, and that withdrawal is CORRECT
  // — the rendered id was minted by one source and names nothing in the other.
  //
  // ISS-5605 (STILL OPEN) tracks the fact that the withdrawal is SILENT. Its
  // stated repro — sign-in flipping `branchesReadCloud` true while the session
  // read stays on Local — no longer reproduces: ISS-5714 put BOTH surfaces
  // behind the same read-source rule, so in that state they agree and the link
  // survives. No OTHER path to a silent withdrawal is pinned here,
  // and none is claimed: a mode change rebuilds the app-core stack's QueryClient
  // outright (`useDesktopAppCoreStack` swaps its whole stack ref per mode), so
  // the pane visibly reloads around any withdrawal a mode change causes. Do NOT
  // "fix" this with a latch, which would keep a genuinely dead link alive.
  // ISS-5607's read-source badge (mounted in the Topbar by
  // `SessionReadSourceTopbarAction`) is the disclosure half and does not by
  // itself close ISS-5605.
  //
  // The Branches half is READ FROM THE CONTEXT rather than re-derived here
  // (stage review on #4650): `DesktopBranchesConsumptionProvider` is mounted by
  // `DesktopAppCoreModeStack` (ISS-5714 moved it there, inside the app-core
  // mode context), which `main.tsx` wraps around the whole `App`, so
  // this component always sits inside it and the provider's own
  // `useCanonicalCloudSource` is the value `DesktopBranchesSource` will actually
  // select on. A second derivation of the same rule would have to be changed in
  // lockstep with the provider forever, and already diverged for a provider-less
  // mount (context defaults to local; a re-derivation reads cloud off an
  // authenticated auth stub) — exactly the standalone case that would then paint
  // a link the real source cannot serve.
  const sessionsReadCloud =
    useDesktopAppCoreMode() === DesktopAppCoreMode.Cloud;
  const branchesReadCloud =
    useDesktopBranchesConsumption().useCanonicalCloudSource;
  const branchSourceResolved = authState.status !== DesktopAuthStatus.Loading;
  const branchLinkResolvable =
    branchSourceResolved && sessionsReadCloud === branchesReadCloud;
  // Publish the session name to the Topbar breadcrumb (mirrors the web detail
  // page's "Sessions / <name>" breadcrumb); null while still loading. The third
  // argument reports that the READ settled (ISS-4839 / codex review on #4266):
  // a not-found or errored session publishes a null name just like a loading
  // one, and without this the breadcrumb would hold its pending skeleton
  // forever against a body that already says "Session not found".
  usePublishDetailTitle(
    detailTitleKey("session", sessionId),
    sessionQuery.data?.name ?? sessionQuery.data?.externalSessionId ?? null,
    !sessionQuery.isLoading
  );
  // FEA-1998: render-commit timing for the session detail. Item count is the
  // number of rendered session events.
  // ISS-7516: the desktop's LOCAL answer for whether a transcript is never
  // expected, read from this device's own consent record and scoped to sessions
  // recorded on THIS machine (the hook compares compute-target identity),
  // because this device's level says nothing about someone else's.
  //
  // It is the FALLBACK, not the answer. `AgentSessionDetailView` prefers the
  // recording machine's level off the session payload when the server reports
  // one (ISS-7516 wire half) — which is both correct for another machine's
  // session and the only thing the web has. This stays wired so a desktop
  // talking to a server that predates that field keeps working.
  const transcriptNeverExpected = useTranscriptNeverExpected(
    sessionQuery.data?.computeTarget.id ?? null
  );
  const onRenderCommit = useRenderCommitInstrumentation({
    view: RendererRenderView.SessionsDetail,
    itemCount: sessionQuery.data?.events.length ?? 0,
    causeInputs: { sessionId },
    resolveCause: resolveSessionsDetailCause,
  });
  const SessionDetailBody = useFeatureFlagEnabledOptional(
    ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY
  )
    ? AgentSessionShellView
    : SharedAgentSessionDetailView;
  // The Topbar breadcrumb ("Sessions / <name>") is the back affordance now;
  // this wrapper stays as the detail shell (h-full overflow-hidden). backHref
  // still feeds the shared not-found state's "Back to Sessions" link.
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <Profiler id="sessions_detail" onRender={onRenderCommit}>
        <SessionDetailBody
          artifactHrefPending={artifactHrefPending}
          backHref={backHref}
          buildArtifactHref={
            canBuildArtifactHref ? buildArtifactHref : undefined
          }
          buildTranscriptFileHref={buildTranscriptFileHref}
          errorKind={classifySessionDetailError(sessionQuery.error)}
          getBranchHref={branchLinkResolvable ? getBranchHref : undefined}
          invocationAnchor={invocationAnchor}
          isError={sessionQuery.isError}
          isLoading={sessionQuery.isLoading}
          selectedThreadId={selectedThreadId}
          session={sessionQuery.data}
          transcriptFileKey={transcriptFileKey}
          transcriptNeverExpected={transcriptNeverExpected}
        />
      </Profiler>
    </div>
  );
}
