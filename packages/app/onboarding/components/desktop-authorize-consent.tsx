"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ApiError } from "../../shared/api/api-error";
import { useDesktopAuthorizeMint } from "../hooks/use-desktop-authorize";
import {
  type DesktopAuthorizeParams,
  parseDesktopAuthorizeParams,
} from "../lib/desktop-authorize-params";
import {
  buildLoopbackCancelUrl,
  buildLoopbackRedirectUrl,
  redirectToDesktopLoopback,
} from "../lib/desktop-authorize-redirect";
import { clearDesktopAuthorizeRun } from "../lib/desktop-authorize-run-client";

import {
  type DesktopAuthorizeErrorCopy,
  getAuthorizeMintErrorCopy,
  getAuthorizeParamErrorCopy,
  mintFailureEndsRun,
} from "../lib/desktop-authorize-state";
import { DesktopConnectPageShell } from "./desktop-connect-page-shell";
import { DesktopHandbackPanel } from "./desktop-handback-panel";

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
 *
 * `accountCreated` is derived on the server by the authorize page (ISS-11395 /
 * PLN-2118) from the pending run and the signed-in user, never read off this
 * URL, and rides to the desktop on the loopback callback.
 */
export function DesktopAuthorizeConsent({
  searchParams,
  requestedOrgSlug,
  accountCreated = false,
}: {
  searchParams: DesktopAuthorizeSearchParams;
  requestedOrgSlug?: string;
  accountCreated?: boolean;
}): ReactNode {
  const mint = useDesktopAuthorizeMint();
  const [cancelled, setCancelled] = useState(false);
  const parsed = parseDesktopAuthorizeParams(searchParams);

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

  /**
   * Tell the desktop before showing the cancelled card.
   *
   * This used to only set local state, so the desktop never heard anything and
   * sat in its awaiting-redirect state until the sign-in timeout fired — the
   * page said "return to the desktop app" while the desktop was still waiting
   * for a browser that was never coming back.
   */
  const onCancel = async () => {
    setCancelled(true);
    await clearDesktopAuthorizeRun();
    redirectToDesktopLoopback(
      buildLoopbackCancelUrl(params.redirectUri, params.state)
    );
  };

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
        {/* ISS-11429: the sentence above is a promise this page cannot keep on
            its own. The loopback navigation is what hands the user back, and
            while it is in flight — a listener that is slow, or a window that
            does not raise itself — they are left reading "returning to desktop"
            in a tab that is going nowhere. The panel is the way back, and it
            never claims to have succeeded at something the browser cannot
            observe — and it renders NOTHING at all unless the hand-back has
            demonstrably not landed (operator ruling 2026-09-28: the success
            path takes no user action), so on the happy path this card is
            exactly what it was before.

            It covers the IN-FLIGHT window only, because `location.replace` has
            already been called by the time this renders: a loopback the browser
            cannot reach unloads this document for an error page and takes the
            panel with it. That is not a placement that can be rescued from here
            — an https document may only reach `http://127.0.0.1` as a TOP-LEVEL
            NAVIGATION; the same URL as a `fetch` or an iframe is a private-network
            subresource, subject to `connect-src`/`frame-src` and Private Network
            Access, so the mechanism that would keep this document alive is the
            one mechanism that cannot deliver the callback. The recovery
            therefore ALSO rides on the terminal cards below, which never
            navigate and so always survive. */}
        <DesktopHandbackPanel />
      </DesktopConnectPageShell>
    );
  }

  if (mint.isError) {
    const copy = getAuthorizeMintErrorCopy(mintErrorStatus(mint.error));
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
        onSuccess: async (result) => {
          await clearDesktopAuthorizeRun();
          redirectToDesktopLoopback(
            buildLoopbackRedirectUrl(
              params.redirectUri,
              result.code,
              params.state,
              accountCreated
            )
          );
        },
        // A failure that ends the run ends it as surely as Cancel does;
        // leaving it pending would bounce every navigation back to it.
        onError: async (error) => {
          if (mintFailureEndsRun(mintErrorStatus(error))) {
            await clearDesktopAuthorizeRun();
          }
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
        <Button disabled={mint.isPending} onClick={onCancel} variant="outline">
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
      {/* ISS-11429: this card is terminal and fires no navigation, so unlike the
          success card it is still on screen when the user needs a way out. A
          browser-side failure leaves a running desktop sitting behind this tab
          waiting for a callback that is not coming; the panel is the only thing
          on the page that offers the way back to it. It stays silent until its
          own bound elapses, so it adds nothing to a card the user is only
          passing through. */}
      <DesktopHandbackPanel />
    </DesktopConnectPageShell>
  );
}

function mintErrorStatus(error: unknown): number | undefined {
  return error instanceof ApiError ? error.status : undefined;
}
