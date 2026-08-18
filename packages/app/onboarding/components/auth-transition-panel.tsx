"use client";

import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import {
  GitHubMark,
  GoogleGlyph,
} from "@repo/design-system/components/ui/brand-icons";
import { Loader2 } from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  type SVGProps,
  useEffect,
  useState,
} from "react";

/**
 * Hold before revealing. The happy path through these screens is a couple of
 * hundred milliseconds, and a heading that appears and vanishes inside that
 * window is a strobe rather than information. Past this delay the hop is
 * genuinely slow and an explanation is worth showing.
 *
 * It fades in rather than popping: the surrounding column is empty until this
 * renders, so an instant hard cut reads as a layout correcting itself.
 */
const REVEAL_DELAY_MS = 400;

/**
 * Brand mark per provider. The panel owns the sizing so every transition screen
 * renders the mark identically instead of each call site repeating the classes,
 * and so adding a provider is one entry here rather than a second boolean prop.
 *
 * Typed as an exhaustive `Record` over {@link DesktopSignInProvider}: a new
 * provider fails `tsc` here instead of silently rendering no mark.
 */
const PROVIDER_MARK = {
  [DesktopSignInProvider.GitHub]: GitHubMark,
  [DesktopSignInProvider.Google]: GoogleGlyph,
} as const satisfies Record<
  DesktopSignInProvider,
  ComponentType<SVGProps<SVGSVGElement>>
>;

type AuthTransitionPanelProps = {
  /** Sentence-case heading. The only `h1` on these transitional routes. */
  readonly title: string;
  readonly description?: string;
  /** Recovery affordance, rendered below the copy. */
  readonly action?: ReactNode;
  /** Renders the spinner and marks the live region busy. */
  readonly busy?: boolean;
  /**
   * Which provider this transition is about. Shows that provider's brand mark —
   * the continuity cue back to the CTA the user pressed in the desktop app.
   * Omit for a transition that is not provider-specific.
   */
  readonly provider?: DesktopSignInProvider;
};

/**
 * Shared block for the auth transitions in the desktop connect flow
 * (`/connect/github`, `/sso-callback`).
 *
 * Every one of those screens is the same moment — "hold on, we're moving you" —
 * so they share one component rather than drifting into separate spellings of
 * it. Lives here rather than beside the routes because Storybook does not scan
 * `apps/app/**`, and this has a real state matrix (busy, mark, description,
 * action) that is worth seeing in isolation.
 *
 * Width is deliberately NOT set here: the `(unauthenticated)` layout already
 * clamps children to `max-w-sm`, so a local max-width would be inert.
 *
 * `role="status"` makes this a polite live region, so flipping from a waiting
 * state to a failure state is announced rather than silently swapping under a
 * screen-reader user.
 *
 * NOT YET the only spelling in the flow: the device consent step at
 * `/settings/integrations/desktop/authorize` is still its own bordered card
 * with an inline spinner. Unifying it is deliberate follow-up work, not
 * something this component's existence has already accomplished.
 */
export function AuthTransitionPanel({
  title,
  description,
  action,
  busy = false,
  provider,
}: AuthTransitionPanelProps) {
  const [revealed, setRevealed] = useState(false);
  const Mark = provider ? PROVIDER_MARK[provider] : null;

  useEffect(() => {
    const timeoutId = setTimeout(() => setRevealed(true), REVEAL_DELAY_MS);
    return () => clearTimeout(timeoutId);
  }, []);

  if (!revealed) {
    return null;
  }

  return (
    <div
      aria-busy={busy}
      className="fade-in-0 flex animate-in flex-col items-center gap-4 text-center duration-200"
      role="status"
    >
      {Mark ? <Mark className="size-6 text-muted-foreground" /> : null}
      <div className="flex flex-col gap-1.5">
        <h1 className="font-semibold text-2xl tracking-tight">{title}</h1>
        {description ? (
          <p className="text-muted-foreground text-sm">{description}</p>
        ) : null}
      </div>
      {busy ? (
        <Loader2
          aria-hidden="true"
          className="size-6 animate-spin text-muted-foreground"
        />
      ) : null}
      {action}
    </div>
  );
}
