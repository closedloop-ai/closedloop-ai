"use client";

import type { BasicUser } from "@repo/api/src/types/user";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { copyToClipboard } from "@repo/app/shared/lib/clipboard-utils";
import { formatDateTimeOrFallback } from "@repo/app/shared/lib/date-utils";
import { SESSION_TIMELINE_COVERAGE_DISCLOSURE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import {
  CountCell,
  type CountCellProps,
} from "@repo/design-system/components/ui/count-cell";
import { InfoHint } from "@repo/design-system/components/ui/primitives/info-hint";
import type { CountNoun } from "@repo/design-system/lib/count-noun";
import { cn } from "@repo/design-system/lib/utils";
import { CheckIcon, CopyIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { DetailsField, DetailsFieldValue } from "./details-design-model";
import { DETAILS_EMPTY_VALUE } from "./details-field-value";
import { useDetailsRowLabel } from "./details-sections";

/**
 * ISS-10792: read-only CUSTOM cells a host hands the Details renderer for its
 * rich rows (Daveth, 2026-09-23). The renderer never knows their shape; each
 * is the host's own component, drawn where the prototype puts a value. The
 * disclosures read their production flag at the leaf, as production does.
 */

/** Shipped wording, reused: `branch-delivered-panel.tsx`'s collapse toggle. */
const SHOW_LESS_LABEL = "Show less";
const ABSOLUTE_HTTP_HREF = /^https?:\/\//i;

/** Where the prototype's value buttons put their text. */
export function CellText({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center px-1 py-1", className)}>
      {children}
    </span>
  );
}

/** Session Duration: the figure, with its evidence behind production's flag. */
export function DurationCell({
  evidence,
  text,
}: {
  evidence: string;
  text: string;
}) {
  const disclosed =
    useFeatureFlagEnabledOptional(
      SESSION_TIMELINE_COVERAGE_DISCLOSURE_FEATURE_FLAG_KEY
    ) === true;
  return (
    <CellText className="flex-wrap gap-x-2">
      <span className="tabular-nums">{text}</span>
      {disclosed ? (
        <span className="text-muted-foreground text-xs">{evidence}</span>
      ) : null}
    </CellText>
  );
}

/** `href` null renders an inert label, as production's pills do. */
export type PillItem = { href: string | null; label: string };
const PILL_CLASS = "rounded-full border px-2 py-0.5 font-mono text-xs";

function Pill({ item }: { item: PillItem }) {
  if (!item.href) {
    return (
      <span className={cn(PILL_CLASS, "text-muted-foreground")}>
        {item.label}
      </span>
    );
  }
  // Production renders an in-app href through `@repo/navigation`'s Link; the
  // harness mounts no NavigationProvider, so a plain anchor stands in.
  const external = ABSOLUTE_HTTP_HREF.test(item.href);
  return (
    <a
      className={cn(PILL_CLASS, "hover:bg-muted")}
      href={item.href}
      {...(external ? { rel: "noreferrer", target: "_blank" } : {})}
    >
      {item.label}
    </a>
  );
}

/**
 * Production's overflow chip name (`session-linked-artifacts-row.tsx`
 * `overflowChipAccessibleName`, private there): the visible "+N" names
 * neither what it counts nor that it opens.
 */
function overflowName(count: number) {
  const noun = count === 1 ? "linked artifact" : "linked artifacts";
  return `Show ${count.toLocaleString()} more ${noun}`;
}

/** Session PR and artifact rows: pills, the rest behind production's "+N" chip. */
export function PillsCell({
  items,
  visible = 4,
}: {
  items: readonly PillItem[];
  visible?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const overflow = items.length - visible;
  const shown = expanded ? items : items.slice(0, visible);
  return (
    <CellText className="flex-wrap gap-1.5">
      {shown.map((item) => (
        <Pill item={item} key={item.href ?? item.label} />
      ))}
      {overflow > 0 ? (
        <button
          aria-expanded={expanded}
          aria-label={expanded ? SHOW_LESS_LABEL : overflowName(overflow)}
          className="rounded-full px-2 py-0.5 text-muted-foreground text-xs hover:bg-muted"
          onClick={() => setExpanded((open) => !open)}
          type="button"
        >
          {expanded ? SHOW_LESS_LABEL : `+${overflow.toLocaleString()}`}
        </button>
      ) : null}
    </CellText>
  );
}

export function LinkPillCell({ item }: { item: PillItem }) {
  return <PillsCell items={[item]} />;
}

/**
 * A count through the design-system count primitive (ISS-12197), which keeps
 * a real zero, an unknown count and a loading one apart. Not the primitive's
 * name: `CountCell` is the design system's.
 */
export function DetailsCountCell({
  count,
  noun,
}: Pick<CountCellProps, "count" | "noun">) {
  return (
    <CellText>
      <CountCell count={count} noun={noun} />
    </CellText>
  );
}

/**
 * A viewer-local date and time (ISS-12197). An absent value draws the shared
 * unknown glyph; whether the row is drawn at all is the host's `empty`.
 */
export function DateTimeCell({
  value,
}: {
  value: Date | string | null | undefined;
}) {
  return (
    <CellText>
      <span className="tabular-nums">
        {formatDateTimeOrFallback(value, { fallback: DETAILS_EMPTY_VALUE })}
      </span>
    </CellText>
  );
}

/** How long the Copied state shows before the control resets. */
const COPIED_RESET_MS = 2000;

/**
 * A copyable identifier. Its accessible name follows production's
 * `PropertyValue` ("Copy session id" / "Copied session id"); it claims Copied
 * only on a real clipboard write, and resets.
 */
export function CopyCell({
  ariaLabel,
  text,
}: {
  ariaLabel: string;
  text: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copiedLabel = ariaLabel.startsWith("Copy ")
    ? `Copied ${ariaLabel.slice(5)}`
    : `${ariaLabel} copied`;
  return (
    <CellText className="gap-1.5">
      <span className="min-w-0 truncate font-mono" title={text}>
        {text}
      </span>
      <button
        aria-label={copied ? copiedLabel : ariaLabel}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={async () => {
          if (await copyToClipboard(text)) {
            setCopied(true);
          }
        }}
        type="button"
      >
        {copied ? (
          <CheckIcon aria-hidden="true" className="size-3.5" />
        ) : (
          <CopyIcon aria-hidden="true" className="size-3.5" />
        )}
      </button>
    </CellText>
  );
}

/**
 * The value half of the rows every host draws the same way (the Session and
 * Branch hosts, PLN-2169): the cell and ISS-12197's empty predicate are decided
 * here once, and a host adds only the row's read-only reason.
 */

/**
 * Owner and Created by share the renderer's person cell (decision 5,
 * 2026-10-07). An absent person is the empty text value, not a person with an
 * empty name: the person cell has no empty state of its own and draws a blank
 * avatar beside blank text (tamsinb, #8514).
 */
export function personValue(
  user: BasicUser | null | undefined
): DetailsFieldValue {
  return user
    ? {
        avatarUrl: user.avatarUrl ?? undefined,
        choices: [],
        kind: "person",
        name: getUserDisplayName(user),
      }
    : { kind: "text", text: "" };
}

export function copyValue(
  label: string,
  text: string | null | undefined
): DetailsFieldValue {
  return {
    kind: "custom",
    empty: !text,
    render: () => (
      <CopyCell ariaLabel={`Copy ${label.toLowerCase()}`} text={text ?? ""} />
    ),
  };
}

export function dateTimeValue(
  value: Date | string | null | undefined
): DetailsFieldValue {
  return {
    kind: "custom",
    empty: value == null,
    render: () => <DateTimeCell value={value} />,
  };
}

export function countValue(
  count: number | null | undefined,
  noun: CountNoun
): DetailsFieldValue {
  return {
    kind: "custom",
    empty: count == null,
    render: () => <DetailsCountCell count={count} noun={noun} />,
  };
}

/**
 * A Partial figure drawn the way the Branch headline card draws one: the value
 * keeps its `*`, and the producer's disclosure sits in an info popover named
 * `About <label>` after `MetricCard`'s, never on the row face (branches
 * AGENTS.md, ISS-10540). `row` is the row's own label pair, resolved here by
 * the renderer's resolver so the popover is named after the label the row
 * actually draws.
 */
export function PartialValueCell({
  disclosure,
  mono,
  row,
  text,
}: {
  disclosure: string;
  mono?: boolean;
  row: Pick<DetailsField, "flaggedLabel" | "label">;
  text: string;
}) {
  const label = useDetailsRowLabel(row);
  return (
    <CellText className="gap-1.5">
      <span
        className={cn("min-w-0 truncate", mono && "font-mono")}
        title={text}
      >
        {text}*
      </span>
      <InfoHint
        align="start"
        contentClassName="w-60 p-3 text-xs"
        label={`About ${label}`}
      >
        <p className="text-muted-foreground text-xs">{disclosure}</p>
      </InfoHint>
    </CellText>
  );
}
