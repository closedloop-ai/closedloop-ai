import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@closedloop-ai/design-system/components/ui/empty";
import { BuildingIcon } from "lucide-react";
import { type ReactNode, useId } from "react";
import { GUEST_OFFER_COPY } from "../onboarding/guest-signup-copy";
import { GuestSignupIntent } from "../onboarding/guest-signup-provider";

/**
 * The dashboard body, or the Organization ask in its place.
 *
 * An earlier revision dimmed the body to 30% and floated the ask over it on an
 * `absolute inset-0` layer. Two things were wrong with that. Selecting
 * Organization deliberately does not change scope, so the ghosted field was the
 * guest's OWN sessions — and a dimmed dashboard under an upsell card reads as
 * withheld organization data no matter what the card says. (The prototype this
 * came from could do it honestly: there the field behind really was org data.)
 * And an absolutely-positioned ask on a full-height body leaves anyone who
 * scrolls looking at a ghost page with the ask off-screen above them.
 *
 * Replacing the body says the true thing and scrolls correctly, because the ask
 * is in normal flow. It also makes the scope toggle's pin on "Organization"
 * honest: the page really is showing the organization view now, which is that
 * it needs an account.
 */
export function OrgGatedRegion({
  gated,
  onCreateAccount,
  onDismiss,
  children,
}: {
  gated: boolean;
  onCreateAccount: () => void;
  onDismiss: () => void;
  children: ReactNode;
}) {
  if (gated) {
    return (
      <OrgScopeGate onCreateAccount={onCreateAccount} onDismiss={onDismiss} />
    );
  }
  return <>{children}</>;
}

/**
 * ISS-5112 (PLN-1600 Step D) — what a guest gets for selecting Organization.
 *
 * Organization scope is the one thing on this page an account actually buys, so
 * the ask is made where the value is rather than as a generic banner. It is not
 * a dialog: a modal would trap someone who only wanted to look, and the header
 * above stays live so the range, the scope toggle and the tour are all still
 * reachable.
 *
 * Composed from the `Empty` primitives rather than the `EmptyState` wrapper,
 * for one reason: `EmptyState` takes `title` as a string and renders it through
 * `EmptyTitle`, which is a styling slot over a plain `div`. This title names the
 * whole region and is what the section's `aria-labelledby` points at, so it has
 * to carry heading semantics — which the wrapper gives no way to pass through.
 * Same primitives, one level down.
 */
export function OrgScopeGate({
  onCreateAccount,
  onDismiss,
}: {
  onCreateAccount: () => void;
  onDismiss: () => void;
}) {
  const headingId = useId();
  const copy = GUEST_OFFER_COPY[GuestSignupIntent.Organization];
  return (
    <section aria-labelledby={headingId}>
      {/*
        `border-solid` is load-bearing. `Empty`'s own base class carries
        `border-dashed`, and overriding width, color and radius does not displace
        a STYLE utility — tailwind-merge keeps both, so this card shipped dashed.
        A dashed outline means "nothing here yet" in this product (the sidebar's
        guest avatar comment states the same rule); this card is an ask, not an
        absence, and every sibling using this idiom is solid.
      */}
      <Empty className="min-h-[360px] rounded-xl border border-border/70 border-solid bg-card">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BuildingIcon className="size-6" />
          </EmptyMedia>
          <EmptyTitle aria-level={2} id={headingId} role="heading">
            {copy.title}
          </EmptyTitle>
          <EmptyDescription>{copy.body}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex flex-col gap-2">
          <Button onClick={onCreateAccount}>Create account</Button>
          <Button onClick={onDismiss} variant="ghost">
            Back to my sessions
          </Button>
        </EmptyContent>
      </Empty>
    </section>
  );
}
