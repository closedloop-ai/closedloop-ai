"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { cn } from "@repo/design-system/lib/utils";
import { ArrowRightIcon, CheckIcon, ChevronLeftIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { type TourSummaryRow, tourSteps } from "../mock";

type Rect = { top: number; left: number; width: number; height: number };

const SPOTLIGHT_PAD = 8;

const SummaryRow = ({ row }: { row: TourSummaryRow }) => (
  <div className="flex items-start justify-between gap-3 border-border border-t px-3.5 py-3 first:border-0">
    <div className="min-w-0">
      <p className="font-semibold text-xs">{row.label}</p>
      {row.chips ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {row.chips.map((chip) => (
            <Badge
              className={cn(
                "gap-1 rounded-full font-normal text-[11px]",
                chip.muted && "text-muted-foreground"
              )}
              key={chip.text}
              variant={chip.ok === false ? "destructive" : "outline"}
            >
              {chip.ok ? <CheckIcon className="size-3 text-success" /> : null}
              {chip.text}
            </Badge>
          ))}
        </div>
      ) : null}
      {row.sub ? (
        <p className="mt-1.5 text-pretty text-[11px] text-muted-foreground leading-relaxed">
          {row.sub}
        </p>
      ) : null}
    </div>
    {row.value ? (
      <span className="font-mono font-semibold text-base">{row.value}</span>
    ) : null}
  </div>
);

// Guided walkthrough. After the dashboard populates, this spotlights each card
// with a short explanation. The final step drives the GitHub-first account CTA.
export const OnboardingTour = ({
  active,
  onClose,
}: {
  active: boolean;
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
    element.scrollIntoView({ behavior: "smooth", block: "center" });
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
    const interval = window.setInterval(measure, 60);
    const stop = window.setTimeout(() => window.clearInterval(interval), 700);
    window.addEventListener("resize", measure);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(stop);
      window.removeEventListener("resize", measure);
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

  // The tour ends by landing on the frosted team card (its own ring + CTA is the
  // finale) rather than showing a docked callout beside it.
  const finish = () => {
    document
      .querySelector('[data-tour="team"]')
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    onClose("done");
  };
  const advance = () => (isLast ? finish() : setIdx((i) => i + 1));

  return (
    <>
      {/* Blocks clicks from reaching the dashboard underneath while the tour is
          up. It does NOT dismiss on click (that was the old bug: a stray tap
          silently ended the tour). Dismissal is only Escape or the explicit
          Skip tour button below, both wired through Dialog. */}
      <div aria-hidden="true" className="fixed inset-0 z-40 bg-transparent" />

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

      {/* Dialog gives the card what it was missing as a modal: focus moves
          into it on open, Escape closes it (mapped to "skip" below), and it's
          announced with the right role. onPointerDownOutside/onInteractOutside
          are suppressed so a stray click on the dim backdrop can't silently
          end the tour — only Escape and the Skip tour button can (#4285 T10). */}
      <Dialog
        onOpenChange={(next) => {
          if (!next) {
            onClose("skip");
          }
        }}
        open={true}
      >
        <DialogContent
          className={
            isIntro
              ? "w-[472px] max-w-full gap-0 rounded-2xl p-5 shadow-2xl sm:max-w-[472px]"
              : "top-auto right-6 bottom-6 left-auto w-[344px] max-w-full translate-x-0 translate-y-0 gap-0 rounded-2xl p-4 shadow-2xl sm:max-w-[344px]"
          }
          onInteractOutside={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          showCloseButton={false}
          showOverlay={false}
        >
          <div
            className={cn("flex items-center gap-2", isIntro ? "mb-3" : "mb-2")}
          >
            {isIntro ? (
              <CheckIcon aria-hidden="true" className="size-3.5 text-success" />
            ) : null}
            <span
              className={cn(
                "font-semibold text-[11px] uppercase tracking-[0.08em]",
                isIntro ? "text-success" : "text-primary"
              )}
            >
              {step.eyebrow}
            </span>
            {dots}
          </div>
          <DialogTitle className="font-semibold text-lg tracking-tight">
            {step.title}
          </DialogTitle>
          <DialogDescription className="mt-1.5 text-pretty text-sm leading-relaxed">
            {step.body}
          </DialogDescription>
          {step.summary ? (
            <div className="mt-4 overflow-hidden rounded-xl border border-border bg-card">
              {step.summary.map((row) => (
                <SummaryRow key={row.label} row={row} />
              ))}
            </div>
          ) : null}
          <div
            className={cn(
              "flex items-center gap-2",
              isIntro ? "mt-4" : "mt-3.5"
            )}
          >
            <Button onClick={() => onClose("skip")} size="sm" variant="ghost">
              Skip tour
            </Button>
            {isIntro ? (
              <Button className="ml-auto" onClick={advance} size="sm">
                Take a quick tour
                <ArrowRightIcon />
              </Button>
            ) : (
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
                  {isLast ? "Done" : "Next"}
                  {isLast ? null : <ArrowRightIcon />}
                </Button>
              </span>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};
