"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { cn } from "@repo/design-system/lib/utils";
import { ArrowRightIcon, ChevronLeftIcon } from "lucide-react";
import { useEffect, useState } from "react";

type TargetRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export const DashboardTourTarget = {
  Stats: "stats",
  Impact: "impact",
  Activity: "activity",
  Sessions: "sessions",
  Models: "models",
  PullRequests: "pull-requests",
} as const;

export type DashboardTourTarget =
  (typeof DashboardTourTarget)[keyof typeof DashboardTourTarget];

type DashboardTourStep = {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  target: DashboardTourTarget;
};

const tourSteps: readonly DashboardTourStep[] = [
  {
    id: "stats",
    target: DashboardTourTarget.Stats,
    eyebrow: "Your numbers",
    title: "Start with the headline metrics",
    body: "Sessions, AI spend, PRs shipped, PR size, and merged code update as more of your history is analyzed.",
  },
  {
    id: "impact",
    target: DashboardTourTarget.Impact,
    eyebrow: "AI impact",
    title: "Connect spend to shipped work",
    body: "See how model cost translates into pull requests, merged code, and the repositories where agents create the most value.",
  },
  {
    id: "activity",
    target: DashboardTourTarget.Activity,
    eyebrow: "Activity",
    title: "See when the work happens",
    body: "Each agent run and human input appears here, making working patterns and bursts of activity easy to spot.",
  },
  {
    id: "sessions",
    target: DashboardTourTarget.Sessions,
    eyebrow: "Sessions",
    title: "Open any session for the full story",
    body: "Recent sessions show the harness, duration, and work performed. Open one to review the complete session trace.",
  },
  {
    id: "models",
    target: DashboardTourTarget.Models,
    eyebrow: "Models",
    title: "Understand where model spend goes",
    body: "Track model cost over time and compare how Claude, Codex, and other models contribute to your work.",
  },
  {
    id: "pull-requests",
    target: DashboardTourTarget.PullRequests,
    eyebrow: "Pull requests",
    title: "Track shipping velocity",
    body: "Follow merged pull requests over time to see whether changes to your agentic workflow are helping you ship faster.",
  },
];

const SPOTLIGHT_PADDING = 8;
const DESIGN_NOTE_GAP = 12;
const DESIGN_NOTE_WIDTH = 288;

function rectsMatch(current: TargetRect | null, next: TargetRect) {
  return (
    current?.top === next.top &&
    current.left === next.left &&
    current.width === next.width &&
    current.height === next.height
  );
}

function usePrototypeAnnotationsVisible() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const syncVisibility = () => {
      setVisible(
        globalThis.document.documentElement.dataset.prototypeAnnotations !==
          "hide"
      );
    };

    syncVisibility();
    globalThis.window.addEventListener(
      "prototype-annotations-change",
      syncVisibility
    );
    return () =>
      globalThis.window.removeEventListener(
        "prototype-annotations-change",
        syncVisibility
      );
  }, []);

  return visible;
}

export function DashboardSpotlightTour({
  active,
  onClose,
}: {
  active: boolean;
  onClose: (reason: "done" | "skip") => void;
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const annotationsVisible = usePrototypeAnnotationsVisible();
  const step = tourSteps[stepIndex];

  useEffect(() => {
    if (active) {
      setStepIndex(0);
    }
  }, [active]);

  useEffect(() => {
    if (!(active && step)) {
      setTargetRect(null);
      return;
    }

    const target = globalThis.document.querySelector<HTMLElement>(
      `[data-dashboard-tour="${step.target}"]`
    );
    if (!target) {
      setTargetRect(null);
      return;
    }

    target.scrollIntoView({ behavior: "smooth", block: "center" });
    let lastRect: TargetRect | null = null;
    let animationFrame = 0;
    const measure = () => {
      const rect = target.getBoundingClientRect();
      const nextRect = {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      };
      if (!rectsMatch(lastRect, nextRect)) {
        lastRect = nextRect;
        setTargetRect(nextRect);
      }
      animationFrame = globalThis.window.requestAnimationFrame(measure);
    };
    measure();

    return () => globalThis.window.cancelAnimationFrame(animationFrame);
  }, [active, step]);

  if (!(active && step)) {
    return null;
  }

  const isFirst = stepIndex === 0;
  const isLast = stepIndex === tourSteps.length - 1;
  const spotlight = targetRect
    ? {
        top: targetRect.top - SPOTLIGHT_PADDING,
        left: targetRect.left - SPOTLIGHT_PADDING,
        width: targetRect.width + SPOTLIGHT_PADDING * 2,
        height: targetRect.height + SPOTLIGHT_PADDING * 2,
      }
    : null;
  const advance = () => {
    if (isLast) {
      onClose("done");
      return;
    }
    setStepIndex((current) => current + 1);
  };

  return (
    <>
      <div aria-hidden="true" className="fixed inset-0 z-40 bg-transparent" />

      {spotlight ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-40 rounded-xl outline-2 outline-primary"
          data-slot="dashboard-tour-spotlight"
          style={{
            top: spotlight.top,
            left: spotlight.left,
            width: spotlight.width,
            height: spotlight.height,
            boxShadow:
              "0 0 0 9999px color-mix(in oklab, var(--foreground) 55%, transparent)",
          }}
        />
      ) : (
        <div className="pointer-events-none fixed inset-0 z-40 bg-foreground/55" />
      )}

      {isFirst && annotationsVisible && spotlight ? (
        <aside
          aria-hidden="true"
          className="pointer-events-none fixed z-50 hidden w-72 md:block"
          data-prototype-annotation="tour-layout-shift"
          style={{
            top: spotlight.top,
            left: Math.max(
              DESIGN_NOTE_GAP,
              spotlight.left - DESIGN_NOTE_WIDTH - DESIGN_NOTE_GAP
            ),
          }}
        >
          <span className="absolute top-6 left-full h-px w-3 bg-violet-500" />
          <span className="block rounded-lg bg-violet-600 px-4 py-3 text-white shadow-lg shadow-violet-950/20">
            <span className="block font-semibold text-[11px] text-violet-100 uppercase tracking-[0.14em]">
              DESIGN NOTE
            </span>
            <span className="mt-1.5 block text-sm leading-5">
              Web users may enter this tour without installing Desktop only when
              their organization already has synced session data. In that case,
              Dashboard, Sessions, and Branches show teammates' data; an
              organization with no data remains blocked at Download. Also keep
              this spotlight anchored through analysis status-bar layout shifts
              and cover that alignment with VQA or an end-to-end test.
            </span>
          </span>
        </aside>
      ) : null}

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            onClose("skip");
          }
        }}
        open
      >
        <DialogContent
          className="top-auto right-6 bottom-6 left-auto w-[344px] max-w-[calc(100vw-3rem)] translate-x-0 translate-y-0 gap-0 rounded-2xl p-4 shadow-2xl sm:max-w-[344px]"
          onInteractOutside={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          showCloseButton={false}
          showOverlay={false}
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="font-semibold text-[11px] text-primary uppercase tracking-[0.1em]">
              {step.eyebrow}
            </span>
            <span className="ml-auto flex items-center gap-1">
              {tourSteps.map((tourStep, index) => (
                <span
                  className={cn(
                    "h-1.5 rounded-full transition-all",
                    index === stepIndex
                      ? "w-4 bg-primary"
                      : "w-1.5 bg-input-border"
                  )}
                  key={tourStep.id}
                />
              ))}
            </span>
          </div>
          <DialogTitle className="font-semibold text-lg tracking-tight">
            {step.title}
          </DialogTitle>
          <DialogDescription className="mt-1.5 text-pretty text-sm leading-relaxed">
            {step.body}
          </DialogDescription>
          <div className="mt-3.5 flex items-center gap-2">
            <Button onClick={() => onClose("skip")} size="sm" variant="ghost">
              Skip tour
            </Button>
            <span className="ml-auto flex gap-2">
              {isFirst ? null : (
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
              )}
              <Button onClick={advance} size="sm">
                {isLast ? "Done" : "Next"}
                {isLast ? null : <ArrowRightIcon />}
              </Button>
            </span>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
