import { Button } from "@repo/design-system/components/ui/button";
import {
  LANDING_HERO_HEADLINE,
  LANDING_HERO_HEADLINE_ACCENT_WORD,
  LANDING_HERO_SUBTITLE,
  splitHeadlineOnAccent,
} from "@repo/lib/landing-hero-copy";
import { ArrowRight, Github } from "lucide-react";
import Link from "next/link";
import { env } from "@/env";
import { GITHUB_REPO_URL } from "./constants";

/**
 * ISS-5490 FR-1: this landing and the desktop guest landing are the same door
 * into the same product, so they render the same hero from one shared copy
 * module rather than two literals that drift.
 *
 * The accent word is split out of the headline instead of the headline being
 * stored pre-split, so the copy module holds one readable sentence and this
 * surface decides how to emphasise it. The split lives beside the copy, where
 * it is tested: a headline a copy edit has moved the accent word out of comes
 * back with `accent: null` and renders whole, rather than as the full headline
 * plus a stray word that is no longer in it.
 */
const HEADLINE = splitHeadlineOnAccent(
  LANDING_HERO_HEADLINE,
  LANDING_HERO_HEADLINE_ACCENT_WORD
);

export const HeroSection = () => {
  return (
    <section className="mx-auto flex w-full max-w-[1300px] flex-col gap-8 px-6 pt-16 pb-12 md:px-10 md:pt-24 lg:pt-28">
      <h1 className="max-w-4xl font-semibold text-4xl tracking-tight md:text-5xl lg:text-6xl">
        {HEADLINE.before}
        {HEADLINE.accent !== null && (
          <span className="text-primary">{HEADLINE.accent}</span>
        )}
        {HEADLINE.after}
      </h1>
      <p className="max-w-3xl text-balance text-base text-muted-foreground md:text-lg">
        {LANDING_HERO_SUBTITLE}
      </p>
      <div className="flex flex-col flex-wrap gap-3 sm:flex-row">
        <Button
          asChild
          className="h-10 rounded-full px-5 text-sm md:text-base"
          size="lg"
        >
          <Link href={`${env.NEXT_PUBLIC_APP_URL}/sign-up`}>
            Get Started
            <ArrowRight className="size-4" />
          </Link>
        </Button>
        <Button
          asChild
          className="h-10 rounded-full px-5 text-sm md:text-base"
          size="lg"
          variant="outline"
        >
          <Link
            href={GITHUB_REPO_URL}
            rel="noopener noreferrer"
            target="_blank"
          >
            <Github className="size-4" />
            Support us on GitHub
          </Link>
        </Button>
      </div>
    </section>
  );
};
