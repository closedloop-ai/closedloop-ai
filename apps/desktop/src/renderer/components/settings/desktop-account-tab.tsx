import { useGitHubIntegrationStatus } from "@repo/app/github/hooks/use-github-integration";
import {
  type AuthMethod,
  AuthMethods,
} from "@repo/app/onboarding/components/auth-methods";
import { ConnectGitHubPrompt } from "@repo/app/onboarding/components/connect-github-prompt";
import { getUserNamePart } from "@repo/app/shared/lib/user-utils";
import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@closedloop-ai/design-system/components/ui/card";
import { useState } from "react";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import {
  signInFailureMessage,
  signInPendingMessage,
} from "../../shared-agent-sessions/desktop-sign-in-copy";
import { useDesktopIdentity } from "../../shared-agent-sessions/use-desktop-identity";
import type {
  DesktopAuthStatus,
  DesktopIdentity,
} from "../../types/desktop-api";
import {
  DesktopGitHubConnectState,
  useDesktopGitHubConnect,
} from "../branches/use-desktop-github-connect";
import { providerForMethod } from "../onboarding/provider-for-method";

/**
 * Settings → Account (FEA-2219 / PRD-532). Renders the canonical GitHub-first
 * hierarchy shared with web + onboarding: signed-out → {@link AuthMethods};
 * signed-in but GitHub not connected → {@link ConnectGitHubPrompt}; signed-in +
 * connected → identity + connected status + sign-out. Drives the real
 * main-process auth bridge over IPC and the real desktop GitHub connect flow —
 * no mocks (PRD §12). Never renders token, refresh, or session secret material.
 */
export function DesktopAccountTab() {
  const { state } = useDesktopAuth();
  const isAuthenticated = state.status === "authenticated";
  // Only read the GitHub status when signed in: signed-out cloud requests
  // short-circuit to 401 in the main process, so gating on it here avoids a
  // guaranteed-failing fetch on the signed-out surface.
  const githubStatus = useGitHubIntegrationStatus({ enabled: isAuthenticated });
  const githubConnected = githubStatus.data?.connected === true;

  return (
    <div className="mt-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <AccountStatusRow status={state.status} />
          {isAuthenticated ? (
            <SignedInAccount connected={githubConnected} state={state} />
          ) : (
            <SignedOutAccount status={state.status} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Maps an {@link AuthMethods} selection onto the real loopback sign-in flow. */
function useUnifiedSignIn(): {
  pendingMethod: AuthMethod | null;
  error: string | null;
  onSelect: (method: AuthMethod) => Promise<void>;
} {
  const { beginSignIn } = useDesktopAuth();
  const [pendingMethod, setPendingMethod] = useState<AuthMethod | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSelect = async (method: AuthMethod) => {
    setPendingMethod(method);
    setError(null);
    try {
      // ISS-5112: the picked method has to REACH the sign-in. Dropping it here
      // sent every method through the absent-provider fallback, so "Continue
      // with Google" opened GitHub's consent screen.
      const result = await beginSignIn(providerForMethod(method));
      if (!(result.ok || result.reason === "cancelled")) {
        setError(signInFailureMessage(result.reason));
      }
    } catch {
      setError("Sign-in could not be completed. Try again.");
    } finally {
      setPendingMethod(null);
    }
  };

  return { pendingMethod, error, onSelect };
}

/**
 * Signed-out unified surface: the shared GitHub-first {@link AuthMethods}. Every
 * method routes through the single first-party loopback sign-in (there is one
 * desktop sign-in flow), and since ISS-5112 the picked provider rides along so
 * the browser opens THAT provider rather than always GitHub; the pending spinner
 * reflects the picked method. A pending browser approval also surfaces the
 * shared cancel affordance.
 *
 * This is the one desktop surface that still offers the email method, which has
 * no magic-link path behind it — it falls back to GitHub like any absent hint.
 * Tracked separately from the onboarding doors, which no longer offer it.
 */
function SignedOutAccount({ status }: { status: DesktopAuthStatus }) {
  const { pendingMethod, error, onSelect } = useUnifiedSignIn();
  return (
    <div className="space-y-3 border-t pt-3">
      <p className="text-[var(--muted-foreground)] text-xs">
        {status === "refresh_failed"
          ? "Your session expired or was revoked. Sign in again to reconnect this device."
          : "Sign in to connect this device to Closedloop."}
      </p>
      <AuthMethods onSelect={onSelect} pendingMethod={pendingMethod} />
      <SignInPendingRow status={status} />
      {error ? <ErrorText message={error} /> : null}
    </div>
  );
}

/**
 * Signed-in unified surface. When GitHub is not yet connected, shows the shared
 * {@link ConnectGitHubPrompt} wired to the real desktop connect flow; once
 * connected, shows the identity, the connected-GitHub status, and sign-out.
 */
function SignedInAccount({
  connected,
  state,
}: {
  connected: boolean;
  state: { userId: string | null; organizationId: string | null };
}) {
  if (connected) {
    return (
      <ConnectedAccount
        organizationId={state.organizationId}
        userId={state.userId}
      />
    );
  }
  return <ConnectGitHubStep />;
}

/**
 * Sign-out state + action for the unified signed-in surfaces. Signing out never
 * depends on the GitHub connection, so both the connected panel and the
 * connect-GitHub step share this — an authenticated user can always leave,
 * including while the GitHub status is still loading or has failed to load.
 */
function useDesktopSignOut(): {
  busy: boolean;
  error: string | null;
  handleSignOut: () => Promise<void>;
} {
  const { signOut } = useDesktopAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return { busy, error, handleSignOut };
}

/** Shared sign-out control for the unified signed-in surfaces. */
function SignOutRow({
  busy,
  error,
  onSignOut,
}: {
  busy: boolean;
  error: string | null;
  onSignOut: () => void;
}) {
  return (
    <>
      <div className="flex justify-end">
        <Button disabled={busy} onClick={onSignOut} size="sm" variant="outline">
          {busy ? "Signing out..." : "Sign out"}
        </Button>
      </div>
      {error ? <ErrorText message={error} /> : null}
    </>
  );
}

/**
 * The signed-in-but-not-connected step: the shared connect-GitHub prompt. Sign-out
 * stays available here — it does not depend on GitHub, and this same surface also
 * renders while the connection status is still loading or has failed to load, so
 * a user must never be trapped without a way to sign out.
 */
function ConnectGitHubStep() {
  const { connectState, connectGitHub } = useDesktopGitHubConnect({
    returnTo: "/settings",
  });
  const { busy, error: signOutError, handleSignOut } = useDesktopSignOut();
  const connecting = connectState === DesktopGitHubConnectState.Pending;
  return (
    <div className="space-y-3 border-t pt-3">
      <GitHubStatusRow connected={false} />
      <ConnectGitHubPrompt
        connecting={connecting}
        onConnect={() => {
          connectGitHub().catch(() => {
            // The hook already surfaces terminal failure via connectState; the
            // rejection is swallowed here to avoid an unhandled promise.
          });
        }}
      />
      {connectState === DesktopGitHubConnectState.Failed ? (
        <ErrorText message="GitHub couldn't be opened. Try again." />
      ) : null}
      {connectState === DesktopGitHubConnectState.SignInRequired ? (
        <ErrorText message="Sign in again to connect GitHub." />
      ) : null}
      <SignOutRow busy={busy} error={signOutError} onSignOut={handleSignOut} />
    </div>
  );
}

/** Signed-in + GitHub connected: identity, connected status, and sign-out. */
function ConnectedAccount({
  userId,
  organizationId,
}: {
  userId: string | null;
  organizationId: string | null;
}) {
  const { state } = useDesktopAuth();
  const { identity } = useDesktopIdentity(state.status, userId);
  const { busy, error, handleSignOut } = useDesktopSignOut();

  return (
    <div className="space-y-3 border-t pt-3">
      <IdentityDetails
        identity={identity}
        organizationId={organizationId}
        userId={userId}
      />
      <GitHubStatusRow connected={true} />
      <SignOutRow busy={busy} error={error} onSignOut={handleSignOut} />
    </div>
  );
}

/** GitHub connection status row (connected / not connected). */
function GitHubStatusRow({ connected }: { connected: boolean }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-24 shrink-0 text-[var(--muted-foreground)]">
        GitHub
      </span>
      <Badge variant={connected ? "default" : "outline"}>
        {connected ? "Connected" : "Not connected"}
      </Badge>
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

function IdentityDetails({
  identity,
  userId,
  organizationId,
}: {
  identity: DesktopIdentity | null;
  userId: string | null;
  organizationId: string | null;
}) {
  const fullName = identity ? getUserNamePart(identity) : "";
  // Prefer name, then email, then the raw id so the row is never blank.
  const userValue = fullName || identity?.email || userId || "—";
  const userSecondary = fullName && identity?.email ? identity.email : null;
  const organizationValue = identity?.organizationName || organizationId || "—";
  return (
    <>
      <IdentityRow label="User" secondary={userSecondary} value={userValue} />
      <IdentityRow label="Organization" value={organizationValue} />
    </>
  );
}

/**
 * Shared cancel affordance for a pending browser approval on the unified
 * signed-out surface: the shared {@link AuthMethods} owns the method buttons, so
 * the cancel-while-pending control lives here beside them.
 */
function SignInPendingRow({ status }: { status: DesktopAuthStatus }) {
  const { cancelSignIn } = useDesktopAuth();
  if (!isPendingSignIn(status)) {
    return null;
  }
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-[var(--muted-foreground)] text-sm">
        {signInPendingMessage(status)}
      </p>
      <Button
        onClick={() => {
          cancelSignIn().catch(() => {
            // Best-effort; the pushed state is the source of truth.
          });
        }}
        size="sm"
        variant="ghost"
      >
        Cancel
      </Button>
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

function ErrorText({ message }: { message: string }) {
  return <p className="text-[var(--destructive)] text-xs">{message}</p>;
}

/** Whether an interactive browser sign-in is currently in flight. */
function isPendingSignIn(status: DesktopAuthStatus): boolean {
  return (
    status === "opening_browser" ||
    status === "awaiting_redirect" ||
    status === "exchanging"
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
