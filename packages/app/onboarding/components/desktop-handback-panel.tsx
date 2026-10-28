"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  isGatewayDetectionExhausted,
  rearmGatewayDetection,
  useGatewayDetection,
} from "@repo/shared-platform/detection-store";
import { Loader2Icon, MonitorUpIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { openDesktopApp } from "../lib/desktop-deep-link-navigation";
import {
  DesktopRecheckPhase,
  DesktopUndetectedNotice,
} from "./desktop-undetected-notice";

/**
 * How long the hand-back gets to land before this surface says anything at all.
 *
 * The bound runs from MOUNT, not from a click, and while it runs this component
 * renders NOTHING. The happy path asks nothing of the user — the desktop brings
 * itself forward off the loopback callback (ISS-10412 `returnFromBrowserSignIn`)
 * — so there is nothing to offer for it, and offering anyway is what the
 * operator ruled against on 2026-09-28. The panel is the FAILURE MODE only.
 *
 * Firing `closedloop://` is UNOBSERVABLE from the browser: an unregistered or
 * refused scheme no-ops with no error and no event. So this bound cannot detect
 * a failure, and the copy it unlocks does not claim one — it says the app is
 * running in the background and offers the manual route, which is the whole of
 * what the page knows.
 *
 * The verdict is keyed on the OBSERVABLE this surface has. The panel only
 * renders once detection has found the app, so reachability is already true
 * and carries no signal about whether the window came to the front. What this
 * surface can observe is whether THIS TAB is still the one in front, so that is
 * what the verdict is keyed on.
 */
const HANDBACK_UNCONFIRMED_MS = 6000;

/** How long the explicit re-check shows feedback before it may report a result. */
const RECHECK_MIN_FEEDBACK_MS = 1200;

const HandbackAttempt = {
  /** Watching silently. Nothing rendered, and nothing asked of the user. */
  Untried: "untried",
  /** The user fired the deep link here, and nothing has contradicted it. */
  Unconfirmed: "unconfirmed",
  /** A bound elapsed with this tab still the one in front. */
  Unanswered: "unanswered",
  /**
   * This tab went hidden, which is the desktop having come forward. TERMINAL:
   * the watch does not re-arm, so returning to the tab cannot resurrect a panel
   * for a hand-back that worked.
   *
   * It is a deliberately generous reading — a user who alt-tabs to their email
   * inside the bound also lands here and is never offered the panel. That is
   * the honest side of an ambiguous signal: silence claims nothing, while a
   * panel would assert a failure the browser never established.
   */
  Landed: "landed",
  // Still no FAILED member. The scheme is unobservable, so no state here knows
  // the launch failed; `Unanswered` says only that this tab is still in front.
} as const;
type HandbackAttempt = (typeof HandbackAttempt)[keyof typeof HandbackAttempt];

/**
 * All four strings are HUMAN-AUTHORED, ruled by @marisolashgrove on 2026-09-28, and
 * are reproduced here byte-for-byte — punctuation, casing and the absent
 * trailing period on {@link DETECTED_COPY} included. AGENTS.md:373 forbids an
 * agent originating user-visible words, so do not "improve" any of them.
 *
 * {@link UNANSWERED_COPY} asserts the app IS running, which the panel is
 * entitled to say because neither sentence can render until
 * `detection.detected` is true — the `DesktopUndetectedNotice` early return
 * below owns every state where running-ness is unestablished, and carries its
 * own copy.
 */
const OPEN_LABEL = "Open the desktop app";
const OPENING_LABEL = "Opening the desktop app";
const UNANSWERED_COPY =
  "The desktop app is running in the background, switch to it now.";
const DETECTED_COPY = "Pick up where you left off in the desktop app";

/**
 * The browser half of the post-auth hand-back: bring a RUNNING desktop app to
 * the front, or say honestly that one could not be found.
 *
 * ISS-11429, operator scope. A desktop user is sent to the browser to sign up or
 * sign in and is then stranded in a tab while the app they actually wanted sits
 * behind it. The desktop already brings itself forward when the renderer's own
 * `BeginSignIn` promise resolves (ISS-10412, `returnFromBrowserSignIn`), and it
 * already HOLDS the first-launch walkthrough's one shot across a browser round
 * trip rather than spending it mid-handoff (ISS-11315 Defect 4,
 * `isDesktopAuthHandoffPending`), reopening it on the falling edge. What neither
 * covers is the leg that does not come back through that promise — a loopback
 * navigation that does not land, or a browser sign-up that never went through
 * the desktop's own IPC at all. Then nothing in the browser offers a way back.
 *
 * So this is the missing return path, and the walkthrough continues BECAUSE the
 * app is activated: `handleActivate()` runs
 * `processCanonicalOnboardingHandoff("activate")`, which resumes the run the
 * desktop was already holding. Nothing about the run travels through the URL,
 * and it must not: `closedloop://` is payload-free by deliberate security
 * design, every field checked, deny by default
 * (`apps/desktop/src/main/lifecycle/deep-link.ts`), so the desktop's own state
 * is the only authority on where the run resumes.
 *
 * The four-state detection model is not collapsed into a running-or-download
 * branch — that collapse is exactly what {@link DesktopUndetectedNotice} exists
 * to prevent, and its rule governs here: a stopped probe must never render as a
 * proven negative it did not establish. Not-detected delegates to that component
 * wholesale (still sweeping, checking now, gave up, checked-again-still-nothing).
 *
 * DETECTED renders nothing until the hand-back has demonstrably not landed. The
 * silent watch ({@link HANDBACK_UNCONFIRMED_MS}) starts on mount; the tab going
 * hidden ends it as a success and nothing is ever shown, and only the bound
 * elapsing with this tab still in front opens the panel.
 *
 * The panel's own control stays a CLICK rather than an auto-fired navigation, and
 * that is not a shortcut. Browsers gate external-protocol navigation behind a
 * user gesture and drop an ungated one SILENTLY — console note only, no error and
 * no event — so an auto-fire on mount would be indistinguishable from a fire that
 * worked, on a scheme that is already unobservable. Every other `closedloop://`
 * site in this repo is behind a gesture for the same reason, the desktop's own
 * loopback success page included (`apps/desktop/src/main/auth/desktop-handoff-page.ts`
 * serves an anchor, not a redirect).
 *
 * Lives in `packages/app` so ISS-11458 — the same mechanism for the dashboard
 * empty state — consumes this rather than building a second, divergent answer to
 * the same question.
 */
export function DesktopHandbackPanel({
  latestVersion = null,
}: {
  /** Newest desktop release, for the not-detected notice's download route. */
  readonly latestVersion?: string | null;
}) {
  // `fastPoll`: the user has just finished authenticating for the desktop app,
  // so asking whether it is there is the thing they came for.
  const detection = useGatewayDetection(true, { fastPoll: true });
  const [phase, setPhase] = useState<DesktopRecheckPhase>(
    DesktopRecheckPhase.Idle
  );
  const [attempt, setAttempt] = useState<HandbackAttempt>(
    HandbackAttempt.Untried
  );
  const recheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Read through the store's own stop condition rather than re-derived here: the
  // probe budget depends on which loop is running, which only that module knows,
  // and a render-site guess would keep claiming "still looking" past the point
  // where nothing is looking.
  const detectionExhausted = isGatewayDetectionExhausted();

  useEffect(
    () => () => {
      if (recheckTimerRef.current) {
        clearTimeout(recheckTimerRef.current);
      }
    },
    []
  );

  // Finding the app retires any re-check in progress and any unanswered attempt:
  // both are statements about an app that was not there, and it now is.
  useEffect(() => {
    if (!detection.detected) {
      return;
    }
    setPhase(DesktopRecheckPhase.Idle);
    setAttempt((previous) =>
      previous === HandbackAttempt.Unanswered
        ? HandbackAttempt.Untried
        : previous
    );
  }, [detection.detected]);

  const onRecheck = () => {
    setPhase(DesktopRecheckPhase.Checking);
    // `userInitiated` because this IS the explicit control the store's docstring
    // names. Without it every click charges a passive-rearm attempt, doubling the
    // focus/visibility debounce toward its 30-minute cap — so asking more often
    // would make the answer arrive later.
    rearmGatewayDetection({ userInitiated: true });
    if (recheckTimerRef.current) {
      clearTimeout(recheckTimerRef.current);
    }
    // The minimum-feedback hold. Without it a cached negative answers instantly
    // and the button appears to do nothing; with it the user sees the check run.
    // It may only report a NEGATIVE — the effect above overrides it the moment
    // the app is found.
    recheckTimerRef.current = setTimeout(() => {
      setPhase((previous) =>
        previous === DesktopRecheckPhase.Checking
          ? DesktopRecheckPhase.StillAbsent
          : previous
      );
    }, RECHECK_MIN_FEEDBACK_MS);
  };

  // The silent watch. PRIMITIVE deps, and only the two that decide whether a
  // verdict is still open: the detected poll re-probes every 10s and every
  // snapshot re-renders this component, so deps that changed per render would
  // tear down and re-arm the bound on each poll — pushing the verdict out
  // indefinitely on a visible tab, and re-arming it on a hidden one so that
  // returning to the browser produced a failure panel moments after the
  // hand-back had worked. `setAttempt` is a stable setter, so nothing else has
  // to be memoised to hold that.
  useEffect(() => {
    const watching =
      attempt === HandbackAttempt.Untried ||
      attempt === HandbackAttempt.Unconfirmed;
    if (!(detection.detected && watching)) {
      return;
    }
    const timeoutId = setTimeout(() => {
      // The one thing this page can actually see. A desktop window that came to
      // the front takes focus off this document, so a tab that is STILL the
      // visible one is the only evidence there is that the hand-back did not
      // land — and it is what opens the panel.
      if (globalThis.document.visibilityState === "hidden") {
        return;
      }
      setAttempt(HandbackAttempt.Unanswered);
    }, HANDBACK_UNCONFIRMED_MS);
    // Reading visibility only when the timer fires is not enough: the tab going
    // hidden IS the success signal, and a throttled timer can land after the
    // user has come back. So settle it at the moment the evidence arrives.
    const onVisibilityChange = () => {
      if (globalThis.document.visibilityState === "hidden") {
        setAttempt(HandbackAttempt.Landed);
      }
    };
    globalThis.document.addEventListener(
      "visibilitychange",
      onVisibilityChange
    );
    return () => {
      clearTimeout(timeoutId);
      globalThis.document.removeEventListener(
        "visibilitychange",
        onVisibilityChange
      );
    };
    // `attempt` itself, not a boolean derived from it: a click moves
    // Untried -> Unconfirmed, which must RESTART the bound, and a boolean would
    // collapse that transition and leave the first bound running.
  }, [attempt, detection.detected]);

  const onFire = useCallback(() => {
    setAttempt(HandbackAttempt.Unconfirmed);
    openDesktopApp();
  }, []);

  if (!detection.detected) {
    return (
      <DesktopUndetectedNotice
        detectionExhausted={detectionExhausted}
        latestVersion={latestVersion}
        onRecheck={onRecheck}
        phase={phase}
        runningVersion={detection.version}
      />
    );
  }

  // Silent until the hand-back has demonstrably not landed. Operator ruling,
  // 2026-09-28: "it should take no action from user if desktop can properly be
  // brought up from background. Only need for a panel is failure mode."
  if (
    attempt === HandbackAttempt.Untried ||
    attempt === HandbackAttempt.Landed
  ) {
    return null;
  }

  return <DesktopHandbackAction attempt={attempt} onFire={onFire} />;
}

/**
 * The failure-mode panel: purely presentational, reached only once the silent
 * watch above has opened it. The control is a CLICK because an external-protocol
 * navigation without a user gesture is dropped silently by browsers.
 */
function DesktopHandbackAction({
  attempt,
  onFire,
}: {
  readonly attempt: HandbackAttempt;
  readonly onFire: () => void;
}) {
  const pending = attempt === HandbackAttempt.Unconfirmed;

  return (
    <div aria-live="polite" className="mt-4 flex flex-col gap-2">
      <p className="text-muted-foreground text-sm">
        {attempt === HandbackAttempt.Unanswered
          ? UNANSWERED_COPY
          : DETECTED_COPY}
      </p>
      <Button className="w-full" disabled={pending} onClick={onFire}>
        {pending ? <Loader2Icon className="animate-spin" /> : <MonitorUpIcon />}
        {pending ? OPENING_LABEL : OPEN_LABEL}
      </Button>
    </div>
  );
}
