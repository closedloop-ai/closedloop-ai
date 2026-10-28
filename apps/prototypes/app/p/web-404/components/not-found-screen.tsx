import { Button } from "@repo/design-system/components/ui/button";
import Link from "next/link";
import { primaryActions, recoveryLinks, type SiteLink } from "../mock";

// The screen itself. Self-contained apart from one production seam: every
// internal href here is unprefixed, and apps/web routes all of them through
// `localize(locale, href)` (lib/site.tsx), so the production version takes a
// `locale` prop and threads it. Nothing else needs to change on the way in.
// The section rhythm, the copy column width and the divider are the values the
// home page's hero and final-CTA sections already use, so a 404 does not read
// as a different site.
export const NotFoundScreen = () => (
  <section className="mx-auto w-full max-w-[1300px] px-6 pt-16 pb-24 md:px-10 md:pt-24">
    <div className="max-w-3xl">
      {/* Muted, not accent: the SiteBanner above is a full-bleed bg-primary
          strip that shows on a first visit, and the primary button below is
          the action. A blue eyebrow between them made three blues in the top
          400px on a screen whose job is to point at one thing. The status code
          is orientation, so it keeps its place and gives up the accent. */}
      <p className="font-medium text-muted-foreground text-sm">404</p>
      <h1 className="mt-4 font-semibold text-4xl tracking-tight md:text-5xl">
        That page isn't here.
      </h1>
      <p className="mt-6 text-balance text-lg text-muted-foreground">
        The link might be out of date, or the address has a typo.
      </p>

      <div className="mt-8 flex flex-col flex-wrap gap-3 sm:flex-row">
        {primaryActions.map((action, index) => (
          <Button
            asChild
            className={pageLevelButtonClassName}
            key={action.href}
            size="lg"
            variant={index === 0 ? "default" : "outline"}
          >
            {siteLinkElement(action)}
          </Button>
        ))}
      </div>

      <div className="mt-12 border-border/60 border-t pt-8">
        <h2
          className="font-medium text-foreground text-sm"
          id={otherPagesHeadingId}
        >
          Other pages
        </h2>
        <nav aria-labelledby={otherPagesHeadingId} className="mt-3">
          <ul className="flex flex-wrap gap-x-6 gap-y-2">
            {recoveryLinks.map((link) => (
              <li key={link.href}>
                {siteLinkElement(link, recoveryLinkClassName)}
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
  </section>
);

const otherPagesHeadingId = "web-404-other-pages";

// One branch for every link on the screen, so `hardNavigate` cannot be honored
// in one place and silently dropped in another.
const siteLinkElement = (link: SiteLink, className?: string) =>
  link.hardNavigate ? (
    <a className={className} href={link.href}>
      {link.label}
    </a>
  ) : (
    <Link className={className} href={link.href}>
      {link.label}
    </Link>
  );

// A focus ring that is actually visible, on the two page-level actions AND on
// the recovery links. `globals.css` applies `outline-ring` to everything and the
// DS Button adds `focus-visible:ring-[3px]`, but a 404 is where a keyboard user
// is trying to get un-stuck, so every control the screen offers gets an explicit
// 2px offset outline rather than only the secondary ones.
//
// ISS-9063 retuned `--ring` itself — `var(--primary)` in light (5.43:1 on
// `--background`), the lighter `var(--link)` in dark (9.15:1, where `--primary`
// is only 3.11:1) — and dropped the `/50` the base layer composited it at. So
// this reads the shared focus token instead of hard-coding `outline-primary`,
// which would keep the prototype on a treatment the product no longer paints
// and would be the WORSE of the two in dark.
const visibleFocusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

// The hero's treatment, not the final-CTA's. Every square Button on the live
// site sits inside the final-CTA's rounded-3xl card; the only page-level
// buttons on a plain background are the hero's, and those are pills
// (control-visibility-section even hand-rolls a PillButton). `size="lg"` is
// kept because this mirrors hero-section.tsx verbatim, and its `gap-2` and
// `has-[>svg]:px-4` survive the override even though h-10/rounded/px do not.
const pageLevelButtonClassName = `h-10 rounded-full px-5 text-sm md:text-base ${visibleFocusRing}`;

// The footer's link treatment plus the same ring.
const recoveryLinkClassName = `rounded-sm text-muted-foreground text-sm transition-colors hover:text-primary ${visibleFocusRing}`;
