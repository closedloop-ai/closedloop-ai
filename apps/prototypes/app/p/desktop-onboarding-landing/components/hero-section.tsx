"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { ArrowRight, ShieldCheckIcon } from "lucide-react";
import { heroCopy } from "../mock";

/**
 * The WHY, given the most weight: a text-forward, full-viewport statement of
 * the tension (agents write the code, teams stay in control) in one headline
 * and one line, with a single primary action into the sign-in flow. The hero
 * carries the whole pitch now that the sections below the fold are gone, so it
 * left-aligns to the top bar's margin rather than floating centered, and states
 * the local-first promise under the CTA.
 */
export const HeroSection = ({
  onGetStarted,
  onSignIn,
}: {
  onGetStarted: () => void;
  onSignIn: () => void;
}) => (
  <section className="flex min-h-svh items-center px-6 pt-24 pb-16 md:px-10">
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <span className="font-medium text-muted-foreground text-sm uppercase tracking-widest">
        {heroCopy.eyebrow}
      </span>
      <h1 className="font-semibold text-5xl tracking-tight md:text-6xl lg:text-7xl">
        {heroCopy.title}
        <span className="block text-primary">{heroCopy.titleAccent}</span>
      </h1>
      <p className="max-w-xl text-balance text-lg text-muted-foreground md:text-xl">
        {heroCopy.subtitle}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-5">
        <Button className="px-6" onClick={onGetStarted} size="lg">
          {heroCopy.primaryCta}
          <ArrowRight className="size-4" />
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
      <p className="flex items-center gap-1.5 text-muted-foreground text-sm">
        <ShieldCheckIcon aria-hidden="true" className="size-4" />
        {heroCopy.privacyNote}
      </p>
    </div>
  </section>
);
