"use client";

import type { SessionLinkedArtifact } from "@repo/api/src/types/agent-session";
import { getDocumentTypeLabel } from "@repo/app/documents/lib/document-navigation";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { Link } from "@repo/navigation/link";
import { TicketIcon } from "lucide-react";

/**
 * ISS-4449: how many linked-artifact pills the session-detail Properties pane
 * renders inline before collapsing the rest behind a reachable `+N` overflow
 * chip. Every other fact in this pane is a single 28px line and the value cell is
 * a narrow grid track, so a long slug list has to stay to a few pills or it wraps
 * to five or six lines and breaks the pane's label-to-label rhythm. Six keeps the
 * common cases inline; the overflow chip (parallel to `TagChips`) carries the
 * rest and its tooltip names them, so a truncated row is never a dead end.
 */
const VISIBLE_LINKED_ARTIFACTS = 6 as const;

/**
 * ISS-4898: an href a shell hands this row is either root-relative (the web
 * shell's in-app `/<org>/issues/<slug>`) or an absolute `https://` URL to the
 * web app (the desktop shell, which hosts no document detail routes and so
 * hands off to the browser). Only the latter may render as an external anchor.
 */
const ABSOLUTE_HTTP_HREF = /^https?:\/\//i;

function linkedArtifactLabel(artifact: SessionLinkedArtifact): string {
  return artifact.slug ?? artifact.name ?? "Artifact";
}

function linkedArtifactTitle(artifact: SessionLinkedArtifact): string {
  const label = linkedArtifactLabel(artifact);
  const typeLabel = getDocumentTypeLabel(artifact.documentType);
  if (typeLabel) {
    return `${typeLabel}: ${artifact.name ?? label}`;
  }
  return artifact.name ?? label;
}

/**
 * One linked-artifact pill. Three branches, and which one renders is decided by
 * the SHELL, not by this component:
 *
 *  - no `buildArtifactHref` (or it resolved nothing) → an inert `<span>`;
 *  - a ROOT-RELATIVE href → a real `@repo/navigation` `Link`, for a shell that
 *    hosts the artifact's own route (the web app);
 *  - an ABSOLUTE `https://` href → an external `<a target="_blank">`, for a
 *    shell that cannot render the artifact itself and hands off to the browser.
 *
 * ISS-5366 adds a fourth, and it exists because the first three are all
 * ASSERTIONS. The inert span does not mean "we don't know"; it means "this is
 * not reachable" — that is the whole point of the link-colored/muted rule below.
 * A shell whose reachability inputs resolve asynchronously (the desktop
 * renderer's org slug and web-app origin both arrive over IPC) therefore spent
 * its load window making a claim it had not yet checked: the pills rendered as
 * settled-unreachable labels and then flipped to links, so the row asserted
 * "not reachable" about artifacts that were reachable all along — a loading
 * state wearing the unavailable state's clothes. `pending` gives that window its
 * own rendering, which asserts neither answer.
 *
 * ISS-4793: all three navigable/inert branches deliberately survive. The web shell hosts
 * `/issues|prds|implementation-plans|documents/[slug]`, so its pills are in-app
 * links. Handing the desktop renderer a root-relative href would be strictly
 * worse than the span: its nav guard DROPS an href with no route-table entry
 * (`handleUnmappedHref`), so the pill would look clickable and then do nothing.
 *
 * ISS-4898: which is why the desktop's destination is the ABSOLUTE web-app URL
 * on the external branch instead — the same affordance the `PullRequestPill`
 * inches away already uses for GitHub, where the Electron window-open handler
 * hands an allowlisted `https://` target to the OS browser. The renderer builds
 * that URL only once it has an org SLUG (its identity payload carries one as of
 * ISS-4898); until the slug and the web-app origin both resolve it passes no
 * builder and the pills stay inert spans.
 *
 * The branches are told apart at rest, not just on hover: `a.sd3-result-pr` is
 * link-colored and the inert span is muted, so link-colored means clickable on
 * both surfaces (FEA-4292's rule).
 *
 * ISS-4793: the description rides the design-system `Tooltip` on EVERY branch,
 * not a native `title`. `title` never opens on keyboard focus or touch, so the
 * exact users this ticket added a focus ring for got nothing from it — and the
 * PR pill inches away in this same pane already uses the DS Tooltip, so a native
 * `title` here left one row with two different disclosure behaviors. Both link
 * branches are anchors, so their tooltips already open on keyboard focus; the
 * inert branch stays a non-focusable span, because a tabIndex on a
 * non-interactive element is a tab stop that does nothing.
 */
function IssueLinkPill({
  artifact,
  href,
  pending = false,
}: Readonly<{
  artifact: SessionLinkedArtifact;
  href: string | null;
  pending?: boolean;
}>) {
  const label = linkedArtifactLabel(artifact);
  const title = linkedArtifactTitle(artifact);
  const content = (
    <>
      <TicketIcon aria-hidden className="size-3.5" />
      <span className="mono">{label}</span>
    </>
  );

  // Checked BEFORE the `!href` branch: while the shell's reachability inputs are
  // unresolved there is no href yet, and falling through would render the
  // settled "not reachable" label over an unanswered question.
  if (pending && !href) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            aria-busy="true"
            className="sd3-result-pr sd3-result-pr-pending"
          >
            {content}
          </span>
        </TooltipTrigger>
        <TooltipContent>{`${title} — checking link…`}</TooltipContent>
      </Tooltip>
    );
  }

  if (!href) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="sd3-result-pr">{content}</span>
        </TooltipTrigger>
        <TooltipContent>{title}</TooltipContent>
      </Tooltip>
    );
  }

  if (ABSOLUTE_HTTP_HREF.test(href)) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            className="sd3-result-pr"
            href={href}
            rel="noreferrer"
            target="_blank"
          >
            {content}
          </a>
        </TooltipTrigger>
        <TooltipContent>{title}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link className="sd3-result-pr" href={href}>
          {content}
        </Link>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The `+N` overflow chip that follows the visible pills. Reuses the `TagChips`
 * shape (a muted chip whose tooltip enumerates the hidden entries) so a truncated
 * row lets the reader reach what got cut instead of dead-ending on a bare count.
 *
 * ISS-4897: the chip is a real DISCLOSURE — a `Popover`, not a `Tooltip`. As a
 * span it was the one element in this row that revealed content but advertised
 * nothing: the tooltip was the only way to see what got truncated and it opened
 * on HOVER only, so a keyboard-only user could never reach the hidden artifacts
 * and a touch user could not either.
 *
 * A tooltip is the wrong primitive for this and could not be made right by
 * swapping the span for a button: Radix's `TooltipTrigger` composes its own
 * `onClick` that CLOSES the tooltip, so a button named "Show 2 more linked
 * artifacts" would have dismissed the very list it names the moment it was
 * activated — Enter/Space on keyboard, tap on touch. A tooltip describes its
 * trigger; this chip REVEALS content, which is a disclosure.
 *
 * `PopoverTrigger` owns the whole contract: it toggles on click and on
 * Enter/Space, manages `aria-expanded` itself, closes on Escape and outside
 * click, and works on touch. The deliberate trade is that pointer users now
 * CLICK instead of hover — a discoverable affordance on a control that already
 * has to advertise itself, rather than a hover secret two thirds of input
 * methods never had.
 *
 * It stays visually muted — see the CSS note: link color in this row means
 * "this navigates", and this chip reveals in place.
 *
 * `overflowCount` is the true resolved total minus the visible pills — it can
 * exceed `hiddenNamed.length`, because the projection ships at most
 * `MAX_DISPLAYED_LINKED_ARTIFACTS` resolved links even when more exist. The
 * tooltip names every hidden artifact we actually received, and when the server
 * truncated beyond that it adds an honest "and K more…" line rather than
 * implying it can name links it never sent.
 */
function LinkedArtifactsOverflowChip({
  overflowCount,
  hiddenNamed,
}: Readonly<{
  overflowCount: number;
  hiddenNamed: SessionLinkedArtifact[];
}>) {
  const unnamedCount = overflowCount - hiddenNamed.length;
  const chipLabel = `+${overflowCount.toLocaleString()}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label={overflowChipAccessibleName(overflowCount)}
          className="sd3-result-pr sd3-linked-overflow"
          type="button"
        >
          {chipLabel}
        </button>
      </PopoverTrigger>
      {/* `w-auto` overrides the primitive's fixed `w-72`: this list is a handful
          of short slugs, and a 288px panel beside a 40px chip reads as a dialog
          rather than an overflow of the row it belongs to. */}
      <PopoverContent align="start" className="w-auto max-w-xs p-2">
        <LinkedArtifactsOverflowList
          hiddenNamed={hiddenNamed}
          unnamedCount={unnamedCount}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * ISS-4449: the session-detail Properties-pane "Linked artifacts" row. Renders up
 * to {@link VISIBLE_LINKED_ARTIFACTS} navigable pills and, when the resolved
 * `total` exceeds them, a reachable `+N` overflow chip instead of silently
 * dropping links or dead-ending on an "N of M shown" caption. Extracted to a
 * sibling so the grandfathered `agent-session-detail-view.tsx` does not grow.
 *
 * Renders nothing when there are no linked artifacts — a session with none adds
 * no extra row to the pane.
 */
export function SessionLinkedArtifactsRow({
  linkedArtifacts,
  total,
  buildArtifactHref,
  artifactHrefPending = false,
}: Readonly<{
  linkedArtifacts: SessionLinkedArtifact[];
  total: number;
  buildArtifactHref?: (artifact: SessionLinkedArtifact) => string | null;
  /**
   * ISS-5366: the shell has not yet resolved whether it can build artifact
   * destinations, so no pill may claim either reachability answer. Defaults to
   * false, which is correct for a shell whose inputs are synchronous (the web
   * app builds hrefs from the route's own org slug) — only a shell that
   * resolves them asynchronously needs to raise it.
   */
  artifactHrefPending?: boolean;
}>) {
  if (linkedArtifacts.length === 0) {
    return null;
  }

  const visible = linkedArtifacts.slice(0, VISIBLE_LINKED_ARTIFACTS);
  const hiddenNamed = linkedArtifacts.slice(VISIBLE_LINKED_ARTIFACTS);
  // The true resolved total, not just the pills we received, so the chip counts
  // links the projection capped before sending them.
  const overflowCount = Math.max(0, total - visible.length);

  return (
    <div className="prd-prop sd3-linked-prop">
      <span className="prd-prop-label">Linked artifacts</span>
      <div
        className="prd-prop-value sd3-prs-value"
        style={{ cursor: "default" }}
      >
        {visible.map((artifact) => (
          <IssueLinkPill
            artifact={artifact}
            href={buildArtifactHref?.(artifact) ?? null}
            key={artifact.id}
            pending={artifactHrefPending}
          />
        ))}
        {overflowCount > 0 ? (
          <LinkedArtifactsOverflowChip
            hiddenNamed={hiddenNamed}
            overflowCount={overflowCount}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * ISS-4897: the overflow chip's accessible name. The visible "+3" is a bare
 * count that names neither what it counts nor that it can be opened, so a
 * screen-reader user hearing "plus three, button" learns nothing actionable.
 * The tooltip content itself is not the name — it is the disclosed content — so
 * the control states its own purpose here.
 */
function overflowChipAccessibleName(overflowCount: number): string {
  const noun = overflowCount === 1 ? "linked artifact" : "linked artifacts";
  return `Show ${overflowCount.toLocaleString()} more ${noun}`;
}

/**
 * The disclosed content behind the `+N` chip: every hidden artifact we actually
 * received, plus an honest "and K more…" trailer when the server truncated
 * beyond what it sent (ISS-4897).
 */
function LinkedArtifactsOverflowList({
  hiddenNamed,
  unnamedCount,
}: Readonly<{
  hiddenNamed: SessionLinkedArtifact[];
  unnamedCount: number;
}>) {
  return (
    <div className="flex flex-col gap-1">
      {hiddenNamed.map((artifact) => (
        <span className="mono" key={artifact.id}>
          {linkedArtifactLabel(artifact)}
        </span>
      ))}
      {unnamedCount > 0 ? (
        <span className="text-muted-foreground">
          and {unnamedCount.toLocaleString()} more…
        </span>
      ) : null}
    </div>
  );
}
