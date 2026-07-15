import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@closedloop-ai/design-system/components/ui/card";
import { useEffect, useState } from "react";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import { signInPendingMessage } from "../../shared-agent-sessions/desktop-sign-in-copy";
import type {
  DesktopAuthStatus,
  DesktopBrowserSignInFailure,
  DesktopIdentity,
} from "../../types/desktop-api";

/**
 * Settings → Account: the first-party desktop sign-in surface (FEA-2219). Drives
 * the {@link DesktopSessionManager} state machine over IPC — primary sign-in
 * action, cancel while the browser approval is pending, sign-out, and an
 * actionable message for each failure. Never renders token, refresh, or session
 * secret material; once signed in it fetches the display-only identity (name,
 * email, organization name) and falls back to the session's ids if unavailable.
 */
export function DesktopAccountTab() {
  const { state, beginSignIn, cancelSignIn, signOut } = useDesktopAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<DesktopIdentity | null>(null);

  // Resolve the human-readable identity once signed in. Re-runs if the signed-in
  // user changes; a null result (fetch/transport failure) leaves the id fallback
  // in place rather than blanking the panel.
  const authedUserId = state.status === "authenticated" ? state.userId : null;
  useEffect(() => {
    const fetchIdentity = window.desktopApi.getDesktopIdentity;
    if (!(authedUserId && fetchIdentity)) {
      setIdentity(null);
      return;
    }
    let cancelled = false;
    fetchIdentity()
      .then((result) => {
        if (!cancelled) {
          setIdentity(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIdentity(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [authedUserId]);

  const handleSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await beginSignIn();
      if (!(result.ok || result.reason === "cancelled")) {
        setError(signInFailureMessage(result.reason));
      }
    } catch {
      setError("Sign-in could not be completed. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    setError(null);
    await cancelSignIn().catch(() => {
      // Cancel is best-effort; the pushed state is the source of truth.
    });
  };

  const handleSignOut = async () => {
    setBusy(true);
    setError(null);
    try {
      await signOut();
    } catch {
      setError("Sign-out could not be completed. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <AccountStatusRow status={state.status} />

          {state.status === "authenticated" ? (
            <SignedInDetails
              busy={busy}
              identity={identity}
              onSignOut={handleSignOut}
              organizationId={state.organizationId}
              userId={state.userId}
            />
          ) : (
            <SignedOutActions
              busy={busy}
              onCancel={handleCancel}
              onSignIn={handleSignIn}
              status={state.status}
            />
          )}

          {error && (
            <p className="text-[var(--destructive)] text-xs">{error}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AccountStatusRow({ status }: { status: DesktopAuthStatus }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-24 shrink-0 text-[var(--muted-foreground)]">
        Status
      </span>
      <Badge variant={status === "authenticated" ? "default" : "outline"}>
        {STATUS_LABELS[status]}
      </Badge>
    </div>
  );
}

function SignedInDetails({
  identity,
  userId,
  organizationId,
  busy,
  onSignOut,
}: {
  identity: DesktopIdentity | null;
  userId: string | null;
  organizationId: string | null;
  busy: boolean;
  onSignOut: () => void;
}) {
  const fullName = identity
    ? [identity.firstName, identity.lastName].filter(Boolean).join(" ")
    : "";
  // Prefer name, then email, then the raw id so the row is never blank.
  const userValue = fullName || identity?.email || userId || "—";
  const userSecondary = fullName && identity?.email ? identity.email : null;
  const organizationValue = identity?.organizationName || organizationId || "—";

  return (
    <div className="space-y-3 border-t pt-3">
      <IdentityRow label="User" secondary={userSecondary} value={userValue} />
      <IdentityRow label="Organization" value={organizationValue} />
      <div className="flex justify-end">
        <Button disabled={busy} onClick={onSignOut} size="sm" variant="outline">
          {busy ? "Signing out..." : "Sign out"}
        </Button>
      </div>
    </div>
  );
}

function SignedOutActions({
  status,
  busy,
  onSignIn,
  onCancel,
}: {
  status: DesktopAuthStatus;
  busy: boolean;
  onSignIn: () => void;
  onCancel: () => void;
}) {
  const pending =
    status === "opening_browser" ||
    status === "awaiting_redirect" ||
    status === "exchanging";

  return (
    <div className="space-y-3 border-t pt-3">
      <p className="text-[var(--muted-foreground)] text-xs">
        {status === "refresh_failed"
          ? "Your session expired or was revoked. Sign in again to reconnect this device."
          : "Sign in with your browser to connect this device to Closedloop."}
      </p>
      {pending ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-[var(--muted-foreground)] text-sm">
            {signInPendingMessage(status)}
          </p>
          <Button onClick={onCancel} size="sm" variant="ghost">
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button
            disabled={busy || status === "loading"}
            onClick={onSignIn}
            size="sm"
            variant="default"
          >
            {busy ? "Signing in..." : "Sign in"}
          </Button>
        </div>
      )}
    </div>
  );
}

function IdentityRow({
  label,
  value,
  secondary,
}: {
  label: string;
  value: string;
  secondary?: string | null;
}) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="w-24 shrink-0 pt-0.5 text-[var(--muted-foreground)]">
        {label}
      </span>
      <div className="min-w-0">
        <p className="truncate">{value}</p>
        {secondary ? (
          <p className="truncate text-[var(--muted-foreground)] text-xs">
            {secondary}
          </p>
        ) : null}
      </div>
    </div>
  );
}

const STATUS_LABELS: Record<DesktopAuthStatus, string> = {
  loading: "Checking…",
  signed_out: "Signed out",
  opening_browser: "Opening browser…",
  awaiting_redirect: "Waiting for browser…",
  exchanging: "Finishing sign-in…",
  authenticated: "Signed in",
  refresh_failed: "Session expired",
};

/** User-facing, secret-free message for a begin-sign-in failure reason. */
function signInFailureMessage(reason: DesktopBrowserSignInFailure): string {
  switch (reason) {
    case "start_failed":
      return "Couldn't start sign-in. Check your connection and try again.";
    case "open_failed":
      return "Couldn't open your browser. Try again.";
    case "redirect_timeout":
      return "Sign-in timed out waiting for your browser. Try again.";
    case "state_mismatch":
      return "The sign-in response failed a security check. Try again.";
    case "expired":
      return "The sign-in request expired. Try again.";
    case "exchange_failed":
      return "Sign-in completed but credentials couldn't be established. Try again.";
    case "already_in_progress":
      return "A sign-in is already in progress.";
    default:
      return "Sign-in isn't available right now. Try again.";
  }
}
