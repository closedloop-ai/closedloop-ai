import { useMemo } from "react";
import type { AgentCoachingGroundedMetrics } from "./agent-coaching-types";
import {
  buildWrappedCards,
  type CodingWrappedCard,
} from "./coding-wrapped-model";

type CodingWrappedProps = {
  metrics: AgentCoachingGroundedMetrics | null;
};

/**
 * "Coding Wrapped" (FEA-3403): a playful set of fun-fact stats rendered from the
 * already-computed coaching lookback metrics (FEA-3397 signals). One fact per
 * available signal; the whole surface hides when no signal is present, and each
 * fact degrades gracefully per missing signal (see buildWrappedCards).
 *
 * Presentational and secondary: it lives at the foot of the coaching card as a
 * light stat strip under the actionable tip, not as a competing bordered box.
 * Read-only, so it incurs no extra LLM cost and shows no raw evidence or secrets
 * (prompt text is redacted upstream by the lookback).
 */
export function CodingWrapped({ metrics }: CodingWrappedProps) {
  const cards = useMemo(() => buildWrappedCards(metrics), [metrics]);
  if (cards.length === 0) {
    return null;
  }
  // FEA-3722: the window label mirrors the selected date range. A positive
  // lookback reads "last N days"; the 0 sentinel means the all-time range,
  // shown as "all time" rather than hidden (which previously masked the range).
  const lookbackDays = metrics?.lookbackDays ?? 0;
  const windowLabel =
    lookbackDays > 0 ? `last ${lookbackDays} days` : "all time";
  return (
    <section
      aria-label="Coding Wrapped"
      className="border-border/60 border-t pt-4"
    >
      <div className="flex items-baseline gap-2">
        <h3 className="font-medium text-foreground text-sm">Coding Wrapped</h3>
        <span className="text-muted-foreground text-xs">{windowLabel}</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
        {cards.map((card) => (
          <WrappedFact card={card} key={card.id} />
        ))}
      </div>
    </section>
  );
}

function WrappedFact({ card }: { card: CodingWrappedCard }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-muted-foreground text-xs uppercase tracking-wide">
        {card.label}
      </div>
      <div
        className="mt-1 truncate font-medium text-base text-foreground"
        title={card.value}
      >
        {card.value}
      </div>
      {card.caption ? (
        <div className="mt-0.5 text-muted-foreground text-xs">
          {card.caption}
        </div>
      ) : null}
    </div>
  );
}
