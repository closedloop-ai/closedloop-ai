import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import {
  LANDING_HERO_HEADLINE,
  LANDING_HERO_SUBTITLE,
} from "@repo/lib/landing-hero-copy";
import { ArrowRightIcon } from "lucide-react";
import { type ReactNode, useId } from "react";
import { isMacOS, macStoplightClearance } from "../../platform";
import { ClosedloopMark } from "../layout/closedloop-mark";

const WORDMARK = "Closedloop.ai";
/**
 * The PM settled this copy directly ("Stop burning tokens is accurate. please
 * follow that copy") over the alternative still written into ISS-5112 §1; the
 * issue's landing section is stale and the prototype is the spec here.
 *
 * ISS-5490 moved the strings themselves to `@repo/lib/landing-hero-copy`
 * because `apps/web`'s landing renders the same hero, and two literals in two
 * apps drift the moment one is edited. The STYLING stays local and stays
 * different — see below.
 *
 * One colour, deliberately. The prototype (and now the web landing) accents
 * "burning" with `text-primary`, and that worked there because its mark sat in an
 * absolute top bar far from the headline. Putting both on one rail — which is
 * what makes the mark sit over the "S" — stood the primary blue and the mark's
 * lighter brand blue nose to nose at `text-7xl`, two blues close enough to read
 * as a mistake rather than a hierarchy. The mark keeps the colour; the headline
 * carries on weight.
 */
const HEADLINE = LANDING_HERO_HEADLINE;
const SUBTITLE = LANDING_HERO_SUBTITLE;
const GET_STARTED_LABEL = "Get Started";
const SIGN_IN_PROMPT = "Already have an account?";
const SIGN_IN_LABEL = "Sign in";

type GuestLandingProps = {
  /** Enter the app as a guest — no account, local analysis only. */
  onGetStarted: () => void;
  /** Start the real system-browser sign-in, for someone who already has an account. */
  onSignIn: () => void;
};

/**
 * ISS-5112 (PLN-1600 Step F) — the first screen a new install shows.
 *
 * Hero only. Everything the earlier `desktop-onboarding-landing` prototype put
 * below the fold (how-it-works, the value comparison, what-you-downloaded, a
 * closing CTA) was cut before this reached production: the window is small, the
 * reader has already installed the thing, and a second pitch below a pitch is
 * scrolling for its own sake.
 *
 * **Both actions are real and different**, which is why a sign-in link belongs
 * here and not in `AccountDialog`. There, "Sign up" and "Already have an
 * account?" both opened the same loopback OAuth door, so the second control was
 * cut as a promise the product could not keep (see the note in
 * `account-dialog.tsx`). Here the choice is genuine: Get Started enters the app
 * with NO account at all, and Sign in authenticates. Do not "tidy" this link
 * away by reading that comment out of context.
 */
export function GuestLanding({ onGetStarted, onSignIn }: GuestLandingProps) {
  const headingId = useId();
  return (
    // A `div`, not a `main`: the app shell's `SidebarInset` owns the renderer's
    // single `main` landmark, and `check:source-gates` enforces that statically
    // — it cannot see that this screen replaces the shell rather than nesting in
    // it. The hero below carries the accessible name instead, via the pattern the
    // gate points at (`section aria-labelledby` → a real visible heading).
    <div className="relative h-screen overflow-y-auto bg-background">
      <GuestLandingDragStrip />
      <GuestLandingRail>
        <GuestLandingHeader />
        <section
          aria-labelledby={headingId}
          className="flex flex-1 items-center pb-16"
        >
          <div className="flex w-full flex-col gap-6">
            <h1
              className="font-semibold text-3xl tracking-tight sm:text-5xl md:text-6xl lg:text-7xl"
              id={headingId}
            >
              {HEADLINE}
            </h1>
            <p className="max-w-xl text-balance text-lg text-muted-foreground md:text-xl">
              {SUBTITLE}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-5">
              <Button className="px-6" onClick={onGetStarted} size="lg">
                {GET_STARTED_LABEL}
                <ArrowRightIcon aria-hidden="true" />
              </Button>
              <p className="text-muted-foreground text-sm">
                {SIGN_IN_PROMPT}{" "}
                <Button
                  className="h-auto p-0 align-baseline font-medium text-foreground"
                  onClick={onSignIn}
                  variant="link"
                >
                  {SIGN_IN_LABEL}
                </Button>
              </p>
            </div>
          </div>
        </section>
      </GuestLandingRail>
    </div>
  );
}

/**
 * The window-move handle, full-bleed and behind everything.
 *
 * macOS hides the native title bar (main/window.ts), and this screen replaces
 * the whole app shell — including the Topbar and Sidebar strips that normally
 * serve as the drag region. Without this the window could not be moved at all
 * while the landing is up. Full width rather than part of the header, because a
 * handle only as wide as the centered content rail would leave most of the top
 * edge dead.
 */
export function GuestLandingDragStrip() {
  if (!isMacOS()) {
    return null;
  }
  return (
    <div
      aria-hidden="true"
      className="app-region-drag absolute inset-x-0 top-0 h-16"
    />
  );
}

/**
 * ONE rail for the mark and the hero.
 *
 * They used to sit on different ones — the header padded from the window edge,
 * the hero a centered `max-w-5xl` box — and a centered container has no fixed
 * left margin, so the two could never line up: at 1400px the mark hung 104px
 * left of the headline, and at 900px it was indented 44px right of it, which
 * reads as a stray padding. Sharing the rail makes the mark sit above the "S" of
 * "Stop" at every width.
 *
 * The stoplight clearance goes on the OUTER box, outside `mx-auto`, so the whole
 * rail shifts clear of the buttons at narrow widths instead of the mark alone
 * shifting away from the hero.
 */
function GuestLandingRail({ children }: { children: ReactNode }) {
  return (
    // `min-h-svh` on both, never `h-*` — these sit inside an `overflow-y-auto`
    // scroller, and a child fixed to the container's exact height can never make
    // it scroll, so tall content is clipped with no way to reach it. The hero is
    // short, but the headline runs to `text-7xl` and the window has no minimum
    // height.
    //
    // The unit is load-bearing: this was `min-h-full` on both, and the INNER one
    // silently collapsed. A percentage `min-height` resolves against the parent's
    // `height`, and the outer box here sets only a `min-height` — its `height` is
    // `auto` — so `min-height: 100%` on the inner column resolved to `auto`. The
    // column was then only as tall as its content, the hero's `flex-1` had no
    // free space to claim, and `items-center` centered it within its own height:
    // the whole screen sat jammed at the top with the window empty below it. A
    // viewport unit has no parent to resolve against, so the chain cannot break
    // this way again.
    <div className={cn("min-h-svh", macStoplightClearance())}>
      <div className="mx-auto flex min-h-svh w-full max-w-5xl flex-col px-6 md:px-10">
        {children}
      </div>
    </div>
  );
}

/**
 * What the window shows before the flag snapshot lands on a first run.
 *
 * The landing minus its hero. Holding beats painting the app shell and yanking
 * it away, but an entirely blank window reads as a hung app rather than a
 * product starting — and because the mark sits exactly where the real header
 * puts it a beat later, nothing moves when the hero arrives.
 */
export function GuestLandingHold() {
  return (
    <div className="relative h-screen overflow-y-auto bg-background">
      <GuestLandingDragStrip />
      <GuestLandingRail>
        <GuestLandingHeader />
      </GuestLandingRail>
    </div>
  );
}

/**
 * The brand lockup. Shared with the sign-in step and the hold deliberately: the
 * sign-in step used to
 * drop the brand entirely, so one click took you from a full-window branded hero
 * to a bare card on an empty field — a hard break in continuity for what is
 * still the same product and the same decision.
 */
export function GuestLandingHeader({ className }: { className?: string }) {
  return (
    <header
      className={cn("flex shrink-0 items-center gap-2", className ?? "py-5")}
    >
      <ClosedloopMark className="size-7" />
      <span className="font-semibold text-lg tracking-tight">{WORDMARK}</span>
    </header>
  );
}
