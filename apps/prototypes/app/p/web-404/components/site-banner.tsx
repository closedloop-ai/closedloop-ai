"use client";

import { ArrowRight, X } from "lucide-react";
import { useState } from "react";

// Stand-in for apps/web's SiteBanner, which sits between the header and `main`
// in the real (site) layout. It is reproduced here because it SHOWS by default:
// the real component seeds `dismissed` from localStorage, so a first-time
// visitor — exactly who lands on a 404 from a stale link — gets the full-bleed
// bg-primary strip above the screen. Reviewing the 404 without it would review
// a page that never ships.
//
// Two things this simplification hides, both for whoever builds production,
// because neither shows up in a screenshot:
//
// 1. The real component reads localStorage inside `useEffect`, so the banner is
//    ABSENT on first paint and inserted after hydration. That pushes the screen
//    down 44px (56 at 390). On a 404 the thing that jumps is the h1, which is
//    the one element the eye is hunting for. This stand-in starts visible, so
//    it shows the settled layout and not the shift.
// 2. There are TWO chrome states. This draws the busier one (first visit,
//    banner shown). The returning visitor has no strip at all, and for anyone
//    who has been to the site before that is the more common state.
export const SiteBanner = () => {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) {
    return null;
  }

  return (
    <div className="w-full bg-primary text-primary-foreground">
      <div className="mx-auto flex w-full max-w-[1300px] items-center gap-3 px-6 py-2 md:px-10">
        <p className="flex-1 text-sm">
          Looking for the healthcare data science platform?{" "}
          <a
            className="ml-1 inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
            href="https://www.gethealthy.com"
            rel="noopener noreferrer"
            target="_blank"
          >
            Visit GetHealthy.com
            <ArrowRight className="size-3.5" />
          </a>
        </p>
        <button
          aria-label="Dismiss banner"
          className="-mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-primary-foreground/80 transition-colors hover:bg-primary-foreground/10 hover:text-primary-foreground"
          onClick={() => setDismissed(true)}
          type="button"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
};
