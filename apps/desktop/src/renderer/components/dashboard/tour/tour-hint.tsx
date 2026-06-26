import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { useEffect, useState } from "react";

type Rect = { top: number; left: number; width: number; height: number };

const POPOVER_WIDTH = 280;
const AUTO_DISMISS_MS = 9000;

/**
 * Shown after the user skips the tour: a small popover anchored to the
 * dashboard's "Tour" button telling them the walkthrough lives there for next
 * time. Auto-dismisses after a few seconds.
 */
export function TourHint({
  show,
  onClose,
}: {
  show: boolean;
  onClose: () => void;
}) {
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    if (!show) {
      setRect(null);
      return;
    }
    const measure = () => {
      const btn = document.querySelector<HTMLElement>("[data-tour-btn]");
      if (btn) {
        const r = btn.getBoundingClientRect();
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      }
    };
    measure();
    const interval = window.setInterval(measure, 250);
    window.addEventListener("resize", measure);
    const dismiss = window.setTimeout(onClose, AUTO_DISMISS_MS);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(dismiss);
      window.removeEventListener("resize", measure);
    };
  }, [show, onClose]);

  if (!(show && rect)) {
    return null;
  }

  const top = rect.top + rect.height + 12;
  const left = Math.min(
    Math.max(12, rect.left + rect.width / 2 - POPOVER_WIDTH / 2),
    window.innerWidth - POPOVER_WIDTH - 12
  );
  const caretLeft = rect.left + rect.width / 2 - left;

  return (
    // Two independent fixed overlays (the pulsing ring + the popover). A
    // `display: contents` wrapper keeps them as one root without adding a box —
    // and crucially without a containing block, so the fixed ring still
    // resolves against the viewport (the popover's transform animation would
    // otherwise capture it if nested).
    <div style={{ display: "contents" }}>
      <div
        style={{
          position: "fixed",
          top: rect.top - 4,
          left: rect.left - 4,
          width: rect.width + 8,
          height: rect.height + 8,
          borderRadius: 9,
          border: "2px solid var(--primary)",
          zIndex: 61,
          pointerEvents: "none",
          animation: "ob-pulse 1.5s ease-in-out infinite",
        }}
      />
      <div
        style={{
          position: "fixed",
          top,
          left,
          width: POPOVER_WIDTH,
          zIndex: 62,
          background: "var(--background)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          boxShadow: "0 20px 50px -16px rgba(0,0,0,0.45)",
          padding: "14px 16px 12px",
          animation: "ob-rise .26s cubic-bezier(.2,.7,.3,1)",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: -6,
            left: Math.max(12, Math.min(POPOVER_WIDTH - 18, caretLeft - 5)),
            width: 11,
            height: 11,
            background: "var(--background)",
            borderLeft: "1px solid var(--border)",
            borderTop: "1px solid var(--border)",
            transform: "rotate(45deg)",
          }}
        />
        <div
          style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: "-0.01em" }}
        >
          Want a refresher later?
        </div>
        <p
          style={{
            margin: "5px 0 0",
            fontSize: 12.5,
            lineHeight: 1.5,
            color: "var(--muted-foreground)",
            textWrap: "pretty",
          }}
        >
          The full walkthrough lives in the{" "}
          <strong style={{ color: "var(--foreground)", fontWeight: 600 }}>
            Tour
          </strong>{" "}
          button up here — reopen it anytime to revisit any of these
          explanations.
        </p>
        <div
          style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}
        >
          <Button onClick={onClose} size="sm" type="button">
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}
