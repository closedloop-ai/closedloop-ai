"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import {
  ArrowRightIcon,
  Check,
  ChevronLeftIcon,
  Cpu,
  Layers,
  SquareTerminal,
} from "lucide-react";
import type { ComponentType } from "react";
import { useEffect, useState } from "react";
import {
  type TourChip,
  type TourSummaryRow,
  tourSteps,
  tourSummary,
} from "../app-mock";

type Rect = { top: number; left: number; width: number; height: number };

const SPOTLIGHT_PAD = 8;

const ROW_ICONS: Record<
  TourSummaryRow["icon"],
  ComponentType<{ className?: string }>
> = {
  sessions: Layers,
  harnesses: SquareTerminal,
  models: Cpu,
};

const chipVariant = (chip: TourChip) => {
  if (chip.warn) {
    return "warning" as const;
  }
  if (chip.muted) {
    return "muted" as const;
  }
  return "outline" as const;
};

const SummaryRow = ({ row }: { row: TourSummaryRow }) => {
  const Icon = ROW_ICONS[row.icon];
  return (
    <div className="flex items-start gap-3 border-border border-t px-3.5 py-3 first:border-t-0">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-sm">{row.label}</p>
        {row.chips ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {row.chips.map((chip) => (
              <Badge
                className="font-normal"
                key={chip.text}
                variant={chipVariant(chip)}
              >
                {chip.ok ? <Check className="size-3 text-success" /> : null}
                {chip.warn ? (
                  <span className="size-1.5 rounded-full bg-current" />
                ) : null}
                {chip.text}
              </Badge>
            ))}
          </div>
        ) : null}
        {row.sub ? (
          <p className="mt-1.5 text-pretty text-muted-foreground text-xs leading-relaxed">
            {row.sub}
          </p>
        ) : null}
      </div>
      {row.value ? (
        <span className="font-semibold text-base tabular-nums">
          {row.value}
        </span>
      ) : null}
    </div>
  );
};

/**
 * Guided walkthrough. After the dashboard populates it spotlights each section
 * with a short explanation; the final step drives the account CTA. Dismissing
 * it early (clicking the dim, or Skip) closes with reason "skip", which just
 * ends the tour without the account CTA a completed tour would surface.
 */
export const OnboardingTour = ({
  active,
  signedUp,
  onClose,
}: {
  active: boolean;
  /** Replays for account users end with a plain close, not an account CTA. */
  signedUp: boolean;
  onClose: (reason: "done" | "skip") => void;
}) => {
  const [idx, setIdx] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const step = tourSteps[idx];

  useEffect(() => {
    if (active) {
      setIdx(0);
    }
  }, [active]);

  useEffect(() => {
    if (!(active && step) || step.intro || !step.target) {
      setRect(null);
      return;
    }
    const element = document.querySelector(`[data-tour="${step.target}"]`);
    if (!element) {
      setRect(null);
      return;
    }
    // Instant scroll so the immediate measurement is authoritative, then track
    // the target on scroll/resize (rAF-coalesced) so the outline never orphans
    // if the user scrolls mid-step (r3706838802). The scroll listener captures
    // so the inner scroll container's events are seen too.
    element.scrollIntoView({ behavior: "instant", block: "center" });
    const measure = () => {
      const box = element.getBoundingClientRect();
      setRect({
        top: box.top,
        left: box.left,
        width: box.width,
        height: box.height,
      });
    };
    measure();
    let frame = 0;
    const scheduleMeasure = () => {
      if (frame !== 0) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    window.addEventListener("scroll", scheduleMeasure, true);
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
      window.removeEventListener("scroll", scheduleMeasure, true);
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [active, step]);

  if (!(active && step)) {
    return null;
  }

  const isIntro = Boolean(step.intro);
  const isLast = idx === tourSteps.length - 1;
  const isFirst = idx === 0;
  const hole = rect
    ? {
        top: rect.top - SPOTLIGHT_PAD,
        left: rect.left - SPOTLIGHT_PAD,
        width: rect.width + SPOTLIGHT_PAD * 2,
        height: rect.height + SPOTLIGHT_PAD * 2,
      }
    : null;

  const dots = (
    <span className="ml-auto flex items-center gap-1">
      {tourSteps.map((tourStep, dotIndex) => (
        <span
          className={cn(
            "h-1.5 rounded-full transition-all",
            dotIndex === idx ? "w-4 bg-primary" : "w-1.5 bg-input-border"
          )}
          key={tourStep.id}
        />
      ))}
    </span>
  );

  const advance = () => (isLast ? onClose("done") : setIdx((i) => i + 1));
  // A guest's finale drives the account CTA; a signed-in replay just closes.
  const lastStepLabel = signedUp ? "Close Tour" : "Create Account";

  return (
    <>
      {/* click-blocker: clicking the dimmed area skips the tour */}
      <button
        aria-label="Skip tour"
        className="fixed inset-0 z-40 cursor-default bg-transparent"
        onClick={() => onClose("skip")}
        type="button"
      />

      {isIntro || !hole ? (
        <div className="pointer-events-none fixed inset-0 z-40 bg-foreground/55" />
      ) : (
        <div
          className="pointer-events-none fixed z-40 rounded-xl outline outline-2 outline-primary"
          style={{
            top: hole.top,
            left: hole.left,
            width: hole.width,
            height: hole.height,
            boxShadow:
              "0 0 0 9999px color-mix(in oklab, var(--foreground) 55%, transparent)",
          }}
        />
      )}

      {isIntro ? (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-6">
          <div className="pointer-events-auto w-full max-w-lg rounded-2xl border border-border bg-background p-5 shadow-2xl">
            <div className="mb-3 flex items-center gap-2">
              <span className="flex size-6 items-center justify-center rounded-lg border border-success/35 bg-success/15 text-success">
                <Check className="size-3.5" />
              </span>
              <span className="font-semibold text-success text-xs uppercase tracking-wide">
                {step.eyebrow}
              </span>
              {dots}
            </div>
            <p className="font-semibold text-xl tracking-tight">{step.title}</p>
            <p className="mt-1.5 text-pretty text-muted-foreground text-sm leading-relaxed">
              {step.body}
            </p>
            <div className="mt-4 overflow-hidden rounded-xl border border-border bg-card">
              {tourSummary.map((row) => (
                <SummaryRow key={row.key} row={row} />
              ))}
            </div>
            <div className="mt-4 flex items-center gap-2">
              <Button onClick={() => onClose("skip")} size="sm" variant="ghost">
                Skip tour
              </Button>
              <Button className="ml-auto" onClick={advance} size="sm">
                Take a quick tour
                <ArrowRightIcon />
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="pointer-events-auto fixed inset-x-6 bottom-6 z-50 rounded-2xl border border-border bg-background p-4 shadow-2xl sm:right-6 sm:left-auto sm:w-full sm:max-w-sm">
          <div className="mb-2 flex items-center gap-2">
            <span className="font-semibold text-primary text-xs uppercase tracking-wide">
              {step.eyebrow}
            </span>
            {dots}
          </div>
          <p className="font-semibold text-sm tracking-tight">{step.title}</p>
          <p className="mt-1.5 text-pretty text-muted-foreground text-sm leading-relaxed">
            {step.body}
          </p>
          <div className="mt-3.5 flex items-center gap-2">
            <Button onClick={() => onClose("skip")} size="sm" variant="ghost">
              Skip tour
            </Button>
            <span className="ml-auto flex gap-2">
              {isFirst ? null : (
                <Button
                  onClick={() => setIdx((i) => Math.max(0, i - 1))}
                  size="sm"
                  variant="outline"
                >
                  <ChevronLeftIcon />
                  Back
                </Button>
              )}
              <Button onClick={advance} size="sm">
                {isLast ? lastStepLabel : "Next"}
                {isLast ? null : <ArrowRightIcon />}
              </Button>
            </span>
          </div>
        </div>
      )}
    </>
  );
};
