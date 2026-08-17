"use client";

import {
  GitHubMark,
  GoogleGlyph,
} from "@repo/design-system/components/ui/brand-icons";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Loader2Icon, LockKeyholeIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ClosedloopMark } from "./brand-icons";

/**
 * Presentational system-browser auth surface. A method click simulates the
 * OAuth round trip before returning an authenticated user to Desktop.
 */
export const BrowserSignIn = ({
  onCancel,
  onComplete,
}: {
  onCancel: () => void;
  onComplete: () => void;
}) => {
  const [pendingMethod, setPendingMethod] = useState<AuthMethod | null>(null);
  const authTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (authTimer.current !== null) {
        window.clearTimeout(authTimer.current);
      }
    },
    []
  );

  const signIn = (method: AuthMethod) => {
    if (pendingMethod !== null) {
      return;
    }
    setPendingMethod(method);
    authTimer.current = window.setTimeout(onComplete, AUTH_ROUND_TRIP_MS);
  };

  return (
    <div className="flex min-h-svh flex-col bg-muted/30">
      <header className="flex h-12 shrink-0 items-center justify-center gap-2 border-border border-b bg-background px-4 text-muted-foreground text-sm">
        <LockKeyholeIcon aria-hidden="true" className="size-4" />
        app.closedloop.ai/sign-in
      </header>
      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-md space-y-4">
          <div className="flex items-center gap-2 px-1">
            <ClosedloopMark className="size-7" />
            <span className="font-semibold text-lg tracking-tight">
              Closedloop.ai
            </span>
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-xl tracking-tight">
                Sign in to Closedloop
              </CardTitle>
              <CardDescription className="text-pretty leading-relaxed">
                Sign in with the account connected to your team workspace.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Button
                disabled={pendingMethod !== null}
                onClick={() => signIn(AuthMethod.GitHub)}
                size="lg"
              >
                {pendingMethod === AuthMethod.GitHub ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <GitHubMark />
                )}
                {pendingMethod === AuthMethod.GitHub
                  ? "Signing in..."
                  : "Continue with GitHub"}
              </Button>
              <Button
                disabled={pendingMethod !== null}
                onClick={() => signIn(AuthMethod.Google)}
                size="lg"
                variant="outline"
              >
                {pendingMethod === AuthMethod.Google ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <GoogleGlyph />
                )}
                {pendingMethod === AuthMethod.Google
                  ? "Signing in..."
                  : "Continue with Google"}
              </Button>
            </CardContent>
            <CardFooter>
              <Button onClick={onCancel} variant="ghost">
                Back to Desktop
              </Button>
            </CardFooter>
          </Card>
        </div>
      </main>
    </div>
  );
};

const AUTH_ROUND_TRIP_MS = 800;

const AuthMethod = {
  GitHub: "github",
  Google: "google",
} as const;
type AuthMethod = (typeof AuthMethod)[keyof typeof AuthMethod];
