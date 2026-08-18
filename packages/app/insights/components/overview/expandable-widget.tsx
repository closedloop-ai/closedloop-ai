"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { dispatchGraphReset } from "@repo/design-system/components/ui/primitives/graph-events";
import { cn } from "@repo/design-system/lib/utils";
import { Maximize2Icon } from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";

// The single host node reshapes to fit whichever slot owns it, and its class is
// swapped imperatively as it moves between them:
// - In the CARD it is a plain block (`min-w-0`) so the card hugs its content in
//   normal block flow — byte-for-byte the pre-FEA-3700 inline `{children}`
//   layout, introducing NO flex container.
// - In the DIALOG (a flex column with a real fixed height) it becomes a
//   `flex-1 min-h-0 flex-col` item, so it grows to fill and container-sized
//   charts (FEA-3622) read the enlarged space.
//
// This must be swapped, not held constant: a persistent `flex flex-col` is NOT
// inert in the card (only `flex-1`/`min-h-0` are without a flex parent) — it
// would make the host itself a flex CONTAINER, turning every wrapped card from a
// block-flow child into a flex item, which can perturb `h-full` height
// propagation or grid-stretch alignment and quietly reshape the overview grid.
const HOST_CARD_CLASS = "min-w-0";
const HOST_DIALOG_CLASS = "flex min-h-0 min-w-0 flex-1 flex-col";

// Radix Tooltip dispatches this document-level event whenever ANY tooltip opens,
// and every currently-open tooltip's content listens for it and closes itself
// (its cross-tooltip "only one open at a time" mechanism). We reuse that same
// signal to dismiss any hover/focus tooltip that was open when a widget is
// expanded or collapsed, so it does not freeze open across the transition — the
// relocated trigger never receives a pointerleave/blur when its DOM node is
// moved between the card and the dialog (FEA-3944).
//
// This is Radix's INTERNAL `TOOLTIP_OPEN` constant (`@radix-ui/react-tooltip`,
// pinned at 1.2.8 — see pnpm-lock.yaml). It is not a public API, so a Radix
// major bump could rename or drop it. If that happens the frozen-tooltip
// dismissal silently no-ops — verify this string still matches Radix's
// `TOOLTIP_OPEN` when upgrading. The blast radius is bounded: this only dismisses
// Radix hover/focus tooltips; the bespoke `Graph` tooltip (the harder-to-clear
// case) is reset via its own `GRAPH_RESET_EVENT` below, independent of Radix.
const RADIX_TOOLTIP_OPEN_EVENT = "tooltip.open";

// Close any currently-open Radix tooltip by replaying its own cross-tooltip
// dismiss signal. Fires for both hover- and focus-opened tooltips (the content
// closes on this event regardless of how it opened) and does not disturb focus,
// so it is safe to run on both expand and collapse. Guarded for SSR (no
// `document`).
function dismissOpenTooltips(): void {
  if (globalThis.document === undefined) {
    return;
  }
  globalThis.document.dispatchEvent(new CustomEvent(RADIX_TOOLTIP_OPEN_EVENT));
}

/**
 * FEA-3632 — the shared "expand to full screen" affordance for overview
 * dashboard widgets. Wraps a widget's content and overlays a small icon-button
 * in the top-right corner; activating it opens the SAME content in a
 * large-format modal overlay so dense charts / graphs / long lists are legible.
 *
 * FEA-3700 — the widget renders as a SINGLE logical instance across the
 * collapsed card and the expanded modal. Rather than mounting `children` in the
 * card body AND again in the dialog body (two component identities that
 * duplicate data fetches, subscriptions, timers, analytics and element IDs, and
 * reset local control state on expand), `children` is rendered exactly once into
 * a stable host element via a React portal, and that host DOM node is *moved*
 * between the in-card slot and the dialog slot when expanding / collapsing. The
 * host node's identity never changes, so React never unmounts or remounts the
 * child subtree — selected filters/tabs/timeframes, scroll position, in-flight
 * requests, and live subscriptions all carry over continuously.
 *
 * Design decisions:
 * - Built entirely on design-system primitives — the `Button` (ghost `icon-sm`)
 *   for the trigger and the `Dialog` primitive for the modal (backdrop,
 *   focus-trap, scroll-lock, and Esc / backdrop-click / close-button dismissal
 *   all come from the primitive; no bespoke modal).
 * - The charts/graphs already size to their container via ResizeObserver
 *   (FEA-3622), so relocating the single host into the larger dialog container
 *   re-fits them for free.
 * - The trigger is absolutely positioned and reveals on hover/focus, so adding
 *   it causes no layout shift to the dashboard grid. It stays keyboard-focusable
 *   (focus-within reveals it) and carries an aria-label derived from `title`.
 *
 * Domain-adjacent (dashboard feature slice), composing generic design-system
 * primitives — per the UI placement rule it belongs here, not in
 * `@repo/design-system`.
 */
export function ExpandableWidget({
  title,
  children,
  className,
  contentClassName,
  titleInContent = false,
}: {
  /**
   * Human-readable widget name, used for the trigger's aria-label ("Expand
   * <title>") and the modal heading. When a widget has no visible title the
   * caller can pass a descriptive label (e.g. "Recent activity").
   */
  title: string;
  /**
   * The widget content, rendered EXACTLY ONCE into the relocatable host. Either
   * a plain node — in which case the default corner expand button supplies the
   * affordance — or a render function that receives
   * `{ expand, collapse, isExpanded }` so a widget that already owns a control
   * cluster (e.g. the Insights chart tiles' pin/edit/resize toolbar) can place
   * its own expand control alongside the existing controls instead of overlapping
   * the floating corner button. Because the render-function output lives INSIDE
   * the single portaled subtree, that caller-owned expand button relocates with
   * the widget and never causes a second mount. `isExpanded` lets the caller
   * hide grid-only affordances (drag/resize) and its expand control while the
   * modal is already open; `collapse` lets it close the modal when an action
   * makes the expanded view stale (e.g. removing the tile from the dashboard),
   * so the modal never lingers over a widget that no longer exists behind it.
   */
  children:
    | ReactNode
    | ((props: {
        expand: () => void;
        collapse: () => void;
        isExpanded: boolean;
      }) => ReactNode);
  className?: string;
  /**
   * Sizing/layout intent that must reach the wrapped content itself — i.e. the
   * in-card slot and the relocatable host that owns the single live instance —
   * rather than only the outer `.group` wrapper. A card tile that fills its grid
   * cell (`h-full` down to a `flex h-full flex-col` Card) needs a DEFINITE height
   * at every link in the chain wrapper → card-slot → host → Card; without this
   * the host and slot are plain `min-w-0` blocks with no height, the Card's
   * `h-full` resolves against `auto`, and the tile collapses to its content
   * height instead of stretching to the cell. Pass e.g. `contentClassName="h-full"`
   * so the height propagates all the way down. It is applied to the CARD slot;
   * the DIALOG slot always owns a real fixed height (see `HOST_DIALOG_CLASS`), so
   * this class is intentionally not re-applied there.
   */
  contentClassName?: string;
  /**
   * Set when the wrapped content already renders its own visible title (e.g. a
   * DashboardCard with a header). The modal heading is then kept sr-only to
   * avoid a duplicated title while still giving the dialog an accessible name.
   * Defaults to false, so title-less widgets get a visible modal heading.
   */
  titleInContent?: boolean;
}) {
  const [open, setOpen] = useState(false);

  // Toggle expanded state AND clear any tooltip/highlight that was open on the
  // widget's trigger/content, so it does not freeze across the transition — the
  // relocated trigger's DOM node is MOVED between card and dialog and never fires
  // a pointerleave/blur (FEA-3944). Two independent dismissals are needed:
  // `dismissOpenTooltips` closes Radix hover/focus tooltips; `dispatchGraphReset`
  // resets the bespoke fixed-position tooltip + hover highlight owned by the
  // `Graph` primitive (Agent Collaboration Network), which Radix's signal does
  // NOT reach. The Graph case also covers the pure-keyboard path (hover a node,
  // Tab to the expand control, press Enter) where the pointer never leaves the
  // SVG, so no `mouseleave` fires. All open/close paths (corner button,
  // render-children expand/collapse, Esc, backdrop, close button) route through
  // here via the Dialog's `onOpenChange`.
  const handleOpenChange = useCallback((next: boolean) => {
    dismissOpenTooltips();
    dispatchGraphReset();
    setOpen(next);
  }, []);

  // The card-slot host class, with the caller's card-side sizing intent merged
  // in so a definite height (e.g. `h-full`) reaches the host that owns the live
  // instance — not just the outer wrapper. Held in a ref so the imperative class
  // swaps in the callback refs below always read the current value without
  // re-subscribing. The DIALOG class is intentionally NOT extended: the dialog
  // slot already supplies its own real fixed height.
  const hostCardClass = cn(HOST_CARD_CLASS, contentClassName);
  const hostCardClassRef = useRef(hostCardClass);
  hostCardClassRef.current = hostCardClass;

  // One stable host element that owns the single live widget instance. It is
  // created SYNCHRONOUSLY on the client via a lazy `useState` initializer, so
  // the host exists from the very FIRST client render: `children` portal
  // straight into it from client render #1. There is no inline-then-portal
  // phase and no null→non-null host transition on the client, so React mounts
  // the `children` subtree EXACTLY ONCE — at initial load — and never remounts
  // it when the host is relocated between the card and the dialog on
  // expand/collapse. That is the FEA-3700 "never unmounts" guarantee, upheld
  // even on the first client paint.
  //
  // `document` is guarded because this component (though `"use client"`) is
  // still server-rendered by Next.js for the initial HTML, where `document`
  // does not exist. On the server the host is null and `createPortal` renders
  // nothing (React skips portals during SSR regardless), so the card slot is
  // empty in the server HTML; the host is then created synchronously on the
  // first client render and the children portal in — no hydration mismatch,
  // since the card slot is an empty `<div>` in both the server HTML and the
  // initial client tree (the children live only in the portal).
  //
  // No cleanup is needed: React detaches the portal's children when this
  // component unmounts, and the now-orphaned host `div` is garbage-collected.
  //
  // The host starts life in the CARD slot, so it is created with the plain-block
  // card class; `HOST_DIALOG_CLASS` is applied only while it lives in the dialog
  // (see the ref callbacks). Keeping the card class a plain block — not a flex
  // container — is what makes the collapsed layout a true no-op vs. pre-FEA-3700
  // (see the constants above).
  const [host] = useState<HTMLDivElement | null>(() => {
    if (globalThis.document === undefined) {
      return null;
    }
    const node = globalThis.document.createElement("div");
    node.className = hostCardClassRef.current;
    return node;
  });

  // The card slot is always mounted; the dialog slot mounts/unmounts with the
  // (Radix-portaled, possibly deferred) dialog. Callback refs let us relocate
  // the single host the instant a slot node attaches, so we don't depend on
  // Radix's mount timing. `appendChild` on an already-attached node MOVES it
  // (it is not cloned), so the widget instance survives the relocation intact.
  const cardSlotRef = useRef<HTMLDivElement | null>(null);

  const dialogSlotRef = useCallback(
    (node: HTMLDivElement | null) => {
      // `host` is only null during SSR, where callback refs never run; on the
      // client it is created synchronously in the first render, so it is always
      // present here.
      if (!host) {
        return;
      }
      if (node) {
        // Entering the dialog: become a flex column so the host fills the
        // fixed-height dialog and container-sized charts read the enlarged space.
        host.className = HOST_DIALOG_CLASS;
        node.appendChild(host);
      } else if (cardSlotRef.current) {
        // Dialog slot unmounted (collapse): revert to the plain-block card class
        // (with the caller's card-side sizing intent merged back in) and return
        // the host to the card so it hugs its content again.
        host.className = hostCardClassRef.current;
        cardSlotRef.current.appendChild(host);
      }
    },
    [host]
  );

  const setCardSlot = useCallback(
    (node: HTMLDivElement | null) => {
      cardSlotRef.current = node;
      // Adopt the host into the card on first mount (and when it isn't currently
      // living in the dialog). Ensure the plain-block card class is applied so a
      // remount of the card slot never leaves the host carrying the dialog's
      // flex-container class.
      if (host && node && host.parentNode === null) {
        host.className = hostCardClassRef.current;
        node.appendChild(host);
      }
    },
    [host]
  );

  // When `children` is a render function the caller supplies its OWN expand
  // control (inside the single portaled subtree, so it relocates with the widget
  // and never double-mounts); the default floating corner button is then
  // suppressed to avoid two overlapping affordances.
  const callerOwnsTrigger = typeof children === "function";
  const resolvedChildren = callerOwnsTrigger
    ? (
        children as (props: {
          expand: () => void;
          collapse: () => void;
          isExpanded: boolean;
        }) => ReactNode
      )({
        expand: () => handleOpenChange(true),
        collapse: () => handleOpenChange(false),
        isExpanded: open,
      })
    : children;

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      {/* `group` scopes the hover/focus reveal to this widget only. A plain
          block wrapper (as before FEA-3700): the card hugs its content and the
          overview grid is unchanged. */}
      <div className={cn("group relative min-w-0", className)}>
        {/* In-card mount point. The host (with the single live widget instance)
            is adopted here on mount and `children` render into it via the portal
            below — from the very first render, so there is no inline phase and
            no remount. Both this slot and the adopted host stay plain blocks
            (no flex container), so the card hugs its content exactly matching the
            pre-FEA-3700 inline `{children}` layout. */}
        <div className={cn("min-w-0", contentClassName)} ref={setCardSlot} />
        {callerOwnsTrigger ? null : (
          <WidgetExpandButton
            label={title}
            onClick={() => handleOpenChange(true)}
          />
        )}
      </div>
      {open ? (
        <DialogContent
          aria-describedby={undefined}
          className="flex h-[calc(100vh-4rem)] max-h-[calc(100vh-4rem)] w-[calc(100vw-4rem)] max-w-[calc(100vw-4rem)] flex-col gap-4 sm:max-w-[calc(100vw-4rem)]"
        >
          {/* When the content renders its own visible title, keep this heading
              sr-only so the title isn't doubled — it stays in the a11y tree to
              give the dialog an accessible name for the focus-trap (mirrors
              command.tsx). Title-less widgets get a visible heading instead. */}
          <DialogHeader className={titleInContent ? "sr-only" : undefined}>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          {/* Expanded mount point. The same host node (and its live widget
              instance) is relocated here; `min-h-0` lets the flex child shrink
              so ResizeObserver-driven charts read the real available space.
              `group` mirrors the in-card wrapper so relocated content whose own
              controls reveal on `group-hover` / `group-focus-within` (e.g. the
              Insights chart tiles' pin/edit/info cluster) stay reachable inside
              the modal too — without it the modal has no `.group` ancestor and
              those hover-revealed controls would be stuck hidden while expanded.
              When the header is sr-only the content's own top row rides to the
              top-right corner, where the Dialog's `top-4 right-4` close button
              sits; reserve the button's gutter on that path so a content-owned
              action cluster (e.g. Event Activity's filter toggle) can't graze it
              (FEA-4016). */}
          <div
            className={cn(
              "group flex min-h-0 min-w-0 flex-1 flex-col overflow-auto",
              titleInContent && "pr-8"
            )}
            ref={dialogSlotRef}
          />
        </DialogContent>
      ) : null}
      {/* Render `children` exactly once into the stable host, from the first
          CLIENT render onward (the host is created synchronously there). The
          host node is adopted by whichever slot is active (card or dialog) via
          the callback refs, so there is a single live widget instance
          throughout — mounted once at initial load and never remounted across
          expand/collapse. During SSR `host` is null and this portal renders
          nothing (React skips portals server-side regardless). */}
      {host ? createPortal(resolvedChildren, host) : null}
    </Dialog>
  );
}

/**
 * The floating corner "expand to full screen" affordance for a dashboard widget.
 * The single source of truth for this control: `ExpandableWidget` renders it in
 * its default (plain-children) path, and `DashboardCard`'s fill-mode branch —
 * which owns the render-children API and so suppresses the default — renders the
 * same button itself. Extracting it here keeps the aria-label, reveal-on-hover
 * className, size, and icon defined once so the two placements can't drift (the
 * reveal string already changed once for `pointer-coarse`).
 *
 * Hover/focus-reveal on fine pointers (mouse/trackpad) keeps the dashboard grid
 * uncluttered; coarse pointers (touch) have no hover event, so `pointer-coarse`
 * pins it visible there or the expand feature would be undiscoverable
 * (FEA-3700 design-critic follow-up). The parent must be the `.group` wrapper the
 * reveal classes key off.
 */
export function WidgetExpandButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      aria-label={`Expand ${label}`}
      className="absolute top-2 right-2 z-10 text-muted-foreground opacity-0 pointer-coarse:opacity-100 transition-opacity hover:text-foreground focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
      onClick={onClick}
      size="icon-sm"
      type="button"
      variant="ghost"
    >
      <Maximize2Icon aria-hidden="true" />
    </Button>
  );
}
