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
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { ArrowRightIcon, Loader2Icon, MailIcon } from "lucide-react";
import type { ReactNode } from "react";
import { AuthProvider } from "../mock";
import { ClosedloopMark } from "./closedloop-mark";

type SocialRedirectPanelProps = {
  provider: AuthProvider;
  email?: string;
  onComplete: () => void;
};

// The boundary the flow can't cross: the provider's own authorize screen (or,
// for email, the user's inbox) lives outside this prototype. It names whichever
// path the user actually chose and gives the reviewer a button to stand in for
// the return trip.
export const SocialRedirectPanel = ({
  provider,
  email,
  onComplete,
}: SocialRedirectPanelProps) => {
  const config = redirectConfig[provider];
  // The email path carries the validated address so this screen can say where
  // the link went instead of "your email".
  const description =
    provider === AuthProvider.Email && email
      ? `We sent a sign-in link to ${email}. Open it to confirm your address, then you'll come right back here to finish setting up your workspace.`
      : config.description;

  return (
    <div className="flex min-h-svh flex-col bg-muted/30">
      <header className="flex h-12 shrink-0 items-center justify-center gap-2 border-border border-b bg-background px-4 text-muted-foreground text-sm">
        {config.icon}
        {config.urlBar}
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
            <CardHeader className="items-center text-center">
              <div className="mb-2 text-muted-foreground">{config.glyph}</div>
              <CardTitle className="text-xl tracking-tight">
                {config.title}
              </CardTitle>
              <CardDescription className="text-pretty leading-relaxed">
                {description}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-center gap-6">
              <span className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2Icon
                  aria-hidden="true"
                  className="size-4 animate-spin"
                />
                {config.waiting}
              </span>
              <div className="w-full rounded-lg border border-border border-dashed bg-background/60 p-3 text-center text-muted-foreground text-xs leading-relaxed">
                Prototype note: {config.note} Use the button below to simulate a
                completed sign-in.
              </div>
              <Button className="w-full" onClick={onComplete} size="lg">
                {config.cta}
                <ArrowRightIcon />
              </Button>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
};

type RedirectConfig = {
  urlBar: string;
  icon: ReactNode;
  glyph: ReactNode;
  title: string;
  description: string;
  waiting: string;
  note: string;
  cta: string;
};

const redirectConfig: Record<AuthProvider, RedirectConfig> = {
  [AuthProvider.GitHub]: {
    urlBar: "github.com/login/oauth",
    icon: <GitHubMark className="size-4" />,
    glyph: <GitHubMark className="size-8" />,
    title: "Taking you to GitHub",
    description:
      "You're being sent to GitHub to authorize Closedloop. Once you approve, you'll come right back here to finish setting up your workspace.",
    waiting: "Waiting for authorization...",
    note: "GitHub's own authorize screen lives outside this flow.",
    cta: "Simulate returning from GitHub",
  },
  [AuthProvider.Google]: {
    urlBar: "accounts.google.com",
    icon: <GoogleGlyph className="size-4" />,
    glyph: <GoogleGlyph className="size-8" />,
    title: "Taking you to Google",
    description:
      "You're being sent to Google to authorize Closedloop. Once you approve, you'll come right back here to finish setting up your workspace.",
    waiting: "Waiting for authorization...",
    note: "Google's own authorize screen lives outside this flow.",
    cta: "Simulate returning from Google",
  },
  [AuthProvider.Email]: {
    urlBar: "app.closedloop.ai/sign-in",
    icon: <MailIcon aria-hidden="true" className="size-4" />,
    glyph: <MailIcon aria-hidden="true" className="size-8" />,
    title: "Check your inbox",
    description:
      "We sent a sign-in link to your email. Open it to confirm your address, then you'll come right back here to finish setting up your workspace.",
    waiting: "Waiting for you to open the link...",
    note: "The email and its link live outside this flow.",
    cta: "Simulate clicking the email link",
  },
};
