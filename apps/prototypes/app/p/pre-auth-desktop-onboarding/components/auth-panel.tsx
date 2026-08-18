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
import { ArrowLeftIcon, Loader2Icon, LockKeyholeIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ClosedloopMark } from "./closedloop-mark";

type AuthPanelProps = {
  onBack: () => void;
  onComplete: () => void;
};

export const AuthPanel = ({ onBack, onComplete }: AuthPanelProps) => {
  const [pendingMethod, setPendingMethod] = useState<AuthMethod | null>(null);
  const authTimer = useRef<ReturnType<typeof globalThis.setTimeout> | null>(
    null
  );

  useEffect(
    () => () => {
      if (authTimer.current !== null) {
        globalThis.clearTimeout(authTimer.current);
      }
    },
    []
  );

  const authenticate = (method: AuthMethod) => {
    if (pendingMethod !== null) {
      return;
    }
    setPendingMethod(method);
    authTimer.current = globalThis.setTimeout(onComplete, AUTH_DELAY_MS);
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
                onClick={() => authenticate(AuthMethod.GitHub)}
                size="lg"
              >
                {pendingMethod === AuthMethod.GitHub ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <GitHubMark />
                )}
                {getMethodLabel(AuthMethod.GitHub, pendingMethod)}
              </Button>
              <Button
                disabled={pendingMethod !== null}
                onClick={() => authenticate(AuthMethod.Google)}
                size="lg"
                variant="outline"
              >
                {pendingMethod === AuthMethod.Google ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <GoogleGlyph />
                )}
                {getMethodLabel(AuthMethod.Google, pendingMethod)}
              </Button>
            </CardContent>
            <CardFooter>
              <Button onClick={onBack} variant="ghost">
                <ArrowLeftIcon />
                Back to landing
              </Button>
            </CardFooter>
          </Card>
        </div>
      </main>
    </div>
  );
};

const AuthMethod = {
  GitHub: "github",
  Google: "google",
} as const;
type AuthMethod = (typeof AuthMethod)[keyof typeof AuthMethod];

const AUTH_DELAY_MS = 800;

const getMethodLabel = (
  method: AuthMethod,
  pendingMethod: AuthMethod | null
) => {
  if (method === pendingMethod) {
    return "Opening workspace...";
  }
  if (method === AuthMethod.GitHub) {
    return "Continue with GitHub";
  }
  return "Continue with Google";
};
