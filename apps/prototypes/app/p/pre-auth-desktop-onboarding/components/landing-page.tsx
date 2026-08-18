"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { ArrowRightIcon } from "lucide-react";
import { heroCopy } from "../mock";
import { ClosedloopMark } from "./closedloop-mark";

type LandingPageProps = {
  onGetStarted: () => void;
  onSignIn: () => void;
};

export const LandingPage = ({ onGetStarted, onSignIn }: LandingPageProps) => (
  <main className="relative min-h-svh bg-background">
    <header className="absolute inset-x-0 top-0 z-10 flex items-center px-6 py-5 md:px-10">
      <div className="flex items-center gap-2">
        <ClosedloopMark className="size-7" />
        <span className="font-semibold text-lg tracking-tight">
          Closedloop.ai
        </span>
      </div>
    </header>

    <section className="flex min-h-svh items-center px-6 pt-24 pb-16 md:px-10">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <h1 className="font-semibold text-3xl tracking-tight sm:text-5xl md:text-6xl lg:text-7xl">
          Stop <span className="text-primary">burning</span> tokens.
        </h1>
        <p className="max-w-xl text-balance text-lg text-muted-foreground md:text-xl">
          {heroCopy.subtitle}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-5">
          <Button className="px-6" onClick={onGetStarted} size="lg">
            {heroCopy.primaryCta}
            <ArrowRightIcon />
          </Button>
          <p className="text-muted-foreground text-sm">
            {heroCopy.signInPrompt}{" "}
            <Button
              className="h-auto p-0 align-baseline font-medium text-foreground"
              onClick={onSignIn}
              variant="link"
            >
              {heroCopy.signInCta}
            </Button>
          </p>
        </div>
      </div>
    </section>
  </main>
);
