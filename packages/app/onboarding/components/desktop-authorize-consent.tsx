"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ApiError } from "../../shared/api/api-error";
import { useFeatureFlagEnabled } from "../../shared/feature-flags/use-feature-flag-enabled";
import { DESKTOP_LOOPBACK_AUTH_FEATURE_FLAG_KEY } from "../../shared/lib/feature-flags";
import { useDesktopAuthorizeMint } from "../hooks/use-desktop-authorize";
import {
  type DesktopAuthorizeParams,
  parseDesktopAuthorizeParams,
} from "../lib/desktop-authorize-params";
import {
  buildLoopbackRedirectUrl,
  redirectToDesktopLoopback,
} from "../lib/desktop-authorize-redirect";
import {
  type DesktopAuthorizeErrorCopy,
  getAuthorizeMintErrorCopy,
  getAuthorizeParamErrorCopy,
} from "../lib/desktop-authorize-state";
import { DesktopConnectPageShell } from "./desktop-connect-page-shell";

export type DesktopAuthorizeSearchParams = Record<
  string,
  string | string[] | undefined
>;

/**
 * Web authorize/consent page for the desktop loopback OAuth flow (FEA-2460).
 *
 * Renders a minimal consent step for the desktop-supplied params, mints a
 * one-time code via `POST /desktop/authorize` on confirm, and hands the browser
 * off to the desktop's loopback `redirect_uri` with `code` + `state`. The API
 * binds the code to the Clerk-resolved user/org and stays the authoritative
 * validator; the checks here are fail-fast + defense-in-depth.
 */
export function DesktopAuthorizeConsent({
  searchParams,
  requestedOrgSlug,
}: {
  searchParams: DesktopAuthorizeSearchParams;
  requestedOrgSlug?: string;
}): ReactNode {
  const flagEnabled = useFeatureFlagEnabled(
    DESKTOP_LOOPBACK_AUTH_FEATURE_FLAG_KEY
  );
  const mint = useDesktopAuthorizeMint();
  const [cancelled, setCancelled] = useState(false);
  const parsed = parseDesktopAuthorizeParams(searchParams);

  if (!flagEnabled) {
    // The desktop opened this page but the web half of the flow isn't enabled
    // for this user yet (FEA-2686). Don't leave a dead end: tell the user to
    // return to (and, if needed, cancel from) the desktop app rather than
    // waiting here.
    return (
      <DesktopConnectPageShell title="Not available">
        <p className="text-muted-foreground text-sm">
          Desktop sign-in isn't available for your account yet. You can close
          this tab and return to the desktop app.
        </p>
      </DesktopConnectPageShell>
    );
  }

  if (!parsed.ok) {
    return (
      <AuthorizeErrorCard copy={getAuthorizeParamErrorCopy(parsed.reason)} />
    );
  }
  const { params } = parsed;

  if (cancelled) {
    return (
      <DesktopConnectPageShell title="Connection cancelled">
        <p className="text-muted-foreground text-sm">
          You can close this tab and return to the desktop app.
        </p>
      </DesktopConnectPageShell>
    );
  }

  // On a successful mint the browser is navigated to the loopback listener at
  // once; this terminal state shows only briefly before the page unloads (and
  // is what a test observes, since the navigation is mocked).
  if (mint.isSuccess) {
    return (
      <DesktopConnectPageShell title="Returning to desktop…">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="size-4 animate-spin" />
          Handing you back to the desktop app. You can close this tab.
        </div>
      </DesktopConnectPageShell>
    );
  }

  if (mint.isError) {
    const status =
      mint.error instanceof ApiError ? mint.error.status : undefined;
    const copy = getAuthorizeMintErrorCopy(status);
    return (
      <AuthorizeErrorCard
        copy={copy}
        onRetry={copy.retryable ? () => mint.reset() : undefined}
      />
    );
  }

  const onConnect = () => {
    mint.mutate(
      {
        webAppOrigin: globalThis.location.origin,
        gatewayId: params.gatewayId,
        gatewayPublicKeyPem: params.gatewayPublicKeyPem,
        codeChallenge: params.codeChallenge,
        codeChallengeMethod: params.codeChallengeMethod,
        redirectUri: params.redirectUri,
      },
      {
        onSuccess: (result) => {
          redirectToDesktopLoopback(
            buildLoopbackRedirectUrl(
              params.redirectUri,
              result.code,
              params.state
            )
          );
        },
      }
    );
  };

  return (
    <DesktopConnectPageShell title="Connect this device?">
      <p className="text-muted-foreground text-sm">
        Allow this device to sign in to your Closedloop workspace.
      </p>
      <DeviceDetails params={params} requestedOrgSlug={requestedOrgSlug} />
      <div className="flex justify-end gap-2">
        <Button
          disabled={mint.isPending}
          onClick={() => setCancelled(true)}
          variant="outline"
        >
          Cancel
        </Button>
        <Button disabled={mint.isPending} onClick={onConnect}>
          {mint.isPending && <Loader2 className="size-4 animate-spin" />}
          Connect
        </Button>
      </div>
    </DesktopConnectPageShell>
  );
}

function DeviceDetails({
  params,
  requestedOrgSlug,
}: {
  params: DesktopAuthorizeParams;
  requestedOrgSlug?: string;
}): ReactNode {
  return (
    <dl className="grid grid-cols-[140px_1fr] gap-2 rounded-lg border p-4 text-sm">
      <DetailRow label="Application" value="Closedloop Desktop" />
      <DetailRow label="Device" value={params.deviceName} />
      <DetailRow label="Platform" value={params.platform} />
      {requestedOrgSlug ? (
        <DetailRow label="Workspace" value={requestedOrgSlug} />
      ) : null}
    </dl>
  );
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactNode {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function AuthorizeErrorCard({
  copy,
  onRetry,
}: {
  copy: DesktopAuthorizeErrorCopy;
  onRetry?: () => void;
}): ReactNode {
  return (
    <DesktopConnectPageShell title={copy.title}>
      <p className="text-muted-foreground text-sm">{copy.description}</p>
      {onRetry ? (
        <div className="flex justify-end">
          <Button onClick={onRetry} variant="outline">
            Try again
          </Button>
        </div>
      ) : null}
    </DesktopConnectPageShell>
  );
}
