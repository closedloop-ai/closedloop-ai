import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { ArrowRightIcon, CheckIcon, ChevronLeftIcon } from "lucide-react";
import {
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export type TourSummaryChip = {
  label: string;
  ok?: boolean;
  mono?: boolean;
  muted?: boolean;
};

export type TourSummaryRow = {
  icon: ReactNode;
  label: string;
  value?: string;
  chips?: TourSummaryChip[];
  sub?: string;
};

export type TourStep =
  | {
      intro: true;
      eyebrow: string;
      title: string;
      body: string;
      summary: TourSummaryRow[];
    }
  | {
      intro?: false;
      /** `data-tour` anchor key on the element to spotlight. */
      sel: string;
      eyebrow?: string;
      title: string;
      body: string;
    };

type Rect = { top: number; left: number; width: number; height: number };

const CALLOUT_WIDTH = 344;
const DOCK = 24;
const SPOTLIGHT_PAD = 8;

function getScrollParent(node: HTMLElement | null): HTMLElement | null {
  let current = node?.parentElement ?? null;
  while (current) {
    const { overflowY } = getComputedStyle(current);
    if (overflowY === "auto" || overflowY === "scroll") {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

/**
 * Guided walkthrough for the first-launch dashboard. After the populate reveal
 * finishes, this spotlights each section in turn with a short explanation so
 * the dashboard reads as an introduction rather than an eye chart. Rendered at
 * the app level so `position: fixed` resolves against the viewport and
 * `getBoundingClientRect` coordinates line up 1:1 with the spotlight hole.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the tour renders three tightly-coupled modes (intro summary, spotlight, skip-into-button animation) over shared chrome; splitting it would fragment the shared geometry/animation state.
export function Tour({
  active,
  steps,
  onClose,
}: {
  active: boolean;
  steps: TourStep[];
  onClose: (reason: "done" | "skip") => void;
}) {
  const [idx, setIdx] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [skip, setSkip] = useState<{ dx: number; dy: number } | null>(null);
  const calloutRef = useRef<HTMLDivElement | null>(null);
  const step = steps[idx];

  useEffect(() => {
    if (active) {
      setIdx(0);
      setSkip(null);
    }
  }, [active]);

  useEffect(() => {
    if (!(active && step) || step.intro) {
      setRect(null);
      return;
    }
    const el = document.querySelector<HTMLElement>(`[data-tour="${step.sel}"]`);
    if (!el) {
      setRect(null);
      return;
    }
    const scrollEl = getScrollParent(el);
    if (scrollEl) {
      const mr = scrollEl.getBoundingClientRect();
      const tr = el.getBoundingClientRect();
      const top = scrollEl.scrollTop + (tr.top - mr.top) - 56;
      scrollEl.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }
    const measure = () => {
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    measure();
    // Track the element while the smooth-scroll settles.
    const interval = window.setInterval(measure, 50);
    const stop = window.setTimeout(() => window.clearInterval(interval), 800);
    window.addEventListener("resize", measure);
    scrollEl?.addEventListener("scroll", measure, { passive: true });
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(stop);
      window.removeEventListener("resize", measure);
      scrollEl?.removeEventListener("scroll", measure);
    };
  }, [active, step]);

  // Move focus into the callout when the tour opens or advances a step, so
  // screen readers announce the dialog (via its `aria-label`) and keyboard
  // focus leaves the page behind the scrim instead of staying trapped there.
  useEffect(() => {
    if (active && step) {
      calloutRef.current?.focus();
    }
  }, [active, step]);

  const close = useCallback(
    (reason: "done" | "skip") => onClose(reason),
    [onClose]
  );

  const startSkip = useCallback(() => {
    if (skip) {
      return;
    }
    const btn = document.querySelector<HTMLElement>("[data-tour-btn]");
    const co = calloutRef.current;
    if (!(btn && co)) {
      close("skip");
      return;
    }
    const cr = co.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    setSkip({
      dx: br.left + br.width / 2 - (cr.left + cr.width / 2),
      dy: br.top + br.height / 2 - (cr.top + cr.height / 2),
    });
    window.setTimeout(() => close("skip"), 460);
  }, [skip, close]);

  if (!(active && step)) {
    return null;
  }
  const isIntro = step.intro === true;
  // A non-intro step whose anchor isn't on screen (not yet revealed, or the
  // view is hidden) falls back to a full-dim scrim + docked callout instead of
  // unmounting the whole tour — the user can still read it and advance.

  const last = idx === steps.length - 1;
  const first = idx === 0;
  const next = () => (last ? close("done") : setIdx((i) => i + 1));
  const back = () => setIdx((i) => Math.max(0, i - 1));

  const hole = rect
    ? {
        top: rect.top - SPOTLIGHT_PAD,
        left: rect.left - SPOTLIGHT_PAD,
        width: rect.width + SPOTLIGHT_PAD * 2,
        height: rect.height + SPOTLIGHT_PAD * 2,
      }
    : null;

  const cardChrome: CSSProperties = {
    background: "var(--background)",
    border: "1px solid var(--border)",
    borderRadius: 14,
    boxShadow: "0 24px 60px -16px rgba(0,0,0,0.5)",
    transformOrigin: "center center",
    transform: skip
      ? `translate(${skip.dx}px, ${skip.dy}px) scale(0.06)`
      : "none",
    opacity: skip ? 0 : 1,
    animation: skip ? "none" : "ob-rise .28s cubic-bezier(.2,.7,.3,1)",
    transition: skip
      ? "transform .44s cubic-bezier(.4,0,.2,1), opacity .44s ease"
      : "none",
    pointerEvents: skip ? "none" : "auto",
  };

  // Expose each callout as a modal dialog to assistive tech and let Escape
  // dismiss the tour. Focus is moved into the container (see the effect above),
  // so an `onKeyDown` here catches Escape from anywhere inside the callout.
  const dialogProps: HTMLAttributes<HTMLDivElement> = {
    role: "dialog",
    "aria-modal": true,
    "aria-label": step.title,
    tabIndex: -1,
    onKeyDown: (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        startSkip();
      }
    },
  };

  const dots = (
    <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
      {steps.map((_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: progress dots are positional
          key={i}
          style={{
            width: i === idx ? 16 : 6,
            height: 6,
            borderRadius: 999,
            background: i === idx ? "var(--primary)" : "var(--input-border)",
            transition: "width .2s, background .2s",
          }}
        />
      ))}
    </span>
  );

  return (
    // Layout-neutral single root over the fixed overlays (blocker, scrim,
    // callout) — avoids a bare fragment without adding a box/containing block.
    <div style={{ display: "contents" }}>
      {/* click blocker — clicking the dimmed area skips the tour */}
      <button
        aria-label="Skip tour"
        onClick={startSkip}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          border: "none",
          background: "transparent",
          cursor: "default",
        }}
        type="button"
      />

      {isIntro || !hole ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 61,
            pointerEvents: "none",
            background:
              "color-mix(in oklab, var(--foreground) 52%, transparent)",
            opacity: skip ? 0 : 1,
            transition: "opacity .35s ease",
          }}
        />
      ) : (
        <div
          style={{
            position: "fixed",
            top: hole.top,
            left: hole.left,
            width: hole.width,
            height: hole.height,
            borderRadius: 14,
            zIndex: 61,
            pointerEvents: "none",
            opacity: skip ? 0 : 1,
            boxShadow:
              "0 0 0 9999px color-mix(in oklab, var(--foreground) 52%, transparent)",
            outline: "2px solid var(--primary)",
            transition:
              "top .32s cubic-bezier(.3,.7,.3,1), left .32s cubic-bezier(.3,.7,.3,1), width .32s, height .32s, opacity .35s ease",
          }}
        />
      )}

      {isIntro && step.intro ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 62,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            pointerEvents: "none",
          }}
        >
          <div
            ref={calloutRef}
            {...dialogProps}
            style={{
              ...cardChrome,
              outline: "none",
              width: 472,
              maxWidth: "100%",
              padding: "22px 24px 18px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                marginBottom: 12,
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 26,
                  height: 26,
                  borderRadius: 8,
                  background:
                    "color-mix(in oklab, var(--success) 18%, var(--card))",
                  border:
                    "1px solid color-mix(in oklab, var(--success) 38%, transparent)",
                  color: "var(--success-foreground)",
                }}
              >
                <CheckIcon size={15} strokeWidth={2.6} />
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  color: "var(--success-foreground)",
                }}
              >
                {step.eyebrow}
              </span>
              {dots}
            </div>
            <div
              style={{
                fontSize: 19,
                fontWeight: 600,
                letterSpacing: "-0.02em",
                lineHeight: 1.18,
              }}
            >
              {step.title}
            </div>
            <p
              style={{
                margin: "8px 0 0",
                fontSize: 13,
                lineHeight: 1.55,
                color: "var(--muted-foreground)",
                textWrap: "pretty",
              }}
            >
              {step.body}
            </p>

            <div
              style={{
                marginTop: 16,
                border: "1px solid var(--border)",
                borderRadius: 12,
                overflow: "hidden",
                background: "var(--card)",
              }}
            >
              {step.summary.map((row, i) => (
                <div
                  key={row.label}
                  style={{
                    display: "flex",
                    gap: 12,
                    padding: "12px 14px",
                    borderTop: i ? "1px solid var(--border)" : "none",
                  }}
                >
                  <span
                    style={{
                      flexShrink: 0,
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background:
                        "color-mix(in oklab, var(--primary) 10%, var(--card))",
                      border:
                        "1px solid color-mix(in oklab, var(--primary) 22%, transparent)",
                      color: "var(--primary)",
                    }}
                  >
                    {row.icon}
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 8,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          letterSpacing: "-0.01em",
                        }}
                      >
                        {row.label}
                      </span>
                      {row.value ? (
                        <span
                          style={{
                            marginLeft: "auto",
                            fontSize: 15,
                            fontWeight: 600,
                            fontFamily: "var(--font-mono)",
                            letterSpacing: "-0.01em",
                          }}
                        >
                          {row.value}
                        </span>
                      ) : null}
                    </div>
                    {row.chips ? (
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: 6,
                          marginTop: 7,
                        }}
                      >
                        {row.chips.map((c) => (
                          <SummaryChip chip={c} key={c.label} />
                        ))}
                      </div>
                    ) : null}
                    {row.sub ? (
                      <p
                        style={{
                          margin: "7px 0 0",
                          fontSize: 11,
                          lineHeight: 1.45,
                          color: "var(--muted-foreground)",
                          textWrap: "pretty",
                        }}
                      >
                        {row.sub}
                      </p>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 16,
              }}
            >
              <button
                onClick={startSkip}
                style={{
                  border: "none",
                  background: "none",
                  padding: "4px 2px",
                  cursor: "pointer",
                  color: "var(--muted-foreground)",
                  font: "inherit",
                  fontSize: 12.5,
                }}
                type="button"
              >
                Skip tour
              </button>
              <span style={{ marginLeft: "auto" }}>
                <Button onClick={next} size="sm" type="button">
                  Take a quick tour
                  <ArrowRightIcon className="size-3.5" />
                </Button>
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div
          ref={calloutRef}
          {...dialogProps}
          style={{
            ...cardChrome,
            outline: "none",
            position: "fixed",
            right: DOCK,
            bottom: DOCK,
            width: CALLOUT_WIDTH,
            zIndex: 62,
            padding: "16px 18px 14px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: "var(--primary)",
              }}
            >
              {(!step.intro && step.eyebrow) || `Step ${idx + 1}`}
            </span>
            {dots}
          </div>
          <div
            style={{
              fontSize: 15.5,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              lineHeight: 1.2,
            }}
          >
            {step.title}
          </div>
          <p
            style={{
              margin: "6px 0 0",
              fontSize: 12.5,
              lineHeight: 1.5,
              color: "var(--muted-foreground)",
              textWrap: "pretty",
            }}
          >
            {step.body}
          </p>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 14,
            }}
          >
            <button
              onClick={startSkip}
              style={{
                border: "none",
                background: "none",
                padding: "4px 2px",
                cursor: "pointer",
                color: "var(--muted-foreground)",
                font: "inherit",
                fontSize: 12.5,
              }}
              type="button"
            >
              Skip tour
            </button>
            <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              {first ? null : (
                <Button
                  onClick={back}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <ChevronLeftIcon className="size-3.5" />
                  Back
                </Button>
              )}
              <Button onClick={next} size="sm" type="button">
                {last ? "Done" : "Next"}
                {last ? null : <ArrowRightIcon className="size-3.5" />}
              </Button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryChip({ chip }: { chip: TourSummaryChip }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: 22,
        padding: "0 9px",
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 500,
        whiteSpace: "nowrap",
        fontFamily: chip.mono ? "var(--font-mono)" : "inherit",
        background: chip.muted ? "transparent" : "var(--accent)",
        border: "1px solid var(--border)",
        color: chip.muted ? "var(--muted-foreground)" : "var(--foreground)",
      }}
    >
      {chip.ok ? (
        <CheckIcon
          size={12}
          strokeWidth={2.6}
          style={{ color: "var(--success-foreground)" }}
        />
      ) : null}
      {chip.label}
    </span>
  );
}
