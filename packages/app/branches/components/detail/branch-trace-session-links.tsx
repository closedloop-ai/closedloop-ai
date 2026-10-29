"use client";

import type { BranchSession } from "@repo/api/src/types/branch";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { ChevronRightIcon } from "lucide-react";
import { useId, useState } from "react";
import { distinctBranchSessions } from "../../lib/branch-session-cost";

/**
 * Accessible name of the links' nav. Copy approved by Nerys Applethwaite, 2026-10-13
 * (ISS-12210 comment). Absence assertions import it so a reword cannot pass them vacuously.
 */
export const BRANCH_TRACE_SESSION_LINKS_LABEL = "Sessions in this trace";

/** The name a Branch trace shows for one of its Sessions. */
export function branchTraceSessionLabel(
  session: Pick<BranchSession, "name" | "sessionId" | "slug">
): string {
  return session.name ?? session.slug ?? session.sessionId;
}

/**
 * ISS-12210: the "open this session" links ISS-10963 asks for, attached to the
 * "Combined session trace" heading as its legend. Same deduped population the
 * heading's "N sessions" counts, so the names and the count cannot disagree.
 */
export function BranchTraceSessionLinks({
  getSessionHref,
  hidden,
  id,
  sessions,
}: {
  getSessionHref: (sessionId: string) => string;
  hidden?: boolean;
  id?: string;
  sessions: readonly BranchSession[];
}) {
  const distinct = distinctBranchSessions(sessions);
  if (distinct.length === 0) {
    return null;
  }
  return (
    <nav
      aria-label={BRANCH_TRACE_SESSION_LINKS_LABEL}
      className="bq-act-legend"
      hidden={hidden}
      id={id}
    >
      {distinct.map((session) => {
        const label = branchTraceSessionLabel(session);
        return (
          <Link
            className="bq-lg bq-lg-name max-w-64 hover:underline focus-visible:underline"
            href={getSessionHref(session.sessionId)}
            key={session.sessionId}
            title={label}
          >
            <span className="min-w-0 truncate">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export type BranchTraceSessionLinksDisclosure = {
  /** Whether there are links to render at all. */
  available: boolean;
  /** Whether the heading's count carries the toggle. */
  hasToggle: boolean;
  id: string;
  open: boolean;
  toggle: () => void;
  visible: boolean;
};

/**
 * ISS-12448: the heading's session links are collapsed by default and open from
 * the "N sessions" count (Nerys Applethwaite's ruling, 2026-10-19: on a 35-Session
 * branch the open list wraps to 10 rows on desktop and 20 on a phone). The open
 * state is keyed to the Branch so it does not carry across navigation. With no
 * count to carry the toggle, the links stay open as they were before.
 */
export function useBranchTraceSessionLinksDisclosure({
  branchId,
  hasLinks,
  sessionCount,
  showSessionCount,
}: {
  branchId: string;
  hasLinks: boolean;
  sessionCount: number;
  showSessionCount: boolean;
}): BranchTraceSessionLinksDisclosure {
  const id = useId();
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = openFor === branchId;
  const available = hasLinks && sessionCount > 0;
  return {
    available,
    hasToggle: available && showSessionCount,
    id,
    open,
    toggle: () => setOpenFor(open ? null : branchId),
    visible: available && (open || !showSessionCount),
  };
}

/** The heading's session count; the links' toggle when there are links. */
export function BranchTraceSessionCount({
  disclosure,
  label,
}: {
  disclosure: BranchTraceSessionLinksDisclosure;
  label: string;
}) {
  if (!disclosure.hasToggle) {
    return label;
  }
  return (
    <button
      aria-controls={disclosure.id}
      aria-expanded={disclosure.open}
      className="inline-flex cursor-pointer items-center gap-0.5 border-0 bg-transparent p-0 font-[inherit] text-[inherit] hover:underline focus-visible:underline"
      onClick={disclosure.toggle}
      type="button"
    >
      {label}
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "size-3 transition-transform",
          disclosure.open && "rotate-90"
        )}
      />
    </button>
  );
}
