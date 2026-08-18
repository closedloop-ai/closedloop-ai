"use client";

import {
  GitHubMark,
  GoogleGlyph,
} from "@repo/design-system/components/ui/brand-icons";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Separator } from "@repo/design-system/components/ui/separator";
import { ArrowLeftIcon, LockKeyholeIcon } from "lucide-react";
import { useState } from "react";
import { AuthMode, AuthProvider, authCopy } from "../mock";
import { ClosedloopMark } from "./closedloop-mark";

type AuthCardProps = {
  // Email carries the entered address so the hand-off can name where the link
  // went; it is omitted for the OAuth providers.
  onAuthenticate: (provider: AuthProvider, email?: string) => void;
  onBack: () => void;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const OrDivider = () => (
  <div className="flex items-center gap-3">
    <Separator className="flex-1" />
    <span className="text-muted-foreground text-xs">or</span>
    <Separator className="flex-1" />
  </div>
);

// New visitors from "Get Started" open on sign-up; the footer toggles to sign-in
// (it switches modes, it does NOT fire an auth handoff). GitHub is the single
// filled button above the divider in both modes; Google and email are the
// de-emphasized alternatives below.
export const AuthCard = ({ onAuthenticate, onBack }: AuthCardProps) => {
  const [mode, setMode] = useState<AuthMode>(AuthMode.SignUp);
  const [email, setEmail] = useState("");
  const copy = authCopy[mode];
  const otherMode =
    mode === AuthMode.SignUp ? AuthMode.SignIn : AuthMode.SignUp;
  const emailValid = EMAIL_PATTERN.test(email.trim());

  return (
    <div className="flex min-h-svh flex-col bg-muted/30">
      <header className="flex h-12 shrink-0 items-center justify-center gap-2 border-border border-b bg-background px-4 text-muted-foreground text-sm">
        <LockKeyholeIcon aria-hidden="true" className="size-4" />
        {copy.path}
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
              <CardTitle className="text-center text-xl tracking-tight">
                {copy.heading}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              <Button
                className="w-full"
                onClick={() => onAuthenticate(AuthProvider.GitHub)}
                size="lg"
              >
                <GitHubMark className="size-4" />
                {copy.githubCta}
              </Button>

              <OrDivider />

              <div className="flex flex-col gap-4">
                <Button
                  className="w-full"
                  onClick={() => onAuthenticate(AuthProvider.Google)}
                  size="lg"
                  variant="outline"
                >
                  <GoogleGlyph className="size-4" />
                  {copy.googleCta}
                </Button>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="email">{copy.emailLabel}</Label>
                  <Input
                    autoComplete="email"
                    id="email"
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder={copy.emailPlaceholder}
                    type="email"
                    value={email}
                  />
                </div>

                <Button
                  className="w-full"
                  disabled={!emailValid}
                  onClick={() =>
                    onAuthenticate(AuthProvider.Email, email.trim())
                  }
                  size="lg"
                  variant="secondary"
                >
                  {copy.submitCta}
                </Button>
              </div>

              <p className="text-center text-muted-foreground text-sm">
                {copy.switchPrompt}{" "}
                <Button
                  className="h-auto p-0 align-baseline font-medium text-foreground"
                  onClick={() => setMode(otherMode)}
                  variant="link"
                >
                  {copy.switchCta}
                </Button>
              </p>
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
