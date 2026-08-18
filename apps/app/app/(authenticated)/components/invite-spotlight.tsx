"use client";

import { ChecklistItemId } from "@repo/api/src/types/onboarding";
import { Button } from "@repo/design-system/components/ui/button";
import { Card, CardContent } from "@repo/design-system/components/ui/card";
import { UserPlus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CHECKLIST_LIST_SELECTOR,
  checklistItemSelector,
} from "./use-onboarding-checklist";

/**
 * The checklist row this anchors to — built from the shared selector helper, so
 * the attribute the checklist stamps and the attribute this queries are one
 * declaration rather than two strings that compile independently.
 */
export const INVITE_SPOTLIGHT_ANCHOR_SELECTOR = checklistItemSelector(
  ChecklistItemId.InviteMembers
);

const SPOTLIGHT_PADDING = 8;
const CARD_GAP = 12;
/** Keeps the card off the very edge when it has to be clamped. */
const VIEWPORT_MARGIN = 12;
/** Matches `max-w-xs` on the card. */
const CARD_WIDTH = 320;

type SpotlightRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

type InviteSpotlightProps = {
  readonly active: boolean;
  readonly onDismiss: () => void;
  readonly onInvite: () => void;
};

/**
 * ISS-5490 FR-7: the post-onboarding nudge toward inviting teammates. Highlights
 * the "Invite team members" checklist row and floats a card beside it.
 *
 * Deliberately NON-modal. The dim and outline are `pointer-events-none`, so the
 * rest of the page stays clickable and the keyboard is never trapped; Escape
 * dismisses. A first-run nudge that held the app hostage would be a worse
 * version of the blocking step this whole change removed.
 *
 * It measures a live DOM node, so it has to survive that node going away: the
 * checklist unmounts when every item completes, when it is dismissed, and while
 * its status query is loading. In each case the anchor lookup misses and the
 * spotlight renders nothing rather than pinning a card to stale coordinates.
 */
export function InviteSpotlight({
  active,
  onDismiss,
  onInvite,
}: InviteSpotlightProps) {
  const [rect, setRect] = useState<SpotlightRect | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [cardHeight, setCardHeight] = useState(0);

  // Measured, not assumed: the card's height depends on how its copy wraps, and
  // the placement below cannot decide whether the card fits under the anchor
  // without it. Layout effect so the corrected position paints in the same frame
  // instead of as a visible jump.
  useLayoutEffect(() => {
    const element = cardRef.current;
    if (element) {
      setCardHeight(element.getBoundingClientRect().height);
    }
  });

  useEffect(() => {
    if (!active) {
      setRect(null);
      return;
    }

    const element = document.querySelector(INVITE_SPOTLIGHT_ANCHOR_SELECTOR);
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

    // Scroll fires per frame; coalesce so a fling does not re-render the card on
    // every event.
    let frame = 0;
    const scheduleMeasure = () => {
      if (frame !== 0) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onDismiss();
      }
    };

    // Capture phase: the checklist scrolls inside the page's own overflow
    // container, not the window, so a bubbling listener would never see it.
    window.addEventListener("scroll", scheduleMeasure, true);
    window.addEventListener("resize", scheduleMeasure);
    window.addEventListener("keydown", onKeyDown);

    // The anchor also moves without either event firing: the checklist inserts
    // the Google row above this one when its flag resolves, which shifts the
    // invite row down while the page neither scrolls nor resizes, leaving the
    // hole cut over the wrong row.
    //
    // Watch the LIST, not the row's parent. Inserting a sibling changes the
    // list's height and nothing else's — the row keeps its box, and so does the
    // `Link` wrapping it, so an observer on either would never fire. The row is
    // observed too, for the copy-wraps-differently case where it alone resizes.
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleMeasure);
    observer?.observe(element);
    const list = document.querySelector(CHECKLIST_LIST_SELECTOR);
    if (list) {
      observer?.observe(list);
    }

    return () => {
      if (frame !== 0) {
        cancelAnimationFrame(frame);
      }
      observer?.disconnect();
      window.removeEventListener("scroll", scheduleMeasure, true);
      window.removeEventListener("resize", scheduleMeasure);
      window.removeEventListener("keydown", onKeyDown);
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
      <div
        aria-hidden="true"
        className="pointer-events-none fixed z-40 rounded-md outline-2 outline-primary"
        style={{
          // A flat black scrim, matching the catalog Dialog overlay. The
          // prototype dimmed with `var(--foreground)`, which is near-BLACK in
          // light mode and near-WHITE in dark — so on a dark OS (the theme
          // provider defaults to system) this washed the whole app white
          // instead of dimming it.
          boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.5)",
          top: spotlight.top,
          left: spotlight.left,
          width: spotlight.width,
          height: spotlight.height,
        }}
      />
      <Card
        aria-label="Invite your team"
        className="pointer-events-auto fixed z-50 w-full max-w-xs shadow-lg"
        ref={cardRef}
        role="region"
        style={resolveCardPosition(spotlight, cardHeight)}
      >
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <UserPlus className="size-4 text-primary" />
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
              <UserPlus className="size-4" />
              Invite
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

/**
 * Place the card against the anchor without letting it leave the viewport.
 *
 * The card is `fixed`, so anything off-screen is unreachable — a user cannot
 * scroll to it and can only dismiss a thing they were never able to read. That
 * is not hypothetical here: the invite row is the last of six (seven with Drive
 * on) and sits above the agent-onboarding card, so it lands much further down
 * the page than the five-row prototype this was ported from.
 *
 * Below the anchor when it fits, above when it does not, clamped to the viewport
 * when neither does.
 */
function resolveCardPosition(
  spotlight: SpotlightRect,
  cardHeight: number
): { top: number; left: number } {
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;

  const below = spotlight.top + spotlight.height + CARD_GAP;
  const above = spotlight.top - CARD_GAP - cardHeight;

  let top = below;
  if (below + cardHeight > viewportHeight - VIEWPORT_MARGIN) {
    top = above >= VIEWPORT_MARGIN ? above : below;
  }
  const maxTop = Math.max(
    VIEWPORT_MARGIN,
    viewportHeight - cardHeight - VIEWPORT_MARGIN
  );
  top = Math.min(Math.max(top, VIEWPORT_MARGIN), maxTop);

  const maxLeft = Math.max(
    VIEWPORT_MARGIN,
    viewportWidth - CARD_WIDTH - VIEWPORT_MARGIN
  );
  const left = Math.min(Math.max(spotlight.left, VIEWPORT_MARGIN), maxLeft);

  return { top, left };
}
