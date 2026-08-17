"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Card, CardContent } from "@repo/design-system/components/ui/card";
import { UserPlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { INVITE_ANCHOR } from "./onboarding-checklist";

type SpotlightRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

type InviteSpotlightProps = {
  active: boolean;
  onDismiss: () => void;
  onInvite: () => void;
};

// The post-landing nudge. It highlights the "Invite team members" checklist row
// and floats a card beside it. Deliberately NON-modal: the dim + outline are
// pointer-events-none so the rest of the app stays clickable, there is no
// invisible full-screen dismiss button to trap keyboard focus, and Escape
// dismisses it. The card is a real catalog Card so its radius matches the app.
export const InviteSpotlight = ({
  active,
  onDismiss,
  onInvite,
}: InviteSpotlightProps) => {
  const [rect, setRect] = useState<SpotlightRect | null>(null);

  useEffect(() => {
    if (!active) {
      setRect(null);
      return;
    }
    const element = globalThis.document.querySelector(
      `[data-tour="${INVITE_ANCHOR}"]`
    );
    if (!element) {
      setRect(null);
      return;
    }
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
      frame = globalThis.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onDismiss();
      }
    };
    globalThis.addEventListener("scroll", scheduleMeasure, true);
    globalThis.addEventListener("resize", scheduleMeasure);
    globalThis.addEventListener("keydown", onKeyDown);
    return () => {
      if (frame !== 0) {
        globalThis.cancelAnimationFrame(frame);
      }
      globalThis.removeEventListener("scroll", scheduleMeasure, true);
      globalThis.removeEventListener("resize", scheduleMeasure);
      globalThis.removeEventListener("keydown", onKeyDown);
    };
  }, [active, onDismiss]);

  if (!(active && rect)) {
    return null;
  }

  const spotlight = {
    top: rect.top - SPOTLIGHT_PADDING,
    left: rect.left - SPOTLIGHT_PADDING,
    width: rect.width + SPOTLIGHT_PADDING * 2,
    height: rect.height + SPOTLIGHT_PADDING * 2,
  };

  return (
    <>
      {/* Dim + outline, purely visual — pointer-events-none so it never
          swallows a click or blocks the keyboard. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed z-40 rounded-md outline-2 outline-primary"
        style={{
          boxShadow:
            "0 0 0 9999px color-mix(in oklab, var(--foreground) 55%, transparent)",
          top: spotlight.top,
          left: spotlight.left,
          width: spotlight.width,
          height: spotlight.height,
        }}
      />
      <Card
        aria-label="Invite your team"
        className="pointer-events-auto fixed z-50 w-full max-w-xs shadow-lg"
        role="region"
        style={{
          top: spotlight.top + spotlight.height + CARD_GAP,
          left: spotlight.left,
        }}
      >
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <UserPlusIcon className="size-4 text-primary" />
            <span className="font-semibold text-primary text-xs uppercase tracking-wide">
              Invite your team
            </span>
          </div>
          <p className="text-pretty text-muted-foreground text-sm leading-relaxed">
            Bring your teammates in so you can compare AI spend and output
            across the org.
          </p>
          <div className="flex items-center gap-2">
            <Button onClick={onDismiss} size="sm" variant="ghost">
              Maybe later
            </Button>
            <Button className="ml-auto" onClick={onInvite} size="sm">
              <UserPlusIcon className="size-4" />
              Invite
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
};

const SPOTLIGHT_PADDING = 8;
const CARD_GAP = 12;
