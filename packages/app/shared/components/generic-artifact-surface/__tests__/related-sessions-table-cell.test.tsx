import { DISPLAYED_SESSION_STATUS } from "@repo/api/src/types/session-status";
import { restoreTimeZone } from "@repo/app/shared/test-fixtures/tz-utils";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RELATED_SESSIONS_TABLE_EMPTY_TITLE,
  RelatedSessionsTableCell,
  type RelatedSessionTableItem,
  toRelatedSessionTableReference,
} from "../related-sessions-table-cell";

/** One initial on every avatar (Nerys, 2026-10-22), and nothing else. */
const ONLY_A = /^A$/;

/**
 * The label and tooltip are viewer-local by design, so both the wall-clock
 * assertion and the today/earlier boundary only mean something against a
 * pinned zone. Unpinned, this suite is green on a US Central laptop, red under
 * CI's UTC, and red again from UTC+9 where NOW and `occurredAt` fall on
 * different local calendar days.
 */
const VIEWER_TIME_ZONE = "America/Chicago";
const ORIGINAL_TIME_ZONE = process.env.TZ;
const NOW = new Date("2026-08-21T15:00:00.000Z");
const TIME_OF_DAY = /\d{1,2}:\d{2}\s?(AM|PM)/;
const MONTH_AND_DAY = /^\d{2}\/\d{2}$/;
const ACTIVE_SESSION_NAME =
  /SES-595-3 · Avery Example · Active · Wrote to artifact/;
const OVERFLOW_PILL_PATTERN = /^\+\d/;
const AVATAR_URL = "data:image/svg+xml,%3Csvg/%3E";
const ITEM: RelatedSessionTableItem = {
  href: "/artifacts/PRD-595?tab=sessions&traceRow=102",
  id: "session-newest",
  occurredAt: "2026-08-21T09:04:00.000Z",
  ownerAvatarUrl: AVATAR_URL,
  ownerName: "Avery Example",
  relationshipLabel: "Wrote to artifact",
  sessionSlug: "SES-595-3",
  status: DISPLAYED_SESSION_STATUS.ACTIVE,
};

/**
 * A reference chip links through the navigation PORT rather than a raw anchor
 * (ISS-8972), so every mount of this cell needs an adapter — the same memory
 * adapter the Branches chips suite and the Storybook preview mount. Its
 * `renderHref` is identity, so the rendered `href` is still the path passed in.
 */
function renderCell(ui: ReactNode) {
  return render(
    <NavigationProvider
      adapter={createMemoryNavigation({ initialPath: "/artifacts" }).adapter}
    >
      <TooltipProvider>{ui}</TooltipProvider>
    </NavigationProvider>
  );
}

describe("RelatedSessionsTableCell", () => {
  beforeEach(() => {
    process.env.TZ = VIEWER_TIME_ZONE;
  });

  afterEach(() => {
    restoreTimeZone(ORIGINAL_TIME_ZONE);
  });

  it("projects the domain item into the compact reference contract", () => {
    const reference = toRelatedSessionTableReference(ITEM, NOW);

    expect(reference).toMatchObject({
      className: "border-success/25 bg-success/10 text-success",
      href: "/artifacts/PRD-595?tab=sessions&traceRow=102",
      id: "session-newest",
      // One initial on every avatar (Nerys, 2026-10-22).
      initials: "A",
      avatarUrl: AVATAR_URL,
      tooltip:
        "SES-595-3 · Avery Example · Active · Wrote to artifact · Most recent interaction Aug 21, 2026 at 4:04 AM",
    });
    expect(reference.label).toMatch(TIME_OF_DAY);
  });

  it("uses local time today and MM/DD for every earlier calendar day", () => {
    const today = toRelatedSessionTableReference(ITEM, NOW);
    const earlier = toRelatedSessionTableReference(
      {
        ...ITEM,
        occurredAt: "2026-08-20T23:59:00.000Z",
      },
      NOW
    );

    expect(today.label).toMatch(TIME_OF_DAY);
    expect(earlier.label).toMatch(MONTH_AND_DAY);
  });

  it("uses initials when no avatar picture is supplied", () => {
    const { container } = renderCell(
      <RelatedSessionsTableCell
        items={[{ ...ITEM, ownerAvatarUrl: undefined }]}
        now={NOW}
      />
    );

    expect(
      container.querySelector('[data-slot="avatar-image"]')
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="avatar-fallback"]')
    ).toHaveTextContent(ONLY_A);
  });

  it("uses success for active, destructive for error, and muted otherwise", () => {
    const failed = toRelatedSessionTableReference(
      { ...ITEM, status: DISPLAYED_SESSION_STATUS.ERROR },
      NOW
    );

    expect(failed.className).toBe(
      "border-destructive/25 bg-destructive/10 text-destructive"
    );
    // ISS-10364 retired `WAITING`/`STALE`/`UNKNOWN` from `DisplayedSessionStatus`
    // (this cell's `status` field type), so INACTIVE is now the only remaining
    // non-active, non-error lifecycle value to pin against the muted tone.
    for (const status of [DISPLAYED_SESSION_STATUS.INACTIVE]) {
      expect(
        toRelatedSessionTableReference({ ...ITEM, status }, NOW).className
      ).toBe("border-border bg-muted text-muted-foreground");
    }
  });

  it("renders a real link with the complete accessible name", () => {
    renderCell(<RelatedSessionsTableCell items={[ITEM]} now={NOW} />);

    expect(
      screen.getByRole("link", {
        name: ACTIVE_SESSION_NAME,
      })
    ).toHaveAttribute("href", ITEM.href);
  });

  // The directive is the type-level half. The render is the runtime half: the
  // projection picks the same arm the chip's precedence picks, so an untyped
  // caller cannot make the two layers disagree about which arm survives.
  it("forbids an item that names both a destination and an action", () => {
    const onSelect = vi.fn();
    // @ts-expect-error - href and onSelect are mutually exclusive
    const bothArms: RelatedSessionTableItem = { ...ITEM, onSelect };

    renderCell(<RelatedSessionsTableCell items={[bothArms]} now={NOW} />);

    expect(
      screen.getByRole("button", { name: ACTIVE_SESSION_NAME })
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("does not let a reference click bubble into row selection", () => {
    const onRowClick = vi.fn();
    renderCell(<RelatedSessionsTableCell items={[ITEM]} now={NOW} />);
    const link = screen.getByRole("link");
    document.addEventListener("click", onRowClick);
    link.addEventListener("click", (event) => event.preventDefault());

    fireEvent.pointerDown(link);
    fireEvent.click(link);
    document.removeEventListener("click", onRowClick);

    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("renders the named grid empty sentinel", () => {
    renderCell(<RelatedSessionsTableCell items={[]} now={NOW} />);

    expect(
      screen.getByTitle(RELATED_SESSIONS_TABLE_EMPTY_TITLE)
    ).toHaveAttribute("data-slot", "grid-empty-value");
  });

  it("stays read-only when it has data", () => {
    const { container } = renderCell(
      <RelatedSessionsTableCell items={[ITEM]} now={NOW} />
    );

    expect(
      container.querySelectorAll(
        "input, textarea, [contenteditable], [data-grid-primary-editor]"
      )
    ).toHaveLength(0);
  });

  it("adds the server-withheld remainder to the overflow pill", () => {
    renderCell(<RelatedSessionsTableCell items={[ITEM]} now={NOW} total={4} />);

    expect(screen.getByText("+4")).toBeInTheDocument();
  });

  it("renders no pill when total matches the delivered items", () => {
    renderCell(<RelatedSessionsTableCell items={[ITEM]} now={NOW} total={1} />);

    expect(screen.queryByText(OVERFLOW_PILL_PATTERN)).not.toBeInTheDocument();
  });

  it("renders no pill when total is omitted", () => {
    renderCell(<RelatedSessionsTableCell items={[ITEM]} now={NOW} />);

    expect(screen.queryByText(OVERFLOW_PILL_PATTERN)).not.toBeInTheDocument();
  });

  it("keeps the empty sentinel, and no pill, when total is set on an empty list", () => {
    renderCell(<RelatedSessionsTableCell items={[]} now={NOW} total={3} />);

    expect(
      screen.getByTitle(RELATED_SESSIONS_TABLE_EMPTY_TITLE)
    ).toHaveAttribute("data-slot", "grid-empty-value");
    expect(screen.queryByText(OVERFLOW_PILL_PATTERN)).not.toBeInTheDocument();
  });
});
