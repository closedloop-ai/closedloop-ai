"use client";

import { toast } from "@repo/design-system/components/ui/sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { useCopyToClipboard } from "@repo/design-system/hooks/use-copy-to-clipboard";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The focus ring a Properties value wears when it is focusable — the clipped
 * {@link TruncatingPropertyValue} span and the explained value alike. One
 * constant so the two focusable value treatments cannot drift apart.
 */
const VALUE_FOCUS_RING_CLASS =
  "rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

/**
 * FEA-4026: the non-copyable Properties value. Its inner text truncates with an
 * ellipsis inside the fixed-width property column (`.prd-prop-value > span`), so
 * long, multi-part values (Tokens, Duration, Work, …) were unreadable — the old
 * native `title` only fired for string children (never the ReactNode fragments)
 * and was hover-only. This surfaces the full text via the shared DS `Tooltip`
 * (Radix-portaled, so it escapes the Properties panel's sticky-header overflow
 * from FEA-4025), but only when the value is actually clipped — mirroring the
 * `SessionMetadataPanel` `MetadataValue` pattern (FEA-3644). When clipped the
 * value becomes a keyboard-focusable span with an accessible name, so the full
 * value is reachable by keyboard and assistive tech, not hover alone. It is a
 * focusable span rather than a `<button>` because opening the tooltip is not an
 * activation — a button would promise assistive tech an action that does
 * nothing (matching `MetadataValue`). Copyable values already expose their full
 * value through {@link CopyablePropertyValue}.
 */
export function TruncatingPropertyValue({
  children,
  leading,
  href,
}: Readonly<{
  children: ReactNode;
  leading?: ReactNode;
  /**
   * FEA-4256: when set, the truncating value IS an in-app `@repo/navigation`
   * `Link` to `href` (the session's own branch detail page) rather than a plain
   * span. The `Link` is itself the truncating element and — when the value is
   * clipped — the tooltip trigger, so a linked value has exactly one tab stop
   * and one hover target, matching the workspace agents-table name lead
   * (`renderNameLead`). A null/absent `href` renders the value as before.
   */
  href?: string | null;
}>) {
  // The truncating element is a plain `<span>` or, when `href` is set, the value
  // `Link`'s anchor — mutually exclusive at runtime. They need distinct ref
  // types (`Ref<HTMLSpanElement>` vs the `Link`'s `Ref<HTMLAnchorElement>`), so
  // each branch owns its own ref and the effect measures whichever is mounted;
  // both nodes expose the same `scrollWidth`/`clientWidth`/`textContent`.
  const spanRef = useRef<HTMLSpanElement>(null);
  const anchorRef = useRef<HTMLAnchorElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const [fullText, setFullText] = useState("");

  // Measure on mount, on layout resize, and when the rendered value changes: a
  // value is clipped when its rendered text is wider than the column track it
  // occupies. Only the `.prd-prop-value-text` element (the anchor when `href` is
  // set, otherwise the span) carries the ellipsis, so observe that node (the
  // leading icon is a sibling and never truncates). The element type is fixed by
  // `href` for the value's lifetime, so it stays mounted across the
  // truncated/plain branches below and the ref never points at a detached node —
  // a later same-session detail refresh (e.g. the Desktop detail fallback poll)
  // or a column/viewport resize re-measures `isTruncated` and `fullText` in
  // place. A ResizeObserver on the text node fires both when the column resizes
  // AND when the node's content box changes width — matching the `MetadataValue`
  // truncation detector.
  useEffect(() => {
    const textNode = anchorRef.current ?? spanRef.current;
    if (!textNode) {
      return;
    }
    const measure = () => {
      setIsTruncated(textNode.scrollWidth > textNode.clientWidth);
      setFullText(textNode.textContent ?? "");
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(textNode);
    return () => observer.disconnect();
  });

  // One text node per `href` mode (anchor or span), stable across the
  // truncated/plain branches, so the observed element is never swapped out from
  // under its ref. The full value is present in the DOM as the node's text —
  // only visually clipped by CSS — so the trigger's accessible name is the
  // complete value without an explicit `aria-label` (which a bare span/`generic`
  // role does not support), matching `MetadataValue`.
  //
  // Linked value (`href`): the truncating element is an in-app `Link`, which is
  // inherently focusable and interactive, so it carries no `tabIndex` smell and,
  // when clipped, becomes the tooltip trigger directly — one tab stop and one
  // hover target, never an anchor nested inside a focusable span. Plain value:
  // only the clipped span is focusable so keyboard users don't tab through every
  // value, and only then is it the tooltip trigger.
  const text = href ? (
    <Link
      className={cn(
        "prd-prop-value-text hover:underline",
        VALUE_FOCUS_RING_CLASS
      )}
      href={href}
      ref={anchorRef}
    >
      {children}
    </Link>
  ) : (
    <span
      className={cn(
        "prd-prop-value-text",
        isTruncated && VALUE_FOCUS_RING_CLASS
      )}
      ref={spanRef}
      tabIndex={isTruncated ? 0 : undefined}
    >
      {children}
    </span>
  );

  if (!isTruncated) {
    return (
      <span className="prd-prop-value" style={{ cursor: "default" }}>
        {leading}
        {text}
      </span>
    );
  }

  return (
    <span className="prd-prop-value">
      {leading}
      <Tooltip>
        <TooltipTrigger asChild>{text}</TooltipTrigger>
        <TooltipContent className="max-w-sm break-words text-left">
          {fullText}
        </TooltipContent>
      </Tooltip>
    </span>
  );
}

export function CopyablePropertyValue({
  ariaLabel,
  children,
  copiedToastMessage,
  value,
}: Readonly<{
  ariaLabel: string;
  children: ReactNode;
  copiedToastMessage: string;
  value: string;
}>) {
  const [copied, copyValue] = useCopyToClipboard();
  const copy = useCallback(() => {
    copyValue(value)
      .then((success) => {
        if (success) {
          toast.success(copiedToastMessage);
        }
      })
      .catch(() => undefined);
  }, [copiedToastMessage, copyValue, value]);
  const copiedAriaLabel = ariaLabel.startsWith("Copy ")
    ? `Copied ${ariaLabel.slice(5)}`
    : `${ariaLabel} copied`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={copied ? copiedAriaLabel : ariaLabel}
          className="prd-prop-value"
          onClick={copy}
          type="button"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm break-all text-left font-mono">
        {value}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The session-detail Properties row: a label plus its value, rendered copyable
 * ({@link CopyablePropertyValue}) or truncating ({@link TruncatingPropertyValue}).
 * Moved here from `agent-session-detail-view.tsx` (ISS-4667) — it belongs with
 * the two value primitives it composes, and siblings such as
 * `SessionLocPerDollarProperty` need it without importing the view back.
 */
export function PropertyValue({
  children,
  copyValue,
  explanation,
  href,
  icon: Icon,
  label,
  leading,
  mono,
}: Readonly<{
  children: ReactNode;
  copyValue?: string;
  /**
   * ISS-4654: the sentence explaining a value that is a HEDGE rather than a fact
   * — today only the Status row's "Unknown", which names this build's limitation
   * and not the run. It becomes both the hover copy and the tail of the row's
   * accessible name (see {@link ExplainedPropertyValue}). Takes precedence over
   * the truncation tooltip: a value short enough to be a hedge is never clipped,
   * and the reason matters more than repeating the word. Ignored when
   * `copyValue` is set — a copyable value is never a hedge.
   */
  explanation?: string;
  /**
   * FEA-4256: when set, the value becomes an in-app `Link` to `href` (the
   * session's own branch detail page) via {@link TruncatingPropertyValue} — one
   * tab stop, no anchor nested in a focusable span. Only the Branch row supplies
   * one, and only when the session resolved a real branch value (never on the
   * "None" placeholder). Ignored when `copyValue` is set (a value can't be both
   * copyable and a link). Absent → the value renders as plain text.
   */
  href?: string | null;
  icon: LucideIcon | null;
  label: string;
  leading?: ReactNode;
  mono?: boolean;
}>) {
  const leadingContent =
    leading ?? (Icon ? <Icon aria-hidden className="size-3.5" /> : null);

  return (
    <div className="prd-prop">
      <span className="prd-prop-label">{label}</span>
      <PropertyValueBody
        copiedToastMessage={`${label} copied`}
        copyAriaLabel={`Copy ${label.toLowerCase()}`}
        copyValue={copyValue}
        explanation={explanation}
        href={href}
        leading={leadingContent}
        mono={mono}
      >
        {children}
      </PropertyValueBody>
    </div>
  );
}

/**
 * ISS-4654: the Properties value whose word is this build's HEDGE rather than a
 * fact about the session, so the row carries the REASON alongside it.
 *
 * Same shape as the Sessions LIST Unknown pill (`session-status-badges.tsx`):
 * the sentence in a portaled DS `Tooltip`, and an accessible name that LEADS
 * with the visible word (WCAG 2.5.3 Label in Name) before the sentence, because
 * a hover-only tooltip is unreachable for keyboard and touch users.
 *
 * The mechanics follow the sibling that already solved this exact problem,
 * `insights/components/kpi-delta-placeholder.tsx`, rather than inventing a
 * second answer:
 *  • a `<button type="button">`, not a focusable span. The span is what FEA-4026
 *    reached for above on the reasoning that opening a tooltip is not an
 *    activation, but that site only clears Biome's `noNoninteractiveTabindex`
 *    because its `tabIndex` is a conditional the rule cannot resolve; a literal
 *    `tabIndex={0}` fails lint. Radix opens the tooltip on hover AND on focus,
 *    so the button is what puts the reason in the tab order.
 *  • `cursor-default`, because `globals.css` gives every enabled button a
 *    pointer cursor and this one has no `onClick` to promise.
 *  • no `aria-label` — the visible word plus the `sr-only` sentence ARE the
 *    accessible name, where a label would REPLACE them. That also keeps the name
 *    composed from the same two canonical pieces the list pill composes its own
 *    from, so the two cannot drift apart.
 */
function ExplainedPropertyValue({
  children,
  leading,
  tooltip,
}: Readonly<{
  children: ReactNode;
  leading?: ReactNode;
  tooltip: string;
}>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={cn(
            "prd-prop-value cursor-default",
            VALUE_FOCUS_RING_CLASS
          )}
          type="button"
        >
          {leading}
          {children}
          <span className="sr-only">{`, ${tooltip}`}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm break-words text-left">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The three mutually exclusive value treatments a {@link PropertyValue} row can
 * take, resolved in precedence order rather than by a nested ternary: copyable,
 * explained (ISS-4654), then the default truncating value. A copyable value is
 * never a hedge, so the first two can never both apply.
 */
function PropertyValueBody({
  children,
  copiedToastMessage,
  copyAriaLabel,
  copyValue,
  explanation,
  href,
  leading,
  mono,
}: Readonly<{
  children: ReactNode;
  copiedToastMessage: string;
  copyAriaLabel: string;
  copyValue?: string;
  explanation?: string;
  href?: string | null;
  leading?: ReactNode;
  mono?: boolean;
}>) {
  const text = <span className={mono ? "mono" : undefined}>{children}</span>;
  if (copyValue) {
    return (
      <CopyablePropertyValue
        ariaLabel={copyAriaLabel}
        copiedToastMessage={copiedToastMessage}
        value={copyValue}
      >
        {leading}
        {text}
      </CopyablePropertyValue>
    );
  }
  if (explanation) {
    return (
      <ExplainedPropertyValue leading={leading} tooltip={explanation}>
        {text}
      </ExplainedPropertyValue>
    );
  }
  return (
    <TruncatingPropertyValue href={href} leading={leading}>
      {text}
    </TruncatingPropertyValue>
  );
}
