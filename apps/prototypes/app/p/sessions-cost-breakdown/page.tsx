import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Separator } from "@repo/design-system/components/ui/separator";
import { CostBreakdownCard } from "./cost-breakdown-card";
import { mockCostCohorts, shippedCardToday, shippedHonestMode } from "./mock";

/** The width the shipped five-card rank measures on a 1400px desktop window. */
const STRIP_CARD_WIDTH = "207px";

// Reproduces SummaryCardRow's label re-flow (ISS-5070): the strip drops
// MetricCard's label region out of flex so a two-line label cannot strand the
// info glyph in the card's top-right corner, where it reads as a card-level
// control. Without it this section would render a friendlier header than the one
// that actually ships, and the point of the section is to judge what ships.
const STRIP_HOST_CLASS = "[&_[data-slot=card-description]]:block";

const ReferenceCard = ({
  delta,
  deltaCaption,
  detail,
  label,
  value,
}: {
  delta: string | null;
  deltaCaption: string | null;
  detail: string;
  label: string;
  value: string;
}) => (
  <Card className="border-border bg-card">
    <CardHeader className="flex min-w-0 flex-row items-start justify-between gap-4 space-y-0 pb-3">
      <div className="min-w-0 space-y-1">
        <CardDescription className="font-semibold text-[11px] uppercase tracking-[0.12em]">
          {label}
        </CardDescription>
        <CardTitle className="font-semibold text-2xl tracking-tight">
          {value}
        </CardTitle>
      </div>
    </CardHeader>
    <CardContent className="flex flex-col gap-2 pt-0">
      {/* Rendered only when the option ACTUALLY carries a delta. An invented
          figure on the option we are not proposing would stack the comparison. */}
      {delta === null ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge
            className="border-transparent bg-success/10 font-medium text-[11px] text-success tabular-nums"
            variant="outline"
          >
            {delta}
          </Badge>
          {deltaCaption === null ? null : (
            <span className="text-muted-foreground text-sm">
              {deltaCaption}
            </span>
          )}
        </div>
      )}
      <span className="text-muted-foreground text-sm">{detail}</span>
    </CardContent>
  </Card>
);

const SessionsCostBreakdownPrototypePage = () => (
  <main className="mx-auto max-w-6xl px-6 py-10">
    <header className="space-y-2">
      <h1 className="font-semibold text-2xl tracking-tight">
        Sessions cost breakdown
      </h1>
      <p className="max-w-3xl text-muted-foreground text-sm">
        The Sessions summary Cost card, headlined by the subscription-inclusive
        total and broken into lanes that sum to it. Today the card headlines
        only the not-subscription-covered bucket, so an account whose spend is
        almost entirely subscription-covered reads as though it spent $210.
      </p>
    </header>

    <section className="mt-8 space-y-4">
      <div className="space-y-1">
        <h2 className="font-semibold text-lg tracking-tight">
          The three options, same cohort
        </h2>
        <p className="max-w-3xl text-muted-foreground text-sm">
          The middle card is not hypothetical: it is the flag-gated honest mode
          already in the tree behind{" "}
          <code className="text-xs">sessions-cost-billing-honesty</code>,
          default off. The choice is a three-way, not a two-up.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Shipped today
          </p>
          <ReferenceCard
            delta={shippedCardToday.delta}
            deltaCaption={shippedCardToday.deltaCaption}
            detail={shippedCardToday.detail}
            label={shippedCardToday.label}
            value={`$${shippedCardToday.value.toFixed(0)}`}
          />
        </div>
        <div className="space-y-2">
          <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Honest mode, built and flagged off
          </p>
          <ReferenceCard
            delta={shippedHonestMode.delta}
            deltaCaption={shippedHonestMode.deltaCaption}
            detail={shippedHonestMode.detail}
            label={shippedHonestMode.label}
            value={`$${shippedHonestMode.value}`}
          />
        </div>
        <div className="space-y-2">
          <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Proposed
          </p>
          <CostBreakdownCard cohort={mockCostCohorts[0]} />
        </div>
      </div>
    </section>

    <Separator className="my-10" />

    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="font-semibold text-lg tracking-tight">
          At the width the strip actually gives it
        </h2>
        <p className="max-w-3xl text-muted-foreground text-sm">
          The shipped five-card rank measures {STRIP_CARD_WIDTH} on a 1400px
          desktop window, and the lane row inside the card&rsquo;s padding gets
          roughly 48px less than that. A lane label beside two right-aligned
          numbers needs about 300px, so the lanes sit behind the Cost breakdown
          disclosure rather than wrapping onto each other. They stay there at
          every width: the strip <em>can</em> grow the card past 300px on a wide
          display, and product chose one consistent form over a card that
          changes shape by monitor.
        </p>
      </div>
      <div className="flex flex-wrap items-start gap-4">
        {mockCostCohorts.slice(0, 3).map((cohort) => (
          <div
            className={STRIP_HOST_CLASS}
            key={cohort.id}
            style={{ width: STRIP_CARD_WIDTH }}
          >
            <CostBreakdownCard cohort={cohort} />
          </div>
        ))}
      </div>
    </section>

    <Separator className="my-10" />

    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="font-semibold text-lg tracking-tight">
          The states it has to survive
        </h2>
        <p className="max-w-3xl text-muted-foreground text-sm">
          Every shape the real payload can take, including the two lanes that
          are optional on the wire.
        </p>
      </div>
      <div className="grid gap-6 sm:grid-cols-2">
        {mockCostCohorts.map((cohort) => (
          <div className="space-y-2" key={cohort.id}>
            <CostBreakdownCard cohort={cohort} />
            <p className="text-muted-foreground text-xs leading-relaxed">
              {cohort.caption}
            </p>
          </div>
        ))}
      </div>
    </section>

    <Separator className="my-10" />

    <section className="space-y-3">
      <h2 className="font-semibold text-lg tracking-tight">Open questions</h2>
      <ul className="max-w-3xl space-y-2 text-muted-foreground text-sm">
        <li>
          The org Dashboard renders this same component and already headlines
          the subscription-inclusive total, so lanes would land there too.
          Whether it wants them, or only Sessions does, is undecided.
        </li>
        <li>
          The delta drops the visible &ldquo;better&rdquo; / &ldquo;worse&rdquo;
          word, keeps a direction glyph, and adds an sr-only verdict. If the
          wider treatment graduates, the recorded position is sr-only verdict
          text (operator pick, 2026-08-24) &mdash; the cheapest of the three
          resolutions, and honest about its limit: it does not reach a sighted
          reader with a colour vision deficiency, for whom the tint is still the
          only verdict channel. Dropping the sentiment colour is the only
          resolution that closes it for everyone.
        </li>
        <li>
          The lanes are numbers, not a share meter. On the production cohort the
          subscription lane is 99.86% of the total, so a stacked bar would
          render the other two at sub-pixel width and read as a rendering bug.
        </li>
      </ul>
    </section>
  </main>
);

export default SessionsCostBreakdownPrototypePage;
