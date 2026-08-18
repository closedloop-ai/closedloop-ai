import {
  Alert,
  AlertDescription,
} from "@closedloop-ai/design-system/components/ui/alert";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@closedloop-ai/design-system/components/ui/dialog";
import { AlertCircle, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import { GUEST_OFFER_COPY, type OfferCopy } from "./guest-signup-copy";
import { GuestSignupIntent } from "./guest-signup-provider";
import { signInFailureMessage } from "./sign-in-failure-message";

const SIGN_UP_LABEL = "Sign Up";
const SIGN_UP_PENDING_LABEL = "Opening browser…";
/**
 * `DialogContent` IS the panel — it already ships the background, border,
 * radius, padding and elevation, and both steps render straight onto it.
 *
 * An earlier revision hollowed it out (`border-none bg-transparent p-0`) so a
 * nested `Card` could be the visible surface. That left two components owning
 * one panel and neither doing the whole job: the shadow rendered on an
 * invisible box, and the close control had no surface to belong to. Nothing
 * nested renders its own surface now — the dialog's content is the offer or the
 * signing-up notice, both plain.
 */
const PANEL_CLASS = "sm:max-w-md";
/**
 * The scroll lives INSIDE the panel, not on it. On the `DialogContent` it made
 * Radix's `absolute top-4 right-4` close control a scrolling child, so the only
 * visible way out disappeared as soon as the setup step's sync-consent tiers ran
 * past the viewport.
 *
 * `pt-2` is what keeps content from sliding UNDER that control on the way past:
 * the close sits 16px down and is 16px tall, so its lower edge is 32px from the
 * panel top, and the panel's own `p-6` only accounts for 24 of those.
 */
const PANEL_SCROLL_CLASS = "max-h-[75vh] overflow-y-auto pt-2";

type AccountDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Which surface asked. Decides both the offer's copy and whether the offer is
   * shown at all. Defaults to the standing header offer.
   */
  intent?: GuestSignupIntent;
  /**
   * Fired when the flow COMPLETED, before the close. Distinguishes "they signed
   * up" from "they backed out", which the close alone cannot — and only the
   * former should resume whatever the person was doing when they were asked.
   */
  onSignedUp?: () => void;
};

/**
 * ISS-5112 — what a guest sees when the first-run tour ends.
 *
 * The pitch first, the sign-in methods only if they want them. "Not now" is a
 * real answer: the dialog closes and the guest keeps the dashboard they were
 * just shown, which is the whole point of guest mode. Escape, the overlay, and
 * the close control all do the same thing, so this can never trap anyone the way
 * the pre-auth blocking overlay does.
 *
 * "Sign Up" starts the real loopback OAuth run through the system browser
 * directly (ISS-5489). It used to mount `DesktopOnboardingFlow` here and ask
 * which provider first; the web page already asks that, so the middle step cost
 * a click and carried no information. Consent moved too — the post-auth takeover
 * owns it — so this dialog's whole job is the offer and the handoff.
 */
export function AccountDialog({
  open,
  onOpenChange,
  onSignedUp,
  intent = GuestSignupIntent.Header,
}: AccountDialogProps) {
  const { beginSignIn, cancelSignIn } = useDesktopAuth();
  const [signingUp, setSigningUp] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const startedRef = useRef(false);
  /**
   * Which handoff attempt is current. Bumped on every start AND on every close,
   * so a run whose promise is still outstanding cannot write into the dialog
   * after the user has moved on.
   *
   * `cancelSignIn` releases the main-process slot but does not un-await this
   * side's promise: a cancelled run still settles here, and without a token it
   * would clear the spinner of a NEWER run, or — if it settled `ok` — fire
   * `onSignedUp` and close a dialog the user had just reopened.
   */
  const runIdRef = useRef(0);

  // Radix routes Escape, the overlay click, and the close control through here,
  // so resetting on close covers every exit — a reopened dialog never inherits a
  // stale in-flight state or the error from a previous attempt.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      if (signingUp) {
        // `beginBrowserSignIn` is single-flight in the main process. Backing out
        // while the system browser is open leaves that run in flight, and the
        // next "Sign Up" is refused with "A sign-in is already in progress."
        // with nothing on screen to clear it. Best-effort, the same way the
        // session-expired banner and Settings → Account cancel.
        cancelSignIn().catch(() => undefined);
      }
      setSigningUp(false);
      setSignInError(null);
      startedRef.current = false;
      // Whatever was in flight belongs to a dialog that is gone.
      runIdRef.current += 1;
    }
    onOpenChange(next);
  };

  /**
   * "Sign Up" opens the web sign-up page directly — there is no second dialog.
   *
   * It used to hand off to `DesktopOnboardingFlow` rendered inside this dialog,
   * which meant a dialog whose only job was to offer an account opened another
   * dialog to ask which provider. The web page already asks that, so the middle
   * step was a screen that added a click and no information.
   *
   * The await matters: `beginSignIn` resolves when the loopback round-trip
   * finishes, which is the SAME success signal the flow used. Without it there
   * would be no moment to report completion, and the resume-after-signup intent
   * (`onSignedUp`) — the thing that reopens the invite dialog someone was asking
   * for when they got sent to sign up — would silently never fire.
   */
  const handleSignUp = useCallback(async () => {
    runIdRef.current += 1;
    const runId = runIdRef.current;
    setSigningUp(true);
    setSignInError(null);
    let failure: string | null = null;
    try {
      const result = await beginSignIn();
      if (!result.ok) {
        failure = signInFailureMessage(result.reason);
      }
    } catch {
      failure = signInFailureMessage();
    }
    // Superseded — the dialog was closed, or a newer attempt started. Its own
    // run owns the state from here; this one settles silently.
    if (runId !== runIdRef.current) {
      return;
    }
    setSigningUp(false);
    if (failure) {
      setSignInError(failure);
      return;
    }
    // Order matters: the success signal goes out BEFORE the close, so a host
    // that treats the close as "they backed out" has already been told
    // otherwise.
    onSignedUp?.();
    onOpenChange(false);
    // Stable identity so the skips-offer effect below can depend on it honestly
    // rather than re-running every render. Only the state setters are omitted,
    // and those are stable by contract.
  }, [beginSignIn, onSignedUp, onOpenChange]);

  // An ask made FROM a surface that already stated the case does not get to
  // state it twice: the organization gate card names the view, the value and the
  // price before its button is ever pressed. It used to skip the offer and open
  // the sign-in flow directly; with that flow gone (ISS-5489) the equivalent is
  // to open the browser directly. The dialog still renders, so there is a
  // spinner to look at and a way to back out and cancel the in-flight run.
  useEffect(() => {
    if (!(open && skipsOffer(intent)) || startedRef.current) {
      return;
    }
    startedRef.current = true;
    handleSignUp().catch(() => {
      // `handleSignUp` already routes every failure into `signInError`; this arm
      // exists so an escaped rejection cannot surface as an unhandled renderer
      // rejection on a path the user cannot act on.
    });
    // `startedRef`, not the dep list, is what guarantees ONE browser handoff per
    // open — `handleOpenChange` resets it on close.
  }, [open, intent, handleSignUp]);

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className={PANEL_CLASS}>
        <div className={PANEL_SCROLL_CLASS}>
          {skipsOffer(intent) ? (
            <SigningUpNotice
              copy={GUEST_OFFER_COPY[intent]}
              error={signInError}
              onDecline={() => handleOpenChange(false)}
            />
          ) : (
            <AccountOffer
              copy={GUEST_OFFER_COPY[intent]}
              error={signInError}
              onDecline={() => handleOpenChange(false)}
              onSignUp={handleSignUp}
              signingUp={signingUp}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AccountOffer({
  copy,
  onSignUp,
  onDecline,
  signingUp,
  error,
}: {
  copy: OfferCopy;
  onSignUp: () => void;
  onDecline: () => void;
  signingUp: boolean;
  error: string | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        {copy.eyebrow ? (
          <p className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
            {copy.eyebrow}
          </p>
        ) : null}
        <DialogTitle className="text-xl">{copy.title}</DialogTitle>
        <DialogDescription className="text-pretty leading-relaxed">
          {copy.body}
        </DialogDescription>
      </DialogHeader>
      {error ? (
        <Alert variant="error">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-col gap-2 pt-2">
        <Button aria-busy={signingUp} disabled={signingUp} onClick={onSignUp}>
          {signingUp ? <Loader2 className="animate-spin" /> : null}
          {signingUp ? SIGN_UP_PENDING_LABEL : SIGN_UP_LABEL}
        </Button>
        <Button disabled={signingUp} onClick={onDecline} variant="ghost">
          Not now
        </Button>
      </div>
      {/*
        Both this and the primary open the SAME web page — desktop auth is one
        loopback OAuth door, and that page serves sign-in and sign-up alike. An
        earlier revision removed this line for exactly that reason; it is back
        because the prototype is the spec and the two labels answer different
        questions a person is actually asking themselves ("do I make one?" vs "I
        already have one"), which the page they land on can then honour.
      */}
      <p className="text-center text-muted-foreground text-sm">
        Already have an account?{" "}
        <Button
          className="h-auto p-0 align-baseline text-foreground"
          disabled={signingUp}
          onClick={onSignUp}
          variant="link"
        >
          Sign in
        </Button>
      </p>
    </div>
  );
}

/**
 * What an ask that skips the pitch shows while the browser opens.
 *
 * Deliberately NOT {@link AccountOffer}: the whole point of skipping is that the
 * calling surface already made the argument, so repeating it here — even behind
 * a spinner — would be the second pitch this intent exists to avoid. Title,
 * progress, and a way out.
 */
function SigningUpNotice({
  copy,
  onDecline,
  error,
}: {
  copy: OfferCopy;
  onDecline: () => void;
  error: string | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle className="text-xl">{copy.title}</DialogTitle>
        <DialogDescription className="text-pretty leading-relaxed">
          Opening your browser to finish signing up.
        </DialogDescription>
      </DialogHeader>
      {error ? (
        <Alert variant="error">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : (
        <div
          className="flex items-center gap-2 text-muted-foreground text-sm"
          role="status"
        >
          <Loader2 className="size-4 animate-spin" />
          {SIGN_UP_PENDING_LABEL}
        </div>
      )}
      <Button onClick={onDecline} variant="ghost">
        Not now
      </Button>
    </div>
  );
}

/**
 * Whether this ask opens the browser immediately instead of making its case.
 *
 * An ask made FROM a surface that already stated the case does not get to state
 * it twice: the organization gate card names the view, the value and the price
 * before its button is ever pressed, so following it with a dialog that makes
 * the same argument reads as being asked the same question two screens running.
 * The uncontextual asks — the standing header offer, the end of the tour, the
 * invite item, which is a menu label and not an argument — still need the offer
 * to make the case.
 */
function skipsOffer(intent: GuestSignupIntent): boolean {
  return intent === GuestSignupIntent.Organization;
}
