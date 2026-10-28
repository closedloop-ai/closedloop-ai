"use client";

import { CLERK_SESSION_TASK_CHOOSE_ORGANIZATION } from "@repo/api/src/types/desktop-bootstrap";
import { AuthTransitionPanel } from "@repo/app/onboarding/components/auth-transition-panel";
import { useDesktopBootstrapAuthorize } from "@repo/app/onboarding/hooks/use-desktop-bootstrap-authorize";
import {
  buildLoopbackRedirectUrl,
  redirectToDesktopLoopback,
} from "@repo/app/onboarding/lib/desktop-authorize-redirect";
import { clearDesktopAuthorizeRun } from "@repo/app/onboarding/lib/desktop-authorize-run-client";
import { getAuthorizeMintErrorCopy } from "@repo/app/onboarding/lib/desktop-authorize-state";
import { ApiError } from "@repo/app/shared/api/api-error";
import { useSession } from "@repo/auth/client";
import { Button } from "@repo/design-system/components/ui/button";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { DesktopBootstrapBrowserRun } from "@/lib/desktop-bootstrap-run";

export function DesktopBootstrapSignUpGate({
  browserRun,
  children,
}: {
  readonly browserRun: DesktopBootstrapBrowserRun | null;
  readonly children: ReactNode;
}) {
  const { isLoaded, session } = useSession();
  const awaitingOrganization =
    browserRun?.bootstrapSupported &&
    isLoaded &&
    session?.currentTask?.key === CLERK_SESSION_TASK_CHOOSE_ORGANIZATION;

  if (awaitingOrganization && browserRun) {
    return <DesktopBootstrapHandback browserRun={browserRun} />;
  }

  return children;
}

function DesktopBootstrapHandback({
  browserRun,
}: {
  readonly browserRun: DesktopBootstrapBrowserRun;
}) {
  const mint = useDesktopBootstrapAuthorize();
  const { mutate, reset } = mint;
  const started = useRef(false);

  const startMint = useCallback(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    mutate(
      {
        codeChallenge: browserRun.codeChallenge,
        codeChallengeMethod: browserRun.codeChallengeMethod,
        gatewayId: browserRun.gatewayId,
        gatewayPublicKeyPem: browserRun.gatewayPublicKeyPem,
        redirectUri: browserRun.redirectUri,
        webAppOrigin: globalThis.location.origin,
      },
      {
        onSuccess: async (result) => {
          await clearDesktopAuthorizeRun();
          redirectToDesktopLoopback(
            buildLoopbackRedirectUrl(
              browserRun.redirectUri,
              result.code,
              browserRun.state,
              true,
              true
            )
          );
        },
      }
    );
  }, [browserRun, mutate]);

  useEffect(() => {
    // StrictMode replays mount effects and detaches the mutation observer.
    // Start only after that replay, so neither completion nor errors are lost.
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        startMint();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [startMint]);

  if (mint.isError) {
    const copy = getAuthorizeMintErrorCopy(mintErrorStatus(mint.error));
    return (
      <AuthTransitionPanel
        action={
          copy.retryable ? (
            <Button
              onClick={() => {
                started.current = false;
                reset();
                startMint();
              }}
              variant="outline"
            >
              Try again
            </Button>
          ) : undefined
        }
        description={copy.description}
        title={copy.title}
      />
    );
  }

  return (
    <AuthTransitionPanel
      busy
      description="Handing you back to the desktop app. You can close this tab."
      title="Returning to desktop…"
    />
  );
}

function mintErrorStatus(error: unknown): number | undefined {
  return error instanceof ApiError ? error.status : undefined;
}
