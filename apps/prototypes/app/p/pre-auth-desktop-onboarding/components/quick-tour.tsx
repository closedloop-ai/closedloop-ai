"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { cn } from "@repo/design-system/lib/utils";
import { ArrowRightIcon, CheckIcon, ChevronLeftIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type TourSummaryRow, tourSteps, tourSummary } from "../mock";

type QuickTourProps = {
  active: boolean;
  onComplete: () => void;
  onSkip: () => void;
};

type TourTargetRect = {
  height: number;
  left: number;
  top: number;
  width: number;
};

export const QuickTour = ({ active, onComplete, onSkip }: QuickTourProps) => {
  const [stepIndex, setStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<TourTargetRect | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const step = tourSteps[stepIndex];

  useEffect(() => {
    if (active) {
      setStepIndex(0);
    }
  }, [active]);

  // Pull keyboard focus into the tour panel on each spotlight step so a
  // keyboard user reaches Next/Back without tabbing the whole dashboard first
  // (the intro uses the catalog Dialog, which traps focus on its own).
  useEffect(() => {
    if (active && step && !step.intro) {
      panelRef.current?.focus();
    }
  }, [active, step]);

  // Escape skips a spotlight step, matching the intro Dialog's own Escape
  // behavior so both step types dismiss deliberately the same way. A
  // document-level listener catches it wherever focus currently sits.
  useEffect(() => {
    if (!(active && step) || step.intro) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onSkip();
      }
    };
    globalThis.addEventListener("keydown", handleKeyDown);
    return () => globalThis.removeEventListener("keydown", handleKeyDown);
  }, [active, step, onSkip]);

  useEffect(() => {
    if (!(active && step?.target)) {
      setTargetRect(null);
      return;
    }
    const element = globalThis.document.querySelector(
      `[data-tour="${step.target}"]`
    );
    if (!element) {
      setTargetRect(null);
      return;
    }
    element.scrollIntoView({ behavior: "auto", block: "center" });
    const measure = () => {
      const box = element.getBoundingClientRect();
      setTargetRect({
        height: box.height,
        left: box.left,
        top: box.top,
        width: box.width,
      });
    };
    measure();
    let frame = 0;
    const scheduleMeasure = () => {
      if (frame !== 0) {
        return;
      }
      frame = globalThis.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    globalThis.addEventListener("scroll", scheduleMeasure, true);
    globalThis.addEventListener("resize", scheduleMeasure);
    return () => {
      if (frame !== 0) {
        globalThis.cancelAnimationFrame(frame);
      }
      globalThis.removeEventListener("scroll", scheduleMeasure, true);
      globalThis.removeEventListener("resize", scheduleMeasure);
    };
  }, [active, step]);

  if (!(active && step)) {
    return null;
  }

  const isIntro = Boolean(step.intro);
  const isLast = stepIndex === tourSteps.length - 1;
  const spotlight = targetRect
    ? {
        height: targetRect.height + SPOTLIGHT_PADDING * 2,
        left: targetRect.left - SPOTLIGHT_PADDING,
        top: targetRect.top - SPOTLIGHT_PADDING,
        width: targetRect.width + SPOTLIGHT_PADDING * 2,
      }
    : null;
  const advance = () => {
    if (isLast) {
      onComplete();
      return;
    }
    setStepIndex((current) => current + 1);
  };

  return (
    <>
      {/* Click shield — fences off the dashboard behind the tour WITHOUT
          dismissing it. Skipping is deliberate (the Skip tour button only), so
          a stray click can no longer end onboarding. When a spotlight is
          active, the four inert strips fence the area around the cutout while
          the cutout itself is left unblocked, so the highlighted card stays
          interactive. */}
      {!isIntro &&
        (spotlight ? (
          <>
            <div
              className="fixed z-40"
              style={{ top: 0, left: 0, right: 0, height: spotlight.top }}
            />
            <div
              className="fixed z-40"
              style={{
                top: spotlight.top + spotlight.height,
                left: 0,
                right: 0,
                bottom: 0,
              }}
            />
            <div
              className="fixed z-40"
              style={{
                top: spotlight.top,
                left: 0,
                width: spotlight.left,
                height: spotlight.height,
              }}
            />
            <div
              className="fixed z-40"
              style={{
                top: spotlight.top,
                left: spotlight.left + spotlight.width,
                right: 0,
                height: spotlight.height,
              }}
            />
          </>
        ) : (
          <div className="fixed inset-0 z-40" />
        ))}
      {/* Manual dim overlay — only for non-intro steps. The intro uses the
          catalog Dialog which renders its own backdrop. */}
      {!isIntro && spotlight && (
        <div
          className="pointer-events-none fixed z-40 rounded-xl outline-2 outline-primary"
          style={{
            boxShadow:
              "0 0 0 9999px color-mix(in oklab, var(--foreground) 55%, transparent)",
            height: spotlight.height,
            left: spotlight.left,
            top: spotlight.top,
            width: spotlight.width,
          }}
        />
      )}
      {!(isIntro || spotlight) && (
        <div className="pointer-events-none fixed inset-0 z-40 bg-foreground/55" />
      )}
      {isIntro ? (
        <Dialog
          onOpenChange={(open) => {
            if (!open) {
              onSkip();
            }
          }}
          open={isIntro}
        >
          <DialogContent className="max-w-lg gap-0 p-5">
            <TourHeading eyebrow={step.eyebrow} stepIndex={stepIndex} />
            <DialogTitle className="font-semibold text-xl tracking-tight">
              {step.title}
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-pretty text-sm leading-relaxed">
              {step.body}
            </DialogDescription>
            <div className="mt-4 overflow-hidden rounded-xl border border-border bg-card">
              {tourSummary.map((row) => (
                <SummaryRow key={row.key} row={row} />
              ))}
            </div>
            <div className="mt-4 flex items-center gap-2">
              <Button onClick={onSkip} size="sm" variant="ghost">
                Skip tour
              </Button>
              <Button className="ml-auto" onClick={advance} size="sm">
                Take a quick tour
                <ArrowRightIcon />
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : (
        <section
          aria-label={`${step.eyebrow}: ${step.title}`}
          className="pointer-events-auto fixed inset-x-6 bottom-6 z-50 rounded-2xl border border-border bg-background p-4 shadow-2xl outline-none sm:right-6 sm:left-auto sm:w-full sm:max-w-sm"
          ref={panelRef}
          tabIndex={-1}
        >
          <TourHeading eyebrow={step.eyebrow} stepIndex={stepIndex} />
          <h2 className="font-semibold text-sm tracking-tight">{step.title}</h2>
          <p className="mt-1.5 text-pretty text-muted-foreground text-sm leading-relaxed">
            {step.body}
          </p>
          <div className="mt-3.5 flex items-center gap-2">
            <Button onClick={onSkip} size="sm" variant="ghost">
              Skip tour
            </Button>
            <span className="ml-auto flex gap-2">
              <Button
                onClick={() =>
                  setStepIndex((current) => Math.max(0, current - 1))
                }
                size="sm"
                variant="outline"
              >
                <ChevronLeftIcon />
                Back
              </Button>
              <Button onClick={advance} size="sm">
                {isLast ? "Create Account" : "Next"}
                {isLast ? null : <ArrowRightIcon />}
              </Button>
            </span>
          </div>
        </section>
      )}
    </>
  );
};

const TourHeading = ({
  eyebrow,
  stepIndex,
}: {
  eyebrow: string;
  stepIndex: number;
}) => (
  <div className="mb-3 flex items-center gap-2">
    {stepIndex === 0 ? <CheckIcon className="size-4 text-success" /> : null}
    <span
      className={cn(
        "font-semibold text-xs uppercase tracking-wide",
        stepIndex === 0 ? "text-success" : "text-primary"
      )}
    >
      {eyebrow}
    </span>
    <span aria-hidden="true" className="ml-auto flex items-center gap-1">
      {tourSteps.map((tourStep, dotIndex) => (
        <span
          className={cn(
            "h-1.5 rounded-full transition-all",
            dotIndex === stepIndex ? "w-4 bg-primary" : "w-1.5 bg-input-border"
          )}
          key={tourStep.id}
        />
      ))}
    </span>
  </div>
);

const SummaryRow = ({ row }: { row: TourSummaryRow }) => (
  <div className="border-border border-t px-3.5 py-3 first:border-t-0">
    <div className="flex items-start justify-between gap-4">
      <p className="font-medium text-sm">{row.label}</p>
      {row.value ? (
        <span className="font-semibold text-sm tabular-nums">{row.value}</span>
      ) : null}
    </div>
    {row.chips ? (
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {row.chips.map((chip) => (
          <span
            className={cn(
              "inline-flex items-center gap-1 text-xs",
              chip.warn && "text-warning-foreground",
              chip.muted && "text-muted-foreground"
            )}
            key={chip.text}
          >
            {chip.ok ? <CheckIcon className="size-3 text-success" /> : null}
            {chip.text}
          </span>
        ))}
      </div>
    ) : null}
    {row.sub ? (
      <p className="mt-1.5 text-pretty text-muted-foreground text-xs leading-relaxed">
        {row.sub}
      </p>
    ) : null}
  </div>
);

const SPOTLIGHT_PADDING = 8;
